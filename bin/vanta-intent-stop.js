#!/usr/bin/env node
// vanta-intent-stop — detect + handle the Stop conversational intent.
//
// The Stop intent halts the in-flight VantaAction immediately. No
// undo of prior actions, no clarification step. Reports state cleanly
// in `[Vanta blocked]` form per the roadmap's "Calm Operator UX"
// principle.
//
// The most-recent reversible action in `pending` lifecycle is the
// candidate. If it has a `council_call` inverse with an in-flight
// remote request, we record a cancellation entry (cost-honest) before
// transitioning the action to `rolled_back`. If side_effects_known is
// false on a `command` inverse, the lifecycle moves to
// `rollback_failed` and the user is told what manual cleanup is
// expected.
//
// Surface Impact Discipline: INTERNAL MACHINERY. Adds no commands.
// The handler returns a structured result; the prompt-rewriter hook
// renders it into the existing `[Vanta]` shadow-context shape.

'use strict';
const path = require('path');
const os = require('os');

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

// Detection patterns. Anchored at start-of-string so "stop" embedded
// in a longer prompt (e.g. "stop using async") doesn't false-trigger.
// `^\s*` allows a leading space; `\.?$` allows an optional period.
//
// We deliberately keep the trigger set tight: stop / wait don't /
// hold on / pause / halt / abort. These are conversational halts;
// they're distinct from "rollback" or "undo" (a different intent
// handled by vanta-intent-undo).
const STOP_PATTERNS = [
  /^\s*stop\s*[.!]?\s*$/i,
  /^\s*stop\s+(now|please|it)\s*[.!]?\s*$/i,
  /^\s*wait[,\s]+(don'?t|please don'?t|do not)\s*[.!]?\s*$/i,
  /^\s*hold on\s*[.!]?\s*$/i,
  /^\s*pause\s*[.!]?\s*$/i,
  /^\s*halt\s*[.!]?\s*$/i,
  /^\s*abort\s*[.!]?\s*$/i,
  /^\s*nevermind\s*[.!]?\s*$/i,
  /^\s*never mind\s*[.!]?\s*$/i,
  /^\s*cancel( that)?\s*[.!]?\s*$/i,
];

function detect(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const rx of STOP_PATTERNS) {
    if (rx.test(prompt)) return true;
  }
  return false;
}

// Find the candidate action to halt. The most recent action in
// `pending` lifecycle for this project — that's the in-flight one
// the user is reacting to. If nothing pending, return null and the
// handler reports a no-op cleanly.
function _findInFlight(project) {
  const a = action();
  const pending = a.readActions({ project, lifecycle: 'pending' });
  return pending.length > 0 ? pending[0] : null;
}

// Halt the in-flight action. Returns a structured result the hook
// renders. Decision tree:
//
//   1. No in-flight action → { halted: false, reason: 'nothing-pending' }
//   2. Action has council_call inverse → record cancellation entry,
//      transition to rolled_back. Cost-honest message about possible
//      remote completion.
//   3. Action has command inverse with side_effects_known=false →
//      transition to rollback_failed; surface manual cleanup checklist.
//   4. Otherwise → straight transition to rolled_back. State reported.
function handle({ project, session, prompt }) {
  const inflight = _findInFlight(project);
  if (!inflight) {
    return {
      halted: false,
      reason: 'nothing-pending',
      message: '[Vanta blocked] Stopped — but nothing was in flight. Continue with whatever you want next.',
    };
  }
  const a = action();
  const c = cancellation();
  const inv = inflight.inverse;

  // Council R2 P1 fix (Codex): CLAIM the action via two-phase CAS
  // BEFORE running any side effects. Without this, two sessions both
  // racing on the same in-flight action could each pass the
  // _findInFlight check, both record cancellation entries, and the
  // post-hoc CAS would only detect the race after the damage. The
  // claim transition is `pending → rolling_back`; only the winning
  // session proceeds to record cancellation + finalize.
  try {
    a.updateLifecycle(inflight.id, 'rolling_back', {
      reason: 'user-initiated-stop:claim',
      expectedState: 'pending',
    });
  } catch (err) {
    if (err && err.code === 'CAS_FAILED') {
      return {
        halted: false,
        reason: 'concurrent-conflict',
        error: err.message,
        message: `[Vanta] Another session has already handled this action (it's now "${err.actual_state}"). Nothing left to halt.`,
      };
    }
    return {
      halted: false,
      reason: 'lifecycle-update-failed',
      error: err.message || String(err),
      message: `[Vanta blocked] Stop signaled, but I couldn't claim action ${inflight.id}.`,
    };
  }

  // Claim succeeded — we are the sole halter. Run side effects.
  let nextLifecycle = 'rolled_back';
  const messages = [];
  const cancellations_recorded = [];

  // council_call: cost-honest cancellation entry (post-claim only)
  if (inv && inv.kind === 'council_call' && inv.remote_status === 'unknown') {
    const ok = c.record({
      action_id: inflight.id,
      cancellation_kind: 'user-initiated-stop',
      // v3.10 council C-1: propagate the upstream rule-fire lineage
      // so rule-effectiveness scoring can mark this cancellation as
      // a `stopped` outcome for the rule that produced inflight.
      decision_id: inflight.decision_id || null,
      in_flight_remote_call: {
        provider: _providerFromAction(inflight) || 'codex',
        request_id: inv.request_id,
        estimated_cost_usd: typeof inv.estimated_cost_usd === 'number' ? inv.estimated_cost_usd : null,
      },
    });
    if (ok) {
      cancellations_recorded.push(inflight.id);
      const cost = inv.estimated_cost_usd != null ? `~$${inv.estimated_cost_usd.toFixed(2)}` : 'unknown amount';
      messages.push(`The council call may have completed remotely (${cost}). I'll reconcile next session.`);
    }
  }

  // command with unknown side effects: cannot auto-undo
  if (inv && inv.kind === 'command' && inv.side_effects_known === false) {
    nextLifecycle = 'rollback_failed';
    messages.push("Side effects unknown — manual cleanup is required. The command may have written files or made network calls.");
    if (Array.isArray(inv.cleanup_commands) && inv.cleanup_commands.length > 0) {
      messages.push(`Suggested cleanup: ${inv.cleanup_commands.join(' && ')}`);
    }
  }

  // Finalize: rolling_back → rolled_back / rollback_failed.
  try {
    a.updateLifecycle(inflight.id, nextLifecycle, {
      reason: 'user-initiated-stop:finalize',
      expectedState: 'rolling_back',
    });
  } catch (err) {
    // Finalize CAS shouldn't fail unless something else mutated the
    // ledger out from under us — best-effort tolerance.
    /* swallow: side effects already ran; lifecycle is icing on the cake */
  }

  const summary = _summarizeAction(inflight);
  const tag = nextLifecycle === 'rollback_failed' ? '[Vanta risky]' : '[Vanta blocked]';
  const lead = nextLifecycle === 'rollback_failed'
    ? `Stopped, but the rollback was incomplete. ${summary}`
    : `Stopped before any further changes. ${summary}`;
  return {
    halted: true,
    action_id: inflight.id,
    next_lifecycle: nextLifecycle,
    cancellations_recorded,
    message: [tag, lead, ...messages].join(' ').trim(),
  };
}

// Best-guess provider for a council action — the inverse should
// carry it eventually but the v3.8 schema doesn't. Fallback to codex
// because that's the cheaper / faster default.
function _providerFromAction(a) {
  if (a && a.why && /gemini/i.test(a.why)) return 'gemini';
  return 'codex';
}

function _summarizeAction(a) {
  if (!a || !a.kind) return 'No action context recorded.';
  switch (a.kind) {
    case 'council_call':     return `Council call (${a.detected_intent || 'review'}) was halted.`;
    case 'file_edit':        return `File edit on ${(a.affected_files || []).join(', ') || 'unknown'} was halted.`;
    case 'memory_promotion': return 'Memory promotion was halted.';
    case 'command':          return 'Command execution was halted.';
    case 'prompt_rewrite':   return 'Prompt rewrite was halted.';
    case 'route_decision':   return 'Routing decision was halted.';
    default:                 return 'Action halted.';
  }
}

module.exports = {
  STOP_PATTERNS,
  detect,
  handle,
  _findInFlight,
};
