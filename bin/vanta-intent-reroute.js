#!/usr/bin/env node
// vanta-intent-reroute — detect + handle the Mid-Flight Re-Route intent.
//
// Behavior:
//   1. Detect "no, I meant <X>" / "not that" / "wait, actually <X>"
//   2. Halt the in-flight action (same machinery as Stop)
//   3. Reverse partial side-effects via inverse (same machinery as Undo)
//   4. Pipe the original prompt's context into the NEW route — the
//      user typed "review this" originally; if they say "no, test it",
//      the new route is /test against the same context (diff/files).
//
// The user-facing UX:
//
//     User:  /vanta review this
//     Vanta: [Vanta] Reviewing the diff...    (council fires)
//     User:  no, I meant test it
//     Vanta: [Vanta] Got it — switching to writing tests. Halting
//            review. The Codex review request may have already
//            completed remotely (~$0.18); reconciling next session.
//            Writing tests for the same diff now.
//
// Surface Impact Discipline: INTERNAL MACHINERY. The handler returns
// a structured result; the prompt-rewriter hook renders the message
// AND issues the new-route shadow injection.

'use strict';
const path = require('path');
const os = require('os');

let _action, _cancellation, _stop;
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
function stop() {
  if (_stop) return _stop;
  for (const p of [
    path.join(__dirname, 'vanta-intent-stop.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-intent-stop.js'),
  ]) {
    try { _stop = require(p); return _stop; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-intent-stop.js not resolvable');
}

// Detection patterns. Re-route prompts have a HALT signal AND a
// REPLACEMENT signal. We capture the replacement via a capture group;
// the handler classifies it into a new intent.
//
// Patterns:
//   - "no, I meant <X>"      / "no I meant <X>"
//   - "not that, <X>"        / "not that — <X>"
//   - "wait, actually <X>"
//   - "actually <X>"         (only when prefixed; bare "actually" is too loose)
//   - "no, do <X> instead"
//   - "switch to <X>"        / "instead, <X>"
const REROUTE_PATTERNS = [
  /^\s*no[,\s]+i\s*meant\s+(.+?)\s*[.!]?\s*$/i,
  /^\s*not that[,\s\-—]+(.+?)\s*[.!]?\s*$/i,
  /^\s*wait[,\s]+actually\s+(.+?)\s*[.!]?\s*$/i,
  /^\s*actually[,\s]+(.+?)\s*[.!]?\s*$/i,
  /^\s*no[,\s]+do\s+(.+?)\s+instead\s*[.!]?\s*$/i,
  /^\s*switch to\s+(.+?)\s*[.!]?\s*$/i,
  /^\s*instead[,\s]+(.+?)\s*[.!]?\s*$/i,
];

// Intent extraction from the replacement portion. We map the user's
// natural phrasing to a known route. This piggybacks on the existing
// rewriter rule corpus; for v3.9.0 we keep it simple — explicit
// keyword → route mapping. v3.9.1's universal router will subsume
// this, but for the re-route MVP a small lookup is enough.
const REPLACEMENT_TO_ROUTE = [
  { rx: /\b(test|tests|tdd|write\s+tests?)\b/i, route: '/test',         intent: 'write-tests' },
  { rx: /\b(review|reviewing)\b/i,              route: '/review',       intent: 'review-diff' },
  { rx: /\b(ship|deploy|land|merge)\b/i,        route: '/ship',         intent: 'ship' },
  { rx: /\b(fix|debug|investigate)\b/i,         route: '/investigate',  intent: 'fix-bug' },
  { rx: /\b(qa|browser|playwright)\b/i,         route: '/qa',           intent: 'qa' },
  { rx: /\b(council|second opinion|adversarial)\b/i, route: '/council', intent: 'council' },
  { rx: /\b(undo|revert|roll\s+back)\b/i,       route: 'undo',          intent: 'undo' },
];

function detect(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const rx of REROUTE_PATTERNS) {
    if (rx.test(prompt)) return true;
  }
  return false;
}

// Extract the new intent + route from the replacement portion of the
// prompt. Returns null if no known intent matches; the caller should
// then ASK the user instead of proceeding silently to a wrong route.
function classifyReplacement(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  for (const rx of REROUTE_PATTERNS) {
    const m = prompt.match(rx);
    if (m && m[1]) {
      const replacement = m[1].trim();
      for (const map of REPLACEMENT_TO_ROUTE) {
        if (map.rx.test(replacement)) {
          return { replacement, route: map.route, intent: map.intent };
        }
      }
      // Matched a re-route pattern but no known intent in the
      // replacement — return the replacement so handler ASKs.
      return { replacement, route: null, intent: null };
    }
  }
  return null;
}

// Top-level handler. Returns:
//   { kind: 'apply', halted_action_id?, new_intent, new_route,
//     original_context, message }
//   { kind: 'ask',   replacement, message }   when new intent unclear
//   { kind: 'noop',  message }                when nothing in flight to halt
function handle({ project, session, prompt }) {
  const cls = classifyReplacement(prompt);
  if (!cls) {
    return {
      kind: 'noop',
      message: '[Vanta] No re-route signal detected — leaving the original route in place.',
    };
  }

  // 1. Halt in-flight action via Stop machinery.
  const haltResult = stop().handle({ project, session, prompt });
  // Even if nothing was in flight we still pivot the conversation
  // forward (the user said "actually X"); we just don't have a
  // halted_action_id to report.

  // 2. If the replacement intent is unclear, ASK.
  if (!cls.route) {
    return {
      kind: 'ask',
      replacement: cls.replacement,
      message: `[Vanta] Got it, switching away from the current route. What did you want to do? You said "${cls.replacement}" — that doesn't match a known route. Reply with /investigate, /review, /ship, /test, /qa, or /council.`,
    };
  }

  // 3. Build the message. Pull the original action's context if a halt
  //    happened so the user sees consistent narration.
  const lines = [`[Vanta] Got it — switching to ${cls.intent}.`];
  if (haltResult.halted) {
    lines.push(`Halted the prior ${_kindFor(haltResult.action_id, project) || 'action'}.`);
  }
  // Cost-honest about possibly-billed remote calls.
  const pending = cancellation().summarizePending();
  if (pending && pending.count > 0) {
    lines.push(pending.message);
  }
  lines.push(`Now ${cls.intent} via ${cls.route} on the same context.`);

  // 4. Find the original prompt the user typed BEFORE the wrong route.
  //    The action ledger holds the latest prompt_rewrite; use its
  //    `original_prompt` if available so the new route gets the
  //    original ask, not the re-route prompt itself.
  const originalContext = _findOriginalContext(project, haltResult.action_id);

  return {
    kind: 'apply',
    halted_action_id: haltResult.halted ? haltResult.action_id : null,
    new_intent: cls.intent,
    new_route: cls.route,
    original_context: originalContext,
    message: lines.join(' '),
  };
}

function _kindFor(actionId, project) {
  if (!actionId) return null;
  try {
    const a = action().findById(actionId);
    if (!a) return null;
    return _humanizeKind(a.kind);
  } catch (_) { return null; }
}
function _humanizeKind(k) {
  switch (k) {
    case 'council_call':     return 'council call';
    case 'file_edit':        return 'file edit';
    case 'memory_promotion': return 'memory promotion';
    case 'command':          return 'command';
    case 'prompt_rewrite':   return 'prompt rewrite';
    case 'route_decision':   return 'routing decision';
    default:                 return k;
  }
}

// Find the prompt that triggered the (now-halted) wrong route. The
// most recent prompt_rewrite or route_decision in this project before
// the halted action is our best signal. Returns null if nothing useful.
function _findOriginalContext(project, haltedActionId) {
  if (!haltedActionId) return null;
  try {
    const halted = action().findById(haltedActionId);
    if (!halted) return null;
    // Look for a recent prompt_rewrite predating the halt.
    const recent = action().readActions({ project }).filter(a =>
      a.kind === 'prompt_rewrite' &&
      a.id !== haltedActionId &&
      (a.ts || '') <= (halted.ts || ''),
    );
    if (recent.length === 0) return null;
    const candidate = recent[0];
    return {
      original_prompt: candidate.inverse && candidate.inverse.original_prompt || null,
      affected_files: halted.affected_files || null,
    };
  } catch (_) { return null; }
}

module.exports = {
  REROUTE_PATTERNS,
  REPLACEMENT_TO_ROUTE,
  detect,
  classifyReplacement,
  handle,
};
