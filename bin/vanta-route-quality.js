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

// The three "Vanta-internal" surfaces — slash-prefixed prompts that
// resolve to one of these are NOT manual recalls (the user is using
// the three-command surface). Anything else slash-prefixed (e.g.
// `/ship`, `/qa`, `/investigate`, `/review`, `/gsd-plan-phase`,
// `/brainstorm`) is a recall — the user remembered a non-/vanta route.
const VANTA_SURFACES = new Set([
  'vanta', 'vanta-sync', 'council',
  'vanta-status', 'vanta-undo', 'vanta-undo-list', 'vanta-trust',
]);

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
  if (cmd.startsWith('gsd-') || cmd === 'gsd') surface = 'gsd';
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
    let st2;
    try { st2 = fs.statSync(file); } catch { return; }
    if (!st2 || st2.ino !== st.ino || st2.size <= MAX_BYTES) return;
    fs.renameSync(file, target);
  } catch (_) { /* never let rotation fail a write */ }
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
    appendJsonlLine(file, {
      ts: entry.ts || new Date().toISOString(),
      decision_id: entry.decision_id || null,
      prompt: (entry.prompt || '').slice(0, 200),
      detected_intent: entry.detected_intent || null,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : _coerceConfidence(entry.confidence),
      top1_top2_margin: typeof entry.top1_top2_margin === 'number' ? entry.top1_top2_margin : 1.0,
      n_candidates: typeof entry.n_candidates === 'number' ? entry.n_candidates : 0,
      suggested_route: entry.suggested_route || null,
      tier: entry.tier || null,
      decision: entry.decision || null,
      source: entry.source || null,
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
// session_id; we extract the surface/command via detectRecall().
function recordRecall(entry) {
  try {
    const r = detectRecall(entry.prompt);
    if (!r) return false;
    fs.mkdirSync(_vantaDir(), { recursive: true });
    const file = _recallFile();
    _maybeRotate(file);
    appendJsonlLine(file, {
      ts: entry.ts || new Date().toISOString(),
      prompt: (entry.prompt || '').slice(0, 200),
      surface: r.surface,
      command: r.command,
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
  _coerceConfidence,
  _routeFile,
  _recallFile,
};
