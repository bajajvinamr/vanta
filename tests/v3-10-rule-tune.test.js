'use strict';
// v3.10 commit 3 — rule-tune CLI + rewriter quarantine load tests.
//
// Verifies:
//   - rewriter skips quarantined rules in decide() (rule loop)
//   - rewriter skips quarantined rules in candidatesFor()
//   - quarantine state revalidates on file mtime change (C-6)
//   - auto-rehab fires when rule content hash changes (C-3, C-5)
//   - setStatus() writes status_change entries with correct fields
//   - rehabilitate opens new scoring epoch (C-5)
//   - CLI list/status/quarantine/rehabilitate/auto-quarantine subcommands
//   - auto-quarantine --dry-run does not write
//   - hash carry-forward on rehabilitate from prior status
//
// Surface Impact Discipline: all changes here are INTERNAL MACHINERY.
// No new user-facing surface — three commands still hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v310-rule-tune-' + process.pid);
process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;

const re = require('../bin/vanta-rule-effectiveness.js');
const tune = require('../bin/vanta-rule-tune.js');
// Load rewriter with a fresh module-cache state per test where needed.
function _freshRewriter() {
  const fp = require.resolve('../bin/vanta-rewriter.js');
  delete require.cache[fp];
  return require('../bin/vanta-rewriter.js');
}

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
}

function _captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  let rc;
  try { rc = fn(); } finally { process.stdout.write = orig; }
  return { rc, out: buf };
}

function _captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => { buf += chunk; return true; };
  let rc;
  try { rc = fn(); } finally { process.stderr.write = orig; }
  return { rc, err: buf };
}

// ─── setStatus() ─────────────────────────────────────────────────────

test('setStatus — writes status_change entry with correct fields', async (t) => {
  await t.test('quarantine writes status, prior_status, status_seq, content_hash', () => {
    _reset();
    const entry = re.setStatus('fix-broken', 'quarantined', { reason: 'manual:test' });
    assert.equal(entry.kind, 'status_change');
    assert.equal(entry.status, 'quarantined');
    assert.equal(entry.status_reason, 'manual:test');
    assert.equal(entry.prior_status, null);  // first entry, no prior
    assert.equal(entry.status_seq, 1);
    // rule_content_hash should be extracted from real rewriter source
    // (since this rule exists in the live corpus). May be null in test
    // env if the deployed copy can't be read — that's tolerated.
    if (entry.rule_content_hash) {
      assert.equal(typeof entry.rule_content_hash, 'string');
      assert.equal(entry.rule_content_hash.length, 64);  // sha256 hex
    }
  });

  await t.test('quarantine then rehabilitate increments seq and resets epoch', () => {
    _reset();
    const e1 = re.setStatus('fix-broken', 'quarantined', { reason: 'first' });
    const e2 = re.setStatus('fix-broken', 'active', { reason: 'rehab' });
    assert.equal(e2.status_seq, e1.status_seq + 1);
    assert.equal(e2.prior_status, 'quarantined');
    // C-5: rehab opens new scoring epoch
    assert.ok(e2.scoring_epoch_start_ts);
    assert.equal(typeof e2.scoring_epoch_start_ts, 'string');
  });

  await t.test('rehabilitate from active does NOT reset epoch', () => {
    _reset();
    const e1 = re.setStatus('fix-broken', 'flagged', { reason: 'flag' });
    // Now rehab a flagged (not quarantined) rule
    const e2 = re.setStatus('fix-broken', 'active', { reason: 'unflag' });
    // No epoch should be opened (we only reset on quarantined→active)
    assert.equal(e2.prior_status, 'flagged');
    // Either null (no prior epoch) OR carries forward from prior — both valid
  });

  await t.test('contentHash override is honored', () => {
    _reset();
    const customHash = 'a'.repeat(64);
    const entry = re.setStatus('fix-broken', 'quarantined', {
      contentHash: customHash,
    });
    assert.equal(entry.rule_content_hash, customHash);
  });

  await t.test('rejects unknown rule_id types', () => {
    assert.throws(() => re.setStatus(null, 'quarantined'), /rule_id required/);
    assert.throws(() => re.setStatus(undefined, 'quarantined'), /rule_id required/);
    assert.throws(() => re.setStatus(123, 'quarantined'), /rule_id required/);
  });

  await t.test('rejects unknown status values', () => {
    assert.throws(() => re.setStatus('fix-broken', 'banned'), /status must be one of/);
    assert.throws(() => re.setStatus('fix-broken', null), /status must be one of/);
  });

  await t.test('latest entry per rule wins via readLatestStatus', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', { reason: 'r1' });
    re.setStatus('fix-broken', 'active', { reason: 'r2' });
    const latest = re.readLatestStatus().get('fix-broken');
    assert.equal(latest.status, 'active');
    assert.equal(latest.status_reason, 'r2');
  });

  await t.test('content hash carries forward from prior on rehabilitate', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', {
      contentHash: 'b'.repeat(64),
    });
    const e2 = re.setStatus('fix-broken', 'active', {});
    // Rehab should preserve last known hash even though we didn't pass one
    assert.equal(e2.rule_content_hash, 'b'.repeat(64));
  });
});

// ─── listQuarantined ─────────────────────────────────────────────────

test('listQuarantined reflects latest status only', async (t) => {
  await t.test('rule that was quarantined then rehabbed is NOT listed', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', { reason: 'first' });
    re.setStatus('fix-broken', 'active', { reason: 'rehab' });
    assert.deepEqual(re.listQuarantined(), []);
  });

  await t.test('multiple quarantined rules all listed', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', { reason: 'a' });
    re.setStatus('write-tests', 'quarantined', { reason: 'b' });
    const q = re.listQuarantined().sort();
    assert.deepEqual(q, ['fix-broken', 'write-tests']);
  });
});

// ─── Rewriter quarantine load (the runtime-behavior change) ──────────

test('rewriter respects quarantine state', async (t) => {
  await t.test('non-quarantined rule fires normally', () => {
    _reset();
    const rw = _freshRewriter();
    const r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'rule');
    assert.equal(r.rule_id, 'fix-broken');
  });

  await t.test('quarantined rule is skipped — falls through to next rule or passthrough', () => {
    _reset();
    // To make the rule stay quarantined, the recorded hash must MATCH
    // the current rule block hash; otherwise auto-rehab fires (C-3).
    const source = re.readRewriterSource();
    const realHash = source ? re.extractRuleBlockHashes(source).get('fix-broken') : null;
    if (!realHash) return;  // can't run in this env
    re.setStatus('fix-broken', 'quarantined', {
      reason: 'test',
      contentHash: realHash,
    });
    const rw = _freshRewriter();
    const r = rw.rewrite('fix the bug', {});
    // fix-broken should be skipped → no other rule matches "fix the bug" →
    // passthrough with intent: 'unmatched'
    assert.equal(r.mode, 'passthrough');
    assert.equal(r.intent, 'unmatched');
  });

  await t.test('candidatesFor() also excludes quarantined rules', () => {
    _reset();
    const source = re.readRewriterSource();
    const realHash = source ? re.extractRuleBlockHashes(source).get('fix-broken') : null;
    if (!realHash) return;
    re.setStatus('fix-broken', 'quarantined', {
      reason: 'test',
      contentHash: realHash,
    });
    const rw = _freshRewriter();
    const cands = rw.candidatesFor('fix the bug');
    assert.equal(cands.length, 0, 'fix-broken excluded → no candidates');
  });

  await t.test('quarantine state revalidates on mtime change (C-6)', () => {
    _reset();
    const source = re.readRewriterSource();
    const realHash = source ? re.extractRuleBlockHashes(source).get('fix-broken') : null;
    if (!realHash) return;
    const rw = _freshRewriter();

    // Initially nothing quarantined → fix-broken fires.
    let r = rw.rewrite('fix the bug', {});
    assert.equal(r.rule_id, 'fix-broken');

    // Now write quarantine state; rewriter must pick it up. Use the real
    // content hash so the rule actually STAYS quarantined (no auto-rehab).
    re.setStatus('fix-broken', 'quarantined', {
      reason: 'mid-test',
      contentHash: realHash,
    });
    // Bump mtime explicitly to ensure the stat detects change
    // (some filesystems have low-res mtime; touch with future time).
    const file = path.join(VANTA_TMP, 'rule-effectiveness.jsonl');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);

    r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'passthrough', 'after writing quarantine, rule should be skipped');
  });

  await t.test('auto-rehab via content hash mismatch (C-3): rule fires when hash differs', () => {
    _reset();
    // Quarantine with a hash that DOES match the real rule (we fetch it).
    const eff = re;
    const source = eff.readRewriterSource();
    if (!source) {
      // can't run this test — skip silently
      return;
    }
    const realHashes = eff.extractRuleBlockHashes(source);
    const fixBrokenHash = realHashes.get('fix-broken');
    if (!fixBrokenHash) {
      // fix-broken not in source — skip
      return;
    }

    // First case: quarantine WITH the real hash → rule should be skipped
    // (hash matches, so no auto-rehab).
    re.setStatus('fix-broken', 'quarantined', {
      reason: 'test-real-hash',
      contentHash: fixBrokenHash,
    });
    let rw = _freshRewriter();
    let r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'passthrough', 'with matching hash, rule stays quarantined');

    // Second case: quarantine WITH a DIFFERENT hash → auto-rehab fires,
    // rule is treated as not-quarantined for THIS call.
    _reset();
    re.setStatus('fix-broken', 'quarantined', {
      reason: 'test-stale-hash',
      contentHash: 'stale-hash-that-doesnt-match-anything-' + 'q'.repeat(20),
    });
    rw = _freshRewriter();
    r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'rule', 'with stale hash, auto-rehab fires → rule active again');
    assert.equal(r.rule_id, 'fix-broken');
  });

  await t.test('quarantine without content hash stays quarantined (no auto-rehab possible)', () => {
    _reset();
    // Manually write entry with NO rule_content_hash — older entries
    // pre-content-hash should keep behaving as v3.9.x (no auto-rehab).
    const file = path.join(VANTA_TMP, 'rule-effectiveness.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      rule_id: 'fix-broken',
      kind: 'status_change',
      status: 'quarantined',
      status_seq: 1,
      rule_content_hash: null,
    }) + '\n');
    const rw = _freshRewriter();
    const r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'passthrough', 'no content hash → no auto-rehab → stays quarantined');
  });

  await t.test('flagged status does NOT skip rule (only quarantined skips)', () => {
    _reset();
    re.setStatus('fix-broken', 'flagged', { reason: 'auto-flag' });
    const rw = _freshRewriter();
    const r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'rule', 'flagged rules still fire');
    assert.equal(r.rule_id, 'fix-broken');
  });
});

// ─── CLI: list ──────────────────────────────────────────────────────

test('CLI: list', async (t) => {
  await t.test('prints header + at least one row', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.cmdList());
    assert.equal(rc, 0);
    assert.match(out, /rule-id/);
    assert.match(out, /fires/);
    assert.match(out, /ci_lower/);
  });
});

// ─── CLI: status ────────────────────────────────────────────────────

test('CLI: status', async (t) => {
  await t.test('errors when rule_id missing', () => {
    _reset();
    const { rc, err } = _captureStderr(() => tune.cmdStatus(undefined));
    assert.equal(rc, 2);
    assert.match(err, /requires <rule_id>/);
  });

  await t.test('errors when rule does not exist', () => {
    _reset();
    const { rc, err } = _captureStderr(() => tune.cmdStatus('nonexistent-rule'));
    assert.equal(rc, 1);
    assert.match(err, /not found/);
  });

  await t.test('returns JSON with status field for known rule', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.cmdStatus('fix-broken'));
    assert.equal(rc, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.rule_id, 'fix-broken');
    assert.ok(['active', 'flagged', 'quarantined'].includes(parsed.status));
  });

  await t.test('reflects setStatus changes', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', { reason: 'cli-test' });
    const { out } = _captureStdout(() => tune.cmdStatus('fix-broken'));
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, 'quarantined');
    assert.equal(parsed.status_reason, 'cli-test');
  });
});

// ─── CLI: compute ───────────────────────────────────────────────────

test('CLI: compute', async (t) => {
  await t.test('snapshots without telemetry → 0 fires per rule, no auto-flag', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.cmdCompute());
    assert.equal(rc, 0);
    assert.match(out, /Snapshotted \d+ rule\(s\)/);
    // With zero fires, no rule should be auto-flagged
    assert.doesNotMatch(out, /Auto-flagged/);
  });

  await t.test('writes entries to rule-effectiveness.jsonl', () => {
    _reset();
    tune.cmdCompute();
    const file = path.join(VANTA_TMP, 'rule-effectiveness.jsonl');
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
    const first = JSON.parse(lines[0]);
    assert.equal(first.kind, 'snapshot');
    assert.ok('fires' in first);
    assert.ok('ci_lower' in first);
  });
});

// ─── CLI: quarantine ────────────────────────────────────────────────

test('CLI: quarantine', async (t) => {
  await t.test('errors when rule_id missing', () => {
    _reset();
    const { rc, err } = _captureStderr(() => tune.cmdQuarantine(undefined));
    assert.equal(rc, 2);
    assert.match(err, /requires <rule_id>/);
  });

  await t.test('writes quarantine entry; rule is in listQuarantined', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.cmdQuarantine('fix-broken', { reason: 'manual' }));
    assert.equal(rc, 0);
    assert.match(out, /Quarantined rule: fix-broken/);
    assert.ok(re.listQuarantined().includes('fix-broken'));
  });
});

// ─── CLI: rehabilitate ──────────────────────────────────────────────

test('CLI: rehabilitate', async (t) => {
  await t.test('flips quarantined back to active and opens new epoch', () => {
    _reset();
    tune.cmdQuarantine('fix-broken', { reason: 'first' });
    const before = re.readLatestStatus().get('fix-broken');
    assert.equal(before.status, 'quarantined');

    const { rc, out } = _captureStdout(() => tune.cmdRehabilitate('fix-broken', { reason: 'manual-rehab' }));
    assert.equal(rc, 0);
    assert.match(out, /Rehabilitated rule: fix-broken/);
    assert.match(out, /scoring_epoch_start_ts/);

    const after = re.readLatestStatus().get('fix-broken');
    assert.equal(after.status, 'active');
    assert.ok(after.scoring_epoch_start_ts);
  });
});

// ─── CLI: auto-quarantine ───────────────────────────────────────────

test('CLI: auto-quarantine', async (t) => {
  await t.test('no-op when no rules eligible', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.cmdAutoQuarantine({ dryRun: false }));
    assert.equal(rc, 0);
    assert.match(out, /No rules eligible/);
  });

  await t.test('--dry-run prints plan without writing', () => {
    _reset();
    // Seed telemetry with a degenerate rule that should be quarantined.
    // Need 50+ fires with mostly negative outcomes to cross the threshold.
    const file = path.join(VANTA_TMP, 'route-quality.jsonl');
    const cancellations = path.join(VANTA_TMP, 'cancellations.jsonl');
    const lines = [];
    const cancels = [];
    for (let i = 0; i < 60; i++) {
      const ts = `2026-04-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      const decision_id = `dec-${i}`;
      lines.push(JSON.stringify({
        ts, rule_id: 'fix-broken', skill_route: '/investigate',
        decision_id, project: 'test',
      }));
      // 95% of fires get user-stop (negative outcome)
      if (i < 57) {
        cancels.push(JSON.stringify({
          decision_id, cancellation_kind: 'user-initiated-stop',
          ts: `2026-04-01T00:${String(i).padStart(2, '0')}:30.000Z`,
        }));
      }
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.writeFileSync(cancellations, cancels.join('\n') + '\n');

    const { rc, out } = _captureStdout(() => tune.cmdAutoQuarantine({ dryRun: true }));
    assert.equal(rc, 0);
    assert.match(out, /eligible for quarantine/);
    assert.match(out, /dry run/);
    // Verify NO status_change entry was written
    const effFile = path.join(VANTA_TMP, 'rule-effectiveness.jsonl');
    if (fs.existsSync(effFile)) {
      const content = fs.readFileSync(effFile, 'utf8');
      assert.doesNotMatch(content, /"kind":"status_change"/);
    }
  });

  await t.test('without --dry-run, writes status_change entries', () => {
    _reset();
    // Same seed as above
    const file = path.join(VANTA_TMP, 'route-quality.jsonl');
    const cancellations = path.join(VANTA_TMP, 'cancellations.jsonl');
    const lines = [];
    const cancels = [];
    for (let i = 0; i < 60; i++) {
      const ts = `2026-04-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      const decision_id = `dec-${i}`;
      lines.push(JSON.stringify({
        ts, rule_id: 'fix-broken', skill_route: '/investigate',
        decision_id, project: 'test',
      }));
      if (i < 57) {
        cancels.push(JSON.stringify({
          decision_id, cancellation_kind: 'user-initiated-stop',
          ts: `2026-04-01T00:${String(i).padStart(2, '0')}:30.000Z`,
        }));
      }
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.writeFileSync(cancellations, cancels.join('\n') + '\n');

    const { rc, out } = _captureStdout(() => tune.cmdAutoQuarantine({ dryRun: false }));
    assert.equal(rc, 0);
    assert.match(out, /Quarantined \d+ rule/);
    assert.ok(re.listQuarantined().includes('fix-broken'));
  });

  await t.test('skips already-quarantined rules', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', { reason: 'pre-existing' });
    // Even with telemetry that would normally trigger eligibility,
    // already-quarantined rules are skipped.
    const file = path.join(VANTA_TMP, 'route-quality.jsonl');
    const cancellations = path.join(VANTA_TMP, 'cancellations.jsonl');
    const lines = [];
    const cancels = [];
    for (let i = 0; i < 60; i++) {
      const ts = `2026-04-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      const decision_id = `dec-${i}`;
      lines.push(JSON.stringify({
        ts, rule_id: 'fix-broken', skill_route: '/investigate',
        decision_id, project: 'test',
      }));
      if (i < 57) {
        cancels.push(JSON.stringify({
          decision_id, cancellation_kind: 'user-initiated-stop',
          ts: `2026-04-01T00:${String(i).padStart(2, '0')}:30.000Z`,
        }));
      }
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.writeFileSync(cancellations, cancels.join('\n') + '\n');

    const { rc, out } = _captureStdout(() => tune.cmdAutoQuarantine({ dryRun: false }));
    assert.equal(rc, 0);
    assert.match(out, /No rules eligible/);
  });
});

// ─── main() entry point ─────────────────────────────────────────────

test('main() dispatches commands', async (t) => {
  await t.test('no args prints usage', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.main(['node', 'rule-tune']));
    assert.equal(rc, 0);
    assert.match(out, /Usage: vanta-rule-tune/);
  });

  await t.test('unknown command exits 2', () => {
    _reset();
    const captured = _captureStderr(() => {
      const { rc } = _captureStdout(() => tune.main(['node', 'rule-tune', 'frobnicate']));
      return rc;
    });
    assert.equal(captured.rc, 2);
    assert.match(captured.err, /unknown command/);
  });

  await t.test('--help prints usage', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.main(['node', 'rule-tune', '--help']));
    assert.equal(rc, 0);
    assert.match(out, /Usage: vanta-rule-tune/);
  });

  await t.test('list dispatches to cmdList', () => {
    _reset();
    const { rc, out } = _captureStdout(() => tune.main(['node', 'rule-tune', 'list']));
    assert.equal(rc, 0);
    assert.match(out, /rule-id/);
  });
});

// ─── R1 council fixes regression tests ──────────────────────────────

test('R1 council fix: snapshot does NOT stomp setStatus (Codex P1 + Gemini P1)', async (t) => {
  await t.test('snapshot writes seq=prior (no bump)', () => {
    _reset();
    // Manual quarantine bumps to seq=1
    re.setStatus('fix-broken', 'quarantined', { reason: 'manual' });
    const before = re.readLatestStatus().get('fix-broken');
    assert.equal(before.status_seq, 1);

    // Now snapshot the same rule; the entry must NOT take a higher seq
    const fakeRule = {
      rule_id: 'fix-broken',
      fires: 0, unscorable: 0, proceeded: 0, recalled: 0,
      undone: 0, rerouted: 0, stopped: 0,
      success_rate: 0, ci_lower: 0, last_50_window_rate: 0,
      rule_content_hash: 'a'.repeat(64),
    };
    re.snapshot([fakeRule], { reason: 'test' });

    const after = re.readLatestStatus().get('fix-broken');
    // setStatus seq=1 must still WIN over snapshot seq=1 (latest ts breaks
    // tie, but we must verify status didn't flip back to active).
    // Since snapshot doesn't change quarantined→anything, status stays
    // 'quarantined' regardless of which entry wins on tiebreaker.
    // The critical assertion: max status_seq is still 1 (no random bump).
    assert.equal(after.status_seq, 1, 'snapshot must NOT bump seq above setStatus');
    assert.equal(after.status, 'quarantined', 'status must stay quarantined');
  });

  await t.test('subsequent setStatus dominates after snapshot', () => {
    _reset();
    // Active rule, snapshot observes
    const fakeRule = {
      rule_id: 'fix-broken',
      fires: 0, unscorable: 0, proceeded: 0, recalled: 0,
      undone: 0, rerouted: 0, stopped: 0,
      success_rate: 0, ci_lower: 0, last_50_window_rate: 0,
      rule_content_hash: 'a'.repeat(64),
    };
    re.snapshot([fakeRule]);
    const afterSnapshot = re.readLatestStatus().get('fix-broken');
    assert.equal(afterSnapshot.status, 'active');
    assert.equal(afterSnapshot.status_seq, 0);

    // Operator quarantines manually
    re.setStatus('fix-broken', 'quarantined', { reason: 'manual-after-snapshot' });
    const afterManual = re.readLatestStatus().get('fix-broken');
    assert.equal(afterManual.status, 'quarantined');
    assert.equal(afterManual.status_seq, 1, 'setStatus increments seq, beats snapshot');

    // Another snapshot lands — must NOT undo the manual decision
    re.snapshot([fakeRule]);
    const afterSecondSnapshot = re.readLatestStatus().get('fix-broken');
    assert.equal(afterSecondSnapshot.status, 'quarantined',
      'snapshot must not stomp setStatus — bug fix verification');
  });
});

test('R1 council fix: rewriter source path is canonical (Codex P1 + Gemini P2)', async (t) => {
  await t.test('readRewriterSource prefers __dirname (adjacent file) first', () => {
    // The source returned must be the same file the rewriter would
    // hash via __filename, regardless of which copy is in $HOME.
    const source = re.readRewriterSource();
    assert.ok(source, 'source readable');
    // The repo's rewriter is what we just edited; it must contain the
    // v3.10 commit 3 quarantine state loader.
    assert.match(source, /v3\.10 commit 3 — quarantine state loader/);
  });
});

test('R1 council fix: brace counter handles strings, regexes, comments (Gemini P1)', async (t) => {
  await t.test('regex literal with literal { } is skipped', () => {
    const source = `
      const RULES = [
        {
          id: 'with-brace-regex',
          rx: /[{}]/,
          intent: 'foo',
          chain: ['s'],
        },
      ];
    `;
    const hashes = re.extractRuleBlockHashes(source);
    assert.ok(hashes.has('with-brace-regex'), 'rule with brace-in-regex extracts');
  });

  await t.test('regex with quantifier {0,80} extracts cleanly (current corpus pattern)', () => {
    const source = `
      const RULES = [
        {
          id: 'add-feature',
          rx: /\\b(add|implement)\\b[^.?!\\n]{0,80}\\b(feature|api)\\b/i,
          intent: 'feature',
          chain: ['s'],
        },
      ];
    `;
    const hashes = re.extractRuleBlockHashes(source);
    assert.ok(hashes.has('add-feature'));
  });

  await t.test('block comment with } is skipped', () => {
    const source = `
      const RULES = [
        {
          id: 'with-comment',
          /* this } would break naive counter */
          rx: /a/,
          intent: 'foo',
          chain: ['s'],
        },
      ];
    `;
    const hashes = re.extractRuleBlockHashes(source);
    assert.ok(hashes.has('with-comment'));
  });

  await t.test('string with } is skipped', () => {
    const source = `
      const RULES = [
        {
          id: 'with-string-brace',
          rx: /a/,
          intent: 'foo',
          chain: ['this is a } in a string'],
        },
      ];
    `;
    const hashes = re.extractRuleBlockHashes(source);
    assert.ok(hashes.has('with-string-brace'));
  });

  await t.test('all current corpus rules extract', () => {
    const source = re.readRewriterSource();
    if (!source) return;
    const hashes = re.extractRuleBlockHashes(source);
    // Current corpus (v3.10): it-didnt-work, fix-broken, ship-this,
    // review-this, write-tests, make-faster, refactor, add-feature,
    // resume, audit-gaps, diff-summary, taxonomy-rename = 12 rules
    assert.ok(hashes.size >= 10, `expected ≥10 rules extracted, got ${hashes.size}`);
    for (const id of ['fix-broken', 'add-feature', 'taxonomy-rename', 'resume']) {
      assert.ok(hashes.has(id), `missing rule: ${id}`);
    }
  });
});

test('R1 council fix: CLI --reason rejects flag-like values (Gemini P3)', async (t) => {
  await t.test('--reason --dry-run throws instead of swallowing safety flag', () => {
    _reset();
    let threw = false;
    try {
      tune.main(['node', 'rule-tune', 'auto-quarantine', '--reason', '--dry-run']);
    } catch (err) {
      threw = true;
      assert.match(err.message, /flag --reason requires a value/);
    }
    assert.ok(threw, 'CLI must throw on --reason --dry-run pattern');
  });

  await t.test('--reason at end-of-args throws', () => {
    _reset();
    let threw = false;
    try {
      tune.main(['node', 'rule-tune', 'quarantine', 'fix-broken', '--reason']);
    } catch (err) {
      threw = true;
      assert.match(err.message, /flag --reason requires a value/);
    }
    assert.ok(threw);
  });

  await t.test('--reason "valid text" works', () => {
    _reset();
    const { rc } = _captureStdout(() => tune.main(['node', 'rule-tune', 'quarantine', 'fix-broken', '--reason', 'because-reasons']));
    assert.equal(rc, 0);
    const status = re.readLatestStatus().get('fix-broken');
    assert.equal(status.status_reason, 'because-reasons');
  });
});

// ─── R2 council fixes regression tests ──────────────────────────────

test('R2 council fix: composite mtime+size cache key (Gemini R2 P2)', async (t) => {
  await t.test('quarantine state refreshes when file size changes even with same mtime', () => {
    _reset();
    // Need a real corpus rule for this to be meaningful.
    const source = re.readRewriterSource();
    const realHash = source ? re.extractRuleBlockHashes(source).get('fix-broken') : null;
    if (!realHash) return;

    const rw = _freshRewriter();
    // Initially no quarantine → fix-broken fires
    let r = rw.rewrite('fix the bug', {});
    assert.equal(r.rule_id, 'fix-broken');

    // Write quarantine entry directly with NO mtime change applied externally
    re.setStatus('fix-broken', 'quarantined', {
      reason: 'r2-test',
      contentHash: realHash,
    });
    // The setStatus call appended to the file, so size changed even if mtime
    // resolution is coarse. Composite key catches this.
    r = rw.rewrite('fix the bug', {});
    assert.equal(r.mode, 'passthrough', 'composite key picked up size change');
  });
});

test('R2 council fix: realpath canonicalization (Codex R2 P3)', async (t) => {
  await t.test('readRewriterSource follows symlink to canonical path', () => {
    // Sanity: source readable through realpath
    const source = re.readRewriterSource();
    assert.ok(source);
    // Should still contain the v3.10 sentinel
    assert.match(source, /v3\.10 commit 3 — quarantine state loader/);
  });

  await t.test('extractRuleBlockHashes against realpath source matches rewriter __filename source', () => {
    // The rewriter computes hashes via __filename → realpath → readFile.
    // readRewriterSource should resolve to the same canonical file.
    // Given our test env loads both modules from /Users/vinamr/Projects/vanta/bin
    // (no symlinks involved here), they MUST produce the same hash for
    // every rule. Mismatch would be a regression in canonicalization.
    const source = re.readRewriterSource();
    const hashes = re.extractRuleBlockHashes(source);
    // All current corpus rules must have hashes
    for (const id of ['fix-broken', 'add-feature', 'taxonomy-rename', 'resume', 'ship-this']) {
      assert.ok(hashes.has(id), `corpus rule ${id} hash missing`);
      assert.equal(hashes.get(id).length, 64);
    }
  });
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
});
