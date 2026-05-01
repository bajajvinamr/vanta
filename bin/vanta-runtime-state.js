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
    // R9 P1 — torn-line guard. See bin/vanta-jsonl.js comment.
    fs.appendFileSync(_fileFor(sessionId), '\n' + JSON.stringify(obj) + '\n');
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
    let preMtimeMs = 0;
    if (!force) {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < QUIESCE_MS) return;  // live — skip.
      preMtimeMs = st.mtimeMs;
    } else {
      try { preMtimeMs = fs.statSync(file).mtimeMs; } catch {}
    }
    const state = _foldJournal(sessionId);
    // R9 P1 — Gemini council finding. Earlier impl explicitly enumerated
    // fields, so any new field added to the folded state by future ops
    // (e.g., `last_seen`, telemetry fields) was silently destroyed on
    // compaction. Use spread so unknown fields survive the round-trip.
    // Strip `session_id` because the snapshot is keyed by session_id at
    // _fileFor() level — embedding it would be redundant noise.
    const { session_id: _drop, ...rest } = state;
    void _drop;
    const snapshotLine = '\n' + JSON.stringify({
      ts: new Date().toISOString(),
      op: 'snapshot',
      state: rest,
    }) + '\n';
    const tmp = file + '.compact';
    fs.writeFileSync(tmp, snapshotLine);
    // R8 P3 — Gemini council finding. A dormant session can wake up
    // (user returns from coffee, sends a prompt) AFTER we read mtime
    // for the QUIESCE check but BEFORE we rename. The rename then
    // clobbers the new appendLine. Re-check mtime right before rename;
    // if it changed, abort and leave the journal alone — fold-cache
    // will pick up the new line on next read.
    try {
      const stNow = fs.statSync(file);
      if (preMtimeMs && stNow.mtimeMs !== preMtimeMs) {
        try { fs.unlinkSync(tmp); } catch {}
        return;  // session woke up mid-compact; skip this round.
      }
    } catch { /* file may have been removed; let rename throw if so */ }
    fs.renameSync(tmp, file);
  } catch { /* never block */ }
}

// ─── cooldown table ────────────────────────────────────────────────────────
//
// Codex+Gemini council R6 P3 fix — pruned dead entries. Earlier the table
// listed cooldowns for council-advisory + tool-observer but neither hook
// called shouldInject/markInjected. The aspirational entries were
// misleading: a reader of this code would think those hooks dedup, but
// they fire every event. Now: only the hooks that actually call
// shouldInject are listed.
const COOLDOWNS = {
  'prompt-context:':       10 * 60_000,
  'stack-file-nudge:':     60 * 60_000,
  'contradiction-shown:':  10 * 60_000,  // R6 P3 dedup between council-advisory + prompt-context
  'default':                5 * 60_000,
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
  // R8 P3 — Codex council finding. If the wall clock rolls back (DST,
  // manual correction, machine asleep then woken to a stale RTC), `now -
  // last` goes negative and the cooldown stays active for hours. Treat
  // negative deltas as "expired" — re-inject is safer than suppressing
  // the always-on layer until real time catches up.
  const delta = Date.now() - last;
  if (delta < 0) return true;
  return delta >= window;
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
    // R8 P2 — sweep stale tmp/.compact leaks (Gemini council). When a hook
    // is SIGKILL'd between writeFileSync(tmp) and renameSync(tmp, file),
    // tmp/compact files leak forever. Reap any older than 1 hour.
    const tmpCutoff = Date.now() - 60 * 60_000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) {
        // Backwards-compat: clean up old .json snapshots from v3.6.0.
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
        // R8 P2: stale tmp from interrupted compaction.
        if (f.endsWith('.compact') || /\.tmp(\.|$)/.test(f)) {
          try {
            const st = fs.statSync(path.join(dir, f));
            if (st.mtimeMs < tmpCutoff) {
              fs.unlinkSync(path.join(dir, f));
              removed++;
            }
          } catch {}
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

// R8 P2 — sweep tmp/compact files outside the runtime dir too. Used by the
// Stop hook to clean .vanta/* and ~/.vanta/knowledge/*.tmp.* leaks from
// indexer SIGKILL events. Returns count of files removed.
function reapStaleTmp(dirs, ageHours = 1) {
  const cutoff = Date.now() - ageHours * 60 * 60_000;
  let removed = 0;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.tmp(\.|$)|\.compact$/.test(f)) continue;
        try {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
        } catch {}
      }
    } catch {}
  }
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
  getState, shouldInject, markInjected, bump, setPhase, resetSession, reapStale, reapStaleTmp,
  COOLDOWNS,
  // Internal — exported for tests:
  _foldJournal, _compact, _fileFor, _clearFoldCache,
};
