#!/usr/bin/env node
// UserPromptSubmit hook — surfaces the Vanta rewrite as additional
// context, in shadow mode (Claude sees both original + suggestion).
//
// Hook contract:
//   stdin:  { prompt, session_id, transcript_path, cwd, hook_event_name }
//   stdout: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
//             additionalContext: '<shadow rewrite>' } }
//
// v3.7.2: this hook is a thin adapter around vanta-executor.decide().
// The executor composes kill-switch + safety-floor + rewriter +
// risk-classifier into a single Decision; the hook's only job is to
// translate that Decision into the 4-line shadow injection contract.
//
// Why shadow first: Claude Code hooks can INJECT context but cannot
// REPLACE the user's prompt. Inline rewriting would require building
// a wrapper command (e.g., `/v <prompt>`); shadow mode works through
// the hook system and lets us measure trust-metrics for 14d before
// any inline migration.
//
// Records the rewrite decision into action-log so trust-metrics can
// compute downstream regret/interrupt rates.
//
// Latency budget: Decision.budget_ms (5s..300s). Rule path is ~10ms;
// LLM fallback (when wired) MUST cap at min(budget_ms, 2s) and cancel.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let _vlog;
function vlog() {
  if (_vlog) return _vlog;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-log.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-log.js'),
  ]) { try { _vlog = require(p); return _vlog; } catch {} }
  _vlog = { info: () => {}, warn: () => {}, error: () => {} };
  return _vlog;
}

function _resolveBin(name) {
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', name),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', name),
    path.join(__dirname, '..', 'bin', name),
  ]) { if (fs.existsSync(p)) return p; }
  return null;
}

function _empty() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '',
    },
  }));
  process.exit(0);
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => stdinBuf += c);
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(stdinBuf || '{}'); } catch { return _empty(); }

  const prompt = payload.prompt || '';
  const sessionId = payload.session_id || null;
  const cwd = payload.cwd || process.cwd();

  if (!prompt.trim()) return _empty();

  // Resolve executor bin and call it directly (in-process).
  const executorPath = _resolveBin('vanta-executor.js');
  if (!executorPath) return _empty();

  let executor;
  try { executor = require(executorPath); } catch (err) {
    vlog().error('prompt-rewriter.load', err.message || String(err));
    return _empty();
  }

  let decision;
  try {
    decision = executor.decide({ prompt, session_id: sessionId, cwd });
  } catch (err) {
    vlog().error('prompt-rewriter.decide', err.message || String(err));
    return _empty();
  }

  // ── 1. ASK at T3 (safety-floor or rewriter-ask) — surface a single
  //       "/<route> recommended · T3 ASK · <why>" hint. Never inject a
  //       chain — the user must confirm before Vanta does anything.
  if (decision.decision === 'ask') {
    const route = decision.skill_route || '/council';
    const why = decision.floor && decision.floor.why
      ? decision.floor.why
      : (decision.why || decision.intent || 'product decision');
    const ask = `[Vanta] ${route} recommended · ${decision.tier} ASK · ${why}`;
    _logAction({ session_id: sessionId, cwd, action: 'rewrite-ask',
      decision: 'ask', why: decision.why || ('ask:' + (decision.intent || decision.source)),
      subject: prompt.slice(0, 80), tier: decision.tier });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ask,
      },
    }));
    return process.exit(0);
  }

  // ── 2. Rewrite (T0/T1/T2 + rewriter rule) — inject the terse 4-line
  //       shadow:
  //         [Vanta] /<route> · <intent>
  //         1. step
  //         2. step
  //         3. step
  //
  //       v3.7.4: when trust thresholds clear (`inline_ready`), prepend
  //       a single "[Vanta INLINE]" marker so the user can see the
  //       state transition. The actual mode flip (replace prompt vs
  //       inject context) lands in v3.8.
  if (decision.decision === 'rewrite' && decision.rewritten) {
    const tag = decision.inline_ready ? '[Vanta INLINE]' : '[Vanta]';
    const header = `${tag} ${decision.skill_route || '/' + (decision.intent || 'review')} · ${decision.intent || 'unknown'}`;
    const additionalContext = [header, decision.rewritten].join('\n');
    _logAction({ session_id: sessionId, cwd, action: 'rewrite',
      decision: 'auto', why: decision.why || ('intent=' + decision.intent),
      subject: prompt.slice(0, 80), tier: decision.tier,
      undo_hint: { kind: 'rewriter-shadow', payload: {
        decision_id: decision.decision_id,
        rule_id: decision.rule_id || null,
        skill_route: decision.skill_route || null,
      } } });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }));
    return process.exit(0);
  }

  // ── 3. Auto / passthrough — log silently, inject nothing.
  _logAction({ session_id: sessionId, cwd, action: 'rewrite-skip',
    decision: decision.decision, why: decision.why || decision.intent || 'passthrough',
    subject: prompt.slice(0, 80), tier: decision.tier });
  return _empty();
});

function _logAction(entry) {
  try {
    const al = require(_resolveBin('vanta-action-log.js'));
    al.record(entry);
  } catch { /* never block hook on logging failure */ }
}
