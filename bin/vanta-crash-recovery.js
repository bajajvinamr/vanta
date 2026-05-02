#!/usr/bin/env node
// vanta-crash-recovery — session-start scan for unrecoverable state.
//
// Vanta's state lives in append-only JSONL files. A crash mid-action
// can leave:
//   1. VantaAction entries with lifecycle='pending' or 'applied' but
//      no terminal closure (no rolled_back/rollback_failed AND no
//      session-end marker).
//   2. Cancellation entries with remote_status='unknown' that need
//      reconciliation (council call may have completed remotely).
//   3. Hooks that wrote to action-log but the prompt-rewriter result
//      never reached the user (sync-queue 'synced: false').
//
// Recovery contract:
//   - Read append-only ledgers (actions.jsonl, cancellations.jsonl,
//     sync-queue.jsonl).
//   - For each pending/applied-stale action, surface to the user via
//     session-start brief with three options:
//       A) Accept the partial state as-is
//       B) Re-run the action / council
//       C) Skip / abandon
//   - Idempotency: re-running an action via the executor produces the
//     same Decision (executor is pure on prompt+context; the rewriter
//     is deterministic). So option B is safe.
//
// Output format: structured payload the session-start hook renders
// into the existing 4-line brief slot. No new top-level surface.

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

// "Stale" = pending or applied for longer than this without lifecycle
// closure. Default 30 minutes — long enough to span a normal session
// boundary, short enough that genuine in-flight work doesn't trigger
// false positives.
const STALE_MS = 30 * 60 * 1000;

// Scan for unrecoverable / stale state. Returns:
//   {
//     stale_actions:        [VantaAction, ...]
//     pending_reconciliation: [VantaActionCancellation, ...]
//     summary:              one-line string for the brief
//   }
function scan({ project = null, now = Date.now() } = {}) {
  const stale_actions = _findStaleActions(project, now);
  const pending_reconciliation = cancellation().findPendingReconciliation();

  let summary = null;
  if (stale_actions.length > 0 && pending_reconciliation.length > 0) {
    summary = `${stale_actions.length} stale action(s) + ${pending_reconciliation.length} cancellation(s) need reconciliation`;
  } else if (stale_actions.length > 0) {
    summary = `${stale_actions.length} stale action(s) from a prior session`;
  } else if (pending_reconciliation.length > 0) {
    summary = `${pending_reconciliation.length} cancellation(s) pending reconciliation`;
  }

  return { stale_actions, pending_reconciliation, summary };
}

function _findStaleActions(project, now) {
  const all = action().readActions(project ? { project } : {});
  const cutoff = new Date(now - STALE_MS).toISOString();
  return all.filter(a => {
    if (a.lifecycle !== 'pending' && a.lifecycle !== 'applied') return false;
    if (!a.ts) return false;
    return a.ts < cutoff;
  });
}

// Render a structured user-facing payload for the session-start hook.
// Returns null when nothing to surface.
//
// Output shape:
//   {
//     show: boolean,
//     lines: [string, string, ...],   // already-formatted brief lines
//     options: [{label, kind, action_id?}, ...]   // what the user can choose
//   }
function renderBrief({ project = null } = {}) {
  const result = scan({ project });
  if (!result.summary) return { show: false };

  const lines = ['[Vanta] Last session ended with state to reconcile:'];

  if (result.stale_actions.length > 0) {
    const top = result.stale_actions.slice(0, 3);
    for (const a of top) {
      const kind = _humanizeKind(a.kind);
      const route = a.current_route || a.detected_intent || 'unknown';
      lines.push(`  · ${kind} (${route}) was ${a.lifecycle} since ${_humanAgo(a.ts)}`);
    }
    if (result.stale_actions.length > 3) {
      lines.push(`  · ${result.stale_actions.length - 3} more stale action(s).`);
    }
  }

  if (result.pending_reconciliation.length > 0) {
    const pendingMsg = cancellation().summarizePending();
    if (pendingMsg) lines.push(`  · ${pendingMsg.message}`);
  }

  lines.push('Options: A) accept B) re-run C) skip / abandon');

  // Generate per-action option specs the hook can present as a real
  // ASK if the user engages with the brief.
  const options = [
    { label: 'Accept the partial state',     kind: 'accept' },
    { label: 'Re-run the affected actions',  kind: 'rerun' },
    { label: 'Skip / abandon',               kind: 'skip'   },
  ];

  return { show: true, lines, options, scan_result: result };
}

function _humanizeKind(k) {
  switch (k) {
    case 'council_call':     return 'council call';
    case 'file_edit':        return 'file edit';
    case 'memory_promotion': return 'memory promotion';
    case 'command':          return 'command';
    case 'prompt_rewrite':   return 'prompt rewrite';
    case 'route_decision':   return 'route decision';
    default:                 return k || 'action';
  }
}

function _humanAgo(ts) {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms)) return 'unknown time';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// User-facing dispatch handler. Once the user picks an option from
// the brief, the session-start hook calls this with the choice.
//
//   accept  → mark each stale action as 'applied' (if pending) or
//             leave 'applied' as-is, and unblock further work.
//   rerun   → leave the stale actions in place; the executor will
//             re-fire when the user prompts. Idempotency means the
//             second run produces the same Decision.
//   skip    → mark each stale action 'rollback_failed' with reason
//             'crash-recovery-skip'.
function dispatch(choice, scan_result) {
  if (!choice || !scan_result) return { ok: false, reason: 'no-input' };
  const a = action();
  switch (choice) {
    case 'accept':
      for (const stale of scan_result.stale_actions) {
        if (stale.lifecycle === 'pending') {
          try { a.updateLifecycle(stale.id, 'applied', { reason: 'crash-recovery:accept' }); } catch (_) { /* best-effort */ }
        }
      }
      return { ok: true, mode: 'accept', count: scan_result.stale_actions.length };
    case 'rerun':
      // No-op on the ledger; caller re-fires the executor on next prompt.
      return { ok: true, mode: 'rerun', count: scan_result.stale_actions.length };
    case 'skip':
      for (const stale of scan_result.stale_actions) {
        try { a.updateLifecycle(stale.id, 'rollback_failed', { reason: 'crash-recovery:skip' }); } catch (_) { /* best-effort */ }
      }
      return { ok: true, mode: 'skip', count: scan_result.stale_actions.length };
    default:
      return { ok: false, reason: 'unknown-choice' };
  }
}

module.exports = {
  STALE_MS,
  scan,
  renderBrief,
  dispatch,
  _findStaleActions,
};
