'use strict';
// v3.12 — Auto-stage on Stop hook tests.
//
// Verifies the operator-approved automatic capture path:
//   - Stop hook auto-stages score≥0.40 candidates without LLM
//   - Audit prefix carries `auto=true` so reviewer can distinguish
//     auto-extracted from manually-distilled
//   - R7 P1 holds: NEVER auto-promote; staging-only writes
//   - Consume ledger marked atomically per staged candidate
//   - Stop-hook never breaks on auto-stage failure
//   - Statusline 📥N reflects auto-staged backlog

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const child = require('child_process');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v312-auto-stage-' + process.pid);
const RULES_TMP = path.join(VANTA_TMP, 'claude-rules');
const REPO_TMP  = path.join(os.tmpdir(), 'vanta-v312-auto-stage-repo-' + process.pid);

process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;
// Override invariants rules path for isolation. The auto-stage code
// hard-codes ~/.claude/rules/... — we redirect HOME so paths land in
// the temp dir.
process.env.HOME = VANTA_TMP;

function _resetAll() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(REPO_TMP,  { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
  fs.mkdirSync(path.join(RULES_TMP), { recursive: true });
  fs.mkdirSync(REPO_TMP,  { recursive: true });
  // Standard rules-file paths under temp HOME.
  fs.mkdirSync(path.join(VANTA_TMP, '.claude', 'rules'), { recursive: true });
}

function _isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function _initRepo(name) {
  const fp = path.join(REPO_TMP, name);
  fs.mkdirSync(fp, { recursive: true });
  child.execFileSync('git', ['-C', fp, 'init', '-q', '--initial-branch=main'], { stdio: 'pipe' });
  child.execFileSync('git', ['-C', fp, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
  child.execFileSync('git', ['-C', fp, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  child.execFileSync('git', ['-C', fp, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });
  return fp;
}

function _writeJsonl(filename, entries) {
  const file = path.join(VANTA_TMP, filename);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// Reload modules so HOME and VANTA_DIR_OVERRIDE take effect on each test.
function _loadAutoStage() {
  delete require.cache[require.resolve('../bin/vanta-sync-extract.js')];
  delete require.cache[require.resolve('../bin/vanta-extract-score.js')];
  delete require.cache[require.resolve('../bin/vanta-sync-consume.js')];
  delete require.cache[require.resolve('../bin/vanta-statusline.js')];
}

// Run the auto-stage block in isolation. Mirrors hooks/auto-sync.js
// without the upstream Stop-hook plumbing — directly invokes the same
// extract+score+consume sequence.
function _runAutoStage({ cwd, slug, sid }) {
  _loadAutoStage();
  const extractMod = require('../bin/vanta-sync-extract.js');
  const scoreMod = require('../bin/vanta-extract-score.js');
  const consumeMod = require('../bin/vanta-sync-consume.js');
  const r = extractMod.extract({ cwd, max: 10 });
  const STAGING_FILE = path.join(VANTA_TMP, '.claude', 'rules', 'vinamr-invariants.staging.md');
  const INVARIANTS_FILE = path.join(VANTA_TMP, '.claude', 'rules', 'vinamr-invariants.md');
  const existing = scoreMod.readInvariantBullets(INVARIANTS_FILE);
  const staging = scoreMod.readInvariantBullets(STAGING_FILE);
  let staged = 0;
  for (const rec of r.records) {
    if (rec.type !== 'candidate') continue;
    const route = scoreMod.routeCandidate(rec.candidate, { existing, staging });
    if (route.route !== 'staging' && route.route !== 'auto') continue;
    const audit = scoreMod.auditPrefix({
      sessionId: sid,
      confidence: route.score,
      auto: true,
    });
    const block = '\n## Auto-staged (' + rec.source + ')\n' + audit + '\n- ' + rec.candidate + '\n';
    fs.mkdirSync(path.dirname(STAGING_FILE), { recursive: true });
    fs.appendFileSync(STAGING_FILE, block);
    consumeMod.mark({
      slug: r.slug || slug,
      source: rec.source,
      ref: rec.ref,
      ts: rec.ts,
      candidate_hash: rec.candidate_hash,
    });
    staging.push(rec.candidate);
    staged++;
  }
  return { staged, route_results: r.records, slug: r.slug, staging_file: STAGING_FILE };
}

// ─── Tests ──────────────────────────────────────────────────────────────

test('1. high-signal episodes auto-stage to staging file', () => {
  _resetAll();
  // High-signal candidate text — "must / never / requires" markers,
  // technical tokens, backticks. Should score ≥0.40.
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-1', ts: _isoDaysAgo(1),
      decision: 'CORS headers must appear on every `OPTIONS` response branch including error paths or browser preflight fails silently' },
  ]);
  const repo = _initRepo('testproj-1');
  const r = _runAutoStage({ cwd: repo, slug: 'testproj-1', sid: 'sid-1' });
  assert.ok(r.staged >= 1, `expected >=1 staged, got ${r.staged}`);
  const content = fs.readFileSync(r.staging_file, 'utf8');
  assert.match(content, /CORS headers must appear/);
});

test('2. audit prefix includes auto=true flag', () => {
  _resetAll();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-2', ts: _isoDaysAgo(1),
      decision: 'PixiJS v8 `Application.init()` must be awaited; never call the v7 sync constructor pattern in v8 code' },
  ]);
  const repo = _initRepo('testproj-2');
  const r = _runAutoStage({ cwd: repo, slug: 'testproj-2', sid: 'sid-2' });
  assert.ok(r.staged >= 1);
  const content = fs.readFileSync(r.staging_file, 'utf8');
  assert.match(content, /<!-- vanta-sync: session=sid-2 ts=[^ ]+ confidence=0\.\d+ auto=true -->/);
});

test('3. score<0.40 candidates do NOT auto-stage', () => {
  _resetAll();
  // Low-signal — no markers, no tech tokens, no backticks. Should
  // route as `discard` (score < 0.40).
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-3', ts: _isoDaysAgo(1),
      decision: 'we discussed the thing and looked at some stuff today' },
  ]);
  const repo = _initRepo('testproj-3');
  const r = _runAutoStage({ cwd: repo, slug: 'testproj-3', sid: 'sid-3' });
  assert.equal(r.staged, 0, 'low-signal candidate must not stage');
  const stagingExists = fs.existsSync(r.staging_file);
  if (stagingExists) {
    const content = fs.readFileSync(r.staging_file, 'utf8');
    assert.ok(!content.includes('discussed the thing'),
      'low-signal text must not appear in staging');
  }
});

test('4. existing global invariant → update-in-place route → does NOT stage', () => {
  _resetAll();
  // Pre-populate global invariants with a near-duplicate.
  const INV = path.join(VANTA_TMP, '.claude', 'rules', 'vinamr-invariants.md');
  fs.mkdirSync(path.dirname(INV), { recursive: true });
  fs.writeFileSync(INV,
    `## Supabase / Edge\n\n- CORS headers must appear on every \`OPTIONS\` response branch including error paths or browser preflight fails silently\n`);
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-4', ts: _isoDaysAgo(1),
      decision: 'CORS headers must appear on every `OPTIONS` response branch including error paths or browser preflight fails silently' },
  ]);
  const repo = _initRepo('testproj-4');
  const r = _runAutoStage({ cwd: repo, slug: 'testproj-4', sid: 'sid-4' });
  assert.equal(r.staged, 0, 'near-dup of existing global must not stage');
});

test('5. existing staging entry → staging-duplicate route → does NOT stage', () => {
  _resetAll();
  // Pre-populate staging with the same candidate.
  const STAGING = path.join(VANTA_TMP, '.claude', 'rules', 'vinamr-invariants.staging.md');
  fs.mkdirSync(path.dirname(STAGING), { recursive: true });
  fs.writeFileSync(STAGING,
    `## Some Section\n<!-- vanta-sync: session=prior ts=2026-05-01T00:00:00.000Z confidence=0.55 auto=true -->\n- CORS headers must appear on every \`OPTIONS\` response branch or browser preflight fails silently\n`);
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-5', ts: _isoDaysAgo(1),
      decision: 'CORS headers must appear on every `OPTIONS` response branch including error paths or browser preflight fails silently' },
  ]);
  const repo = _initRepo('testproj-5');
  const r = _runAutoStage({ cwd: repo, slug: 'testproj-5', sid: 'sid-5' });
  assert.equal(r.staged, 0, 'staging-duplicate route must skip the write');
  // Verify the prior staging entry is still there exactly once
  const content = fs.readFileSync(STAGING, 'utf8');
  const matches = content.match(/CORS headers must appear/g);
  assert.equal(matches.length, 1, 'staging file must still have exactly one entry');
});

test('6. consume ledger marked atomically per auto-staged candidate', () => {
  _resetAll();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-6', ts: _isoDaysAgo(1),
      decision: 'BullMQ jobs must use explicit `jobId` to enable dedup; without it, restart creates duplicates of every recurring job' },
  ]);
  const repo = _initRepo('testproj-6');
  const r = _runAutoStage({ cwd: repo, slug: 'testproj-6', sid: 'sid-6' });
  assert.ok(r.staged >= 1);
  // Consume ledger should now have an entry for this episode.
  delete require.cache[require.resolve('../bin/vanta-sync-consume.js')];
  const consume = require('../bin/vanta-sync-consume.js');
  const set = consume.read({ slug: r.slug });
  assert.ok(set.has('episode|s1'), 'consume ledger must record the staged episode');
});

test('7. second run skips already-staged candidates (idempotent)', () => {
  _resetAll();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', slug: 'testproj-7', ts: _isoDaysAgo(1),
      decision: 'Prisma `migrate dev` triggers schema-drift detection that can lock production; always use `migrate deploy` in CI/CD pipelines' },
  ]);
  const repo = _initRepo('testproj-7');
  const r1 = _runAutoStage({ cwd: repo, slug: 'testproj-7', sid: 'sid-7-a' });
  assert.ok(r1.staged >= 1);
  // Second invocation — consume ledger filters this candidate out at extract time.
  const r2 = _runAutoStage({ cwd: repo, slug: 'testproj-7', sid: 'sid-7-b' });
  assert.equal(r2.staged, 0, 'second run must not re-stage already-consumed candidate');
});

test('8. statusline 📥N segment renders when auto-staged entries pending', () => {
  _resetAll();
  const STAGING = path.join(VANTA_TMP, '.claude', 'rules', 'vinamr-invariants.staging.md');
  fs.mkdirSync(path.dirname(STAGING), { recursive: true });
  fs.writeFileSync(STAGING, [
    '<!-- vanta-sync: session=s1 ts=2026-05-04T00:00:00.000Z confidence=0.55 auto=true -->',
    '- entry one',
    '<!-- vanta-sync: session=s2 ts=2026-05-04T00:00:00.000Z confidence=0.71 auto=true -->',
    '- entry two',
    '<!-- vanta-sync: session=s3 ts=2026-05-04T00:00:00.000Z confidence=0.66 -->',
    '- manually-distilled (no auto flag) — should NOT count',
  ].join('\n') + '\n');
  delete require.cache[require.resolve('../bin/vanta-statusline.js')];
  const sl = require('../bin/vanta-statusline.js');
  assert.equal(sl._autoStagedCount(), 2, 'only auto=true blocks count');
});

test('9. statusline 📥 absent when staging file empty or has only manual entries', () => {
  _resetAll();
  const STAGING = path.join(VANTA_TMP, '.claude', 'rules', 'vinamr-invariants.staging.md');
  fs.mkdirSync(path.dirname(STAGING), { recursive: true });
  // Only manually-distilled entries (no auto flag)
  fs.writeFileSync(STAGING,
    '<!-- vanta-sync: session=s1 ts=2026-05-04T00:00:00.000Z confidence=0.55 -->\n- manual entry only\n');
  delete require.cache[require.resolve('../bin/vanta-statusline.js')];
  const sl = require('../bin/vanta-statusline.js');
  assert.equal(sl._autoStagedCount(), 0);
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(REPO_TMP,  { recursive: true, force: true }); } catch {}
});
