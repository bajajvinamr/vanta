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

// v3.9.0 — emit a structured shadow injection and exit. Used by the
// intent-handler chain (safe-mode, stop, undo, reroute) which short-
// circuit the rewriter when they detect their trigger phrases.
function _emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: additionalContext || '',
    },
  }));
  process.exit(0);
}

// Best-effort require helper for v3.9.0 intent modules. Distinguishes
// MODULE_NOT_FOUND (degraded mode is OK) from runtime errors (loud
// warning so a syntax error in a handler doesn't silently revert the
// hook to old behavior). Mirrors the executor + projects-load pattern.
function _tryLoad(name) {
  const p = _resolveBin(name);
  if (!p) return null;
  try { return require(p); }
  catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') {
      try { vlog().warn(`prompt-rewriter.${name}-load`,
        `${p}: ${err && err.message ? err.message : String(err)}`); }
      catch (_) { /* never let logging break the hook */ }
    }
    return null;
  }
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

  // v3.8.0 council P2 fix — derive project slug from cwd so action-log
  // entries from this hook count toward project-scoped trust metrics.
  // Without this, `vanta-trust-metrics.compute({project})` filters out
  // every rewrite event and inline_ready never earns a project signal.
  //
  // R3 fix — delegate to vanta-projects.slugFromCwd(), which walks up
  // to the git repo root before slugging. Without this, monorepo
  // subdirs (`/repo/packages/api`) get slug `api` instead of `repo`,
  // and trust signals fragment across the workspace. The executor uses
  // the same helper (bin/vanta-executor.js _canonProjectFromCwd) — keep
  // them in sync.
  // v3.8.1 hardening — distinguish "vanta-projects.js absent from this
  // install" (fall through silently — degraded mode is OK) from
  // "vanta-projects.js exists but failed to load" (loud warning — a
  // syntax/runtime error in the helper would otherwise revert the
  // hook to old broken basename slugging with no signal). Mirrors the
  // executor's _resolve() hardening.
  let project = null;
  const projectsPath = _resolveBin('vanta-projects.js');
  if (projectsPath) {
    try {
      const projectsMod = require(projectsPath);
      if (typeof projectsMod.slugFromCwd === 'function') {
        project = projectsMod.slugFromCwd(cwd) || null;
      } else if (typeof projectsMod.canonProject === 'function') {
        const slug = path.basename(cwd);
        project = projectsMod.canonProject(slug) || slug;
      }
    } catch (err) {
      // _resolveBin already confirmed the file exists, so this
      // catch only fires on syntax/runtime errors at load — exactly
      // the silent-downgrade case Codex R3 P3 flagged. Log via vlog
      // so the warning lands in the structured Vanta log, not the
      // user's prompt context (which would leak hook internals).
      try { vlog().warn('prompt-rewriter.projects-load',
        `${projectsPath}: ${err && err.message ? err.message : String(err)}`); }
      catch (_) { /* never let logging break the hook */ }
    }
  }
  if (!project) project = path.basename(cwd);

  // v3.9.0 intent-handler chain — short-circuits BEFORE the rewriter.
  // Order is precedence (safe-mode is outermost because it's a toggle,
  // not an action consumer; stop/undo/reroute all relate to in-flight
  // state and should bypass the rewriter entirely when they fire).
  // Each handler is wrapped in its own try/catch so a runtime error in
  // one handler doesn't cascade into the others or break the rewriter.
  //
  // Surface Impact Discipline: this adds NO new commands. The user's
  // natural language ("be careful", "stop", "undo that", "actually X")
  // is detected and routed; the three-command promise is preserved.

  // 1. Safe mode — toggle. detectEngage / detectExit fire on tight
  //    patterns ("safe mode on", "back to normal"). When fired, we
  //    inject the message and short-circuit. When the prompt does not
  //    match either pattern, handle() returns kind='noop' and we fall
  //    through to the next layer.
  try {
    const safe = _tryLoad('vanta-safe-mode.js');
    if (safe && typeof safe.handle === 'function') {
      const sm = safe.handle({ project, prompt });
      if (sm && (sm.kind === 'engaged' || sm.kind === 'exited')) {
        return _emit(sm.message);
      }
    }
  } catch (err) { try { vlog().warn('prompt-rewriter.safe-mode', err && err.message ? err.message : String(err)); } catch (_) {} }

  // 2. Stop — "stop", "halt", "abort", "nevermind". Halts the most
  //    recent pending action (two-phase claim → finalize). Any detect()
  //    hit short-circuits — even if nothing is in flight, we still tell
  //    the user we caught the signal.
  try {
    const stop = _tryLoad('vanta-intent-stop.js');
    if (stop && typeof stop.detect === 'function' && stop.detect(prompt)) {
      const r = stop.handle({ project, session: sessionId, prompt });
      return _emit((r && r.message) || '[Vanta blocked] Stopped.');
    }
  } catch (err) { try { vlog().warn('prompt-rewriter.stop', err && err.message ? err.message : String(err)); } catch (_) {} }

  // 3. Undo — "undo", "revert that", "roll back". Finds reversible
  //    actions in the last 30min and either applies the inverse (single
  //    candidate) or asks (multiple within 5min ambiguity window).
  try {
    const undo = _tryLoad('vanta-intent-undo.js');
    if (undo && typeof undo.detect === 'function' && undo.detect(prompt)) {
      const r = undo.handle({ project, session: sessionId, prompt });
      let msg = '[Vanta] Undo handled.';
      if (r && r.message) msg = r.message;
      else if (r && r.kind === 'apply' && r.result && r.result.message) msg = r.result.message;
      return _emit(msg);
    }
  } catch (err) { try { vlog().warn('prompt-rewriter.undo', err && err.message ? err.message : String(err)); } catch (_) {} }

  // 4. Re-route — "actually X", "wait X instead", "no, X". Halts the
  //    in-flight action and pivots to the new intent. Falls through if
  //    the replacement doesn't match a known route (handler ASKs).
  try {
    const reroute = _tryLoad('vanta-intent-reroute.js');
    if (reroute && typeof reroute.detect === 'function' && reroute.detect(prompt)) {
      const r = reroute.handle({ project, session: sessionId, prompt });
      return _emit((r && r.message) || '[Vanta] Switching route.');
    }
  } catch (err) { try { vlog().warn('prompt-rewriter.reroute', err && err.message ? err.message : String(err)); } catch (_) {} }

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

  // v3.8.2 hidden observability — write a route-quality entry on every
  // prompt that hit the executor. Two streams:
  //   1. route-quality.jsonl — one entry per decide() call (the routing
  //      snapshot); later_undo / user_followed_route fields backfilled
  //      by undo + sync over the decision_id.
  //   2. manual-recalls.jsonl — only if the prompt started with a
  //      non-/vanta slash command (user bypassed routing).
  // Best-effort, never blocks. Both writers are no-ops if their module
  // is unavailable.
  _logRouteQuality({
    decision_id: decision.decision_id,
    prompt,
    detected_intent: decision.intent,
    confidence: decision.confidence,
    top1_top2_margin: decision.top1_top2_margin,
    n_candidates: decision.n_candidates,
    suggested_route: decision.skill_route,
    tier: decision.tier,
    decision: decision.decision,
    source: decision.source,
    rewriter_error: decision.rewriter_error || null,
    project,
    session_id: sessionId,
    ts: decision.ts,
  });
  // R1 council fix (Codex+Gemini, both-confirmed): thread decision_id
  // into the recall entry so v3.9.1 can join recall ↔ route-quality
  // when backfilling user_used_different_command on the matching row.
  _logManualRecall({
    prompt,
    project,
    session_id: sessionId,
    decision_id: decision.decision_id,
    ts: decision.ts,
  });

  // ── 1. ASK at T3 (safety-floor or rewriter-ask) — surface a single
  //       "/<route> recommended · T3 ASK · <why>" hint. Never inject a
  //       chain — the user must confirm before Vanta does anything.
  if (decision.decision === 'ask') {
    const route = decision.skill_route || '/council';
    const why = decision.floor && decision.floor.why
      ? decision.floor.why
      : (decision.why || decision.intent || 'product decision');
    const ask = `[Vanta] ${route} recommended · ${decision.tier} ASK · ${why}`;
    _logAction({ session_id: sessionId, cwd, project, action: 'rewrite-ask',
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
    _logAction({ session_id: sessionId, cwd, project, action: 'rewrite',
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
  _logAction({ session_id: sessionId, cwd, project, action: 'rewrite-skip',
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

// v3.8.2 — best-effort route-quality and recall writers. Resolved
// lazily (matching the action-log + projects pattern); a missing
// module degrades the hook to "rewrite without telemetry" rather than
// breaking shadow injection.
function _logRouteQuality(entry) {
  try {
    const rq = require(_resolveBin('vanta-route-quality.js'));
    rq.recordRoute(entry);
  } catch { /* never block hook on logging failure */ }
}
function _logManualRecall(entry) {
  try {
    const rq = require(_resolveBin('vanta-route-quality.js'));
    rq.recordRecall(entry);
  } catch { /* never block hook on logging failure */ }
}
