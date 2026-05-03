'use strict';
// v3.10 commit 1 — vanta-rule-effectiveness.js tests.
//
// Verifies the council-fixed scoring primitives:
//   C-1 — lineage required (decision_id from v3.9.1)
//   C-3 — content-hash extraction from vanta-rewriter.js
//   C-4 — unscorable when lineage missing (no false attribution)
//   C-5 — scoring_epoch_start_ts filters pre-rehab fires
//   C-8 — monotonic status_seq with deterministic precedence
//   Wilson CI math correctness
//   Quarantine eligibility threshold logic

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v310-rule-eff-' + process.pid);
process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;

const re = require('../bin/vanta-rule-effectiveness.js');

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
}

function _writeJsonl(file, entries) {
  const full = path.join(VANTA_TMP, file);
  fs.writeFileSync(full, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('Wilson CI lower bound math', async (t) => {
  await t.test('n=0 returns 0 (cold start protection)', () => {
    assert.equal(re.wilsonLowerBound(0, 0), 0);
  });

  await t.test('all successes still bounded below 1', () => {
    const lb = re.wilsonLowerBound(50, 50);
    assert.ok(lb < 1, `lb=${lb} should be <1 for finite n`);
    assert.ok(lb > 0.9, `lb=${lb} should be high for 50/50 successes`);
  });

  await t.test('all failures gives lower bound 0 (or near)', () => {
    const lb = re.wilsonLowerBound(0, 50);
    assert.ok(lb < 0.1, `lb=${lb} should be near 0 for 0/50 successes`);
  });

  await t.test('50/50 success rate gives lb < 0.5', () => {
    const lb = re.wilsonLowerBound(25, 50);
    assert.ok(lb < 0.5, `lb=${lb} should be < 0.5 (Wilson is below point estimate)`);
    assert.ok(lb > 0.35, `lb=${lb} should be > 0.35 for 25/50`);
  });

  await t.test('matches known Wilson value for 30/100', () => {
    // Wilson 95% lower bound for 30/100 ≈ 0.2173
    const lb = re.wilsonLowerBound(30, 100);
    assert.ok(Math.abs(lb - 0.2173) < 0.005, `lb=${lb} should be ~0.2173 for 30/100`);
  });
});

test('extractRuleBlockHashes (C-3)', async (t) => {
  await t.test('extracts each rule by id and produces stable hashes', () => {
    const source = `
      const RULES = [
        {
          id: 'rule-a',
          rx: /a/,
          intent: 'foo',
          chain: ['step1'],
        },
        {
          id: 'rule-b',
          rx: /b/,
          intent: 'bar',
          chain: ['step2'],
        },
      ];
    `;
    const hashes = re.extractRuleBlockHashes(source);
    assert.equal(hashes.size, 2);
    assert.ok(hashes.has('rule-a'));
    assert.ok(hashes.has('rule-b'));
    assert.notEqual(hashes.get('rule-a'), hashes.get('rule-b'));
    // Hash is stable for same input
    const hashes2 = re.extractRuleBlockHashes(source);
    assert.equal(hashes.get('rule-a'), hashes2.get('rule-a'));
  });

  await t.test('hash changes when only one rule is edited (C-3 fix verifies)', () => {
    const v1 = `
      const RULES = [
        { id: 'a', rx: /a/, intent: 'x' },
        { id: 'b', rx: /b/, intent: 'y' },
      ];
    `;
    const v2 = `
      const RULES = [
        { id: 'a', rx: /a/, intent: 'x' },
        { id: 'b', rx: /b/, intent: 'y-CHANGED' },
      ];
    `;
    const h1 = re.extractRuleBlockHashes(v1);
    const h2 = re.extractRuleBlockHashes(v2);
    assert.equal(h1.get('a'), h2.get('a'), 'a unchanged should keep same hash');
    assert.notEqual(h1.get('b'), h2.get('b'), 'b changed should produce new hash');
  });

  await t.test('hashes the actual production rewriter source', () => {
    const source = re.readRewriterSource();
    assert.ok(source, 'rewriter source readable');
    const hashes = re.extractRuleBlockHashes(source);
    assert.ok(hashes.size >= 5, `extracted ${hashes.size} rules, expected >=5`);
    assert.ok(hashes.has('fix-broken'), 'fix-broken rule extracted');
    assert.ok(hashes.has('ship-this'), 'ship-this rule extracted');
  });
});

test('scoreRule — C-4 lineage-required scoring', async (t) => {
  await t.test('fires WITHOUT decision_id are unscorable, not proceeded', () => {
    _reset();
    const fires = [
      { ts: '2026-05-01T10:00:00Z', rule_id: 'r1', suggested_route: '/x' },  // no decision_id
      { ts: '2026-05-01T10:01:00Z', rule_id: 'r1', suggested_route: '/x' },  // no decision_id
    ];
    const r = re.scoreRule('r1', fires, new Map(), [], null);
    assert.equal(r.unscorable, 2, 'all unscorable due to missing lineage');
    assert.equal(r.fires, 0, 'unscorable not counted toward fires');
    assert.equal(r.proceeded, 0);
  });

  await t.test('fires with matching outcome are correctly classified', () => {
    _reset();
    const fires = [
      { ts: '2026-05-01T10:00:00Z', rule_id: 'r1', decision_id: 'd1', suggested_route: '/x' },
      { ts: '2026-05-01T10:05:00Z', rule_id: 'r1', decision_id: 'd2', suggested_route: '/x' },
      { ts: '2026-05-01T10:10:00Z', rule_id: 'r1', decision_id: 'd3', suggested_route: '/x' },
    ];
    const outcomes = new Map([
      ['d1', { kind: 'undone',   ts: '2026-05-01T10:00:30Z' }],
      ['d2', { kind: 'rerouted', ts: '2026-05-01T10:06:00Z' }],
      // d3 has no outcome — should count as proceeded
    ]);
    const r = re.scoreRule('r1', fires, outcomes, [], null);
    assert.equal(r.fires, 3);
    assert.equal(r.undone, 1);
    assert.equal(r.rerouted, 1);
    assert.equal(r.proceeded, 1);
    assert.equal(r.unscorable, 0);
  });

  await t.test('outcome OUTSIDE 30min window does not attribute', () => {
    _reset();
    const fires = [
      { ts: '2026-05-01T10:00:00Z', rule_id: 'r1', decision_id: 'd1', suggested_route: '/x' },
    ];
    const outcomes = new Map([
      ['d1', { kind: 'undone', ts: '2026-05-01T11:00:00Z' }],  // 60min later
    ]);
    const r = re.scoreRule('r1', fires, outcomes, [], null);
    assert.equal(r.proceeded, 1, 'outcome outside window → proceeded');
    assert.equal(r.undone, 0);
  });

  await t.test('manual recall matches by (project, session) proximity', () => {
    _reset();
    const fires = [
      {
        ts: '2026-05-01T10:00:00Z',
        rule_id: 'r1',
        decision_id: 'd1',
        suggested_route: '/x',
        project: 'p1',
        session_id: 's1',
      },
    ];
    const recalls = [
      {
        ts: '2026-05-01T10:01:00Z',
        project: 'p1',
        session_id: 's1',
      },
    ];
    const r = re.scoreRule('r1', fires, new Map(), recalls, null);
    assert.equal(r.recalled, 1);
    assert.equal(r.proceeded, 0);
  });
});

test('scoreRule — C-5 scoring_epoch filter', async (t) => {
  await t.test('fires before epoch are excluded from score', () => {
    _reset();
    const fires = [
      // Pre-epoch fires (should be excluded)
      { ts: '2026-04-30T10:00:00Z', rule_id: 'r1', decision_id: 'd-old1', suggested_route: '/x' },
      { ts: '2026-04-30T11:00:00Z', rule_id: 'r1', decision_id: 'd-old2', suggested_route: '/x' },
      // Post-epoch fires
      { ts: '2026-05-01T10:00:00Z', rule_id: 'r1', decision_id: 'd-new1', suggested_route: '/x' },
    ];
    const epochStart = '2026-05-01T00:00:00Z';
    const r = re.scoreRule('r1', fires, new Map(), [], epochStart);
    assert.equal(r.fires + r.unscorable, 1, 'only post-epoch fire counted');
  });
});

test('quarantineEligible — threshold logic', async (t) => {
  await t.test('< 50 fires: ineligible regardless of CI', () => {
    const r = { fires: 10, ci_lower: 0.05, last_50_window_rate: 0.05 };
    const e = re.quarantineEligible(r);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /fires=10 < min=50/);
  });

  await t.test('50 fires + ci_lower 0.45: ineligible (above threshold)', () => {
    const r = { fires: 50, ci_lower: 0.45, last_50_window_rate: 0.20 };
    const e = re.quarantineEligible(r);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /ci_lower/);
  });

  await t.test('50 fires + ci_lower 0.20 + window 0.45: ineligible (window above)', () => {
    const r = { fires: 50, ci_lower: 0.20, last_50_window_rate: 0.45 };
    const e = re.quarantineEligible(r);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /last_50_window/);
  });

  await t.test('50 fires + ci_lower 0.20 + window 0.20: eligible', () => {
    const r = { fires: 50, ci_lower: 0.20, last_50_window_rate: 0.20 };
    const e = re.quarantineEligible(r);
    assert.equal(e.eligible, true);
  });

  await t.test('cold-start protection: 0 fires never eligible', () => {
    const r = { fires: 0, ci_lower: 0, last_50_window_rate: 0 };
    const e = re.quarantineEligible(r);
    assert.equal(e.eligible, false);
  });
});

test('snapshot + readLatestStatus — C-8 monotonic seq + dedup', async (t) => {
  await t.test('snapshot observes at seq=prior (no bump) — R1 council fix', () => {
    // Post-R1 council fix (Codex P1 + Gemini P1): snapshot is OBSERVATION
    // and must NOT bump status_seq, otherwise concurrent setStatus calls
    // get stomped. Only setStatus (manual policy) increments seq.
    _reset();
    const r1 = { rule_id: 'r1', fires: 10, unscorable: 0, proceeded: 8, recalled: 0, undone: 1, rerouted: 1, stopped: 0, success_rate: 0.8, ci_lower: 0.5, last_50_window_rate: 0.8 };
    const w1 = re.snapshot([r1]);
    assert.equal(w1.length, 1);
    assert.equal(w1[0].status_seq, 0, 'first snapshot at seq=0 (prior was null)');
    const w2 = re.snapshot([r1]);
    assert.equal(w2[0].status_seq, 0, 'subsequent snapshots stay at seq=0 — no bump');
  });

  await t.test('readLatestStatus returns latest snapshot by ts when seqs tie', () => {
    _reset();
    const r1 = { rule_id: 'r1', fires: 5, unscorable: 0, proceeded: 5, recalled: 0, undone: 0, rerouted: 0, stopped: 0, success_rate: 1.0, ci_lower: 0.5, last_50_window_rate: 1.0 };
    re.snapshot([r1]);
    re.snapshot([r1]);
    re.snapshot([r1]);
    const status = re.readLatestStatus();
    assert.ok(status.has('r1'));
    const last = status.get('r1');
    // All three snapshot entries share seq=0; ts breaks tie.
    assert.equal(status.size, 1, 'only one entry returned per rule');
  });

  await t.test('setStatus seq=1 dominates any snapshot (which stays at seq=0)', () => {
    _reset();
    const r1 = { rule_id: 'rd', fires: 5, unscorable: 0, proceeded: 5, recalled: 0, undone: 0, rerouted: 0, stopped: 0, success_rate: 1.0, ci_lower: 0.5, last_50_window_rate: 1.0 };
    re.snapshot([r1]);  // seq=0
    re.setStatus('rd', 'quarantined', { reason: 'manual' });  // seq=1
    re.snapshot([r1]);  // seq=0 again — must not stomp
    const last = re.readLatestStatus().get('rd');
    assert.equal(last.status, 'quarantined', 'manual decision sticks');
    assert.equal(last.status_seq, 1, 'setStatus seq=1 beats snapshot seq=0');
  });

  await t.test('flagged status set when snapshot crosses threshold', () => {
    _reset();
    const failing = {
      rule_id: 'rf',
      fires: 80, unscorable: 0,
      proceeded: 10, recalled: 5, undone: 60, rerouted: 5, stopped: 0,
      success_rate: 0.125, ci_lower: 0.07, last_50_window_rate: 0.10,
    };
    const written = re.snapshot([failing]);
    assert.equal(written[0].status, 'flagged', 'crossed-threshold rule auto-flagged');
    assert.match(written[0].status_reason, /auto-flagged/);
  });

  await t.test('healthy rule stays active', () => {
    _reset();
    const healthy = {
      rule_id: 'rh',
      fires: 100, unscorable: 0,
      proceeded: 90, recalled: 2, undone: 5, rerouted: 3, stopped: 0,
      success_rate: 0.90, ci_lower: 0.82, last_50_window_rate: 0.90,
    };
    const written = re.snapshot([healthy]);
    assert.equal(written[0].status, 'active');
  });
});

test('compute — end-to-end scoring against real rewriter', async (t) => {
  await t.test('compute returns rules with hashes from production source', () => {
    _reset();
    // Empty telemetry; just verify we discover rules from rewriter source
    const result = re.compute();
    assert.ok(result.rules.length >= 5, `expected >=5 production rules, got ${result.rules.length}`);
    assert.ok(result.current_block_hashes.size >= 5);
    // Every scored rule should have a content hash
    for (const rule of result.rules) {
      assert.ok(rule.rule_content_hash, `rule ${rule.rule_id} missing content hash`);
    }
  });

  await t.test('compute joins fires + outcomes by decision_id', () => {
    _reset();
    // Seed minimal route-quality + cancellations
    _writeJsonl('route-quality.jsonl', [
      { ts: '2026-05-01T10:00:00Z', rule_id: 'fix-broken', decision_id: 'd1', suggested_route: '/investigate', project: 'p1', session_id: 's1' },
      { ts: '2026-05-01T10:05:00Z', rule_id: 'fix-broken', decision_id: 'd2', suggested_route: '/investigate', project: 'p1', session_id: 's1' },
      { ts: '2026-05-01T10:10:00Z', rule_id: 'fix-broken', decision_id: 'd3', suggested_route: '/investigate', project: 'p1', session_id: 's1' },
    ]);
    _writeJsonl('cancellations.jsonl', [
      { decision_id: 'd1', cancellation_kind: 'user-initiated-undo', cancelled_at: '2026-05-01T10:00:30Z', action_id: 'va-1' },
      { decision_id: 'd2', cancellation_kind: 'user-initiated-stop', cancelled_at: '2026-05-01T10:05:30Z', action_id: 'va-2' },
    ]);

    const result = re.compute();
    const fixBroken = result.rules.find(r => r.rule_id === 'fix-broken');
    assert.ok(fixBroken);
    assert.equal(fixBroken.fires, 3);
    assert.equal(fixBroken.undone, 1);
    assert.equal(fixBroken.stopped, 1);
    assert.equal(fixBroken.proceeded, 1, 'd3 with no outcome → proceeded');
  });
});

test('listQuarantined integration', async (t) => {
  await t.test('returns empty when no rule has been quarantined', () => {
    _reset();
    assert.equal(re.listQuarantined().length, 0);
  });

  await t.test('returns rule_id once status is set to quarantined manually', () => {
    _reset();
    // Simulate a manual quarantine entry (commit 3 will write these via rule-tune CLI)
    const file = path.join(VANTA_TMP, 'rule-effectiveness.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      rule_id: 'r-bad',
      kind: 'status-change',
      status: 'quarantined',
      status_reason: 'manual',
      status_seq: 100,
    }) + '\n');
    const q = re.listQuarantined();
    assert.deepEqual(q, ['r-bad']);
  });
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
});
