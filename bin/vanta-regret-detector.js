#!/usr/bin/env node
// vanta-regret-detector — surface SILENT regret across sessions.
//
// undo_within_2m_rate (in trust-metrics) catches obvious regret: user
// hits undo within 2min of an auto-action. The HARDER signal is silent
// regret:
//   - User reverts the change next session (>1d later)
//   - User edits the same line back to original (semantic undo, no
//     git revert)
//   - User adds a `// no, actually...` comment near the auto-action
//
// This module scans git history for files Vanta touched in the last
// N days and looks for inverse edits. Surfaces a regret signal that
// trust-metrics + autonomy-promote consume.
//
// Runs at session-start (lightweight version: last 7d, capped to 50
// files). Full scans are CLI-only (`vanta-regret-detector --full`).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const al = require('./vanta-action-log');

let _vlog;
function vlog() {
  if (_vlog) return _vlog;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-log.js'),
    path.join(__dirname, 'vanta-log.js'),
  ]) { try { _vlog = require(p); return _vlog; } catch {} }
  _vlog = { info: () => {}, warn: () => {}, error: () => {} };
  return _vlog;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Scan action-log for file-write/auto-edit entries with a subject
// (file path) in the last N days. Cap at maxFiles to keep runtime
// bounded for session-start use.
function _vantaTouchedFiles({ days = 7, maxFiles = 50 } = {}) {
  const sinceMs = Date.now() - days * ONE_DAY_MS;
  const entries = al.read({ sinceMs });
  const touched = new Map();  // file -> { ts, action }
  for (const e of entries) {
    if (!e.subject || !e.subject.includes('/')) continue;  // path-shaped only
    if (!['auto-edit', 'file-write'].includes(e.action)) continue;
    if (!touched.has(e.subject)) {
      touched.set(e.subject, { ts: e.ts, action: e.action, project: e.project });
    }
  }
  return [...touched.entries()].slice(0, maxFiles).map(([file, meta]) => ({ file, ...meta }));
}

// Did the user edit `file` after vanta touched it (per `since`)?
// We check `git log` for commits authored after that ts that touched
// the file. Returns array of { sha, author_ts, message }.
// P0 shell-injection fix: use execFileSync with explicit arg arrays instead of
// execSync with template literals. action-log paths (file) are user-controlled;
// template-literal interpolation into /bin/sh strings is an injection vector.
const SHA_RE = /^[0-9a-f]{40}$/;

function _userEditsAfter(file, sinceTs) {
  try {
    const dir = path.dirname(file);
    const since = new Date(sinceTs).toISOString();
    const out = execFileSync(
      'git',
      ['log', `--since=${since}`, '--format=%H|%cI|%s', '--', file],
      { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      const [sha, author_ts, ...msgParts] = line.split('|');
      return { sha, author_ts, message: msgParts.join('|') };
    });
  } catch { return []; }
}

// Heuristic: look for "regret-shaped" commit messages — `revert`,
// `undo`, `actually`, `wrong`, `instead`, `not what i wanted`.
const REGRET_MSG_RX = /\b(revert|undo|actually|wrong|instead|not\s+what.{0,30}wanted|no.{0,5}we|nope)\b/i;

function _isRegretCommit(commit) {
  return REGRET_MSG_RX.test(commit.message);
}

// Detect inverse edits: lines that were `+` in vanta's diff and are
// now `-` in the user's commit. Quick approximation — we ask git for
// the diff between vanta's state (parent commit at vanta-touch time)
// and the user's commit, and look for edits to lines vanta added.
//
// For session-start use we don't need the precise "this exact line
// was reverted" — we just need a fast signal. We compute a Jaccard-ish
// score: pct of vanta's added lines that no longer exist post-user-commit.
function _silentRevertScore(file, vantaTs, userCommit) {
  try {
    // Validate SHAs before use — both come from git output but defense-in-depth.
    if (userCommit.sha && !SHA_RE.test(userCommit.sha)) return 0;
    const dir = path.dirname(file);
    const vantaCommit = execFileSync(
      'git',
      ['log', `--before=${new Date(vantaTs).toISOString()}`, '--format=%H', '-1', '--', file],
      { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
    if (!vantaCommit || !SHA_RE.test(vantaCommit)) return 0;
    const diff = execFileSync(
      'git',
      ['diff', vantaCommit, userCommit.sha, '--', file],
      { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString();
    if (!diff) return 0;
    // Count deletion lines vs addition lines as a coarse signal of
    // revert-shape (lots of deletions, few additions).
    const additions = (diff.match(/^\+[^+]/gm) || []).length;
    const deletions = (diff.match(/^-[^-]/gm) || []).length;
    if (additions + deletions === 0) return 0;
    return deletions / (additions + deletions);
  } catch { return 0; }
}

// Public: scan + return regret signals.
//
// Each signal: { file, vanta_ts, user_commit_sha, message, regret_score, kind }
// kind ∈ 'message' (regret-shaped commit msg) | 'silent' (high revert score)
//      | 'both' (msg AND high score)
function detect({ days = 7, maxFiles = 50, silentThreshold = 0.7 } = {}) {
  const touched = _vantaTouchedFiles({ days, maxFiles });
  const signals = [];
  for (const t of touched) {
    if (!fs.existsSync(t.file)) continue;
    const userCommits = _userEditsAfter(t.file, t.ts);
    for (const c of userCommits) {
      const msgRegret = _isRegretCommit(c);
      const silentScore = _silentRevertScore(t.file, t.ts, c);
      const isSilent = silentScore >= silentThreshold;
      if (!msgRegret && !isSilent) continue;
      signals.push({
        file: t.file,
        project: t.project,
        vanta_ts: t.ts,
        user_commit_sha: c.sha,
        user_commit_ts: c.author_ts,
        message: c.message,
        silent_score: Math.round(silentScore * 100) / 100,
        kind: msgRegret && isSilent ? 'both' : (msgRegret ? 'message' : 'silent'),
      });
    }
  }
  return signals;
}

// Roll-up for trust-metrics consumption.
function regretRate({ days = 7 } = {}) {
  const touched = _vantaTouchedFiles({ days, maxFiles: 1000 });
  const sigs = detect({ days });
  const regretted = new Set(sigs.map(s => s.file));
  const total = touched.length;
  if (total === 0) return { rate: 0, n: 0, regretted: 0 };
  return { rate: regretted.size / total, n: total, regretted: regretted.size };
}

module.exports = { detect, regretRate };

// CLI:
//   vanta-regret-detector              — scan last 7d, default thresholds
//   vanta-regret-detector --days 30
//   vanta-regret-detector --json
//   vanta-regret-detector --rate       — just print the rate signal
if (require.main === module) {
  const args = process.argv.slice(2);
  const find = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const days = parseInt(find('--days') || '7', 10);
  const json = args.includes('--json');
  if (args.includes('--rate')) {
    const r = regretRate({ days });
    process.stdout.write(json ? JSON.stringify(r, null, 2) + '\n' : `regret_rate=${(r.rate * 100).toFixed(1)}% (${r.regretted}/${r.n})\n`);
    process.exit(0);
  }
  const sigs = detect({ days });
  if (json) {
    process.stdout.write(JSON.stringify(sigs, null, 2) + '\n');
  } else {
    if (sigs.length === 0) {
      process.stdout.write(`no regret signals in last ${days}d\n`);
      process.exit(0);
    }
    process.stdout.write(`${sigs.length} regret signals (last ${days}d):\n`);
    for (const s of sigs) {
      process.stdout.write(`  [${s.kind}] ${s.file}\n    vanta @ ${s.vanta_ts}, user @ ${s.user_commit_ts} (${s.user_commit_sha.slice(0, 8)})\n    msg: ${s.message}\n    silent_score: ${s.silent_score}\n`);
    }
  }
}
