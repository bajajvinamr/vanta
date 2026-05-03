'use strict';
// v3.10 — vanta-statusline tests.
//
// Verifies the heartbeat indicator logic without involving the actual
// statusline subprocess. The composition with gsd-statusline is left
// to manual smoke-test (it depends on the user's $HOME/.claude layout).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-statusline-' + process.pid);

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
}

// The statusline reads from $HOME/.vanta/. We can't easily redirect
// homedir() from the same process, so we test the helper functions
// directly via require's cache by overriding what the module sees.
function _loadStatusline() {
  const fp = require.resolve('../bin/vanta-statusline.js');
  delete require.cache[fp];
  // Override homedir() before module loads
  const origHome = os.homedir;
  os.homedir = () => VANTA_TMP.replace('/.vanta', '');
  try {
    return require('../bin/vanta-statusline.js');
  } finally {
    os.homedir = origHome;
  }
}

test('heartbeat: states based on interactions.jsonl mtime', async (t) => {
  await t.test('returns ∅ when interactions.jsonl missing', () => {
    _reset();
    fs.mkdirSync(path.dirname(VANTA_TMP) + '/.vanta', { recursive: true });
    const sl = _loadStatusline();
    assert.equal(sl._heartbeat(), '∅');
  });

  await t.test('returns ✓ Ns when fired within last 60s', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'interactions.jsonl');
    fs.writeFileSync(file, '{}\n');
    // mtime is "now" by default
    const sl = _loadStatusline();
    assert.match(sl._heartbeat(), /^✓ \d+s$/);
  });

  await t.test('returns ✓ Nm when fired within last 5min', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'interactions.jsonl');
    fs.writeFileSync(file, '{}\n');
    // Set mtime to 2 minutes ago
    const past = new Date(Date.now() - 2 * 60_000);
    fs.utimesSync(file, past, past);
    const sl = _loadStatusline();
    assert.match(sl._heartbeat(), /^✓ \d+m$/);
  });

  await t.test('returns ⚠ Nm when fired between 5min and 1h ago', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'interactions.jsonl');
    fs.writeFileSync(file, '{}\n');
    const past = new Date(Date.now() - 30 * 60_000);  // 30min
    fs.utimesSync(file, past, past);
    const sl = _loadStatusline();
    assert.match(sl._heartbeat(), /^⚠ \d+m$/);
  });

  await t.test('returns ⚠ Nh when fired between 1h and 24h ago', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'interactions.jsonl');
    fs.writeFileSync(file, '{}\n');
    const past = new Date(Date.now() - 3 * 3_600_000);  // 3h
    fs.utimesSync(file, past, past);
    const sl = _loadStatusline();
    assert.match(sl._heartbeat(), /^⚠ \d+h$/);
  });

  await t.test('returns ✗ stale when no fire in >24h', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'interactions.jsonl');
    fs.writeFileSync(file, '{}\n');
    const past = new Date(Date.now() - 48 * 3_600_000);  // 2 days
    fs.utimesSync(file, past, past);
    const sl = _loadStatusline();
    assert.equal(sl._heartbeat(), '✗ stale');
  });
});

test('unsynced count: tail-read heuristic', async (t) => {
  await t.test('returns 0 when sync-queue missing', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const sl = _loadStatusline();
    assert.equal(sl._unsyncedCount(), 0);
  });

  await t.test('counts "synced":false occurrences in tail', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync-queue.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ session_id: `s${i}`, synced: false }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const sl = _loadStatusline();
    assert.equal(sl._unsyncedCount(), 5);
  });

  await t.test('returns 0 when only synced:true entries present', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync-queue.jsonl');
    fs.writeFileSync(file,
      JSON.stringify({ session_id: 's1', synced: true }) + '\n');
    const sl = _loadStatusline();
    assert.equal(sl._unsyncedCount(), 0);
  });
});

test('hook errors: only counts ERROR lines within last hour', async (t) => {
  await t.test('returns false when hook.log missing', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const sl = _loadStatusline();
    assert.equal(sl._hasRecentHookErrors(), false);
  });

  await t.test('returns false for old ERROR lines (>1h)', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hook.log');
    const oldTs = new Date(Date.now() - 2 * 3_600_000).toISOString();
    fs.writeFileSync(file, `${oldTs} | ERROR | test | something failed\n`);
    // Set mtime old too so the quick-reject fires
    const past = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(file, past, past);
    const sl = _loadStatusline();
    assert.equal(sl._hasRecentHookErrors(), false);
  });

  await t.test('returns true for ERROR within last hour', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hook.log');
    const recentTs = new Date(Date.now() - 30 * 60_000).toISOString();
    fs.writeFileSync(file, `${recentTs} | ERROR | test | something failed\n`);
    const sl = _loadStatusline();
    assert.equal(sl._hasRecentHookErrors(), true);
  });

  await t.test('returns false when only INFO lines present (no false positive)', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hook.log');
    const recentTs = new Date(Date.now() - 30 * 60_000).toISOString();
    // Only INFO — no ERROR
    fs.writeFileSync(file, `${recentTs} | INFO | git-guardrails | ADVISORY: ...\n`);
    const sl = _loadStatusline();
    assert.equal(sl._hasRecentHookErrors(), false);
  });
});

test('vanta segment composition', async (t) => {
  await t.test('returns "vanta ∅" when no telemetry', () => {
    _reset();
    fs.mkdirSync(VANTA_TMP.replace('/.vanta', '') + '/.vanta', { recursive: true });
    const sl = _loadStatusline();
    assert.equal(sl._vantaSegment(), 'vanta ∅');
  });

  await t.test('appends ⚡N when unsynced > 0', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'interactions.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'sync-queue.jsonl'),
      JSON.stringify({ session_id: 's1', synced: false }) + '\n');
    const sl = _loadStatusline();
    assert.match(sl._vantaSegment(), /vanta ✓ \d+s ⚡1/);
  });

  await t.test('appends ❗ when recent hook errors', () => {
    _reset();
    const dir = VANTA_TMP.replace('/.vanta', '') + '/.vanta';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'interactions.jsonl'), '{}\n');
    const recentTs = new Date(Date.now() - 30 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, 'hook.log'),
      `${recentTs} | ERROR | test | failed\n`);
    const sl = _loadStatusline();
    assert.match(sl._vantaSegment(), /❗/);
  });
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
});
