#!/usr/bin/env node
// vanta-interaction-log — append + audit tool-call telemetry.
//
// Codex council P1 fix (always-on layer): without a generic tool-call
// observer, "Vanta is active under every command" is a slogan, not a
// measurable property. This module appends shape-only events (tool name,
// arg keys, success bit) to ~/.vanta/interactions.jsonl and audits the
// file for activity patterns.
//
// Privacy: SHAPE only. Args are reduced to top-level keys + lengths +
// regex-classified file extensions. Never full file contents, never full
// command strings. Bash command lines are first-token-only.
//
// Schema (one event per line):
//   { ts, session_id, phase, event: 'pre'|'post', tool, key_shape,
//     ext, ok, slug }
//
// Audit modes:
//   audit       — count by tool, by phase, recent activity
//   audit --tool-by-phase — phase × tool matrix
//   audit --json
//
// Bound: best-effort 5MB rotation. JSONL append only — never edit history.

const fs = require('fs');
const path = require('path');
const os = require('os');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
const MAX_BYTES = 5_000_000;

function _logFile() { return path.join(_vantaDir(), 'interactions.jsonl'); }

function _ensureDir() {
  const d = _vantaDir();
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {}
}

function _rotate(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    // Keep the most-recent half.
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(file, kept.join('\n') + '\n');
  } catch {}
}

// ─── shape extraction (privacy-respecting) ─────────────────────────────────

const FILE_EXT_RE = /\.([a-z][a-z0-9]{0,5})\b/i;

// Codex R2 P2 privacy fix: bash_verb must NEVER carry filesystem paths.
// Previous impl (`/^[\w./-]+/`) captured `/Users/vinamr/Projects/...` whole,
// leaking absolute paths into ~/.vanta/interactions.jsonl. New rule:
//   1. Take the first token of the trimmed command.
//   2. If it contains `/`, reduce to basename — paths never survive.
//   3. If the basename is on the allowlist, emit it verbatim.
//   4. Otherwise emit 'other' — we record that *some* command ran, not which.
// Result: every entry in the log is one of ~30 known verbs OR the literal
// string 'other'. No path component, no project name, no script name from
// outside the allowlist ever lands on disk.
const BASH_VERB_ALLOWLIST = new Set([
  'git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'pip', 'pip3', 'uv', 'pipx',
  'cargo', 'rustc', 'go', 'java', 'mvn', 'gradle',
  'ls', 'cd', 'pwd', 'mkdir', 'cp', 'mv', 'rm', 'cat',
  'echo', 'find', 'grep', 'rg', 'fd', 'awk', 'sed',
  'curl', 'wget', 'ssh', 'scp', 'rsync',
  'docker', 'kubectl', 'gcloud', 'aws', 'gh', 'glab',
  'make', 'cmake', 'bash', 'sh', 'zsh', 'env', 'export',
  'chmod', 'chown', 'tar', 'zip', 'unzip', 'open',
  'jq', 'yq', 'tr', 'sort', 'uniq', 'wc', 'head', 'tail',
  'true', 'false', 'test', 'sleep', 'kill', 'ps',
]);

function _normalizeBashVerb(command) {
  if (typeof command !== 'string') return null;
  // First token = up to first whitespace. We deliberately do NOT match
  // shell metacharacters; "cd /Users/.. && git status" splits at the first
  // space, leaving us with "cd" — exactly what we want.
  const firstToken = command.trim().split(/\s+/, 1)[0];
  if (!firstToken) return null;
  // Strip path components — `/Users/x/script.sh` → `script.sh`.
  const base = firstToken.includes('/')
    ? firstToken.slice(firstToken.lastIndexOf('/') + 1)
    : firstToken;
  // Tail: 'git', 'node', 'rg' → keep. '.sh' or 'unknown-bin' → 'other'.
  if (BASH_VERB_ALLOWLIST.has(base)) return base;
  return 'other';
}

function shapeOfArgs(tool, input) {
  if (!input || typeof input !== 'object') return { keys: [], ext: null };
  const keys = Object.keys(input).slice(0, 10);
  let ext = null;
  // For path-bearing tools, extract the file extension only.
  for (const k of ['file_path', 'path', 'notebook_path']) {
    if (input[k] && typeof input[k] === 'string') {
      const m = input[k].match(FILE_EXT_RE);
      if (m) ext = m[1].toLowerCase();
      break;
    }
  }
  let bashVerb = null;
  if (tool === 'Bash') bashVerb = _normalizeBashVerb(input.command);
  return { keys, ext, bashVerb };
}

// ─── public API ────────────────────────────────────────────────────────────

function logEvent(entry) {
  const e = {
    ts: new Date().toISOString(),
    session_id: entry.session_id || 'unknown',
    phase: entry.phase || 'unknown',
    event: entry.event,                 // 'pre' | 'post'
    tool: entry.tool,                   // 'Bash' | 'Write' | etc
    key_shape: entry.key_shape || [],
    ext: entry.ext || null,
    bash_verb: entry.bash_verb || null,
    ok: typeof entry.ok === 'boolean' ? entry.ok : null,
    slug: entry.slug || null,
  };
  _ensureDir();
  const file = _logFile();
  try {
    _rotate(file);
    fs.appendFileSync(file, JSON.stringify(e) + '\n');
  } catch { /* never block hook on log failure */ }
  return e;
}

function _readAll() {
  const f = _logFile();
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function audit({ days = 7, sessionId } = {}) {
  const cutoff = Date.now() - days * 86400_000;
  let entries = _readAll().filter(e => Date.parse(e.ts) >= cutoff);
  if (sessionId) entries = entries.filter(e => e.session_id === sessionId);
  if (entries.length === 0) return { window_days: days, total: 0 };

  const byTool = new Map();
  const byPhase = new Map();
  const byPhaseTool = new Map();
  const sessions = new Set();
  let preCount = 0, postCount = 0, failCount = 0;
  let bashUniqueVerbs = new Set();

  for (const e of entries) {
    sessions.add(e.session_id);
    if (e.event === 'pre') preCount++;
    if (e.event === 'post') {
      postCount++;
      if (e.ok === false) failCount++;
    }
    byTool.set(e.tool, (byTool.get(e.tool) || 0) + 1);
    byPhase.set(e.phase, (byPhase.get(e.phase) || 0) + 1);
    const k = `${e.phase}|${e.tool}`;
    byPhaseTool.set(k, (byPhaseTool.get(k) || 0) + 1);
    if (e.bash_verb) bashUniqueVerbs.add(e.bash_verb);
  }

  return {
    window_days: days,
    total: entries.length,
    sessions: sessions.size,
    pre: preCount,
    post: postCount,
    failures: failCount,
    by_tool: Object.fromEntries([...byTool.entries()].sort((a, b) => b[1] - a[1])),
    by_phase: Object.fromEntries(byPhase),
    by_phase_tool: Object.fromEntries(byPhaseTool),
    bash_verbs: [...bashUniqueVerbs].sort().slice(0, 30),
  };
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

function cliAudit() {
  const a = parseArgs(process.argv);
  const days = parseInt(a.days, 10) || 7;
  const r = audit({ days, sessionId: a.session });
  if (a.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`=== interaction log (${r.window_days}d) ===`);
  if (r.total === 0) { console.log('  no events yet'); return; }
  console.log(`total: ${r.total} events · ${r.sessions} session(s) · pre=${r.pre} post=${r.post} fail=${r.failures}`);
  console.log('');
  console.log('by tool:');
  for (const [t, n] of Object.entries(r.by_tool)) console.log(`  ${t.padEnd(14)} ${n}`);
  console.log('');
  console.log('by phase:');
  for (const [p, n] of Object.entries(r.by_phase)) console.log(`  ${p.padEnd(10)} ${n}`);
  if (r.bash_verbs.length) {
    console.log('');
    console.log(`bash verbs (${r.bash_verbs.length} unique): ${r.bash_verbs.slice(0, 12).join(', ')}${r.bash_verbs.length > 12 ? '…' : ''}`);
  }
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'audit')      cliAudit();
  else if (cmd === 'log') {
    // Used by the tool-observer hook to write events. Reads JSON on stdin.
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => buf += c);
    process.stdin.on('end', () => {
      try { logEvent(JSON.parse(buf)); } catch {}
    });
  } else {
    console.error('Usage: vanta-interaction-log {audit|log} [args]');
    console.error('  audit [--days 7] [--session ID] [--json]');
    console.error('  log     (reads JSON on stdin)');
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { logEvent, audit, shapeOfArgs };
