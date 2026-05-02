#!/usr/bin/env node
// vanta-route-quality — append-only telemetry for v3.8.2 hidden
// observability. Two streams, same writer:
//
//   ~/.vanta/route-quality.jsonl   one record per executor decide() call
//                                   that had a non-empty user prompt.
//   ~/.vanta/manual-recalls.jsonl  one record per prompt that started
//                                   with a non-/vanta slash command —
//                                   the user bypassed Vanta routing.
//
// Both are inputs to tools/vanta-soak-report.js. Both are hidden from
// the user — no surface, no dashboard, just builder-readable JSONL.
//
// Why split files? Cardinality differs by an order of magnitude.
// route-quality fires on every prompt that hits the executor; recalls
// fire only on slash-prefixed prompts. Separate files keep the soak
// report queries simple (no filter pushdown) and let recall analysis
// survive route-quality rotation independently.
//
// Surface Impact Discipline (CLAUDE.md): this is INTERNAL MACHINERY.
// Adds no commands. Adds two write paths under ~/.vanta/. Anything the
// builder reads via `tools/vanta-soak-report.js` is debug, not UX.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { appendJsonlLine } = require('./vanta-jsonl');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _routeFile() { return path.join(_vantaDir(), 'route-quality.jsonl'); }
function _recallFile() { return path.join(_vantaDir(), 'manual-recalls.jsonl'); }

const MAX_BYTES = 5_000_000;

// The Vanta promised surface — slash-prefixed prompts that resolve to
// one of these are NOT manual recalls (the user is using the
// three-command surface). Anything else slash-prefixed (e.g.
// `/ship`, `/qa`, `/investigate`, `/review`, `/gsd-plan-phase`,
// `/brainstorm`) is a recall — the user remembered a non-/vanta route.
//
// R1 council fix (Codex P3): the prior allowlist exempted internal
// debug commands (`/vanta-status`, `/vanta-undo`, `/vanta-trust`) —
// those bypass routing too. CLAUDE.md "Surface Impact Discipline"
// says the promise is exactly three commands; counting anything else
// as Vanta-internal hides surface drift. Now: only the three
// promised commands are exempt; anything else slash-prefixed is a
// recall (and the surface gets classified as `vanta-internal` for
// `/vanta-*` debug commands so the soak report can separate them).
const VANTA_SURFACES = new Set(['vanta', 'vanta-sync', 'council']);

// Detect a manual recall from the prompt. Returns null if the prompt is
// not slash-prefixed or the slash-command is one of Vanta's three.
// Returns `{ surface, command }` otherwise. `surface` classifies which
// non-Vanta tool the user invoked — gstack / GSD / superpowers / other.
function detectRecall(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const m = prompt.trim().match(/^\/([\w-]+)/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  if (VANTA_SURFACES.has(cmd)) return null;
  let surface = 'other';
  if (cmd.startsWith('vanta-')) surface = 'vanta-internal';   // /vanta-status, /vanta-undo, /vanta-trust — debug, bypass intended router
  else if (cmd.startsWith('gsd-') || cmd === 'gsd') surface = 'gsd';
  else if (cmd === 'brainstorm' || cmd === 'write-plan' || cmd === 'execute-plan') surface = 'superpowers';
  else if (
    ['ship', 'qa', 'qa-only', 'review', 'investigate', 'office-hours',
     'health', 'cso', 'codex', 'autoplan', 'land-and-deploy', 'canary',
     'benchmark', 'browse', 'connect-chrome', 'design-consultation',
     'design-shotgun', 'design-html', 'design-review', 'plan-ceo-review',
     'plan-eng-review', 'plan-design-review', 'careful', 'freeze',
     'guard', 'unfreeze', 'gstack-upgrade', 'learn', 'checkpoint',
     'retro', 'document-release', 'setup-browser-cookies',
     'setup-deploy'].includes(cmd)
  ) surface = 'gstack';
  return { surface, command: cmd };
}

// Rotate file via rename when above MAX_BYTES. Mirrors auto-sync /
// action-log rotation semantics so consumers can reuse readMergedJsonl
// across .bak.<ts> siblings if needed.
//
// R1 council fix (Gemini P3): retain only the most recent BAK_RETAIN
// rotated siblings. action-log.js doesn't prune either; this is a
// Vanta-wide bug, but v3.8.2 only fixes its own two files (route-
// quality + manual-recalls) — touching action-log expands scope
// outside this release.
const BAK_RETAIN = 5;

function _maybeRotate(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const ts = Date.now() + '.' + process.pid;
    const target = `${file}.bak.${ts}`;
    // Re-stat to dodge the dual-rotate race (action-log uses the same
    // pattern). If a peer already rotated, the inode no longer matches
    // and we skip.
    //
    // The outer try/catch absorbs ENOENT here — if Process B rotates
    // milliseconds after Process A reads st.size, B's renameSync
    // throws ENOENT, which is the correct behavior (the file is
    // already rotated). The R1 council Gemini P4 finding asked for a
    // test for this; see tests/v3-8-2-observability.test.js.
    let st2;
    try { st2 = fs.statSync(file); } catch { return; }
    if (!st2 || st2.ino !== st.ino || st2.size <= MAX_BYTES) return;
    fs.renameSync(file, target);
    _pruneBaks(file);
  } catch (_) { /* never let rotation fail a write */ }
}

// Keep only the most recent BAK_RETAIN .bak.<ts> siblings of `file`.
// Older ones are unlinked. Best-effort — failure to prune never
// blocks a write.
function _pruneBaks(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const baks = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.bak.'))
      .map(f => ({ name: f, full: path.join(dir, f), mtime: _safeMtime(path.join(dir, f)) }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of baks.slice(BAK_RETAIN)) {
      try { fs.unlinkSync(old.full); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}
function _safeMtime(fp) {
  try { return fs.statSync(fp).mtimeMs; } catch { return 0; }
}

// R1 council fix (Codex P2): pasted secrets land in the prompt verbatim
// and end up in ~/.vanta/route-quality.jsonl unless we redact at the
// write boundary. This is best-effort, regex-driven redaction — it
// catches the obvious shapes (sk-/pk- API keys, GitHub tokens, AWS
// keys, JWTs, bearer headers, .env-style assignments). It is NOT a
// security guarantee — it's a pragmatic gate to stop the most common
// "I just pasted my prod key into Claude Code" failure mode from
// auto-archiving the secret in a JSONL the user reads weekly.
//
// Returns { text, redacted } so the entry can flag whether redaction
// fired (the soak report can decide whether to re-show the prompt).
const _SECRET_PATTERNS = [
  // API keys / tokens
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bpk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxoxb-[A-Za-z0-9_-]{20,}\b/g,            // Slack bot
  /\bxoxp-[A-Za-z0-9_-]{20,}\b/g,            // Slack user
  /\bghp_[A-Za-z0-9]{30,}\b/g,               // GitHub personal token
  /\bghs_[A-Za-z0-9]{30,}\b/g,               // GitHub server token
  /\bghu_[A-Za-z0-9]{30,}\b/g,               // GitHub user token
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,       // GitHub fine-grained PAT (R2 Codex P2)
  /\bAKIA[0-9A-Z]{16}\b/g,                   // AWS access key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  // env-style secrets
  /\b(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*['"]?[^\s'"]{8,}['"]?/gi,
  /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
];

function _redactSecrets(s) {
  if (!s || typeof s !== 'string') return { text: '', redacted: false };
  let out = s;
  let redacted = false;
  for (const rx of _SECRET_PATTERNS) {
    if (rx.test(out)) {
      redacted = true;
      out = out.replace(rx, '[REDACTED]');
    }
  }
  return { text: out, redacted };
}

// Record a route-quality entry. Caller passes the decision shape from
// vanta-executor's `decide()`; this writer pulls only the v3.8.2 fields
// it cares about. Fields backfilled by other systems (`later_undo`,
// `later_manual_correction`) start null — vanta-undo and the soak
// report can correlate by `decision_id` later.
function recordRoute(entry) {
  try {
    fs.mkdirSync(_vantaDir(), { recursive: true });
    const file = _routeFile();
    _maybeRotate(file);
    const r = _redactSecrets(entry.prompt);
    appendJsonlLine(file, {
      ts: entry.ts || new Date().toISOString(),
      decision_id: entry.decision_id || null,
      prompt: r.text.slice(0, 200),
      prompt_redacted: r.redacted,
      detected_intent: entry.detected_intent || null,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : _coerceConfidence(entry.confidence),
      top1_top2_margin: typeof entry.top1_top2_margin === 'number' ? entry.top1_top2_margin : 1.0,
      n_candidates: typeof entry.n_candidates === 'number' ? entry.n_candidates : 0,
      suggested_route: entry.suggested_route || null,
      tier: entry.tier || null,
      decision: entry.decision || null,
      source: entry.source || null,
      rewriter_error: entry.rewriter_error || null,
      user_followed_route: entry.user_followed_route ?? null,
      user_used_different_command: entry.user_used_different_command ?? null,
      later_undo: entry.later_undo ?? null,
      later_manual_correction: entry.later_manual_correction ?? null,
      session_ended_state: entry.session_ended_state || null,
      project: entry.project || null,
      session_id: entry.session_id || null,
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Record a manual-recall entry. Caller passes the prompt + project +
// session_id + decision_id; we extract the surface/command via
// detectRecall().
//
// R1 council fix (Codex P2 / Gemini P1, both-confirmed): the recall
// entry now persists `decision_id`, the same id the executor stamped
// on the route-quality entry for the same prompt. Without it, repeated
// `/ship` prompts in a session can't be joined back to the route
// decision the user bypassed, and v3.9.1's
// `user_used_different_command` backfill becomes guesswork.
function recordRecall(entry) {
  try {
    const r = _redactSecrets(entry.prompt);
    const detected = detectRecall(r.text);
    if (!detected) return false;
    fs.mkdirSync(_vantaDir(), { recursive: true });
    const file = _recallFile();
    _maybeRotate(file);
    appendJsonlLine(file, {
      ts: entry.ts || new Date().toISOString(),
      decision_id: entry.decision_id || null,
      prompt: r.text.slice(0, 200),
      prompt_redacted: r.redacted,
      surface: detected.surface,
      command: detected.command,
      project: entry.project || null,
      session_id: entry.session_id || null,
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Map rewriter's string confidence ('high' | 'medium' | 'low') to
// numeric. v3.8.2 keeps both — string for back-compat, numeric for
// the soak report's threshold queries.
function _coerceConfidence(c) {
  if (c === 'high') return 0.9;
  if (c === 'medium') return 0.7;
  if (c === 'low') return 0.4;
  return 0.5;
}

module.exports = {
  recordRoute,
  recordRecall,
  detectRecall,
  // v3.9.0 council R1 P2 fix (both-confirmed): exported so the
  // VantaAction layer can reuse the same redactor on
  // PromptRewriteInverse.original_prompt. Without the shared
  // redactor, v3.9.0 would regress the v3.8.2 secret-redaction
  // contract (raw prompts persisted in actions.jsonl).
  redactSecrets: _redactSecrets,
  _coerceConfidence,
  _routeFile,
  _recallFile,
};
