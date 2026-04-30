#!/usr/bin/env node
// vanta-runtime-state — per-session dedupe + cooldown brain.
//
// Codex council P2 fix: the always-on hooks (prompt-context, tool-observer)
// each query the resolver and decide whether to inject context. Without a
// shared cooldown table they spam the same warning every Write|Edit, every
// Bash, every prompt. This module is the one place where "did we already
// say this in this session?" lives.
//
// Storage: ~/.vanta/runtime/<session_id>.json (one file per Claude session).
// Files self-rotate at session start (when the SessionStart hook calls
// reset). Stale files older than 7d get reaped by hard-coded cleanup —
// best-effort, never blocks.
//
// Schema (per session file):
//   {
//     session_id: <string>,
//     started_at: <ISO>,
//     last_seen:  <ISO>,
//     phase:      'plan'|'build'|'debug'|'ship'|'review'|'unknown',
//     injected:   { <key>: <unix-ms-of-last-inject> },
//     warnings:   [ { source, key, ts } ],
//     prompt_count: <int>,
//     tool_calls:   <int>,
//   }
//
// API used by hooks:
//   shouldInject(sessionId, key, opts)  → true if not on cooldown
//   markInjected(sessionId, key)        → records the inject ts
//   bump(sessionId, field)              → counter increment + last_seen tick
//   setPhase(sessionId, phase)          → records prompt-classifier output
//   getState(sessionId)                 → readonly snapshot
//   resetSession(sessionId)             → wipe at SessionStart
//
// All file I/O is best-effort: a failure NEVER blocks a hook. Hooks must
// degrade silently if state is unreadable.

const fs = require('fs');
const path = require('path');
const os = require('os');

function _runtimeDir() {
  return process.env.VANTA_DIR_OVERRIDE
    ? path.join(process.env.VANTA_DIR_OVERRIDE, 'runtime')
    : path.join(os.homedir(), '.vanta', 'runtime');
}

function _fileFor(sessionId) {
  // Sanitize session id — Claude session ids are uuid-shaped but be defensive
  // because the same value lands in a filesystem path.
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  return path.join(_runtimeDir(), `${safe}.json`);
}

function _ensureDir() {
  const d = _runtimeDir();
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {}
}

function _safeRead(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function _safeWrite(file, obj) {
  try {
    _ensureDir();
    // Atomic-ish: write tmp, rename. JSON is small so this is fine.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// Default cooldown windows per source — milliseconds. Hooks pass keys like
// `council-advisory:auth` or `prompt-context:debug` and the cooldown looks
// up by source prefix.
const COOLDOWNS = {
  'council-advisory:': 30 * 60_000,   // 30 min between repeating the same warning
  'prompt-context:':   10 * 60_000,   // 10 min between repeating the same brief
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
  const f = _fileFor(sessionId);
  const raw = _safeRead(f);
  if (raw && raw.session_id) return raw;
  // Initialize lazily — first read creates the file.
  return {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_seen:  new Date().toISOString(),
    phase: 'unknown',
    injected: {},
    warnings: [],
    prompt_count: 0,
    tool_calls: 0,
  };
}

function shouldInject(sessionId, key, { cooldownMs } = {}) {
  if (!sessionId || !key) return true;  // be permissive on bad input — hooks degrade open
  const state = getState(sessionId);
  const last = state.injected[key];
  if (typeof last !== 'number') return true;
  const window = typeof cooldownMs === 'number' ? cooldownMs : _cooldownFor(key);
  return (Date.now() - last) >= window;
}

function markInjected(sessionId, key) {
  if (!sessionId || !key) return;
  const state = getState(sessionId);
  state.injected[key] = Date.now();
  state.last_seen = new Date().toISOString();
  _safeWrite(_fileFor(sessionId), state);
}

function bump(sessionId, field) {
  if (!sessionId || !field) return;
  const state = getState(sessionId);
  state[field] = (state[field] || 0) + 1;
  state.last_seen = new Date().toISOString();
  _safeWrite(_fileFor(sessionId), state);
}

function setPhase(sessionId, phase) {
  if (!sessionId || !phase) return;
  const valid = ['plan','build','debug','ship','review','recall','unknown'];
  if (!valid.includes(phase)) return;
  const state = getState(sessionId);
  state.phase = phase;
  state.last_seen = new Date().toISOString();
  _safeWrite(_fileFor(sessionId), state);
}

function resetSession(sessionId) {
  if (!sessionId) return;
  const f = _fileFor(sessionId);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

// Best-effort cleanup of session files older than `days`. Called occasionally
// by hooks; never blocks. Keeps `~/.vanta/runtime/` from growing without
// bound across days of sessions.
function reapStale({ days = 7 } = {}) {
  const dir = _runtimeDir();
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - days * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
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
  if (cmd === 'should-inject') {
    process.stdout.write(shouldInject(a.session, a.key) ? 'yes' : 'no');
    return;
  }
  if (cmd === 'mark-injected')  { markInjected(a.session, a.key); return; }
  if (cmd === 'bump')           { bump(a.session, a.field); return; }
  if (cmd === 'set-phase')      { setPhase(a.session, a.phase); return; }
  if (cmd === 'state')          { console.log(JSON.stringify(getState(a.session), null, 2)); return; }
  if (cmd === 'reset')          { resetSession(a.session); return; }
  if (cmd === 'reap')           { console.log(`reaped ${reapStale({ days: parseInt(a.days,10) || 7 })} stale session files`); return; }
  console.error('Usage: vanta-runtime-state {should-inject|mark-injected|bump|set-phase|state|reset|reap} [args]');
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  getState, shouldInject, markInjected, bump, setPhase, resetSession, reapStale,
  COOLDOWNS,
};
