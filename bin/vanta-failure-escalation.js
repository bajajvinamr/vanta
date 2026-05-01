#!/usr/bin/env node
// vanta-failure-escalation — detect consecutive-failure runs and emit an
// escalation hint that the executor can use to bump a tier.
//
// Why: when a session is stuck (3+ consecutive test failures, build
// errors, undo events), the next operation is more likely to need
// peer review than the regex risk score would suggest. Vanta should
// auto-escalate without the user remembering to invoke /council.
//
// What counts as a "failure" signal in the action-log:
//   - test-failure        (test-failure-advisor.js logs this on broken tests)
//   - build-failure       (logged similarly when build/typecheck fails)
//   - undo                (undo events count — every undo is a tacit "that didn't work")
//   - regret-detected     (regret-detector flagged an upstream commit)
//   - decision=ask        when the user came back and asked again
//
// Heuristic:
//   3+ failures in the last 10 minutes  → bump tier by ONE  (T0→T1, T1→T2, T2→T3)
//   5+ failures in the last 10 minutes  → force T3
//
// The window is intentionally short (10m). Longer windows would
// over-attribute — an unrelated build failure 4 hours ago shouldn't
// gate the next innocuous edit.
//
// Returns:
//   { count, window_ms, bump: 0|1|2, force_tier: 'T3'|null, why }

'use strict';
const path = require('path');
const os = require('os');

let _al;
function actionLog() {
  if (_al) return _al;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-action-log.js'),
    path.join(__dirname, 'vanta-action-log.js'),
  ]) { try { _al = require(p); return _al; } catch {} }
  return null;
}

// Action types that count as failure signals.
const FAILURE_ACTIONS = new Set([
  'test-failure',
  'build-failure',
  'undo',
  'regret-detected',
]);

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 min
const BUMP_THRESHOLD = 3;
const FORCE_T3_THRESHOLD = 5;

// Tier-bump table. Bumping past T3 stays at T3 (already top).
const NEXT_TIER = { T0: 'T1', T1: 'T2', T2: 'T3', T3: 'T3' };

function escalate({ session_id, sinceMs, windowMs } = {}) {
  const al = actionLog();
  if (!al) {
    return { count: 0, window_ms: windowMs || DEFAULT_WINDOW_MS, bump: 0, force_tier: null, why: 'no action-log' };
  }
  const window = windowMs || DEFAULT_WINDOW_MS;
  const now = Date.now();
  const cutoff = sinceMs != null ? sinceMs : (now - window);

  // Count failure signals in window. Session-scoped if session_id given.
  let entries;
  try {
    entries = al.read({ session_id, sinceMs: cutoff, limit: 200 });
  } catch (_) {
    return { count: 0, window_ms: window, bump: 0, force_tier: null, why: 'action-log read failed' };
  }

  let count = 0;
  const recentTypes = [];
  for (const e of entries) {
    if (FAILURE_ACTIONS.has(e.action)) {
      count++;
      recentTypes.push(e.action);
    }
  }

  let bump = 0;
  let force_tier = null;
  if (count >= FORCE_T3_THRESHOLD) {
    force_tier = 'T3';
    bump = 0; // force_tier overrides bump
  } else if (count >= BUMP_THRESHOLD) {
    bump = 1;
  }

  const why = count > 0
    ? `${count} failure signal(s) in last ${Math.round(window / 60000)}m (${recentTypes.slice(0, 5).join(', ')})`
    : 'no failure signals';

  return { count, window_ms: window, bump, force_tier, why };
}

// Apply an escalation result to a tier string. Used by the executor.
function applyEscalation(tier, esc) {
  if (!esc) return tier;
  if (esc.force_tier) return esc.force_tier;
  let t = tier;
  for (let i = 0; i < (esc.bump || 0); i++) t = NEXT_TIER[t] || t;
  return t;
}

module.exports = {
  escalate,
  applyEscalation,
  FAILURE_ACTIONS,
  BUMP_THRESHOLD,
  FORCE_T3_THRESHOLD,
  DEFAULT_WINDOW_MS,
};

// CLI:
//   vanta-failure-escalation              — global escalation check
//   vanta-failure-escalation --session ID — session-scoped check
if (require.main === module) {
  const args = process.argv.slice(2);
  const find = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const session_id = find('--session');
  const out = escalate({ session_id });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
