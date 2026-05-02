// v3.9.0 — Reversibility Foundation tests.
//
// Covers all 7 sub-systems plus integration scenarios:
//   1. VantaAction schema + persistence (vanta-action.js)
//   2. Cancellation tracker (vanta-cancellation.js)
//   3. Stop intent (vanta-intent-stop.js)
//   4. Undo intent + kind dispatch (vanta-intent-undo.js)
//   5. Mid-flight re-route (vanta-intent-reroute.js)
//   6. Crash recovery scan (vanta-crash-recovery.js)
//   7. Safe mode masking (vanta-safe-mode.js)
//   8. Integration: stop while council mid-flight; undo file_edit;
//      re-route review→test with context preservation
//
// Each suite isolates I/O via VANTA_DIR_OVERRIDE.

'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const va = require('../bin/vanta-action');
const cancel = require('../bin/vanta-cancellation');
const stop = require('../bin/vanta-intent-stop');
const undo = require('../bin/vanta-intent-undo');
const reroute = require('../bin/vanta-intent-reroute');
const recovery = require('../bin/vanta-crash-recovery');
const safe = require('../bin/vanta-safe-mode');

function _tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `v390-${prefix}-`));
}
function _rmTmp(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function _withDir(fn) {
  const dir = _tmpDir('iso');
  const prev = process.env.VANTA_DIR_OVERRIDE;
  process.env.VANTA_DIR_OVERRIDE = dir;
  try { return fn(dir); }
  finally {
    if (prev === undefined) delete process.env.VANTA_DIR_OVERRIDE;
    else process.env.VANTA_DIR_OVERRIDE = prev;
    _rmTmp(dir);
  }
}

// ─── 1. VantaAction schema ────────────────────────────────────────────

describe('v3.9.0 — VantaAction schema', () => {
  test('createAction stamps id, ts, lifecycle=pending', () => {
    const a = va.createAction({
      kind: 'prompt_rewrite',
      inverse: { kind: 'prompt_rewrite', original_prompt: 'fix the bug' },
      project: 'p', session: 's',
    });
    assert.match(a.id, /^va-[0-9a-f]{12}$/);
    assert.equal(a.lifecycle, 'pending');
    assert.equal(a.reversible, true);
    assert.ok(a.ts && Date.parse(a.ts));
  });

  test('validateAction rejects unknown kind', () => {
    assert.throws(() => va.validateAction({
      id: 'x', ts: 'now', kind: 'noooope', lifecycle: 'pending', reversible: false,
    }), /action.kind: invalid/);
  });

  test('validateAction enforces FileEditInverse required fields', () => {
    assert.throws(() => va.validateAction({
      id: 'x', ts: 'now', kind: 'file_edit', lifecycle: 'pending', reversible: true,
      inverse: { kind: 'file_edit' /* missing target_path etc */ },
    }), /FileEditInverse.target_path required/);
  });

  test('validateAction enforces CommandInverse side_effects requirement', () => {
    assert.throws(() => va.validateAction({
      id: 'x', ts: 'now', kind: 'command', lifecycle: 'pending', reversible: true,
      inverse: { kind: 'command', side_effects_known: true /* no PID + no cleanup */ },
    }), /CommandInverse: side_effects_known=true requires/);
  });

  test('validateAction accepts CouncilCallInverse with remote_status enum', () => {
    const a = va.createAction({
      kind: 'council_call',
      inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
      project: 'p', session: 's',
    });
    assert.equal(a.inverse.remote_status, 'unknown');
  });

  test('persistAction + readActions round-trip preserves the entry', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'memory_promotion',
        inverse: { kind: 'memory_promotion', target_file: '/x', inserted_text: 'i', insertion_anchor: '@' },
        project: 'rt', session: 's',
      });
      va.persistAction(a);
      const all = va.readActions({ project: 'rt' });
      assert.equal(all.length, 1);
      assert.equal(all[0].id, a.id);
      assert.equal(all[0].kind, 'memory_promotion');
    });
  });

  test('updateLifecycle latest-wins through append-only writes', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'lc', session: 's',
      });
      va.persistAction(a);
      va.updateLifecycle(a.id, 'applied');
      va.updateLifecycle(a.id, 'rolled_back', { reason: 'undo' });
      const final = va.findById(a.id);
      assert.equal(final.lifecycle, 'rolled_back');
      assert.equal(final.why, 'undo');
    });
  });

  test('updateLifecycle CAS guard rejects mismatched expectedState (R1 P1 both)', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'cas', session: 's',
      });
      va.persistAction(a);
      // Action is currently 'pending' — try to CAS from 'applied' should fail
      assert.throws(() => {
        va.updateLifecycle(a.id, 'rolled_back', { expectedState: 'applied' });
      }, (err) => err.code === 'CAS_FAILED' && err.actual_state === 'pending');
      // The action's lifecycle must NOT have changed
      assert.equal(va.findById(a.id).lifecycle, 'pending');
    });
  });

  test('updateLifecycle CAS guard accepts matching expectedState', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'cas-ok', session: 's',
      });
      va.persistAction(a);
      va.updateLifecycle(a.id, 'applied', { expectedState: 'pending' });
      // Two-phase claim → finalize (R2 P1 fix)
      va.updateLifecycle(a.id, 'rolling_back', { expectedState: 'applied' });
      va.updateLifecycle(a.id, 'rolled_back', { expectedState: 'rolling_back' });
      assert.equal(va.findById(a.id).lifecycle, 'rolled_back');
    });
  });

  test('LIFECYCLE_STATES includes rolling_back transient (R2 P1 fix)', () => {
    assert.ok(va.LIFECYCLE_STATES.includes('rolling_back'),
      'two-phase claim requires the rolling_back transient state');
  });

  test('PromptRewriteInverse redacts secrets (R1 P2 both)', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'use sk-AbCdEfGhIjKlMnOpQrStUvWxYz12345678 for the API' },
        project: 'red', session: 's',
      });
      assert.ok(!a.inverse.original_prompt.includes('sk-AbCd'),
        'API key must be redacted in PromptRewriteInverse.original_prompt');
      assert.equal(a.inverse.original_prompt_redacted, true);
    });
  });

  test('Schema includes file_delete / git_commit / autonomy_promote kinds (R1 P2 Codex)', () => {
    assert.ok(va.ACTION_KINDS.includes('file_delete'));
    assert.ok(va.ACTION_KINDS.includes('git_commit'));
    assert.ok(va.ACTION_KINDS.includes('autonomy_promote'));
  });

  test('readActions filters out non-VantaAction action-log entries', () => {
    _withDir(dir => {
      // Synthetic action-log entry without `kind` (the v3.8.x shape)
      const file = path.join(dir, 'actions.jsonl');
      fs.writeFileSync(file, '\n' + JSON.stringify({ id: 'act-old1', action: 'rewrite', ts: 'now' }) + '\n');
      // VantaAction entry
      const a = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'mig', session: 's',
      });
      va.persistAction(a);
      const all = va.readActions();
      assert.equal(all.length, 1, 'only VantaAction (kind-bearing) entries should be returned');
      assert.equal(all[0].id, a.id);
    });
  });

  test('findRecentReversible filters by lifecycle=applied + reversible', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'fr', session: 's',
      });
      va.persistAction(a);
      // Still pending — should not be in findRecentReversible
      assert.equal(va.findRecentReversible({ project: 'fr' }).length, 0);
      va.updateLifecycle(a.id, 'applied');
      assert.equal(va.findRecentReversible({ project: 'fr' }).length, 1);
      va.updateLifecycle(a.id, 'rolled_back');
      assert.equal(va.findRecentReversible({ project: 'fr' }).length, 0);
    });
  });
});

// ─── 2. Cancellation tracker ──────────────────────────────────────────

describe('v3.9.0 — cancellation tracker', () => {
  test('record requires action_id + valid kind', () => {
    _withDir(() => {
      assert.equal(cancel.record({}), false);
      assert.equal(cancel.record({ action_id: 'a', cancellation_kind: 'bogus' }), false);
      assert.equal(cancel.record({ action_id: 'a', cancellation_kind: 'user-initiated-stop' }), true);
    });
  });

  test('cancelled_locally is forced true at record time (cost honesty)', () => {
    _withDir(() => {
      cancel.record({
        action_id: 'a',
        cancellation_kind: 'user-initiated-stop',
        in_flight_remote_call: { provider: 'codex', request_id: 'r', cancelled_locally: false /* will be ignored */ },
      });
      const all = cancel.readAll();
      assert.equal(all[0].in_flight_remote_call.cancelled_locally, true);
    });
  });

  test('remote_status is hardcoded "unknown" at record time (R1 P2 both)', () => {
    _withDir(() => {
      // Caller tries to lie about remote completion
      cancel.record({
        action_id: 'liar',
        cancellation_kind: 'user-initiated-stop',
        in_flight_remote_call: { provider: 'codex', request_id: 'r', remote_status: 'completed' },
      });
      const all = cancel.readAll();
      assert.equal(all[0].in_flight_remote_call.remote_status, 'unknown',
        'cost-honesty contract: caller-supplied remote_status MUST be ignored');
    });
  });

  test('reconcile supersedes the original cancellation (R1 P1 both)', () => {
    _withDir(() => {
      cancel.record({
        action_id: 'rec-1',
        cancellation_kind: 'user-initiated-stop',
        in_flight_remote_call: { provider: 'codex', request_id: 'r', estimated_cost_usd: 0.18 },
      });
      assert.equal(cancel.findPendingReconciliation().length, 1);
      cancel.reconcile('rec-1', { remote_status: 'completed', actual_cost_usd: 0.20 });
      // After reconcile, the action should NOT appear in pending
      // reconciliation any more — readAll dedupes by action_id and the
      // reconciliation entry's remote_status='completed' supersedes
      // the original 'unknown'.
      assert.equal(cancel.findPendingReconciliation().length, 0,
        'reconciled action must clear from pending');
    });
  });

  test('readAll dedupes by action_id (R1 P1 Gemini)', () => {
    _withDir(() => {
      // Same action cancelled twice (e.g. stop + later undo)
      cancel.record({
        action_id: 'dup',
        cancellation_kind: 'user-initiated-stop',
        in_flight_remote_call: { provider: 'codex', request_id: 'r', estimated_cost_usd: 0.18 },
      });
      cancel.record({
        action_id: 'dup',
        cancellation_kind: 'user-initiated-undo',
        in_flight_remote_call: { provider: 'codex', request_id: 'r', estimated_cost_usd: 0.18 },
      });
      const all = cancel.readAll();
      assert.equal(all.length, 1, 'readAll must dedupe — same action_id appears once');
    });
  });

  test('summarizePending never claims "no charge"', () => {
    _withDir(() => {
      cancel.record({
        action_id: 'x',
        cancellation_kind: 'user-initiated-stop',
        in_flight_remote_call: { provider: 'codex', request_id: 'r', estimated_cost_usd: 0.18 },
      });
      const s = cancel.summarizePending();
      assert.ok(!s.message.includes('no charge'),
        'cost-honest contract: must never claim "no charge"');
      assert.ok(s.message.includes('may have completed remotely'),
        'must use uncertainty language');
    });
  });
});

// ─── 3. Stop intent ───────────────────────────────────────────────────

describe('v3.9.0 — Stop intent', () => {
  const positives = ['stop', 'STOP.', "wait, don't", "wait don't", 'hold on', 'pause', 'halt', 'cancel', 'cancel that', 'nevermind'];
  const negatives = ['stop using async', 'fix this', 'do not stop the build', 'stop and review', '/stop'];

  test('detect: 10/10 positive triggers', () => {
    for (const p of positives) assert.ok(stop.detect(p), `should detect: ${p}`);
  });
  test('detect: 5/5 negative non-triggers', () => {
    for (const n of negatives) assert.ok(!stop.detect(n), `should NOT detect: ${n}`);
  });

  test('handle with nothing in flight reports cleanly', () => {
    _withDir(() => {
      const r = stop.handle({ project: 'no-flight', session: 's', prompt: 'stop' });
      assert.equal(r.halted, false);
      assert.equal(r.reason, 'nothing-pending');
      assert.match(r.message, /\[Vanta blocked\]/);
    });
  });

  test('handle with council mid-flight halts cleanly + records cancellation', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r1', cancelled_locally: false, remote_status: 'unknown', estimated_cost_usd: 0.18 },
        project: 'p', session: 's',
      });
      va.persistAction(a);
      const r = stop.handle({ project: 'p', session: 's', prompt: 'stop' });
      assert.equal(r.halted, true);
      assert.equal(r.next_lifecycle, 'rolled_back');
      assert.match(r.message, /completed remotely/);
      assert.match(r.message, /\$0\.18/);
      assert.equal(va.findById(a.id).lifecycle, 'rolled_back');
      // Cancellation entry written
      assert.equal(cancel.findPendingReconciliation().length, 1);
    });
  });

  test('handle with side-effects-unknown command → rollback_failed', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'command',
        inverse: { kind: 'command', side_effects_known: false },
        reversible: true,
        project: 'p2', session: 's',
      });
      va.persistAction(a);
      const r = stop.handle({ project: 'p2', session: 's', prompt: 'stop' });
      assert.equal(r.next_lifecycle, 'rollback_failed');
      assert.match(r.message, /\[Vanta risky\]/);
      assert.match(r.message, /manual cleanup/);
    });
  });
});

// ─── 4. Undo intent ───────────────────────────────────────────────────

describe('v3.9.0 — Undo intent', () => {
  test('detect: positive triggers', () => {
    for (const p of ['undo', 'undo that', 'revert', "no, that's wrong", 'go back', 'rollback']) {
      assert.ok(undo.detect(p), `should detect: ${p}`);
    }
  });
  test('detect: false triggers ignored', () => {
    // Note: roadmap acknowledges the trigger set is tight. "go back to
    // the previous test" is a navigation prompt; "undo" embedded in a
    // longer command does not currently false-trigger because the
    // anchored regex requires a near-exact match.
    for (const n of ['fix this', 'go back to the previous test', 'review undo']) {
      assert.ok(!undo.detect(n), `should NOT detect: ${n}`);
    }
  });

  test('handle with nothing recent → noop', () => {
    _withDir(() => {
      const r = undo.handle({ project: 'empty', session: 's', prompt: 'undo' });
      assert.equal(r.kind, 'noop');
      assert.match(r.message, /Nothing recent to undo/);
    });
  });

  test('handle with single candidate → apply (memory_promotion)', () => {
    _withDir(() => {
      const tmp = _tmpDir('mp');
      const file = path.join(tmp, 'inv.md');
      const inserted = '\n## X\n- one\n';
      fs.writeFileSync(file, '# Title\n## Other\n- existing\n' + inserted);
      const a = va.createAction({
        kind: 'memory_promotion',
        inverse: { kind: 'memory_promotion', target_file: file, inserted_text: inserted, insertion_anchor: '## X' },
        project: 'mp', session: 's',
      });
      va.persistAction(a);
      va.updateLifecycle(a.id, 'applied');
      const r = undo.handle({ project: 'mp', session: 's', prompt: 'undo' });
      assert.equal(r.kind, 'apply');
      assert.equal(r.result.ok, true);
      assert.ok(!fs.readFileSync(file, 'utf8').includes('## X'));
      _rmTmp(tmp);
    });
  });

  test('handle with multi candidates → ASK', () => {
    _withDir(() => {
      const a1 = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'amb', session: 's',
      });
      va.persistAction(a1); va.updateLifecycle(a1.id, 'applied');
      const a2 = va.createAction({
        kind: 'memory_promotion',
        inverse: { kind: 'memory_promotion', target_file: '/x', inserted_text: 't', insertion_anchor: '@' },
        project: 'amb', session: 's',
      });
      va.persistAction(a2); va.updateLifecycle(a2.id, 'applied');
      const r = undo.handle({ project: 'amb', session: 's', prompt: 'undo' });
      assert.equal(r.kind, 'ask');
      assert.equal(r.candidates.length, 2);
      assert.match(r.message, /Multiple recent reversible/);
    });
  });

  test('file_edit: SHA divergence → rollback_failed (refuses to overwrite)', () => {
    _withDir(() => {
      const tmp = _tmpDir('fe');
      const file = path.join(tmp, 'x.txt');
      fs.writeFileSync(file, 'after-content');
      const sha = crypto.createHash('sha256').update('after-content').digest('hex');
      const a = va.createAction({
        kind: 'file_edit',
        inverse: { kind: 'file_edit', target_path: file, before_sha: 'fff', after_sha: sha, patch: '', before_content: 'before-content' },
        project: 'fe-div', session: 's',
      });
      va.persistAction(a); va.updateLifecycle(a.id, 'applied');
      // Simulate external mutation
      fs.writeFileSync(file, 'externally-modified');
      const r = undo.handle({ project: 'fe-div', session: 's', prompt: 'undo' });
      assert.equal(r.kind, 'apply');
      assert.equal(r.result.ok, false);
      assert.equal(r.result.reason, 'external-mutation');
      assert.match(r.result.message, /\[Vanta risky\]/);
      assert.match(r.result.message, /changed externally/);
      // File content untouched (Vanta refused to overwrite)
      assert.equal(fs.readFileSync(file, 'utf8'), 'externally-modified');
      _rmTmp(tmp);
    });
  });

  test('file_edit: clean before_content → revert succeeds', () => {
    _withDir(() => {
      const tmp = _tmpDir('fe2');
      const file = path.join(tmp, 'x.txt');
      fs.writeFileSync(file, 'after');
      const sha = crypto.createHash('sha256').update('after').digest('hex');
      const a = va.createAction({
        kind: 'file_edit',
        inverse: { kind: 'file_edit', target_path: file, before_sha: 'f', after_sha: sha, patch: '', before_content: 'before' },
        project: 'fe-ok', session: 's',
      });
      va.persistAction(a); va.updateLifecycle(a.id, 'applied');
      const r = undo.handle({ project: 'fe-ok', session: 's', prompt: 'undo' });
      assert.equal(r.result.ok, true);
      assert.equal(fs.readFileSync(file, 'utf8'), 'before');
      _rmTmp(tmp);
    });
  });
});

// ─── 5. Mid-flight re-route ──────────────────────────────────────────

describe('v3.9.0 — re-route intent', () => {
  test('detect + classifyReplacement maps known intents', () => {
    for (const [p, expIntent] of [
      ['no, I meant test it', 'write-tests'],
      ['wait, actually review the diff', 'review-diff'],
      ['switch to ship', 'ship'],
      ['no, do investigate instead', 'fix-bug'],
    ]) {
      assert.ok(reroute.detect(p), p);
      assert.equal(reroute.classifyReplacement(p).intent, expIntent);
    }
  });

  test('classifyReplacement returns null route on opaque text', () => {
    const c = reroute.classifyReplacement('no, I meant something opaque');
    assert.equal(c.replacement, 'something opaque');
    assert.equal(c.route, null);
  });

  test('handle: review→test halts council + pivots cleanly', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown', estimated_cost_usd: 0.18 },
        detected_intent: 'review-diff', current_route: '/council',
        project: 'rr', session: 's',
      });
      va.persistAction(a);
      const r = reroute.handle({ project: 'rr', session: 's', prompt: 'no, I meant test it' });
      assert.equal(r.kind, 'apply');
      assert.equal(r.new_intent, 'write-tests');
      assert.equal(r.new_route, '/test');
      assert.match(r.message, /switching to write-tests/);
      assert.match(r.message, /Halted/);
      assert.match(r.message, /completed remotely/, 'must be cost-honest');
    });
  });

  test('handle: opaque replacement → ASK', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
        project: 'rr-amb', session: 's',
      });
      va.persistAction(a);
      const r = reroute.handle({ project: 'rr-amb', session: 's', prompt: 'no, I meant something opaque' });
      assert.equal(r.kind, 'ask');
      assert.match(r.message, /something opaque/);
    });
  });
});

// ─── 6. Crash recovery ────────────────────────────────────────────────

describe('v3.9.0 — crash recovery', () => {
  test('empty state → show=false', () => {
    _withDir(() => {
      assert.equal(recovery.renderBrief().show, false);
    });
  });

  test('applied lifecycle is NOT flagged as stale (R1 P1 Gemini)', () => {
    _withDir(() => {
      // Plant an applied action older than STALE_MS — must NOT be flagged.
      const old = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'fix' },
        project: 'cr-applied', session: 's',
      });
      old.ts = new Date(Date.now() - 7200 * 1000).toISOString();
      old.lifecycle = 'applied';
      va.persistAction(old);
      const r = recovery.scan({ project: 'cr-applied' });
      assert.equal(r.stale_actions.length, 0,
        'applied is the terminal success state — must NOT trigger crash recovery');
    });
  });

  test('stale pending action → brief surfaces it', () => {
    _withDir(() => {
      const stale = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
        detected_intent: 'review-diff', current_route: '/council',
        project: 'cr', session: 'old',
      });
      stale.ts = new Date(Date.now() - 3600 * 1000).toISOString();
      va.persistAction(stale);
      const b = recovery.renderBrief({ project: 'cr' });
      assert.equal(b.show, true);
      assert.equal(b.lines.length >= 2, true);
      assert.ok(b.lines.some(l => l.includes('council call')), 'brief should name the kind');
    });
  });

  test('dispatch skip → marks stale rollback_failed', () => {
    _withDir(() => {
      const stale = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
        project: 'cr-skip', session: 'old',
      });
      stale.ts = new Date(Date.now() - 3600 * 1000).toISOString();
      va.persistAction(stale);
      const b = recovery.renderBrief({ project: 'cr-skip' });
      const d = recovery.dispatch('skip', b.scan_result);
      assert.equal(d.ok, true);
      assert.equal(d.mode, 'skip');
      assert.equal(va.findById(stale.id).lifecycle, 'rollback_failed');
    });
  });
});

// ─── 7. Safe mode ─────────────────────────────────────────────────────

describe('v3.9.0 — safe mode (masking flag)', () => {
  test('detectEngage: 5+ positive triggers; tight regex', () => {
    for (const p of ['be careful', 'safe mode', "don't auto", 'stop suggesting things', 'conservative mode']) {
      assert.ok(safe.detectEngage(p), p);
    }
    for (const n of ['be careful with the migration', 'safe to ship?']) {
      assert.ok(!safe.detectEngage(n), n);
    }
  });

  test('detectExit: precise', () => {
    for (const p of ['back to normal', 'exit safe mode', 'safe mode off']) {
      assert.ok(safe.detectExit(p), p);
    }
  });

  test('engage masks ambient/council/memory/inline to off', () => {
    _withDir(() => {
      const after = safe.engage('proj-1');
      const eff = safe.applyMasks(after);
      assert.equal(eff.ambient, 'off');
      assert.equal(eff.council, 'off');
      assert.equal(eff.memory_promotion, 'off');
      assert.equal(eff.inline_preview, 'off');
      // Underlying preserved
      assert.equal(eff._underlying.ambient, 'auto');
    });
  });

  test('engage persists to ~/.vanta/repos/<slug>/policy.json', () => {
    _withDir(() => {
      safe.engage('proj-2');
      const stored = safe.readPolicy('proj-2');
      assert.equal(stored.safe_mode.active, true);
      // Stored values UNTOUCHED by the mask — the engagement DID NOT
      // overwrite ambient/council/memory_promotion to off.
      assert.equal(stored.ambient, 'auto', 'underlying preferences must not be clobbered');
      assert.equal(stored.council, 'send-when-high-risk');
    });
  });

  test('exit restores effective values from underlying', () => {
    _withDir(() => {
      safe.engage('proj-3');
      assert.equal(safe.effective('proj-3').ambient, 'off');
      safe.exit('proj-3');
      assert.equal(safe.effective('proj-3').ambient, 'auto', 'exit should restore underlying value');
    });
  });

  test('handle: engage prompt flips active + returns user message', () => {
    _withDir(() => {
      const r = safe.handle({ project: 'h', prompt: 'safe mode' });
      assert.equal(r.kind, 'engaged');
      assert.match(r.message, /Safe mode is on/);
    });
  });

  test('handle: exit when not active → noop', () => {
    _withDir(() => {
      const r = safe.handle({ project: 'h2', prompt: 'back to normal' });
      assert.equal(r.kind, 'noop');
    });
  });

  test('corrupted policy.json restored to default', () => {
    _withDir(dir => {
      const slug = 'corr';
      const p = path.join(dir, 'repos', slug);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'policy.json'), '{not-json');
      const restored = safe.readPolicy(slug);
      // Should not throw; should restore default.
      assert.equal(restored.safe_mode.active, false);
      assert.equal(restored.ambient, 'auto');
    });
  });
});

// ─── 8. Integration scenarios ─────────────────────────────────────────

describe('v3.9.0 — integration scenarios', () => {
  test('stop while council mid-flight: full chain (action → halt → cancel)', () => {
    _withDir(() => {
      // 1. User fires /council → action persists pending
      const a = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'integ-r', cancelled_locally: false, remote_status: 'unknown', estimated_cost_usd: 0.25 },
        detected_intent: 'review-diff', current_route: '/council',
        project: 'integ', session: 's',
      });
      va.persistAction(a);
      // 2. User says "stop"
      const halt = stop.handle({ project: 'integ', session: 's', prompt: 'stop' });
      assert.equal(halt.halted, true);
      // 3. Lifecycle is rolled_back, cancellation recorded, brief surfaces it
      assert.equal(va.findById(a.id).lifecycle, 'rolled_back');
      assert.equal(cancel.findPendingReconciliation().length, 1);
    });
  });

  test('re-route review→test preserves original-prompt context', () => {
    _withDir(() => {
      // Step 1: prompt_rewrite for "review the diff" — this captures the original user ask
      const rewrite = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'review the diff' },
        detected_intent: 'review-diff', current_route: '/review',
        project: 'rr-int', session: 's',
      });
      va.persistAction(rewrite);
      va.updateLifecycle(rewrite.id, 'applied');
      // Step 2: council_call action fires (the "wrong" route the user is reacting to)
      const council = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'int-r', cancelled_locally: false, remote_status: 'unknown' },
        detected_intent: 'review-diff', current_route: '/council',
        project: 'rr-int', session: 's',
      });
      va.persistAction(council);
      // Step 3: user says "no, I meant test it"
      const r = reroute.handle({ project: 'rr-int', session: 's', prompt: 'no, I meant test it' });
      assert.equal(r.kind, 'apply');
      assert.equal(r.new_intent, 'write-tests');
      // Original prompt context surfaced
      assert.ok(r.original_context, 'original_context should be present');
      assert.equal(r.original_context.original_prompt, 'review the diff');
    });
  });

  test('crash recovery + safe-mode interaction: stale action does not auto-act in safe mode', () => {
    _withDir(() => {
      // Engage safe mode
      safe.engage('crash-sm');
      // Plant a stale council_call action
      const stale = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'st-r', cancelled_locally: false, remote_status: 'unknown' },
        project: 'crash-sm', session: 'old',
      });
      stale.ts = new Date(Date.now() - 3600 * 1000).toISOString();
      va.persistAction(stale);
      // Recovery brief still surfaces it (safe mode doesn't hide signal)
      const b = recovery.renderBrief({ project: 'crash-sm' });
      assert.equal(b.show, true);
      // But the effective policy is masked
      const eff = safe.effective('crash-sm');
      assert.equal(eff.council, 'off');
      assert.equal(eff.ambient, 'off');
      // R1 P3 fix (Gemini): rerun option must be hidden when safe mode is on
      assert.equal(b.safe_mode_active, true);
      assert.ok(!b.options.some(o => o.kind === 'rerun'),
        'rerun option must be hidden in safe mode');
      assert.ok(b.options.some(o => o.kind === 'accept'));
      assert.ok(b.options.some(o => o.kind === 'skip'));
    });
  });

  test('re-route does NOT cross-contaminate sessions (R1 P3 both)', () => {
    _withDir(() => {
      // Two sessions in the same project, each with their own
      // prompt_rewrite. The re-route in session A must pull session
      // A's original prompt, not session B's.
      const aRewrite = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'review the auth diff' },
        project: 'cross-tab', session: 'A',
      });
      va.persistAction(aRewrite); va.updateLifecycle(aRewrite.id, 'applied', { expectedState: 'pending' });
      const bRewrite = va.createAction({
        kind: 'prompt_rewrite',
        inverse: { kind: 'prompt_rewrite', original_prompt: 'review the payments diff' },
        project: 'cross-tab', session: 'B',
      });
      va.persistAction(bRewrite); va.updateLifecycle(bRewrite.id, 'applied', { expectedState: 'pending' });
      const aCouncil = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'A-r', cancelled_locally: false, remote_status: 'unknown' },
        project: 'cross-tab', session: 'A',
      });
      va.persistAction(aCouncil);
      const r = reroute.handle({ project: 'cross-tab', session: 'A', prompt: 'no, I meant test it' });
      assert.equal(r.kind, 'apply');
      assert.equal(r.original_context.original_prompt, 'review the auth diff',
        'session A re-route must pull session A original prompt, not session B');
    });
  });

  test('two-phase claim prevents double inverse application (R2 P1 Codex)', () => {
    _withDir(() => {
      const tmp = _tmpDir('claim');
      const file = path.join(tmp, 'invariants.md');
      const inserted = '\n## Promoted\n- One thing\n';
      fs.writeFileSync(file, '# Title\n## Other\n- existing\n' + inserted);
      const a = va.createAction({
        kind: 'memory_promotion',
        inverse: { kind: 'memory_promotion', target_file: file, inserted_text: inserted, insertion_anchor: '## Promoted' },
        project: 'race', session: 's',
      });
      va.persistAction(a);
      va.updateLifecycle(a.id, 'applied', { expectedState: 'pending' });

      // First undo claims and finalizes
      const r1 = undo.applyInverse(va.findById(a.id));
      assert.equal(r1.ok, true, 'first undo should succeed');

      // Second undo on the same action — find it again (it's now rolled_back),
      // try applyInverse: claim CAS will fail because expected='applied'
      // but actual='rolled_back'.
      const aAfter = va.findById(a.id);
      assert.equal(aAfter.lifecycle, 'rolled_back');
      const r2 = undo.applyInverse(aAfter);
      assert.equal(r2.ok, false, 'second undo must NOT re-run the inverse');
      assert.equal(r2.reason, 'concurrent-undo');
      // File content should still be the once-removed state — not double-applied
      const post = fs.readFileSync(file, 'utf8');
      assert.ok(!post.includes(inserted), 'inserted text removed exactly once');
      _rmTmp(tmp);
    });
  });

  test('Stop two-phase claim: race results in clean conflict signal (R2 P1)', () => {
    _withDir(() => {
      const a = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r-claim', cancelled_locally: false, remote_status: 'unknown', estimated_cost_usd: 0.18 },
        project: 'stop-race', session: 's',
      });
      va.persistAction(a);
      // First Stop succeeds
      const r1 = stop.handle({ project: 'stop-race', session: 's', prompt: 'stop' });
      assert.equal(r1.halted, true);
      // Second Stop on a fresh _findInFlight result — no in-flight pending
      // remains, so it returns nothing-pending. (Stop's _findInFlight
      // looks for pending; rolling_back/rolled_back are excluded.)
      const r2 = stop.handle({ project: 'stop-race', session: 's', prompt: 'stop' });
      assert.equal(r2.halted, false);
      assert.equal(r2.reason, 'nothing-pending');
      // Critical: only one cancellation should have been recorded
      assert.equal(cancel.findPendingReconciliation().length, 1,
        'Stop CAS prevents double-recording of cancellation entries');
    });
  });

  test('read-time redaction applies to historical entries (R2 P3 Codex)', () => {
    _withDir(dir => {
      // Plant a HISTORICAL entry that was written before the redaction
      // fix — raw secret in original_prompt. We bypass createAction to
      // simulate a v3.8.x-era entry.
      const file = path.join(dir, 'actions.jsonl');
      const ts = new Date().toISOString();
      const session = 'hist-s';
      const promptRewrite = {
        id: 'va-historical1',
        kind: 'prompt_rewrite',
        lifecycle: 'applied',
        reversible: true,
        inverse: {
          kind: 'prompt_rewrite',
          original_prompt: 'use sk-AbCdEfGhIjKlMnOpQrStUvWxYz12345678 to authenticate',
          // No original_prompt_redacted — historical entry
        },
        project: 'hist', session, ts,
      };
      // Persist the historical (raw) entry directly — bypasses createAction
      const { appendJsonlLine } = require('../bin/vanta-jsonl');
      fs.mkdirSync(dir, { recursive: true });
      appendJsonlLine(file, promptRewrite);

      // Plant a council_call to halt
      const council = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
        project: 'hist', session,
      });
      va.persistAction(council);

      // Re-route — this surfaces original_prompt; the read-time
      // redactor must catch the historical secret.
      const r = reroute.handle({ project: 'hist', session, prompt: 'no, I meant test it' });
      assert.equal(r.kind, 'apply');
      assert.ok(r.original_context);
      assert.ok(!r.original_context.original_prompt.includes('sk-AbCd'),
        'read-time redaction must scrub historical raw secrets before surfacing');
      assert.equal(r.original_context.original_prompt_redacted, true);
    });
  });

  test('cost-honesty contract end-to-end: no message contains "no charge" (R1 P4 Gemini)', () => {
    _withDir(() => {
      // Fire stop with council in flight
      const a = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown', estimated_cost_usd: 0.18 },
        project: 'cost', session: 's',
      });
      va.persistAction(a);
      const stopR = stop.handle({ project: 'cost', session: 's', prompt: 'stop' });
      // Fire reroute with another council in flight
      const b = va.createAction({
        kind: 'council_call',
        inverse: { kind: 'council_call', request_id: 'r2', cancelled_locally: false, remote_status: 'unknown', estimated_cost_usd: 0.25 },
        project: 'cost-rr', session: 's',
      });
      va.persistAction(b);
      const rerR = reroute.handle({ project: 'cost-rr', session: 's', prompt: 'no, I meant test it' });

      const banned = /\b(free|no charge)\b/i;
      for (const msg of [stopR.message, rerR.message]) {
        assert.ok(!banned.test(msg),
          `cost-honesty violation in user message: ${msg}`);
      }
    });
  });
});
