'use strict';
// v3.10 commit 5 — soak report extensions tests.
//
// Verifies:
//   - §7 Rule Effectiveness section renders against real telemetry
//   - §8 Invariant Evidence section renders
//   - §9 Missed-Intent Clusters: clusterMissedIntents algorithm
//   - degraded mode when bins missing
//   - report still produces valid markdown end-to-end

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v310-soak-' + process.pid);
process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;

const soak = require('../tools/vanta-soak-report.js');
const re = require('../bin/vanta-rule-effectiveness.js');
const evid = require('../bin/vanta-evidence-log.js');

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
}

function _writeJsonl(filename, entries) {
  const file = path.join(VANTA_TMP, filename);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// ─── Cluster algorithm unit tests ────────────────────────────────────

test('clusterMissedIntents algorithm', async (t) => {
  await t.test('returns empty for empty input', () => {
    assert.deepEqual(soak.clusterMissedIntents([]), []);
    assert.deepEqual(soak.clusterMissedIntents(null), []);
  });

  await t.test('clusters prompts sharing a distinctive token', () => {
    const missed = [
      { prompt: 'help me deploy this to staging' },
      { prompt: 'deploy this branch please' },
      { prompt: 'lets deploy now' },
      { prompt: 'show me the diff' },
      { prompt: 'list all open PRs' },
    ];
    const clusters = soak.clusterMissedIntents(missed, { topK: 3 });
    // The 3 deploy prompts should cluster
    const deployCluster = clusters.find(c => c.tokens.includes('deploy'));
    assert.ok(deployCluster, 'deploy cluster should exist');
    assert.ok(deployCluster.size >= 3);
  });

  await t.test('skips clusters below minClusterSize', () => {
    const missed = [
      { prompt: 'foo' },
      { prompt: 'bar' },
      { prompt: 'baz' },
    ];
    const clusters = soak.clusterMissedIntents(missed, { topK: 5, minClusterSize: 2 });
    assert.equal(clusters.length, 0, 'no shared tokens, no cluster');
  });

  await t.test('caps at topK clusters', () => {
    // 5 distinct topics — each is its own cluster with ≥2 docs.
    const missed = [
      { prompt: 'deploy api staging' },
      { prompt: 'deploy api production' },
      { prompt: 'migrate database schema' },
      { prompt: 'migrate database now' },
      { prompt: 'review github code' },
      { prompt: 'review github changes' },
      { prompt: 'profile slow queries' },
      { prompt: 'profile memory leak' },
      { prompt: 'lint typescript files' },
      { prompt: 'lint typescript errors' },
    ];
    const clusters = soak.clusterMissedIntents(missed, { topK: 3, minClusterSize: 2 });
    // Cap respected: never more than 3 returned.
    assert.ok(clusters.length <= 3, `expected ≤3 clusters, got ${clusters.length}`);
    assert.ok(clusters.length >= 1, 'at least one cluster found');
  });

  await t.test('strips stopwords from clustering', () => {
    const missed = [
      { prompt: 'please make this work' },
      { prompt: 'please could you help' },
      { prompt: 'this would help me' },
    ];
    // 'please', 'this', 'would', 'help' are stopwords → no cluster
    const clusters = soak.clusterMissedIntents(missed, { topK: 5 });
    // 'help' is too short and a stopword; 'work' appears once
    // Expect 0 or very few clusters
    assert.ok(clusters.length <= 1);
  });

  await t.test('label is truncated to 60 chars', () => {
    const longPrompt = 'this is a very long prompt that goes on and on and on and on and on with deployment stuff';
    const missed = [
      { prompt: longPrompt },
      { prompt: 'deployment something else' },
    ];
    const clusters = soak.clusterMissedIntents(missed, { topK: 1, minClusterSize: 2 });
    if (clusters.length > 0) {
      assert.ok(clusters[0].label.length <= 60);
    }
  });

  await t.test('claimed prompts not double-counted', () => {
    const missed = [
      { prompt: 'deploy api' },
      { prompt: 'deploy ui' },
      { prompt: 'api migration' },
      { prompt: 'api refactor' },
    ];
    const clusters = soak.clusterMissedIntents(missed, { topK: 5 });
    let totalSize = 0;
    for (const c of clusters) totalSize += c.size;
    assert.ok(totalSize <= missed.length, 'no prompt counted twice');
  });
});

// ─── Soak report integration ─────────────────────────────────────────

test('buildReport renders §7 Rule Effectiveness', async (t) => {
  await t.test('section is present in output', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 7 });
    assert.match(md, /## 7\. Rule Effectiveness/);
  });

  await t.test('section shows fired rules from telemetry', () => {
    _reset();
    // Seed some route-quality entries
    _writeJsonl('route-quality.jsonl', [
      { ts: new Date().toISOString(), rule_id: 'fix-broken', skill_route: '/investigate', decision_id: 'd1' },
      { ts: new Date().toISOString(), rule_id: 'fix-broken', skill_route: '/investigate', decision_id: 'd2' },
      { ts: new Date().toISOString(), rule_id: 'ship-this', skill_route: '/ship', decision_id: 'd3' },
    ]);
    const md = soak.buildReport({ windowDays: 7 });
    // Should include at least one rule (the seeded one) — but real corpus
    // discovery means many rules are present at fires=0
    assert.match(md, /## 7\. Rule Effectiveness/);
    // fix-broken should appear in top fired (it has 2 fires in window)
    const section7Match = md.match(/## 7\. Rule Effectiveness[\s\S]*?(?=## 8\.)/);
    assert.ok(section7Match);
    assert.match(section7Match[0], /fix-broken/);
  });

  await t.test('shows quarantined rules separately', () => {
    _reset();
    re.setStatus('fix-broken', 'quarantined', { reason: 'soak-test' });
    const md = soak.buildReport({ windowDays: 7 });
    assert.match(md, /Flagged \/ Quarantined/);
    assert.match(md, /fix-broken: quarantined/);
  });
});

test('buildReport renders §8 Invariant Evidence', async (t) => {
  await t.test('section header always present', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 7 });
    assert.match(md, /## 8\. Invariant Evidence/);
  });

  await t.test('shows top-cited when invariants recorded', () => {
    _reset();
    evid.record({ invariant_hash: 'inv-hot', event: 'retrieved', origin: 'user-prompt' });
    evid.record({ invariant_hash: 'inv-hot', event: 'retrieved', origin: 'user-prompt' });
    evid.record({ invariant_hash: 'inv-hot', event: 'council_tp' });
    const md = soak.buildReport({ windowDays: 7 });
    assert.match(md, /Top-cited/);
    assert.match(md, /inv-hot/);
  });

  await t.test('empty state when no evidence recorded', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 7 });
    const section = md.match(/## 8\. Invariant Evidence[\s\S]*?(?=## 9\.)/);
    assert.ok(section);
    assert.match(section[0], /No invariant evidence recorded/);
  });
});

test('buildReport renders §9 Missed-Intent Clusters', async (t) => {
  await t.test('section header always present', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 7 });
    assert.match(md, /## 9\. Missed-Intent Clusters/);
  });

  await t.test('clusters surfaced when threshold met', () => {
    _reset();
    const now = new Date().toISOString();
    _writeJsonl('missed-intents.jsonl', [
      { ts: now, prompt: 'deploy this branch please' },
      { ts: now, prompt: 'deploy api now' },
      { ts: now, prompt: 'deploy ui staging' },
      { ts: now, prompt: 'show diff' },
    ]);
    const md = soak.buildReport({ windowDays: 7 });
    const section = md.match(/## 9\. Missed-Intent Clusters[\s\S]*?$/);
    assert.ok(section);
    // Cluster about deployment should appear
    assert.match(section[0], /deploy/);
    assert.match(section[0], /3 prompts/);
  });

  await t.test('shows "no missed intents" when empty', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 7 });
    const section = md.match(/## 9\. Missed-Intent Clusters[\s\S]*$/);
    assert.match(section[0], /No missed intents recorded/);
  });
});

test('buildReport produces valid markdown end-to-end', async (t) => {
  await t.test('all 9 sections present', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 7 });
    for (let i = 1; i <= 9; i++) {
      assert.match(md, new RegExp(`## ${i}\\. `), `section ${i} missing`);
    }
  });

  await t.test('header includes window and source paths', () => {
    _reset();
    const md = soak.buildReport({ windowDays: 14 });
    assert.match(md, /Window: last 14d/);
    assert.match(md, /route-quality.*manual-recalls.*actions.*missed-intents/);
  });
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
});
