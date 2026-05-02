#!/usr/bin/env node
// vanta-intent-undo — detect + handle the Undo conversational intent.
//
// Behavior tree:
//   1. Detect "undo that" / "revert that" / "no that's wrong" / "go back".
//   2. Look at the most recent reversible+applied actions for this project.
//   3. If exactly one → apply its `inverse` and transition lifecycle.
//   4. If multiple → ASK the user with kind disambiguation.
//   5. If zero → tell the user there's nothing to undo.
//
// Inverse application is dispatched per-kind:
//   FileEditInverse        — verify after_sha matches current file content,
//                            apply reverse-patch to before_sha. If the
//                            file was edited externally (SHA mismatch),
//                            transition to `rollback_failed` and tell the
//                            user what diverged.
//   MemoryPromotionInverse — find the insertion_anchor, remove the
//                            inserted_text. Idempotent (no-op if
//                            already removed).
//   CommandInverse         — kill PID + run cleanup_commands. If
//                            side_effects_known=false, surface manual
//                            checklist (rollback_failed).
//   PromptRewriteInverse   — re-issue the original_prompt; the hook
//                            replaces the rewrite with the original.
//   CouncilCallInverse     — record a cancellation entry; the council
//                            result is discarded locally even if it
//                            already completed remotely.
//
// Surface Impact Discipline: INTERNAL MACHINERY. The handler returns
// either `{kind: 'apply', result}` for unambiguous cases or
// `{kind: 'ask', candidates}` for the user to disambiguate. The
// prompt-rewriter hook renders both.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let _action, _cancellation;
function action() {
  if (_action) return _action;
  for (const p of [
    path.join(__dirname, 'vanta-action.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-action.js'),
  ]) {
    try { _action = require(p); return _action; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-action.js not resolvable');
}
function cancellation() {
  if (_cancellation) return _cancellation;
  for (const p of [
    path.join(__dirname, 'vanta-cancellation.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-cancellation.js'),
  ]) {
    try { _cancellation = require(p); return _cancellation; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-cancellation.js not resolvable');
}

// Detection patterns. Distinct from Stop: stop halts the FUTURE, undo
// reverses the PAST. Trigger set: undo that / undo / revert that /
// no that's wrong / no that was wrong / go back / take that back /
// roll that back. Anchored at start so "undo" embedded in a longer
// command (e.g. "undo this approach") is left to the rewriter rather
// than triggering the undo handler.
const UNDO_PATTERNS = [
  /^\s*undo\s*[.!]?\s*$/i,
  /^\s*undo (that|the last|the previous)\s*[.!]?\s*$/i,
  /^\s*revert (that|the last|the previous)\s*[.!]?\s*$/i,
  /^\s*revert\s*[.!]?\s*$/i,
  /^\s*no\s*[,.]?\s*(that('?s| was) wrong|that was a mistake|wrong)\s*[.!]?\s*$/i,
  /^\s*go back\s*[.!]?\s*$/i,
  /^\s*take that back\s*[.!]?\s*$/i,
  /^\s*roll (that|it) back\s*[.!]?\s*$/i,
  /^\s*rollback\s*[.!]?\s*$/i,
];

// Window for "recent" reversible actions — anything older than this is
// considered no-longer-the-target-of-an-undo prompt. 30 minutes gives
// the user time to type after a chained set of actions.
const RECENT_WINDOW_MS = 30 * 60 * 1000;
// Window for "ambiguous" — if more than one reversible action lives
// within this window, we ASK rather than auto-applying. Roadmap §undo
// says ambiguous undos always ASK.
const AMBIGUOUS_WINDOW_MS = 5 * 60 * 1000;

function detect(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const rx of UNDO_PATTERNS) {
    if (rx.test(prompt)) return true;
  }
  return false;
}

// Find candidate actions to undo. Returns the most-recent reversible+
// applied actions for this project, capped at `limit`.
function _findCandidates(project, limit = 5) {
  const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  return action().findRecentReversible({ project, limit, since });
}

// Top-level dispatcher. Two return shapes:
//   { kind: 'apply', result } — single candidate, inverse applied
//   { kind: 'ask',   candidates, message } — ask user to disambiguate
//   { kind: 'noop',  message } — nothing to undo
function handle({ project, session, prompt }) {
  const candidates = _findCandidates(project);
  if (candidates.length === 0) {
    return {
      kind: 'noop',
      message: '[Vanta] Nothing recent to undo. The action ledger has no reversible action in the last 30 minutes for this project.',
    };
  }
  // Ambiguous: more than one in the tight window
  const ambiguous = candidates.filter(c =>
    Date.now() - Date.parse(c.ts) < AMBIGUOUS_WINDOW_MS,
  );
  if (ambiguous.length >= 2) {
    return _renderAsk(ambiguous);
  }
  // Single candidate: apply its inverse
  return { kind: 'apply', result: applyInverse(candidates[0]) };
}

function _renderAsk(candidates) {
  const lines = ['[Vanta] Undo what? Multiple recent reversible actions:'];
  candidates.slice(0, 3).forEach((c, i) => {
    const label = String.fromCharCode(65 + i);
    const ago = _humanAgo(c.ts);
    let summary;
    switch (c.kind) {
      case 'prompt_rewrite':   summary = 'prompt rewrite';      break;
      case 'file_edit':        summary = `file edit (${(c.affected_files || []).join(', ') || 'unknown'})`; break;
      case 'memory_promotion': summary = 'memory promotion';    break;
      case 'command':          summary = 'command execution';   break;
      case 'council_call':     summary = `council call (${c.detected_intent || 'review'})`; break;
      default:                 summary = c.kind;                break;
    }
    lines.push(`${label}) ${summary} — ${ago}`);
  });
  return {
    kind: 'ask',
    candidates: candidates.slice(0, 3),
    message: lines.join('\n'),
  };
}

function _humanAgo(ts) {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

// Apply the inverse for a specific action. Returns:
//   { ok: true, action_id, kind, message }
//   { ok: false, action_id, reason, message } — rollback_failed; manual cleanup required
function applyInverse(act) {
  if (!act || !act.inverse) {
    return { ok: false, action_id: act && act.id, reason: 'no-inverse', message: '[Vanta blocked] No inverse recorded — cannot undo.' };
  }
  switch (act.inverse.kind) {
    case 'file_edit':        return _undoFileEdit(act);
    case 'memory_promotion': return _undoMemoryPromotion(act);
    case 'command':          return _undoCommand(act);
    case 'prompt_rewrite':   return _undoPromptRewrite(act);
    case 'council_call':     return _undoCouncilCall(act);
    default:
      return { ok: false, action_id: act.id, reason: 'unknown-kind',
               message: `[Vanta blocked] Unknown inverse kind: ${act.inverse.kind}` };
  }
}

// File edit reversal: verify after_sha matches current file content,
// then write the patch's pre-image. If the file was edited externally
// (current SHA != after_sha), transition to rollback_failed and tell
// the user what diverged.
//
// v3.9.0 implementation note: the patch is a unified diff string. We
// compute SHA on file content for divergence detection but rely on
// the caller to either store the full pre-image OR a reverse-applicable
// patch. For v3.9.0 we accept that some FileEdit actions may be
// reversed via "write before_content directly" rather than patch
// application; the inverse can carry either the patch or a
// `before_content` field. This module handles both.
// Council R1 P2 fix (Codex): TOCTOU between SHA check and write.
// Mitigation: read + verify SHA + write via atomic temp + rename under
// a single best-effort sequence. Atomic rename is the strongest
// guarantee Node ships without an external lock; we add a re-verify
// AFTER reading via O_RDONLY but BEFORE writing the temp, then rename
// in. If a concurrent writer modifies between our read and rename, the
// rename still atomically replaces the file — the user gets a fresh
// pre-image but loses a concurrent edit. Document that explicitly so
// the failure mode is visible.
//
// A true cross-process file lock (flock-style) is left for v3.9.x —
// the action surface is small enough that the user-driven undo race
// is rare in practice; the SHA re-verify catches the dominant case
// (external editor saved the file mid-undo).
function _undoFileEdit(act) {
  const inv = act.inverse;
  const target = inv.target_path;
  if (!target) {
    return _failRollback(act, 'no-target-path', 'No target_path in FileEditInverse.');
  }
  const exists = fs.existsSync(target);
  if (!exists && inv.before_sha === _emptyShaCorrespondingTo(inv)) {
    return _completeRollback(act, `File ${target} already absent — no revert needed.`);
  }
  // First SHA check — gate before doing any write.
  if (exists) {
    const current = fs.readFileSync(target);
    const currentSha = _sha256(current);
    if (currentSha !== inv.after_sha) {
      return _failRollback(act, 'external-mutation',
        `${target} changed externally since the edit (SHA ${currentSha.slice(0, 8)} vs expected ${inv.after_sha.slice(0, 8)}). Refusing to overwrite — manual review needed.`);
    }
  }
  // Apply reverse via atomic temp + rename. Re-verify SHA BEFORE the
  // rename to catch a writer that snuck in between the first check
  // and the temp write.
  try {
    if (typeof inv.before_content !== 'string') {
      if (typeof inv.patch === 'string' && inv.patch) {
        return _failRollback(act, 'patch-only-not-yet-supported',
          'FileEditInverse carries patch only (no before_content). Re-apply manually or write the inverse with before_content.');
      }
      return _failRollback(act, 'no-revert-payload',
        'FileEditInverse has neither before_content nor patch.');
    }
    const tmpPath = target + '.vanta-undo.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmpPath, inv.before_content);
    // Re-verify under retry: if another writer raced us, decline the
    // rename rather than clobber.
    if (exists) {
      let raceSha;
      try { raceSha = _sha256(fs.readFileSync(target)); }
      catch (_) { raceSha = null; }
      if (raceSha && raceSha !== inv.after_sha) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        return _failRollback(act, 'race-detected',
          `${target} mutated during undo (TOCTOU race). Refusing to clobber — manual review needed.`);
      }
    }
    fs.renameSync(tmpPath, target);
  } catch (err) {
    return _failRollback(act, 'write-failed', `Write failed: ${err.message || String(err)}`);
  }
  return _completeRollback(act, `Reverted ${target} to its prior state.`);
}

function _undoMemoryPromotion(act) {
  const inv = act.inverse;
  if (!fs.existsSync(inv.target_file)) {
    return _completeRollback(act, `Target ${inv.target_file} no longer exists — promotion already gone.`);
  }
  let body;
  try { body = fs.readFileSync(inv.target_file, 'utf8'); }
  catch (err) {
    return _failRollback(act, 'read-failed', `Could not read ${inv.target_file}: ${err.message}`);
  }
  if (!body.includes(inv.inserted_text)) {
    return _completeRollback(act, `${inv.target_file}: inserted text already absent (idempotent).`);
  }
  // Anchor-aware removal: prefer to remove the smallest contiguous
  // block that contains the inserted_text and ends at the anchor.
  // For v3.9.0 MVP we just use indexOf + slice — fragile across
  // surrounding edits but bounded by the staged → live promotion
  // path which is short-lived.
  const next = body.replace(inv.inserted_text, '');
  try {
    fs.writeFileSync(inv.target_file, next);
  } catch (err) {
    return _failRollback(act, 'write-failed', `Write failed: ${err.message}`);
  }
  return _completeRollback(act, `Removed promoted memory block from ${inv.target_file}.`);
}

function _undoCommand(act) {
  const inv = act.inverse;
  if (inv.side_effects_known === false) {
    return _failRollback(act, 'side-effects-unknown',
      `Command had unknown side effects — manual cleanup required.${
        Array.isArray(inv.cleanup_commands) && inv.cleanup_commands.length > 0
          ? ' Suggested: ' + inv.cleanup_commands.join(' && ')
          : ''}`);
  }
  // Best-effort: kill PID if present, then run cleanup_commands.
  // We don't actually exec arbitrary commands here — that's a security
  // boundary the user must cross. We surface the cleanup_commands as
  // a checklist instead.
  const lines = [];
  if (inv.process_id != null) {
    try {
      process.kill(inv.process_id, 'SIGTERM');
      lines.push(`Sent SIGTERM to pid ${inv.process_id}.`);
    } catch (err) {
      // ESRCH = no such process; that's fine, the process already exited.
      if (err && err.code === 'ESRCH') {
        lines.push(`Process ${inv.process_id} already exited.`);
      } else {
        return _failRollback(act, 'kill-failed', `Could not signal pid ${inv.process_id}: ${err.message}`);
      }
    }
  }
  if (Array.isArray(inv.cleanup_commands) && inv.cleanup_commands.length > 0) {
    lines.push(`Manual cleanup needed: ${inv.cleanup_commands.join(' && ')}`);
  }
  return _completeRollback(act, lines.join(' '));
}

function _undoPromptRewrite(act) {
  const inv = act.inverse;
  if (typeof inv.original_prompt !== 'string') {
    return _failRollback(act, 'no-original-prompt', 'PromptRewriteInverse.original_prompt missing.');
  }
  return _completeRollback(act, `Prompt rewrite reversed — re-issuing your original prompt: "${inv.original_prompt.slice(0, 80)}".`);
}

function _undoCouncilCall(act) {
  const inv = act.inverse;
  const c = cancellation();
  c.record({
    action_id: act.id,
    cancellation_kind: 'user-initiated-undo',
    in_flight_remote_call: {
      provider: _providerFromAction(act) || 'codex',
      request_id: inv.request_id,
      estimated_cost_usd: typeof inv.estimated_cost_usd === 'number' ? inv.estimated_cost_usd : null,
    },
  });
  const cost = inv.estimated_cost_usd != null ? `~$${inv.estimated_cost_usd.toFixed(2)}` : 'unknown amount';
  return _completeRollback(act,
    `Council call discarded locally. The remote request may have completed (${cost}); reconciled next session.`);
}

// Council R1 P1 fix: CAS the lifecycle transition to prevent two
// sessions from both applying the inverse to the same action. If the
// CAS fails, the peer session has already rolled back; the inverse we
// just applied was a no-op or a duplicate. Surface this as a soft
// failure so the user knows something raced.
function _completeRollback(act, message) {
  try {
    action().updateLifecycle(act.id, 'rolled_back', {
      reason: 'user-initiated-undo',
      expectedState: 'applied',
    });
  } catch (err) {
    if (err && err.code === 'CAS_FAILED') {
      return {
        ok: false, action_id: act.id, kind: act.inverse && act.inverse.kind,
        reason: 'concurrent-undo',
        message: `[Vanta] Another session has already handled this action (state is now "${err.actual_state}"). The inverse may have been applied twice — please review ${(act.affected_files || []).join(', ') || 'the affected files'} manually.`,
      };
    }
    /* the rollback succeeded mechanically; lifecycle update best-effort otherwise */
  }
  return { ok: true, action_id: act.id, kind: act.inverse.kind, message: `[Vanta] ${message}` };
}
function _failRollback(act, reason, why) {
  try {
    action().updateLifecycle(act.id, 'rollback_failed', {
      reason: `undo-failed:${reason}`,
      expectedState: 'applied',
    });
  } catch (_) { /* best-effort: rollback already failed; lifecycle is icing on the cake */ }
  return { ok: false, action_id: act.id, kind: act.inverse && act.inverse.kind, reason, message: `[Vanta risky] ${why}` };
}

function _providerFromAction(a) {
  if (a && a.why && /gemini/i.test(a.why)) return 'gemini';
  return 'codex';
}
function _sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function _emptyShaCorrespondingTo(_inv) {
  // sha256 of empty string — used to detect "the original action
  // created the file from nothing".
  return crypto.createHash('sha256').update('').digest('hex');
}

module.exports = {
  UNDO_PATTERNS,
  RECENT_WINDOW_MS,
  AMBIGUOUS_WINDOW_MS,
  detect,
  handle,
  applyInverse,
  _findCandidates,
};
