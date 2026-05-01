#!/usr/bin/env node
// prompt-context — UserPromptSubmit hook.
//
// Codex council P1 fix (always-on layer): the only Claude Code primitive
// that fires on every user prompt is UserPromptSubmit. This hook injects
// a 3-line Vanta brief into the model's context BEFORE the model sees the
// prompt, but only when:
//   1. The prompt classifies into a Vanta-relevant phase (build/debug/ship/recall/plan)
//   2. We aren't already on cooldown for the same (phase, topic) shape in
//      this session — runtime-state is the dedupe brain
//   3. The resolver actually has something sharp to add
//
// Otherwise: silent. Vanta-as-noise is the failure mode this hook exists
// to prevent. Better to skip an inject than to spam.
//
// Hook protocol (Claude Code UserPromptSubmit):
//   stdin:  { session_id, transcript_path, cwd, hook_event_name, prompt }
//   stdout: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
//                                   additionalContext: '...' } }
//   exit 0 always (this hook never blocks a prompt — that would be hostile)

const path = require('path');
const os = require('os');

let _runtimeState = null;
let _promptBrief = null;
let _vlog = null;

// Lazy-load helpers — avoids slow startup when prompt is short / unrelated.
function rs() {
  if (_runtimeState !== null) return _runtimeState;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-runtime-state.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-runtime-state.js'),
  ]) { try { _runtimeState = require(p); break; } catch {} }
  return _runtimeState;
}
function pb() {
  if (_promptBrief !== null) return _promptBrief;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-prompt-brief.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-prompt-brief.js'),
  ]) { try { _promptBrief = require(p); break; } catch {} }
  return _promptBrief;
}
function vlog() {
  if (_vlog !== null) return _vlog;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-log.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-log.js'),
  ]) { try { _vlog = require(p); break; } catch {} }
  if (!_vlog) _vlog = { error: () => {}, info: () => {} };
  return _vlog;
}

// Codex council R7 P2 fix — share slug computation across hooks.
let _projectsModule = null;
function projectsModule() {
  if (_projectsModule !== null) return _projectsModule;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-projects.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-projects.js'),
  ]) { try { _projectsModule = require(p); break; } catch {} }
  return _projectsModule;
}
function getProjectSlug(cwd) {
  const m = projectsModule();
  if (m && m.slugFromCwd) {
    const slug = m.slugFromCwd(cwd || process.cwd());
    if (slug) return slug;
  }
  // Fall back to basename only as last resort. May collide across projects
  // with the same name; resolver project-filter will keep impact bounded.
  return path.basename(String(cwd || process.cwd()));
}

async function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => buf += c);
    process.stdin.on('end', () => resolve(buf));
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw) { process.exit(0); }

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const sessionId = data.session_id;
  const prompt = data.prompt || '';
  const cwd = data.cwd || process.cwd();
  if (!sessionId || !prompt || prompt.length < 8) process.exit(0);

  const state = rs();
  const brief = pb();
  if (!state || !brief) process.exit(0);  // bins not deployed yet — degrade silently

  // Bump prompt counter — useful telemetry for "how busy is this session"
  try { state.bump(sessionId, 'prompt_count'); } catch {}

  // Classify prompt to set phase. Always set phase even if we don't inject —
  // other hooks (tool-observer) can read it.
  const phase = brief.classify(prompt);
  try { state.setPhase(sessionId, phase); } catch {}

  if (phase === 'unknown' || phase === 'review') process.exit(0);

  const key = `prompt-context:${brief.shapeKey(prompt)}`;
  let canInject;
  try { canInject = state.shouldInject(sessionId, key); } catch { canInject = true; }
  if (!canInject) process.exit(0);

  let detail;
  try {
    detail = brief.buildBriefDetail({ prompt, slug: getProjectSlug(cwd), cwd });
  } catch (e) {
    vlog().error('prompt-context', e && e.message || String(e));
    process.exit(0);
  }
  if (!detail || !detail.line) process.exit(0);
  let output = detail.line;

  // R6 P3 — contradiction dedup. Both prompt-context and council-advisory
  // can detect the same contradiction (ES256/HS256 etc). Without dedup
  // the user sees the warning twice in the same response. Gate via
  // runtime-state cooldown — first hook to see it claims the slot for
  // 10 minutes; the second stays silent on that contradiction.
  if (detail.contradictions && detail.contradictions.length > 0) {
    const c = detail.contradictions[0];
    const tokens = (c.tokens || []).slice().sort().join('-').toLowerCase();
    const cKey = `contradiction-shown:${tokens || c.hint.slice(0, 30)}`;
    let canShow;
    try { canShow = state.shouldInject(sessionId, cKey); } catch { canShow = true; }
    if (canShow) {
      try { state.markInjected(sessionId, cKey); } catch {}
      output += `\n  ⚠ contradiction: ${String(c.hint).slice(0, 120)}`;
    }
  }

  // Mark injected BEFORE writing output — write failure shouldn't cause
  // a duplicate inject on the next prompt with the same shape.
  try { state.markInjected(sessionId, key); } catch {}

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: output,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch(e => {
  // Hooks must NEVER throw — fail open, never block the prompt.
  try { vlog().error('prompt-context', e && e.message || String(e)); } catch {}
  process.exit(0);
});
