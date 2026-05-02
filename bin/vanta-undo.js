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

function _undoFileWrite(payload, opts = {}) {
  if (!payload || !payload.path) return { ok: false, reason: 'missing payload.path' };
  if (!payload.before_sha) {
    return { ok: false, reason: 'no before_sha — cannot reconstruct prior content' };
  }
  // v3.7.3 STATE-CHECK: verify the file is still in the state Vanta
  // wrote. If the user manually edited after Vanta's write, undoing
  // back to before_sha would silently throw away the user's changes.
  // Refuse unless --force.
  //
  // back-compat: payload.after_sha is optional. Old action-log entries
  // recorded before this check don't have after_sha, so we skip the
  // check rather than fail-closed (which would break existing undo).
  if (payload.after_sha && !opts.force) {
    try {
      const dir = path.dirname(payload.path);
      const currentSha = execSync(`git hash-object "${payload.path}"`, {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'],
      }).toString().trim();
      if (currentSha !== payload.after_sha) {
        return {
          ok: false,
          reason:
            `refused — file ${payload.path} has moved on since Vanta wrote it ` +
            `(current ${currentSha.slice(0, 8)} != recorded after_sha ${payload.after_sha.slice(0, 8)}). ` +
            `User may have edited after the Vanta write. Use --force to override.`,
        };
      }
    } catch (err) {
      // hash-object can fail if file no longer exists; that's a state
      // change too. Refuse without --force.
      if (!opts.force) {
        return { ok: false, reason: `state-check failed (${err.message}); pass --force to override` };
      }
    }
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

function _undoFileDelete(payload, opts = {}) {
  if (!payload || !payload.path || !payload.content_b64) {
    return { ok: false, reason: 'missing payload.path or content_b64' };
  }
  // v3.7.3 STATE-CHECK: file was deleted, so it should NOT exist now.
  // If a new file with that path was created by the user (or another
  // process), restoring would silently overwrite it. Refuse unless --force.
  if (fs.existsSync(payload.path) && !opts.force) {
    return {
      ok: false,
      reason:
        `refused — ${payload.path} now exists (was deleted by Vanta, but ` +
        `something else has since created a new file at this path). ` +
        `Use --force to overwrite.`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(payload.path), { recursive: true });
    fs.writeFileSync(payload.path, Buffer.from(payload.content_b64, 'base64'));
    return { ok: true, kind: 'file-delete', restored: payload.path };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Refuse SHA values shorter than this — `head.startsWith("")` is true
// (empty-sha bypass found in council R1, P1).
const MIN_SHA_LEN = 7;

// Branches we refuse to rewrite history on. Extended in v3.6.20 from
// just main/master after R1: long-lived release branches share history
// with deployments and must not be reset --soft from automation.
const PROTECTED_BRANCH_RX = /^(main|master|release\/.*|hotfix\/.*|prod|production)$/;

function _undoGitCommit(payload) {
  if (!payload || !payload.sha) return { ok: false, reason: 'missing payload.sha' };
  if (typeof payload.sha !== 'string' || payload.sha.length < MIN_SHA_LEN) {
    return { ok: false, reason: `refused — payload.sha must be ≥${MIN_SHA_LEN} chars (got ${payload.sha.length}). Empty / short SHA can match anything.` };
  }
  // Refuse on protected branches AND on detached HEAD (detached HEAD
  // returns "HEAD" from --abbrev-ref, which doesn't match any branch
  // guard and was a R1 bypass vector).
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (branch === 'HEAD') {
      return { ok: false, reason: 'refused — detached HEAD. Check out a branch before undoing.' };
    }
    if (PROTECTED_BRANCH_RX.test(branch)) {
      return { ok: false, reason: `refused — current branch is ${branch} (protected). Use git revert manually.` };
    }
  } catch {}
  // Verify commit is HEAD via FULL-sha resolution (rev-parse the stored
  // payload.sha to its canonical 40-char id, then exact-compare). This
  // closes the prefix-collision angle Codex flagged in R1.
  try {
    const head = execSync('git rev-parse HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    let resolved;
    try {
      resolved = execSync(`git rev-parse --verify ${payload.sha}^{commit}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return { ok: false, reason: `refused — payload.sha ${payload.sha.slice(0,8)} could not be resolved to a unique commit.` };
    }
    if (resolved !== head) {
      return { ok: false, reason: `refused — commit ${payload.sha.slice(0,8)} (resolved ${resolved.slice(0,8)}) is not HEAD (${head.slice(0,8)}). Use git revert manually for non-HEAD commits.` };
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

function undo({ action, subject, force } = {}) {
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
  // v3.7.3: pass force flag through to reversers that support it
  // (file-write + file-delete state-checks).
  const result = reverser(target.undo_hint.payload || {}, { force: !!force });
  // Record the undo attempt regardless of outcome — trust-metrics
  // counts undo events whether they succeed or not (success is gravy).
  // R1 P2 (Codex): target the undo by stable id, not by ts+subject. Subject
  // attribution over-counted because one undo on `foo.ts` matched every
  // recent action on `foo.ts` — the trust-metric undo_24h spiked falsely
  // and triggered autonomy demotion oscillation.
  try {
    al.record({
      session_id: target.session_id,
      project: target.project,
      action: 'undo',
      decision: 'auto',
      why: result.ok ? `reversed ${target.action}` : `attempt failed: ${result.reason}`,
      subject: target.subject,
      undo_hint: { kind: 'undo', payload: {
        targets_action_id: target.id || null,
        targets_action_ts: target.ts,
        targets_action: target.action,
      } },
    });
  } catch (err) { vlog().error('undo.record', err.message); }

  // v3.8.1 — explicit trust-cache invalidation. The executor caches
  // trust-metrics per project for 15s; an undo is a regret signal that
  // should drop trust immediately, not wait for the TTL. Lazy-loaded so
  // a stale or missing executor doesn't break the undo path.
  try {
    const ex = _resolveExecutor();
    if (ex && typeof ex.invalidateTrustCache === 'function') {
      ex.invalidateTrustCache(target.project || null);
    }
  } catch (err) {
    try { vlog().warn('undo.cache-invalidate', err.message || String(err)); }
    catch (_) { /* never let logging break undo */ }
  }
  return { ...result, target };
}

// Lazy-resolve the executor module so vanta-undo stays loadable even
// in degraded environments where the executor isn't deployed yet.
let _executorMod;
function _resolveExecutor() {
  if (_executorMod !== undefined) return _executorMod;  // including null
  for (const p of [
    require('path').join(require('os').homedir(), '.claude', 'bin', 'vanta-executor.js'),
    require('path').join(__dirname, 'vanta-executor.js'),
    require('path').join(require('os').homedir(), 'Projects', 'vanta', 'bin', 'vanta-executor.js'),
  ]) {
    try {
      _executorMod = require(p);
      return _executorMod;
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND') continue;
      try { vlog().warn('undo.executor-load', `${p}: ${err.message || String(err)}`); }
      catch (_) { /* never let logging break load */ }
    }
  }
  _executorMod = null;
  return null;
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
  const force = args.includes('--force');
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

  const out = undo({ action, subject, force });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.ok ? 0 : 1);
}
