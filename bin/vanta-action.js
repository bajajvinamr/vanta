#!/usr/bin/env node
// vanta-action — central definition for the v3.9.0 reversibility model.
//
// This is the single source of truth for the VantaAction schema. Every
// reversal-aware Vanta surface (stop intent, undo intent, re-route,
// crash recovery) reads and writes through this module so the schema
// stays consistent.
//
// Storage: extends the existing ~/.vanta/actions.jsonl ledger
// (vanta-action-log.js) with optional v3.9.0 fields. Old entries
// without these fields are interpreted as
// `{ lifecycle: 'applied', reversible: false, inverse: null }` —
// safe default that no existing call site relied on, so the migration
// is implicit. New writes carry the full schema.
//
// Surface Impact Discipline (CLAUDE.md): INTERNAL MACHINERY. Adds no
// commands, no skills. Adds one new module + extends an existing
// JSONL with optional fields. The user only sees behavior changes
// once v3.9.0 stop/undo/re-route handlers consume this.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─── Type definitions (JSDoc; no TypeScript runtime) ─────────────────
//
// LifecycleState: pending | applied | rolled_back | rollback_failed
//
// ConfidenceState: done | likely-done | blocked | risky
//
// ActionInverse (discriminated union, kind-tagged):
//   FileEditInverse        — { kind, target_path, before_sha, after_sha, patch }
//   MemoryPromotionInverse — { kind, target_file, inserted_text, insertion_anchor, staging_path? }
//   CommandInverse         — { kind, process_id?, cleanup_commands?, side_effects_known }
//   PromptRewriteInverse   — { kind, original_prompt }
//   CouncilCallInverse     — { kind, request_id, cancelled_locally, remote_status, estimated_cost_usd?, actual_cost_usd? }
//
// VantaAction (the persisted record):
//   { id, kind, lifecycle, reversible, inverse?, affected_files?,
//     detected_intent?, current_route?, confidence_state?,
//     verification_evidence?, project, session, ts, why? }

// Council R2 P1 fix (Codex): a two-phase claim → finalize lifecycle is
// the only way to actually PREVENT (not just detect) double rollback.
// `rolling_back` is the transient claim state. The intent handlers
// CAS into rolling_back BEFORE running side effects (process.kill,
// file rewrite, cancellation record); a peer racing in observes
// rolling_back and bails out. Finalization then CASes from
// rolling_back → rolled_back (or rollback_failed). The prior single-
// CAS-after-effects could detect the race only after side effects had
// already run twice.
const LIFECYCLE_STATES = Object.freeze(['pending', 'applied', 'rolling_back', 'rolled_back', 'rollback_failed']);
const CONFIDENCE_STATES = Object.freeze(['done', 'likely-done', 'blocked', 'risky']);
// Council R1 P2 fix (Codex): include the kinds vanta-undo.js already
// handles (`file-delete`, `git-commit`, `autonomy-promote`). Without
// this, any future v3.9.x consumer that creates a VantaAction for one
// of these kinds is rejected by validateAction. The existing undo
// handler in bin/vanta-undo.js stays the source of truth for those
// reversal mechanisms; the new action module just declares them as
// valid kinds so the schema covers the full reversible surface.
const ACTION_KINDS = Object.freeze([
  'prompt_rewrite', 'route_decision', 'file_edit',
  'command', 'memory_promotion', 'council_call',
  'file_delete', 'git_commit', 'autonomy_promote',
]);
const INVERSE_KINDS = Object.freeze([
  'file_edit', 'memory_promotion', 'command',
  'prompt_rewrite', 'council_call',
  'file_delete', 'git_commit', 'autonomy_promote',
]);

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _actionsFile() { return path.join(_vantaDir(), 'actions.jsonl'); }

let _jsonl;
function jsonl() {
  if (_jsonl) return _jsonl;
  for (const p of [
    path.join(__dirname, 'vanta-jsonl.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-jsonl.js'),
  ]) {
    try { _jsonl = require(p); return _jsonl; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-jsonl.js not resolvable');
}

// Council R1 P2 fix (both-confirmed): reuse v3.8.2 redactor on
// PromptRewriteInverse.original_prompt. Without sharing this, the
// v3.9.0 ledger would silently regress v3.8.2's secret-redaction
// contract — a user pastes an API key into a prompt that triggers
// a rewrite, the key persists verbatim in actions.jsonl, and the
// soak report later surfaces it. Lazy-loaded so the action module
// degrades gracefully if route-quality is unavailable.
let _redactor;
function redactSecrets(s) {
  if (!_redactor) {
    for (const p of [
      path.join(__dirname, 'vanta-route-quality.js'),
      path.join(os.homedir(), '.claude', 'bin', 'vanta-route-quality.js'),
    ]) {
      try {
        const m = require(p);
        if (typeof m.redactSecrets === 'function') {
          _redactor = m.redactSecrets;
          break;
        }
      } catch (_) { /* try next */ }
    }
    if (!_redactor) {
      // Degraded: pass-through. Better than crash; logged as warning
      // via stderr so the operator notices.
      try {
        process.stderr.write('[vanta-action] WARN: redactor unavailable; original_prompt persisted unredacted\n');
      } catch (_) { /* never let logging break */ }
      _redactor = (text) => ({ text: String(text || ''), redacted: false });
    }
  }
  return _redactor(s);
}

// Generate a fresh action id. 12 hex chars = 2.8e14 collision space —
// matches vanta-action-log.js. Prefix `va-` so VantaAction ids are
// distinguishable from action-log's `act-` ids.
function newActionId() {
  return 'va-' + crypto.randomBytes(6).toString('hex');
}

// Schema validation. Throws on hard contract violations (unknown kind,
// invalid lifecycle, inverse-kind mismatch); returns the validated
// action otherwise. Pure — no I/O.
function validateAction(a) {
  if (!a || typeof a !== 'object') {
    throw new Error('action: must be object');
  }
  if (!ACTION_KINDS.includes(a.kind)) {
    throw new Error(`action.kind: invalid (got "${a.kind}", want one of ${ACTION_KINDS.join('|')})`);
  }
  if (!LIFECYCLE_STATES.includes(a.lifecycle)) {
    throw new Error(`action.lifecycle: invalid (got "${a.lifecycle}", want one of ${LIFECYCLE_STATES.join('|')})`);
  }
  if (typeof a.reversible !== 'boolean') {
    throw new Error('action.reversible: must be boolean');
  }
  if (a.confidence_state != null && !CONFIDENCE_STATES.includes(a.confidence_state)) {
    throw new Error(`action.confidence_state: invalid (got "${a.confidence_state}")`);
  }
  if (a.inverse) {
    if (!INVERSE_KINDS.includes(a.inverse.kind)) {
      throw new Error(`action.inverse.kind: invalid (got "${a.inverse.kind}")`);
    }
    _validateInverseShape(a.inverse);
  }
  if (!a.id || typeof a.id !== 'string') throw new Error('action.id: required string');
  if (!a.ts || typeof a.ts !== 'string') throw new Error('action.ts: required ISO-8601');
  // v3.10 council C-1 (both-confirmed P1): decision_id lineage from the
  // upstream rule fire (route-quality.jsonl entry) to this VantaAction.
  // Optional: legacy entries created before the schema migration read as
  // null, and downstream rule-effectiveness scoring marks those events
  // `unscorable` rather than misattributing them. New v3.10+ writers
  // SHOULD pass decision_id; absence is tolerated for forward-compat
  // but not for new lineage-aware code paths.
  if (a.decision_id != null && typeof a.decision_id !== 'string') {
    throw new Error('action.decision_id: must be string|null');
  }
  return a;
}

// Per-kind inverse shape check. Forces every reversible action to
// carry the exact information needed to safely roll back — the
// council R1 finding that rejected the prior `inverse: object` shape.
function _validateInverseShape(inv) {
  switch (inv.kind) {
    case 'file_edit':
      if (typeof inv.target_path !== 'string') throw new Error('FileEditInverse.target_path required');
      if (typeof inv.before_sha !== 'string')  throw new Error('FileEditInverse.before_sha required');
      if (typeof inv.after_sha !== 'string')   throw new Error('FileEditInverse.after_sha required');
      if (typeof inv.patch !== 'string')       throw new Error('FileEditInverse.patch required');
      break;
    case 'memory_promotion':
      if (typeof inv.target_file !== 'string')      throw new Error('MemoryPromotionInverse.target_file required');
      if (typeof inv.inserted_text !== 'string')    throw new Error('MemoryPromotionInverse.inserted_text required');
      if (typeof inv.insertion_anchor !== 'string') throw new Error('MemoryPromotionInverse.insertion_anchor required');
      break;
    case 'command':
      if (typeof inv.side_effects_known !== 'boolean') throw new Error('CommandInverse.side_effects_known required');
      // process_id and cleanup_commands are both optional — but if
      // side_effects_known is true, at least one of them must be set
      // to give the undo handler something to do.
      if (inv.side_effects_known && inv.process_id == null && (!Array.isArray(inv.cleanup_commands) || inv.cleanup_commands.length === 0)) {
        throw new Error('CommandInverse: side_effects_known=true requires process_id OR non-empty cleanup_commands');
      }
      break;
    case 'prompt_rewrite':
      if (typeof inv.original_prompt !== 'string') throw new Error('PromptRewriteInverse.original_prompt required');
      break;
    case 'council_call':
      if (typeof inv.request_id !== 'string')        throw new Error('CouncilCallInverse.request_id required');
      if (typeof inv.cancelled_locally !== 'boolean') throw new Error('CouncilCallInverse.cancelled_locally required');
      if (typeof inv.remote_status !== 'string' || !['unknown', 'completed', 'aborted'].includes(inv.remote_status)) {
        throw new Error('CouncilCallInverse.remote_status: invalid');
      }
      break;
    // Council R1 P2 fix (Codex): bring the existing vanta-undo.js
    // reversal mechanisms into the schema. The actual rollback logic
    // continues to live in vanta-undo.js — these validators just
    // accept the shape so v3.9.x callers can persist these kinds.
    case 'file_delete':
      // payload: { path, content_b64 } — path required so the undoer
      // knows where to restore; content_b64 may be empty if the file
      // was deleted before its content was preserved (rollback_failed
      // flow).
      if (typeof inv.path !== 'string') throw new Error('FileDeleteInverse.path required');
      break;
    case 'git_commit':
      // payload: { sha } — the commit to revert.
      if (typeof inv.sha !== 'string' || inv.sha.length < 4) throw new Error('GitCommitInverse.sha required');
      break;
    case 'autonomy_promote':
      // payload: { repo, prior_level, new_level } — restore prior_level on undo.
      if (typeof inv.repo !== 'string') throw new Error('AutonomyPromoteInverse.repo required');
      if (typeof inv.prior_level === 'undefined') throw new Error('AutonomyPromoteInverse.prior_level required');
      if (typeof inv.new_level === 'undefined') throw new Error('AutonomyPromoteInverse.new_level required');
      break;
  }
}

// Construct a fresh VantaAction. Sets id + ts + defaults. Caller
// passes the kind and inverse (and optionally other fields). The
// returned action is in `pending` lifecycle by default.
function createAction({
  kind,
  inverse,
  reversible,
  affected_files,
  detected_intent,
  current_route,
  confidence_state,
  verification_evidence,
  project,
  session,
  why,
  decision_id,   // v3.10 council C-1: upstream rule-fire lineage
}) {
  // Council R1 P2 fix (both-confirmed): redact secrets in
  // PromptRewriteInverse.original_prompt before persisting. Mutate a
  // copy of the inverse so the caller's reference is untouched.
  let safeInverse = inverse || null;
  if (safeInverse && safeInverse.kind === 'prompt_rewrite' && typeof safeInverse.original_prompt === 'string') {
    const r = redactSecrets(safeInverse.original_prompt);
    safeInverse = { ...safeInverse, original_prompt: r.text, original_prompt_redacted: r.redacted };
  }
  const a = {
    id: newActionId(),
    kind,
    lifecycle: 'pending',
    reversible: reversible == null ? !!safeInverse : !!reversible,
    inverse: safeInverse,
    affected_files: Array.isArray(affected_files) ? affected_files.slice() : null,
    detected_intent: detected_intent || null,
    current_route: current_route || null,
    confidence_state: confidence_state || null,
    verification_evidence: Array.isArray(verification_evidence) ? verification_evidence.slice() : null,
    project: project || null,
    session: session || null,
    ts: new Date().toISOString(),
    why: why || null,
    decision_id: decision_id || null,
  };
  return validateAction(a);
}

// Persist an action (or an updated lifecycle for an existing action).
// Append-only — every state change writes a new line; the latest line
// for a given id wins. Reader logic dedupes on read by id.
//
// Why append-only? mtime-style mutation on a single file is fragile
// across crashes; the existing action-log + sync-queue pattern uses
// append-on-state-change which is crash-safe. Storage cost is bounded
// by rotation (action-log already rotates at 5MB).
// v3.10 final-council R2 fix (Codex P2 + Gemini P2): actions.jsonl
// must rotate or it grows unbounded. Mirrors vanta-action-log.js
// rotation: rename to .bak.<ts> at 5MB, let appendFileSync recreate
// the live file. Reapers (auto-sync.js reapStaleBaks) keep last N.
const ACTIONS_MAX_BYTES = 5_000_000;
function _maybeRotateActions(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size <= ACTIONS_MAX_BYTES) return;
    const ts = Date.now() + '.' + process.pid;
    const target = `${file}.bak.${ts}`;
    let st2; try { st2 = fs.statSync(file); } catch { return; }
    if (!st2 || st2.ino !== st.ino || st2.size <= ACTIONS_MAX_BYTES) return;
    fs.renameSync(file, target);
  } catch (_) { /* never let rotation fail a write */ }
}

function persistAction(action) {
  const validated = validateAction(action);
  fs.mkdirSync(_vantaDir(), { recursive: true });
  _maybeRotateActions(_actionsFile());
  jsonl().appendJsonlLine(_actionsFile(), validated);
  return validated;
}

// Read all actions across the live file (and optionally .bak.<ts>
// siblings), dedupe by id (latest line wins), and apply optional
// filters.
//
// Note: readMergedJsonl returns the concatenated raw STRING, not
// parsed entries. We parse line-by-line with torn-line tolerance
// (matching the soak-report reader pattern).
//
// v3.10 council C-11 (Gemini, NEW R2): historical default loaded every
// .bak.<ts> sibling synchronously into one string — OOM risk on hot-
// path readers (rule-effectiveness scorer, intent handlers, crash-
// recovery scan). New default: live file only. Pass `allHistory: true`
// when you genuinely need the full ledger (soak-report, audit, debug).
function readActions({ project = null, lifecycle = null, kind = null, since = null, allHistory = false } = {}) {
  const file = _actionsFile();
  if (!fs.existsSync(file) && !_anyBakFor(file)) return [];
  const raw = jsonl().readMergedJsonl(file, { includeBaks: allHistory });
  const byId = new Map();
  // Dedup tiebreaker: when two entries for the same id have identical
  // ts (sub-millisecond writes via updateLifecycle), prefer the LATER
  // line. JSONL append-only puts later writes physically later, so
  // `>=` (not `>`) gives last-write-wins on ts ties.
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; /* torn — skip */ }
    if (!e || !e.id) continue;
    const prior = byId.get(e.id);
    if (!prior || (e.ts || '') >= (prior.ts || '')) byId.set(e.id, e);
  }
  let out = [...byId.values()];
  // Migrate the v3.8.x and pre-v3.8.x action-log shape: entries
  // without `kind` are not VantaAction entries (they're the old
  // record-by-action-verb shape). Skip them — they're owned by
  // vanta-action-log's reader, not this module.
  out = out.filter(e => ACTION_KINDS.includes(e.kind));
  if (project)   out = out.filter(e => e.project === project);
  if (lifecycle) out = out.filter(e => e.lifecycle === lifecycle);
  if (kind)      out = out.filter(e => e.kind === kind);
  if (since)     out = out.filter(e => (e.ts || '') >= since);
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return out;
}

function _anyBakFor(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    return fs.readdirSync(dir).some(f => f.startsWith(base + '.bak.'));
  } catch (_) { return false; }
}

// Find the most recent reversible actions for a project — used by
// the undo intent handler to disambiguate when the user says "undo
// that" with multiple candidates.
function findRecentReversible({ project, limit = 5, since = null } = {}) {
  return readActions({ project, since })
    .filter(e => e.reversible && e.lifecycle === 'applied')
    .slice(0, limit);
}

// Update a known action's lifecycle with optional compare-and-swap.
//
// Council R1 P1 fix (Codex P1 / Gemini P2, both-confirmed): without
// CAS, two sessions racing on the same action can both read its
// current lifecycle, both apply the inverse, and both append a
// terminal state — running side effects (process.kill, cleanup
// commands) twice. Pass `expectedState` to gate the transition: if
// the action's current lifecycle differs, throw, and the caller
// (undo handler / stop handler) treats it as a concurrent-conflict
// signal — abort, the other session is handling it.
//
// expectedState is OPTIONAL for back-compat. Crash-recovery dispatch
// uses it freely; intent handlers MUST pass it before applying any
// inverse with side effects.
function updateLifecycle(actionId, nextState, { reason, expectedState } = {}) {
  if (!LIFECYCLE_STATES.includes(nextState)) {
    throw new Error(`updateLifecycle: invalid state "${nextState}"`);
  }
  const all = readActions();
  const cur = all.find(e => e.id === actionId);
  if (!cur) {
    throw new Error(`updateLifecycle: action "${actionId}" not found`);
  }
  if (expectedState && cur.lifecycle !== expectedState) {
    const e = new Error(
      `updateLifecycle: CAS failed — action "${actionId}" lifecycle is "${cur.lifecycle}", expected "${expectedState}"`,
    );
    e.code = 'CAS_FAILED';
    e.actual_state = cur.lifecycle;
    e.expected_state = expectedState;
    throw e;
  }
  const next = {
    ...cur,
    lifecycle: nextState,
    ts: new Date().toISOString(),
    why: reason || cur.why,
  };
  return persistAction(next);
}

// Find by id, returning the most recent state.
function findById(actionId) {
  const all = readActions();
  return all.find(e => e.id === actionId) || null;
}

module.exports = {
  // Constants
  LIFECYCLE_STATES,
  CONFIDENCE_STATES,
  ACTION_KINDS,
  INVERSE_KINDS,
  // Builders
  createAction,
  newActionId,
  // Validation
  validateAction,
  // Persistence
  persistAction,
  readActions,
  findById,
  findRecentReversible,
  updateLifecycle,
  // Internal seams (test-only)
  _actionsFile,
  _validateInverseShape,
};
