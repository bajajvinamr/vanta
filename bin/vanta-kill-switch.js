#!/usr/bin/env node
// vanta-kill-switch — three-scope shutdown control for the executor.
//
// Scopes (in priority order — lower-numbered wins):
//   1. SESSION  — touch ~/.vanta/runtime/<sid>.paused, valid for that session_id only
//   2. REPO     — touch <repo>/.vanta/paused, valid for that working tree
//   3. GLOBAL   — env VANTA_EXECUTOR=off, valid process-wide
//
// Returns { off: bool, scope, reason }. `off: false` means executor is
// allowed to act; `true` means consumers must degrade to observe-only
// (no auto-execute, no auto-council, no auto-promote).
//
// The kill switch is consulted at the TOP of every auto-action path:
//   - prompt-rewriter (skip rewrite, pass through original)
//   - council-advisory (skip auto-tier-pick)
//   - auto-promote (skip staging-promotion prompt)
//   - autonomy-auto-promote (freeze level)
//
// READS-ONLY ENTRY POINT. Writes happen via pause()/resume() helpers
// or direct `touch` from the user. Never auto-flip.

const fs = require('fs');
const path = require('path');
const os = require('os');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _runtimeDir() { return path.join(_vantaDir(), 'runtime'); }

// Find the active git repo for the cwd (for repo-scope check).
function _repoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Main predicate. Pass { sessionId, cwd } so we can scope-check correctly
// without globals. Both default to env / process.cwd().
//
// Scope priority is session > repo > global. Each scope can independently
// say "off" OR "force-on" (the latter via a `.resumed` marker file). This
// lets a session UN-pause itself even when the global env says off — the
// fix Gemini R1 P4 flagged ("session > repo > global was unidirectional").
function check({ sessionId, cwd } = {}) {
  // 1. Session scope — most specific. Resumed beats paused; both beat
  //    fall-through to lower scopes.
  const sid = sessionId || process.env.CLAUDE_SESSION_ID || null;
  if (sid) {
    const sessionResumed = path.join(_runtimeDir(), `${sid}.resumed`);
    if (fs.existsSync(sessionResumed)) {
      return { off: false, scope: 'session', reason: 'session-resumed' };
    }
    const sessionFile = path.join(_runtimeDir(), `${sid}.paused`);
    if (fs.existsSync(sessionFile)) {
      let reason = 'session-paused';
      try { reason = fs.readFileSync(sessionFile, 'utf8').trim() || reason; } catch {}
      return { off: true, scope: 'session', reason };
    }
  }

  // 2. Repo scope — current working tree.
  const root = _repoRoot(cwd);
  if (root) {
    const repoResumed = path.join(root, '.vanta', 'resumed');
    if (fs.existsSync(repoResumed)) {
      return { off: false, scope: 'repo', reason: 'repo-resumed' };
    }
    const repoFile = path.join(root, '.vanta', 'paused');
    if (fs.existsSync(repoFile)) {
      let reason = 'repo-paused';
      try { reason = fs.readFileSync(repoFile, 'utf8').trim() || reason; } catch {}
      return { off: true, scope: 'repo', reason };
    }
  }

  // 3. Global scope — env var. Only consulted when no session/repo signal.
  const envVal = (process.env.VANTA_EXECUTOR || '').toLowerCase();
  if (envVal === 'off' || envVal === '0' || envVal === 'false') {
    return { off: true, scope: 'global', reason: 'VANTA_EXECUTOR=' + envVal };
  }

  return { off: false };
}

// Pause / resume helpers — for explicit user-driven invocation.
function pauseSession(sid, reason = 'manual pause') {
  if (!sid) throw new Error('pauseSession requires session_id');
  fs.mkdirSync(_runtimeDir(), { recursive: true });
  fs.writeFileSync(path.join(_runtimeDir(), `${sid}.paused`), reason + '\n');
}

function resumeSession(sid) {
  if (!sid) return;
  const f = path.join(_runtimeDir(), `${sid}.paused`);
  try { fs.unlinkSync(f); } catch { /* not paused — fine */ }
}

function pauseRepo(cwd, reason = 'manual pause') {
  const root = _repoRoot(cwd);
  if (!root) throw new Error('pauseRepo: not in a git repo');
  fs.mkdirSync(path.join(root, '.vanta'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vanta', 'paused'), reason + '\n');
}

function resumeRepo(cwd) {
  const root = _repoRoot(cwd);
  if (!root) return;
  try { fs.unlinkSync(path.join(root, '.vanta', 'paused')); } catch { /* not paused */ }
}

// Status summary for vanta-status surface.
function status({ sessionId, cwd } = {}) {
  const c = check({ sessionId, cwd });
  return {
    executor_off: c.off,
    scope: c.scope || null,
    reason: c.reason || null,
    env_var: process.env.VANTA_EXECUTOR || null,
    repo_paused_path: (() => {
      const r = _repoRoot(cwd);
      return r ? path.join(r, '.vanta', 'paused') : null;
    })(),
  };
}

module.exports = { check, status, pauseSession, resumeSession, pauseRepo, resumeRepo };

// CLI for ad-hoc use.
//   vanta-kill-switch check
//   vanta-kill-switch pause-session <sid> [reason]
//   vanta-kill-switch resume-session <sid>
//   vanta-kill-switch pause-repo [reason]
//   vanta-kill-switch resume-repo
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'check':
    case undefined: {
      const c = status();
      process.stdout.write(JSON.stringify(c, null, 2) + '\n');
      process.exit(c.executor_off ? 1 : 0);
    }
    case 'pause-session': {
      const [sid, ...reason] = rest;
      pauseSession(sid, reason.join(' ') || 'cli pause');
      process.stdout.write(`paused session ${sid}\n`);
      break;
    }
    case 'resume-session': {
      resumeSession(rest[0]);
      process.stdout.write(`resumed session ${rest[0]}\n`);
      break;
    }
    case 'pause-repo': {
      pauseRepo(process.cwd(), rest.join(' ') || 'cli pause');
      process.stdout.write(`paused repo ${process.cwd()}\n`);
      break;
    }
    case 'resume-repo': {
      resumeRepo(process.cwd());
      process.stdout.write(`resumed repo ${process.cwd()}\n`);
      break;
    }
    default:
      process.stderr.write(`usage: vanta-kill-switch <check|pause-session SID|resume-session SID|pause-repo|resume-repo>\n`);
      process.exit(2);
  }
}
