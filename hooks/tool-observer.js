#!/usr/bin/env node
// tool-observer — universal tool-call telemetry.
//
// Codex council P1 fix (always-on layer): without a generic observer,
// "Vanta is under every tool call" cannot be measured. This hook fires
// PreToolUse + PostToolUse for ALL tool matchers and writes shape-only
// events to ~/.vanta/interactions.jsonl via vanta-interaction-log.
//
// CRITICAL: this hook NEVER blocks a tool call. NEVER injects context.
// NEVER side-effects user-visible behavior. Telemetry only. The
// council-advisory and git-guardrails hooks own the inject/block jobs;
// this one just observes.
//
// Privacy: shapes only — tool name, top-level arg keys, file extension,
// first Bash command verb. Never full file contents, never full commands.
//
// Why two events (pre + post): pre tells us "what was attempted", post
// tells us "did it succeed". The `pre - post` delta is the "tool failed
// silently and never returned" signal.

const path = require('path');
const os = require('os');

let _log = null;
let _state = null;

function logger() {
  if (_log !== null) return _log;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-interaction-log.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-interaction-log.js'),
  ]) { try { _log = require(p); break; } catch {} }
  return _log;
}
function rs() {
  if (_state !== null) return _state;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-runtime-state.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-runtime-state.js'),
  ]) { try { _state = require(p); break; } catch {} }
  return _state;
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
  if (!raw) process.exit(0);

  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }

  const log = logger();
  if (!log) process.exit(0);

  const event = data.hook_event_name === 'PostToolUse' ? 'post' : 'pre';
  const tool = data.tool_name || 'unknown';
  const input = data.tool_input || {};
  const sessionId = data.session_id || 'unknown';

  // Phase from runtime-state if available — UserPromptSubmit hook sets this.
  let phase = 'unknown';
  try { const s = rs(); if (s) phase = s.getState(sessionId).phase || 'unknown'; } catch {}
  try { rs() && rs().bump(sessionId, 'tool_calls'); } catch {}

  const shape = log.shapeOfArgs(tool, input);

  // Post-tool: capture success bit from tool_response (Claude Code provides
  // this). Pre-tool: ok=null (we don't know yet).
  let ok = null;
  if (event === 'post' && data.tool_response) {
    if (data.tool_response.error)         ok = false;
    else if (data.tool_response.is_error) ok = false;
    else                                  ok = true;
  }

  try {
    log.logEvent({
      session_id: sessionId,
      phase,
      event,
      tool,
      key_shape: shape.keys,
      ext: shape.ext,
      bash_verb: shape.bashVerb,
      ok,
      slug: path.basename(data.cwd || process.cwd()),
    });
  } catch { /* never block on log failure */ }

  // No additionalContext — pure observer. Exit 0, output nothing.
  process.exit(0);
}

main().catch(() => process.exit(0));
