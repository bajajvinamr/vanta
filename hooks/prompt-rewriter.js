#!/usr/bin/env node
// UserPromptSubmit hook — surfaces the Vanta rewrite as additional
// context, in shadow mode (Claude sees both original + suggestion).
//
// Hook contract:
//   stdin:  { prompt, session_id, transcript_path, cwd, hook_event_name }
//   stdout: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
//             additionalContext: '<shadow rewrite>' } }
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
// Latency budget: 5s (Claude Code's per-hook budget). Rule-based path
// is ~10ms; LLM fallback (when wired) MUST cap at 2s with cancellation.

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

  // Resolve rewriter bin and call it directly (in-process).
  const rewriterPath = _resolveBin('vanta-rewriter.js');
  if (!rewriterPath) return _empty();

  let rewriter;
  try { rewriter = require(rewriterPath); } catch (err) {
    vlog().error('prompt-rewriter.load', err.message || String(err));
    return _empty();
  }

  let result;
  try {
    result = rewriter.rewrite(prompt, { sessionId, cwd });
  } catch (err) {
    vlog().error('prompt-rewriter.rewrite', err.message || String(err));
    return _empty();
  }

  // Pass-through with safety-floor product-decision: surface the
  // skill route + ASK marker even though we don't inject a chain.
  // Other passthrough cases (lookups, chitchat, kill-switch) inject
  // nothing — keep latency near zero.
  if (result.mode === 'passthrough') {
    _logAction({ session_id: sessionId, cwd, action: 'rewrite-skip',
      decision: 'auto', why: result.why || result.intent || 'passthrough',
      subject: prompt.slice(0, 80) });
    if (result.skill_route && result.tier === 'T3') {
      // Product-decision floor match → 1-line ASK hint.
      const ask = `[Vanta] ${result.skill_route} recommended · ${result.tier} ASK · ${result.floor_match ? result.floor_match.why || result.floor_match.id : 'product decision'}`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: ask,
        },
      }));
      return process.exit(0);
    }
    return _empty();
  }

  // ASK-mode rule (e.g., taxonomy-rename) — never inject a chain;
  // surface a single-line "/council recommended · T3 ASK".
  if (result.mode === 'ask') {
    const ask = `[Vanta] ${result.skill_route || '/council'} recommended · ${result.tier || 'T3'} ASK · ${result.why || result.intent}`;
    _logAction({ session_id: sessionId, cwd, action: 'rewrite-ask',
      decision: 'ask', why: result.why || ('ask:' + result.intent),
      subject: prompt.slice(0, 80), tier: result.tier || 'T3' });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ask,
      },
    }));
    return process.exit(0);
  }

  // Rule rewrite — inject 4 lines max:
  //   [Vanta] /<route> · <intent>
  //   1. step
  //   2. step
  //   3. step
  // Header carries skill_route + intent so the user knows the suggested
  // skill flow. v3.7.1 trim: rewriter._formatChain returns ONLY the
  // numbered steps; the hook owns the single header.
  const header = `[Vanta] ${result.skill_route || '/' + (result.intent || 'review')} · ${result.intent || 'unknown'}`;
  const additionalContext = [header, result.rewritten].join('\n');

  _logAction({ session_id: sessionId, cwd, action: 'rewrite',
    decision: 'auto', why: result.why || ('intent=' + result.intent),
    subject: prompt.slice(0, 80), tier: 'T0',
    undo_hint: { kind: 'rewriter-shadow', payload: { rule_id: result.rule_id || null, skill_route: result.skill_route || null } } });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
  process.exit(0);
});

function _logAction(entry) {
  try {
    const al = require(_resolveBin('vanta-action-log.js'));
    al.record(entry);
  } catch { /* never block hook on logging failure */ }
}
