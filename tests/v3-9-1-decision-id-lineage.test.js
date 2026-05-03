'use strict';
// v3.9.1 commit 0 — decision_id lineage on VantaAction schema.
//
// Verifies the council C-1 fix (both-confirmed P1 from v3.10 R1): the
// VantaAction schema now carries a decision_id field, propagated from
// the upstream route-quality entry through cancellation records, so
// downstream rule-effectiveness scoring (v3.10 commit 1) can join rule
// fires to undo/stop/reroute outcomes by lineage instead of inferring
// from prompt-time proximity.
//
// Also verifies council C-11 fix (Gemini, NEW R2 P2): readActions
// defaults to the live file only (no .bak.<ts> sibling load) to avoid
// OOM on hot-path readers. Bak load is opt-in via { allHistory: true }.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v391-test-' + process.pid);
process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;

// Re-resolve modules under the env override.
const va = require('../bin/vanta-action.js');
const vc = require('../bin/vanta-cancellation.js');

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
}

test('v3.9.1 — decision_id schema migration', async (t) => {
  await t.test('createAction accepts decision_id and persists it', () => {
    _reset();
    const a = va.createAction({
      kind: 'council_call',
      decision_id: 'dec-abc123',
      project: 'test-project',
      session: 's1',
      inverse: {
        kind: 'council_call',
        request_id: 'req-1',
        cancelled_locally: false,
        remote_status: 'unknown',
      },
    });
    assert.equal(a.decision_id, 'dec-abc123', 'decision_id stamped on created action');
    va.persistAction(a);

    const actions = va.readActions({ project: 'test-project' });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].decision_id, 'dec-abc123', 'decision_id round-trips through persistence');
  });

  await t.test('createAction without decision_id defaults to null (forward-compat)', () => {
    _reset();
    const a = va.createAction({
      kind: 'council_call',
      project: 'p1',
      session: 's1',
      inverse: {
        kind: 'council_call',
        request_id: 'req-2',
        cancelled_locally: false,
        remote_status: 'unknown',
      },
    });
    assert.equal(a.decision_id, null, 'absent decision_id defaults to null, not undefined');
  });

  await t.test('validateAction rejects non-string non-null decision_id', () => {
    _reset();
    assert.throws(
      () => va.validateAction({
        id: 'va-test',
        kind: 'council_call',
        lifecycle: 'pending',
        reversible: true,
        ts: new Date().toISOString(),
        decision_id: 42,  // number — invalid
        inverse: {
          kind: 'council_call',
          request_id: 'r',
          cancelled_locally: false,
          remote_status: 'unknown',
        },
      }),
      /decision_id: must be string\|null/,
    );
  });

  await t.test('legacy entries without decision_id field are tolerated on read', () => {
    _reset();
    // Hand-craft a legacy-shape entry without decision_id (simulating
    // a pre-v3.9.1 ledger). It should validate and read back as null.
    const file = path.join(VANTA_TMP, 'actions.jsonl');
    const legacy = {
      id: 'va-legacy',
      kind: 'council_call',
      lifecycle: 'pending',
      reversible: true,
      ts: new Date().toISOString(),
      project: 'p1',
      session: 's1',
      inverse: {
        kind: 'council_call',
        request_id: 'r',
        cancelled_locally: false,
        remote_status: 'unknown',
      },
      // no decision_id field
    };
    fs.writeFileSync(file, '\n' + JSON.stringify(legacy) + '\n');
    const out = va.readActions({ project: 'p1' });
    assert.equal(out.length, 1);
    assert.equal(out[0].decision_id, undefined, 'legacy entry has no decision_id property (not migrated on read)');
    // Forward-compat key: validateAction accepts the legacy shape (no decision_id is fine, undefined is treated as null by != check)
    assert.doesNotThrow(() => va.validateAction(out[0]));
  });
});

test('v3.9.1 — cancellation propagates decision_id', async (t) => {
  await t.test('cancellation.record preserves decision_id on the entry', () => {
    _reset();
    const ok = vc.record({
      action_id: 'va-1',
      cancellation_kind: 'user-initiated-stop',
      decision_id: 'dec-xyz',
      in_flight_remote_call: {
        provider: 'codex',
        request_id: 'r-1',
      },
    });
    assert.ok(ok);
    const all = vc.readAll();
    const e = all.find(c => c.action_id === 'va-1');
    assert.ok(e);
    assert.equal(e.decision_id, 'dec-xyz', 'decision_id round-trips through cancellation persistence');
  });

  await t.test('cancellation without decision_id reads as null (forward-compat)', () => {
    _reset();
    vc.record({
      action_id: 'va-2',
      cancellation_kind: 'user-initiated-stop',
      // no decision_id passed
    });
    const all = vc.readAll();
    const e = all.find(c => c.action_id === 'va-2');
    assert.ok(e);
    assert.equal(e.decision_id, null);
  });

  await t.test('cancellation rejects non-string decision_id silently (coerced to null)', () => {
    _reset();
    vc.record({
      action_id: 'va-3',
      cancellation_kind: 'user-initiated-stop',
      decision_id: { not: 'a string' },
    });
    const all = vc.readAll();
    const e = all.find(c => c.action_id === 'va-3');
    assert.ok(e);
    assert.equal(e.decision_id, null, 'non-string decision_id coerced to null (defensive)');
  });
});

test('v3.9.1 — readActions C-11 OOM mitigation', async (t) => {
  await t.test('default readActions reads live file only, NOT bak siblings', () => {
    _reset();
    const file = path.join(VANTA_TMP, 'actions.jsonl');
    // Write a bak that contains a "stale" entry; it should NOT appear in default read.
    const stale = {
      id: 'va-stale',
      kind: 'council_call',
      lifecycle: 'pending',
      reversible: true,
      ts: '2020-01-01T00:00:00Z',
      project: 'p1',
      decision_id: 'dec-stale',
      inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
    };
    fs.writeFileSync(file + '.bak.123', '\n' + JSON.stringify(stale) + '\n');
    // Live file: a fresh entry.
    const fresh = {
      id: 'va-fresh',
      kind: 'council_call',
      lifecycle: 'pending',
      reversible: true,
      ts: new Date().toISOString(),
      project: 'p1',
      decision_id: 'dec-fresh',
      inverse: { kind: 'council_call', request_id: 'r', cancelled_locally: false, remote_status: 'unknown' },
    };
    fs.writeFileSync(file, '\n' + JSON.stringify(fresh) + '\n');

    const liveOnly = va.readActions({ project: 'p1' });
    assert.equal(liveOnly.length, 1, 'default read returns only live-file entries');
    assert.equal(liveOnly[0].id, 'va-fresh');

    const allHist = va.readActions({ project: 'p1', allHistory: true });
    assert.equal(allHist.length, 2, 'allHistory: true reads bak siblings too');
    assert.deepEqual(
      allHist.map(a => a.id).sort(),
      ['va-fresh', 'va-stale'],
    );
  });
});

test('v3.9.1 — vanta-jsonl readMergedJsonl includeBaks flag', async (t) => {
  await t.test('default includeBaks=true preserves back-compat for soak-report etc.', () => {
    _reset();
    const j = require('../bin/vanta-jsonl.js');
    const file = path.join(VANTA_TMP, 'sample.jsonl');
    fs.writeFileSync(file + '.bak.1', '{"x":"old"}\n');
    fs.writeFileSync(file, '{"x":"new"}\n');

    const merged = j.readMergedJsonl(file);
    assert.ok(merged.includes('"old"'), 'default reads bak siblings');
    assert.ok(merged.includes('"new"'), 'default reads live file');
  });

  await t.test('includeBaks=false bounds memory to live file', () => {
    _reset();
    const j = require('../bin/vanta-jsonl.js');
    const file = path.join(VANTA_TMP, 'sample.jsonl');
    fs.writeFileSync(file + '.bak.1', '{"x":"old"}\n');
    fs.writeFileSync(file, '{"x":"new"}\n');

    const live = j.readMergedJsonl(file, { includeBaks: false });
    assert.ok(!live.includes('"old"'), 'bak NOT loaded under includeBaks=false');
    assert.ok(live.includes('"new"'), 'live file loaded');
  });
});

// ─── Final-council fix: action-log persists decision_id ─────────────

test('Final-council fix: action-log persists decision_id top-level', async (t) => {
  await t.test('action-log.record persists decision_id field', () => {
    _reset();
    const al = require('../bin/vanta-action-log.js');
    const written = al.record({
      action: 'rewrite',
      session_id: 'sess-1',
      project: 'test',
      decision: 'auto',
      decision_id: 'dec-from-rewriter-123',
      undo_hint: { kind: 'rewriter-shadow', payload: { decision_id: 'dec-from-rewriter-123' } },
    });
    assert.ok(written, 'record() returned non-null');
    assert.equal(written.decision_id, 'dec-from-rewriter-123',
      'decision_id is persisted top-level');

    // Read back from disk to confirm
    const file = path.join(VANTA_TMP, 'actions.jsonl');
    const raw = fs.readFileSync(file, 'utf8').trim();
    const entry = JSON.parse(raw.split('\n')[0]);
    assert.equal(entry.decision_id, 'dec-from-rewriter-123',
      'on-disk entry has decision_id');
  });

  await t.test('action-log.record handles entries without decision_id (back-compat)', () => {
    _reset();
    const al = require('../bin/vanta-action-log.js');
    const written = al.record({
      action: 'rewrite-skip',
      session_id: 'sess-1',
      project: 'test',
    });
    assert.ok(written);
    assert.equal(written.decision_id, null);
  });
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
});
