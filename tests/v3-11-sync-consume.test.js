'use strict';
// v3.11 commit 1 — vanta-sync-consume.js tests.
//
// Verifies the council-fixed primitives:
//   C-1 — per-slug isolation (no cross-project starvation)
//   C-5 — idempotent mark/read (atomicity boundary at consume)
//   v3.10 R8 P1 — bak-sibling discovery + dedup-on-read
//   30d auto-trim retention

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v311-consume-' + process.pid);
process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;

// Lazy-require AFTER env override so paths resolve to the temp dir.
delete require.cache[require.resolve('../bin/vanta-sync-consume.js')];
const consume = require('../bin/vanta-sync-consume.js');

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
}

function _writeLedger(lines, suffix = '') {
  const file = path.join(VANTA_TMP, 'sync-consumed.jsonl' + suffix);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function _isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test('mark() appends entry atomically', () => {
  _reset();
  const ok = consume.mark({
    slug: 'vanta',
    source: 'episode',
    ref: 'session-abc',
    ts: '2026-05-03T10:00:00.000Z',
  });
  assert.equal(ok, true);
  const content = fs.readFileSync(consume._ledgerPath(), 'utf8');
  // Each entry is well under 4KB
  assert.ok(content.length < 4096);
  assert.match(content, /"slug":"vanta"/);
  assert.match(content, /"source":"episode"/);
  assert.match(content, /"ref":"session-abc"/);
  assert.match(content, /"consumed_at":/);
});

test('mark() is idempotent on (slug, source, ref) via dedup-on-read', () => {
  _reset();
  consume.mark({ slug: 'vanta', source: 'episode', ref: 's1', ts: _isoDaysAgo(1) });
  consume.mark({ slug: 'vanta', source: 'episode', ref: 's1', ts: _isoDaysAgo(1) });
  consume.mark({ slug: 'vanta', source: 'episode', ref: 's1', ts: _isoDaysAgo(1) });
  const set = consume.read({ slug: 'vanta' });
  // Three writes, one entry visible after dedup
  assert.equal(set.size, 1);
  assert.ok(set.has('episode|s1'));
});

test('read() dedups across .bak.* siblings + live file', () => {
  _reset();
  // Old entries in a bak file
  _writeLedger([
    { slug: 'vanta', source: 'episode', ref: 's1', ts: _isoDaysAgo(2), consumed_at: _isoDaysAgo(2) },
    { slug: 'vanta', source: 'git',     ref: 'sha-aaa', ts: _isoDaysAgo(2), consumed_at: _isoDaysAgo(2) },
  ], '.bak.0001');
  // New entries in another bak
  _writeLedger([
    { slug: 'vanta', source: 'episode', ref: 's2', ts: _isoDaysAgo(1), consumed_at: _isoDaysAgo(1) },
  ], '.bak.0002');
  // Live file — same s1 again (dedup test) + new entry
  consume.mark({ slug: 'vanta', source: 'episode', ref: 's1', ts: _isoDaysAgo(2) });
  consume.mark({ slug: 'vanta', source: 'failure', ref: 'fail-1', ts: _isoDaysAgo(0) });

  const set = consume.read({ slug: 'vanta' });
  // s1 appears twice (bak + live) but Set dedups → 4 unique
  assert.equal(set.size, 4);
  assert.ok(set.has('episode|s1'));
  assert.ok(set.has('git|sha-aaa'));
  assert.ok(set.has('episode|s2'));
  assert.ok(set.has('failure|fail-1'));
});

test('read() trims entries older than 30 days (lazy retention)', () => {
  _reset();
  _writeLedger([
    { slug: 'vanta', source: 'episode', ref: 'old',    ts: _isoDaysAgo(45), consumed_at: _isoDaysAgo(45) },
    { slug: 'vanta', source: 'episode', ref: 'recent', ts: _isoDaysAgo(5),  consumed_at: _isoDaysAgo(5)  },
  ]);
  const set = consume.read({ slug: 'vanta' });
  assert.equal(set.size, 1);
  assert.ok(set.has('episode|recent'));
  assert.ok(!set.has('episode|old'));
});

test('lookback() returns max(ts) for slug when ledger has entries', () => {
  _reset();
  _writeLedger([
    { slug: 'vanta', source: 'episode', ref: 's1', ts: '2026-05-01T00:00:00.000Z', consumed_at: _isoDaysAgo(2) },
    { slug: 'vanta', source: 'episode', ref: 's2', ts: '2026-05-02T00:00:00.000Z', consumed_at: _isoDaysAgo(1) },
    { slug: 'vanta', source: 'git',     ref: 'sha', ts: '2026-04-30T00:00:00.000Z', consumed_at: _isoDaysAgo(3) },
  ]);
  const lb = consume.lookback({ slug: 'vanta' });
  // max ts = 2026-05-02
  assert.equal(lb, '2026-05-02T00:00:00.000Z');
});

test('lookback() returns now()-7d when ledger empty for slug', () => {
  _reset();
  const lb = consume.lookback({ slug: 'vanta' });
  const ageMs = Date.now() - Date.parse(lb);
  // Allow ±1s margin for test execution time
  const expected = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(ageMs - expected) < 1000, `expected ~7d ago, got ${ageMs}ms`);
});

test('lookback() does NOT advance based on other slugs entries (per-slug isolation)', () => {
  _reset();
  // Project A has a recent entry
  _writeLedger([
    { slug: 'project-a', source: 'episode', ref: 's1', ts: _isoDaysAgo(1), consumed_at: _isoDaysAgo(1) },
  ]);
  // Project B has no entries
  const lbB = consume.lookback({ slug: 'project-b' });
  const ageMs = Date.now() - Date.parse(lbB);
  const expected = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(ageMs - expected) < 1000,
    `project-b lookback should be 7d default, got ${ageMs}ms`);
  // Project A should still get its real lookback
  const lbA = consume.lookback({ slug: 'project-a' });
  assert.ok(Math.abs(Date.now() - Date.parse(lbA)) < 24 * 60 * 60 * 1000 * 1.5);
});

test('malformed JSON line silently skipped (no crash)', () => {
  _reset();
  const file = consume._ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ slug: 'vanta', source: 'episode', ref: 's1', ts: _isoDaysAgo(1), consumed_at: _isoDaysAgo(1) }),
    '{not valid json',
    '',
    JSON.stringify({ slug: 'vanta', source: 'episode', ref: 's2', ts: _isoDaysAgo(1), consumed_at: _isoDaysAgo(1) }),
  ].join('\n') + '\n');
  const set = consume.read({ slug: 'vanta' });
  assert.equal(set.size, 2);
  assert.ok(set.has('episode|s1'));
  assert.ok(set.has('episode|s2'));
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
});
