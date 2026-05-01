#!/usr/bin/env node
// vanta-undo — reverse the most recent Vanta auto-action.
//
// Reads action-log, finds the most recent reversible entry (or one
// matching --action / --subject), and applies its undo_hint inverse.
//
// undo_hint shapes (writer-defined):
//   { kind: 'rewriter-shadow',  payload: {...} }  -- nothing to undo (shadow rewrite is informational)
//   { kind: 'file-write',       payload: { path, before_sha, after_sha } }
//   { kind: 'file-delete',      payload: { path, content_b64 } }
//   { kind: 'git-commit',       payload: { sha } }
//   { kind: 'memory-promote',   payload: { entry_id, prior_text? } }
//   { kind: 'autonomy-promote', payload: { repo, prior_level, new_level } }
//
// The undo command itself is recorded as a new action-log entry with
// action='undo' and undo_hint.targets_action_id pointing at the entry
// being reversed. trust-metrics's undo_within_2m_rate consumes this.
//
// Safety: vanta-undo NEVER re-runs Bash, NEVER touches main/master
// branches, and NEVER undoes a 'risk-classify' or 'rewrite' (those
// are informational — there's nothing to reverse).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

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

const NOT_REVERSIBLE = new Set([
  'rewrite',         // shadow-mode informational
  'rewrite-skip',
  'risk-classify',   // pure metadata
  'undo',            // can't undo an undo
]);

// ─── Per-kind reversers ─────────────────────────────────────────────────────

function _undoFileWrite(payload) {
  if (!payload || !payload.path) return { ok: false, reason: 'missing payload.path' };
  if (!payload.before_sha) {
    return { ok: false, reason: 'no before_sha — cannot reconstruct prior content' };
  }
  // We require the file to be a git-tracked file with the before_sha
  // present in `git cat-file`. Otherwise we don't know what to restore.
  try {
    const dir = path.dirname(payload.path);
    const before = execSync(`git cat-file -p ${payload.before_sha}`, {
      cwd: dir, stdio: ['pipe', 'pipe', 'ignore'],
    });
    fs.writeFileSync(payload.path, before);
    return { ok: true, kind: 'file-write', restored: payload.path };
  } catch (err) {
    return { ok: false, reason: `git cat-file failed: ${err.message}` };
  }
}

function _undoFileDelete(payload) {
  if (!payload || !payload.path || !payload.content_b64) {
    return { ok: false, reason: 'missing payload.path or content_b64' };
  }
  try {
    fs.mkdirSync(path.dirname(payload.path), { recursive: true });
    fs.writeFileSync(payload.path, Buffer.from(payload.content_b64, 'base64'));
    return { ok: true, kind: 'file-delete', restored: payload.path };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function _undoGitCommit(payload) {
  if (!payload || !payload.sha) return { ok: false, reason: 'missing payload.sha' };
  // Refuse to undo on main/master (safety floor — never touch shared history).
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (branch === 'main' || branch === 'master') {
      return { ok: false, reason: `refused — current branch is ${branch} (mainline). Use git revert manually.` };
    }
  } catch {}
  // Verify commit is HEAD (safest case — only reverse the immediate previous commit).
  try {
    const head = execSync('git rev-parse HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (!head.startsWith(payload.sha) && !payload.sha.startsWith(head)) {
      return { ok: false, reason: `refused — commit ${payload.sha.slice(0,8)} is not HEAD (got ${head.slice(0,8)}). Use git revert manually for non-HEAD commits.` };
    }
    execSync('git reset --soft HEAD~1', { stdio: ['pipe', 'pipe', 'ignore'] });
    return { ok: true, kind: 'git-commit', sha: payload.sha };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function _undoMemoryPromote(payload) {
  // For staged-invariant promotion: the staging file gets re-populated.
  // We can't fully reverse promotion to the global invariants file
  // (user-curated). Emit a warning + leave the entry; record this as a
  // partial undo so trust-metrics counts it.
  return {
    ok: false,
    reason: 'memory-promote is partially-reversible — manually edit ' +
            '~/.claude/rules/vinamr-invariants.md to remove the entry. ' +
            (payload && payload.prior_text ? 'Prior text was: ' + payload.prior_text.slice(0, 200) : ''),
  };
}

function _undoAutonomyPromote(payload) {
  if (!payload || !payload.repo || !payload.prior_level) return { ok: false, reason: 'missing payload.repo / prior_level' };
  // Caller passes the repo path; we write back the prior level.
  try {
    const cfg = path.join(payload.repo, '.vanta', 'config.yaml');
    if (!fs.existsSync(cfg)) {
      fs.mkdirSync(path.join(payload.repo, '.vanta'), { recursive: true });
    }
    const content = `level: ${payload.prior_level}\n`;
    fs.writeFileSync(cfg, content);
    return { ok: true, kind: 'autonomy-promote', restored_level: payload.prior_level };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const REVERSERS = {
  'file-write':       _undoFileWrite,
  'file-delete':      _undoFileDelete,
  'git-commit':       _undoGitCommit,
  'memory-promote':   _undoMemoryPromote,
  'autonomy-promote': _undoAutonomyPromote,
};

// ─── Main ────────────────────────────────────────────────────────────────────

function findTarget({ action, subject, before } = {}) {
  // Default: most recent reversible action.
  return al.findLast(e => {
    if (NOT_REVERSIBLE.has(e.action)) return false;
    if (action && e.action !== action) return false;
    if (subject && e.subject !== subject) return false;
    if (before && Date.parse(e.ts) >= before) return false;
    if (!e.undo_hint) return false;
    return true;
  });
}

function undo({ action, subject } = {}) {
  const target = findTarget({ action, subject });
  if (!target) {
    return { ok: false, reason: 'no recent reversible action found' };
  }
  const reverser = REVERSERS[(target.undo_hint && target.undo_hint.kind) || ''];
  if (!reverser) {
    return {
      ok: false,
      reason: `no reverser for kind "${target.undo_hint && target.undo_hint.kind}"`,
      target,
    };
  }
  const result = reverser(target.undo_hint.payload || {});
  // Record the undo attempt regardless of outcome — trust-metrics
  // counts undo events whether they succeed or not (success is gravy).
  try {
    al.record({
      session_id: target.session_id,
      project: target.project,
      action: 'undo',
      decision: 'auto',
      why: result.ok ? `reversed ${target.action}` : `attempt failed: ${result.reason}`,
      subject: target.subject,
      undo_hint: { kind: 'undo', payload: { targets_action_ts: target.ts, targets_action: target.action } },
    });
  } catch (err) { vlog().error('undo.record', err.message); }
  return { ...result, target };
}

module.exports = { undo, findTarget };

// CLI:
//   vanta-undo                    — undo most recent reversible action
//   vanta-undo --action auto-edit — undo most recent of that type
//   vanta-undo --subject foo.ts   — undo most recent action on that subject
//   vanta-undo --dry              — show what would be undone without doing it
if (require.main === module) {
  const args = process.argv.slice(2);
  const find = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dry = args.includes('--dry');
  const action = find('--action');
  const subject = find('--subject');

  if (dry) {
    const t = findTarget({ action, subject });
    if (!t) {
      process.stdout.write('no candidate to undo\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(t, null, 2) + '\n');
    process.exit(0);
  }

  const out = undo({ action, subject });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.ok ? 0 : 1);
}
