#!/usr/bin/env node
// vanta-runtime-state — per-session dedupe + cooldown brain.
//
// Codex council R1-P2 → R2-P1 evolution: original implementation used
// read-modify-write JSON snapshots, which loses updates under concurrent
// PreToolUse + PostToolUse + UserPromptSubmit traffic (Codex reproduced
// 20 parallel bumps landing as 10). v3.6 fix: append-only JSONL journal.
// Each operation is one atomic appendFileSync line. State is derived by
// folding the journal on read.
//
// Concurrency model:
//   - All writes go to ~/.vanta/runtime/<sid>.jsonl via fs.appendFileSync.
//     POSIX guarantees atomic append for writes < PIPE_BUF (4096B); each
//     entry is ~200B, well under the limit. No lock needed.
//   - Reads fold the journal end-to-start, returning the most recent
//     value per (key, field). O(N) per read but N stays bounded by
//     compaction below.
//   - Compaction: on every 200th read OR via reapStale, the journal is
//     folded into a single snapshot line that supersedes prior entries.
//
// Schema entries:
//   { ts, op: 'inject'  , key, value: <unix-ms> }
//   { ts, op: 'bump'    , field, delta: 1 }
//   { ts, op: 'phase'   , value }
//   { ts, op: 'snapshot', state: { phase, injected, counters } }
//
// SessionStart hook calls resetSession to truncate the journal at the
// start of each session.

const fs = require('fs');
const path = require('path');
const os = require('os');

function _runtimeDir() {
  return process.env.VANTA_DIR_OVERRIDE
    ? path.join(process.env.VANTA_DIR_OVERRIDE, 'runtime')
    : path.join(os.homedir(), '.vanta', 'runtime');
}

function _fileFor(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  return path.join(_runtimeDir(), `${safe}.jsonl`);
}

function _ensureDir() {
  const d = _runtimeDir();
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {}
}

function _appendLine(sessionId, obj) {
  _ensureDir();
  try {
    fs.appendFileSync(_fileFor(sessionId), JSON.stringify(obj) + '\n');
    return true;
  } catch { return false; }
}

// ─── journal fold ──────────────────────────────────────────────────────────
//
// Reduce the JSONL journal into a single state object. Walks forward;
// snapshots reset the accumulator. Last-write-wins per (op, key/field).
//
// Codex R4 / Gemini R4 P1 fix — memoize by file mtime. tool-observer.js
// calls getState() on every PreToolUse and PostToolUse event. Without
// memoization, a session with N tool events did O(N) folds, with each
// fold scanning the full journal — quadratic over the session. With
// memoization, a fold runs once per (sessionId, mtime); subsequent
// reads are O(1) until the next append updates the mtime.
//
// Cache scope: per-process. Each hook is its own short-lived node
// process, so the cache only helps when multiple getState() calls
// happen inside the same hook invocation. For long-running test/audit
// processes (e.g. `audit() walking many sessions`) this turns N²
// behavior into linear.
const _foldCache = new Map();

function _foldJournal(sessionId) {
  const file = _fileFor(sessionId);
  let acc = {
    session_id: sessionId,
    started_at: null,
    last_seen: null,
    phase: 'unknown',
    injected: {},
    counters: {},
  };

  if (!fs.existsSync(file)) return acc;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return acc; }
  const cached = _foldCache.get(sessionId);
  if (cached && cached.mtime === mtime) return cached.acc;

  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch { return acc; }

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!acc.started_at) acc.started_at = e.ts;
    acc.last_seen = e.ts;

    switch (e.op) {
      case 'snapshot':
        // Snapshot supersedes everything before it.
        acc = { session_id: sessionId, ...e.state, last_seen: e.ts };
        acc.injected = acc.injected || {};
        acc.counters = acc.counters || {};
        break;
      case 'inject':
        acc.injected[e.key] = e.value;
        break;
      case 'bump':
        acc.counters[e.field] = (acc.counters[e.field] || 0) + (e.delta || 1);
        break;
      case 'phase':
        acc.phase = e.value;
        break;
    }
  }
  _foldCache.set(sessionId, { mtime, acc });
  // Bound the memo at 64 entries to avoid retaining state for thousands
  // of past sessions in a long-running test process.
  if (_foldCache.size > 64) _foldCache.delete(_foldCache.keys().next().value);
  return acc;
}

function _clearFoldCache() { _foldCache.clear(); }

// Compaction: rewrite the journal as a single snapshot line.
//
// Codex R3 P1 fix — the original implementation had a lost-update window:
//   1. _foldJournal() reads the journal end-state.
//   2. Hook A appends a new line via fs.appendFileSync (atomic, < PIPE_BUF).
//   3. We rename tmp → file. The line from step 2 is gone.
//
// Mitigation: only compact files that are quiescent — last modified more
// than QUIESCE_MS ago. A live session is appending every few seconds, so
// it never qualifies. Stale session files (post-Stop hook) DO qualify and
// can be compacted safely. `force: true` overrides for tests.
//
// Acceptance trade: live sessions never compact. They are bounded by
// reapStale's age cutoff; if a file grows huge mid-session, it gets
// compacted after the session ends. That's fine — fold cost is O(N) and
// N is bounded by hook fire rate × session length, which is small.
const QUIESCE_MS = 10_000;

function _compact(sessionId, { force = false } = {}) {
  const file = _fileFor(sessionId);
  if (!fs.existsSync(file)) return;
  try {
    if (!force) {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < QUIESCE_MS) return;  // live — skip.
    }
    const state = _foldJournal(sessionId);
    const snapshotLine = JSON.stringify({
      ts: new Date().toISOString(),
      op: 'snapshot',
      state: {
        started_at: state.started_at,
        phase: state.phase,
        injected: state.injected,
        counters: state.counters,
      },
    }) + '\n';
    const tmp = file + '.compact';
    fs.writeFileSync(tmp, snapshotLine);
    fs.renameSync(tmp, file);
  } catch { /* never block */ }
}

// ─── cooldown table ────────────────────────────────────────────────────────

const COOLDOWNS = {
  'council-advisory:': 30 * 60_000,
  'prompt-context:':   10 * 60_000,
  'tool-observer:':    15 * 60_000,
  'stack-file-nudge:': 60 * 60_000,
  'default':            5 * 60_000,
};

function _cooldownFor(key) {
  for (const prefix of Object.keys(COOLDOWNS)) {
    if (prefix !== 'default' && key.startsWith(prefix)) return COOLDOWNS[prefix];
  }
  return COOLDOWNS.default;
}

// ─── public API ────────────────────────────────────────────────────────────

function getState(sessionId) {
  const folded = _foldJournal(sessionId);
  // Surface counters at the top level for back-compat with v3.5 callers
  // that read state.prompt_count / state.tool_calls directly.
  return {
    session_id: folded.session_id,
    started_at: folded.started_at || new Date().toISOString(),
    last_seen:  folded.last_seen || new Date().toISOString(),
    phase: folded.phase || 'unknown',
    injected: folded.injected || {},
    prompt_count: (folded.counters || {}).prompt_count || 0,
    tool_calls:   (folded.counters || {}).tool_calls   || 0,
    counters: folded.counters || {},
  };
}

function shouldInject(sessionId, key, { cooldownMs } = {}) {
  if (!sessionId || !key) return true;
  const state = getState(sessionId);
  const last = state.injected[key];
  if (typeof last !== 'number') return true;
  const window = typeof cooldownMs === 'number' ? cooldownMs : _cooldownFor(key);
  return (Date.now() - last) >= window;
}

function markInjected(sessionId, key) {
  if (!sessionId || !key) return;
  _appendLine(sessionId, { ts: new Date().toISOString(), op: 'inject', key, value: Date.now() });
}

function bump(sessionId, field) {
  if (!sessionId || !field) return;
  _appendLine(sessionId, { ts: new Date().toISOString(), op: 'bump', field, delta: 1 });
}

function setPhase(sessionId, phase) {
  if (!sessionId || !phase) return;
  const valid = ['plan','build','debug','ship','review','recall','unknown'];
  if (!valid.includes(phase)) return;
  _appendLine(sessionId, { ts: new Date().toISOString(), op: 'phase', value: phase });
}

function resetSession(sessionId) {
  if (!sessionId) return;
  const f = _fileFor(sessionId);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  _foldCache.delete(sessionId);
}

function reapStale({ days = 7, compactRest = true } = {}) {
  const dir = _runtimeDir();
  let removed = 0;
  let compacted = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - days * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) {
        // Backwards-compat: clean up old .json snapshots from v3.6.0.
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
        continue;
      }
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
        else if (compactRest && st.size > 50_000) {
          _compact(f.slice(0, -'.jsonl'.length));
          compacted++;
        }
      } catch {}
    }
  } catch {}
  return removed;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {};
  for (let i = 3; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
      else a[k] = true;
    }
  }
  return a;
}

function main() {
  const cmd = process.argv[2];
  const a = parseArgs(process.argv);
  if (cmd === 'should-inject') { process.stdout.write(shouldInject(a.session, a.key) ? 'yes' : 'no'); return; }
  if (cmd === 'mark-injected') { markInjected(a.session, a.key); return; }
  if (cmd === 'bump')          { bump(a.session, a.field); return; }
  if (cmd === 'set-phase')     { setPhase(a.session, a.phase); return; }
  if (cmd === 'state')         { console.log(JSON.stringify(getState(a.session), null, 2)); return; }
  if (cmd === 'reset')         { resetSession(a.session); return; }
  if (cmd === 'compact')       { _compact(a.session); return; }
  if (cmd === 'reap')          { console.log(`reaped ${reapStale({ days: parseInt(a.days,10) || 7 })} stale session files`); return; }
  console.error('Usage: vanta-runtime-state {should-inject|mark-injected|bump|set-phase|state|reset|compact|reap} [args]');
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  getState, shouldInject, markInjected, bump, setPhase, resetSession, reapStale,
  COOLDOWNS,
  // Internal — exported for tests:
  _foldJournal, _compact, _fileFor, _clearFoldCache,
};
