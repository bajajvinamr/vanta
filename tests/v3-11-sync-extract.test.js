'use strict';
// v3.11 commit 2 — vanta-sync-extract.js tests.
//
// Verifies all council R1+R2 fixes:
//   C-1 — per-slug isolation via consume ledger (no global watermark)
//   C-2 — transcript_hint discovery from sync-queue.jsonl
//   C-3 — cross-source dedup with priority order
//   C-4 — internal slugFromCwd, no --project CLI arg
//   C-5 — idempotency via consume ledger
//   C-6 — git: subject as candidate, body as evidence, trailers stripped
//   C-8 — git -C "$cwd" form

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const child = require('child_process');

const VANTA_TMP = path.join(os.tmpdir(), 'vanta-v311-extract-' + process.pid);
const REPO_TMP  = path.join(os.tmpdir(), 'vanta-v311-extract-repo-' + process.pid);
process.env.VANTA_DIR_OVERRIDE = VANTA_TMP;
process.env.GSTACK_HOME = path.join(VANTA_TMP, 'gstack-home');

// Force reload after env override.
function _loadExtract() {
  delete require.cache[require.resolve('../bin/vanta-sync-extract.js')];
  delete require.cache[require.resolve('../bin/vanta-sync-consume.js')];
  return require('../bin/vanta-sync-extract.js');
}

function _reset() {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(REPO_TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(VANTA_TMP, { recursive: true });
  fs.mkdirSync(REPO_TMP, { recursive: true });
}

function _writeJsonl(filename, entries) {
  const file = path.join(VANTA_TMP, filename);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function _isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Initialize a synthetic git repo with predictable slug. Uses no remote
// so slugFromCwd falls through to basename (which we control).
function _initGitRepo(repoDir, basename) {
  const fullPath = path.join(repoDir, basename);
  fs.mkdirSync(fullPath, { recursive: true });
  child.execFileSync('git', ['-C', fullPath, 'init', '-q', '--initial-branch=main'],
    { stdio: 'pipe' });
  child.execFileSync('git', ['-C', fullPath, 'config', 'user.email', 'test@example.com'],
    { stdio: 'pipe' });
  child.execFileSync('git', ['-C', fullPath, 'config', 'user.name', 'Test'],
    { stdio: 'pipe' });
  child.execFileSync('git', ['-C', fullPath, 'config', 'commit.gpgsign', 'false'],
    { stdio: 'pipe' });
  return fullPath;
}

function _gitCommit(repoDir, message, fileName = 'a.txt') {
  const fp = path.join(repoDir, fileName);
  fs.writeFileSync(fp, Math.random().toString());
  child.execFileSync('git', ['-C', repoDir, 'add', fileName], { stdio: 'pipe' });
  child.execFileSync('git', ['-C', repoDir, 'commit', '-q', '-m', message], { stdio: 'pipe' });
}

// ─── Tests ──────────────────────────────────────────────────────────────

test('1. extracts candidates from synthetic episodes.jsonl (filters by window)', () => {
  _reset();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-1',  ts: _isoDaysAgo(2), decision: 'fixed the foo bug by setting bar to baz when context is empty', topics: ['foo','bar'] },
    { session_id: 's2', project: 'testproj-1',  ts: _isoDaysAgo(15), decision: 'old learning that should be filtered out by lookback window', topics: ['x'] },
    { session_id: 's3', project: 'testproj-1',  ts: _isoDaysAgo(1), decision: 'another recent fix that produces a candidate of acceptable length', topics: ['y'] },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-1');
  // Lookback = 7d (no consume ledger entries)
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const cands = r.records.filter(rec => rec.type === 'candidate' && rec.source === 'episode');
  assert.equal(cands.length, 2, 'expect s1 + s3 within 7d window');
});

test('2. skips entries from other slugs (per-project filter)', () => {
  _reset();
  _writeJsonl('episodes.jsonl', [
    { session_id: 'a1', project: 'testproj-2', ts: _isoDaysAgo(1), decision: 'this is for project A and should appear in extraction output' },
    { session_id: 'b1', project: 'other-project', ts: _isoDaysAgo(1), decision: 'this is for project B and should NOT appear in project A extraction' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-2');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const eps = r.records.filter(c => c.source === 'episode');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].ref, 'a1');
});

test('3. reads bak siblings AND live file, dedupes by session_id', () => {
  _reset();
  // Old bak file
  fs.writeFileSync(path.join(VANTA_TMP, 'episodes.jsonl.bak.001'),
    JSON.stringify({ session_id: 's1', project: 'testproj-3', ts: _isoDaysAgo(2), decision: 'first version of decision text from bak file' }) + '\n');
  // Live with NEW session
  fs.writeFileSync(path.join(VANTA_TMP, 'episodes.jsonl'),
    JSON.stringify({ session_id: 's2', project: 'testproj-3', ts: _isoDaysAgo(1), decision: 'newer decision text from live file should also appear' }) + '\n');
  const repo = _initGitRepo(REPO_TMP, 'testproj-3');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const eps = r.records.filter(c => c.source === 'episode');
  assert.equal(eps.length, 2);
  const refs = new Set(eps.map(e => e.ref));
  assert.ok(refs.has('s1'));
  assert.ok(refs.has('s2'));
});

test('4. failure source emits only outcome=resolved', () => {
  _reset();
  _writeJsonl('recent-failures.jsonl', [
    { session_id: 'f1', project: 'testproj-4', ts: _isoDaysAgo(1), kind: 'test_failure', tool_name: 'npm', outcome: 'resolved', test_name: 'auth.spec' },
    { session_id: 'f2', project: 'testproj-4', ts: _isoDaysAgo(1), kind: 'build_failure', tool_name: 'tsc', outcome: 'pending' },
    { session_id: 'f3', project: 'testproj-4', ts: _isoDaysAgo(1), kind: 'lint_failure', tool_name: 'eslint', outcome: 'resolved' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-4');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const fails = r.records.filter(c => c.source === 'failure');
  assert.equal(fails.length, 2, 'only the 2 resolved entries emit');
});

test('5. git source: candidate=subject, body trailers stripped from evidence', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-5');
  _gitCommit(repo, `fix: critical bug in auth flow

The interceptor now catches all 4xx responses and triggers refresh.
This fixes the silent session drop bug.

Constraint: must not break legacy clients
Rejected: extending TTL | security policy
[P1] Council finding from gemini
Co-Authored-By: Some Bot <bot@example.com>
`);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const gits = r.records.filter(c => c.source === 'git');
  assert.equal(gits.length, 1);
  assert.equal(gits[0].candidate, 'fix: critical bug in auth flow');
  assert.ok(!gits[0].evidence.includes('Constraint:'),
    'trailer Constraint should be stripped');
  assert.ok(!gits[0].evidence.includes('Co-Authored-By:'),
    'trailer Co-Authored-By should be stripped');
  assert.ok(!gits[0].evidence.includes('[P1]'),
    'P-tag finding should be stripped');
  assert.ok(gits[0].evidence.includes('interceptor'),
    'genuine body content preserved');
});

test('6. git source: uses git -C "$cwd" — succeeds when process cwd != repo', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-6');
  _gitCommit(repo, 'feat: add feature x');
  // Run extract from a different cwd entirely (process cwd is wherever this test runs)
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const gits = r.records.filter(c => c.source === 'git');
  assert.equal(gits.length, 1);
  assert.equal(gits[0].candidate, 'feat: add feature x');
});

test('7. RETRO.md source: parses Lessons/Invariants/Gotchas', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-7');
  const phaseDir = path.join(repo, '.planning', 'v1');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'RETRO.md'), `
# Phase v1 retro

## Lessons
- Always validate inputs at the boundary, never trust internal callers
- Test fixtures should match production data shape exactly

## Gotchas
- The auth middleware silently drops empty headers and breaks downstream

## Other section
- This should not be picked up because the section name is not in our list
`);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const retros = r.records.filter(c => c.source === 'retro');
  assert.equal(retros.length, 3);
  const sections = retros.map(r => r.evidence).join(' ');
  assert.ok(sections.includes('section=Lessons'));
  assert.ok(sections.includes('section=Gotchas'));
  assert.ok(!sections.includes('section=Other'));
});

test('8. decisions.md source: emits per-date entries within window', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-8');
  const decFile = path.join(VANTA_TMP, 'gstack-home', 'projects', 'testproj-8', 'decisions.md');
  fs.mkdirSync(path.dirname(decFile), { recursive: true });
  const recentDate = _isoDaysAgo(1).slice(0, 10);
  const oldDate    = _isoDaysAgo(15).slice(0, 10);
  fs.writeFileSync(decFile, `
## ${recentDate}: Auth refactor

**Verdict:** PASS
**Decision:** use ES256 over HS256 for pi-perception JWTs
**Confidence:** high

## ${oldDate}: Old decision that should be filtered

**Decision:** ancient choice
`);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const decs = r.records.filter(c => c.source === 'decision');
  assert.equal(decs.length, 1);
  assert.match(decs[0].candidate, /Auth refactor/);
});

test('9. cross-source dedup: same fix in git + episode → only higher-priority kept', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-9');
  // Episode (priority 2) and git (priority 4) both describe the same fix.
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-9', ts: _isoDaysAgo(1),
      decision: 'fix bug in login flow with null check on session cookie' },
  ]);
  _gitCommit(repo, 'fix: bug in login flow with null check on session cookie');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const cands = r.records.filter(c => c.type === 'candidate');
  // Episode and git would both emit; dedup keeps higher priority (episode).
  // Hash collision should leave exactly 1 candidate.
  assert.equal(cands.length, 1);
  assert.equal(cands[0].source, 'episode');
});

test('10. cross-source dedup: priority order decision > episode > git', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-10');
  // All three sources describe the same fix in identical-after-normalization
  // text; decision (priority 0) should win over episode (2) and git (4).
  // Note: git subjects must start with feat/fix/refactor/perf, but those
  // tokens normalize identically across sources, so we include them in
  // the episode and decision text too.
  const sharedText = 'fix always validate webhook payloads at boundary';
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-10', ts: _isoDaysAgo(1),
      decision: sharedText },
  ]);
  _gitCommit(repo, 'fix: always validate webhook payloads at boundary');
  const decFile = path.join(VANTA_TMP, 'gstack-home', 'projects', 'testproj-10', 'decisions.md');
  fs.mkdirSync(path.dirname(decFile), { recursive: true });
  // Use the topic line so candidate is "topic — body" format. We construct
  // it so the FULL candidate matches the episode after normalization.
  fs.writeFileSync(decFile,
    `## ${_isoDaysAgo(1).slice(0, 10)}: ${sharedText}\n\nbody not used as candidate when topic present\n`);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const cands = r.records.filter(c => c.type === 'candidate');
  assert.equal(cands.length, 1, `expected 1 deduped candidate, got ${cands.length}: ${cands.map(c => c.source + '=' + c.candidate).join('; ')}`);
  assert.equal(cands[0].source, 'decision');
});

test('11. lookback derived from max(ts) per slug in consume ledger', () => {
  _reset();
  // Pre-populate consume ledger with a 3-day-old entry for our slug.
  const consumeFile = path.join(VANTA_TMP, 'sync-consumed.jsonl');
  fs.writeFileSync(consumeFile, JSON.stringify({
    slug: 'testproj-11',
    source: 'episode',
    ref: 'old-session',
    ts: _isoDaysAgo(3),
    consumed_at: _isoDaysAgo(3),
  }) + '\n');
  // Add an episode that's 4 days old (BEFORE consume ledger ts → should be skipped).
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-11', ts: _isoDaysAgo(4), decision: 'this entry is older than the consume ledger watermark and should be skipped' },
    { session_id: 's2', project: 'testproj-11', ts: _isoDaysAgo(2), decision: 'this entry is newer than watermark and should be emitted as candidate' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-11');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const eps = r.records.filter(c => c.source === 'episode');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].ref, 's2');
});

test('12. lookback default = now()-7d when consume ledger empty for slug', () => {
  _reset();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-12', ts: _isoDaysAgo(5),  decision: 'within 7d default lookback should be emitted as candidate' },
    { session_id: 's2', project: 'testproj-12', ts: _isoDaysAgo(10), decision: 'older than 7d default lookback should be filtered out cleanly' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-12');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const eps = r.records.filter(c => c.source === 'episode');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].ref, 's1');
});

test('13. per-slug isolation: project A consume entries do NOT advance project B lookback', () => {
  _reset();
  // Project A has a consume entry from 1 day ago (recent watermark).
  fs.writeFileSync(path.join(VANTA_TMP, 'sync-consumed.jsonl'), JSON.stringify({
    slug: 'project-a',
    source: 'episode',
    ref: 'a1',
    ts: _isoDaysAgo(1),
    consumed_at: _isoDaysAgo(1),
  }) + '\n');
  // Project B has no consume entries → should fall back to 7d default.
  _writeJsonl('episodes.jsonl', [
    { session_id: 'b1', project: 'project-b', ts: _isoDaysAgo(5), decision: 'this is in project B 5 days ago and should still be emitted' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'project-b');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const eps = r.records.filter(c => c.source === 'episode');
  assert.equal(eps.length, 1);
});

test('14. idempotent: extract+stage+crash before consume → second run replays', () => {
  _reset();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-14', ts: _isoDaysAgo(1), decision: 'a learning that should be replayable across multiple extract runs' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-14');
  const ext = _loadExtract();
  // First run — emits candidate. Caller "crashes" before consume ledger gets the mark.
  const r1 = ext.extract({ cwd: repo });
  const cands1 = r1.records.filter(c => c.source === 'episode');
  assert.equal(cands1.length, 1);
  // Second run — should still emit (because consume ledger was never updated).
  const r2 = ext.extract({ cwd: repo });
  const cands2 = r2.records.filter(c => c.source === 'episode');
  assert.equal(cands2.length, 1);
});

test('15. idempotent: extract+stage+consume → second run skips', () => {
  _reset();
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-15', ts: _isoDaysAgo(1), decision: 'a learning that gets consumed and should NOT replay on next run' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-15');
  const ext = _loadExtract();
  const r1 = ext.extract({ cwd: repo });
  const cands1 = r1.records.filter(c => c.source === 'episode');
  assert.equal(cands1.length, 1);
  // Now mark consumed.
  delete require.cache[require.resolve('../bin/vanta-sync-consume.js')];
  const consume = require('../bin/vanta-sync-consume.js');
  consume.mark({
    slug: 'testproj-15',
    source: 'episode',
    ref: cands1[0].ref,
    ts: cands1[0].ts,
  });
  // Second run — should now skip (consumed).
  const r2 = ext.extract({ cwd: repo });
  const cands2 = r2.records.filter(c => c.source === 'episode');
  assert.equal(cands2.length, 0);
});

test('16. slug ambiguous (basename collision) → no candidates, warning emitted', () => {
  _reset();
  // Use a known-ambiguous basename. AMBIGUOUS_BASENAMES includes 'tmp'.
  const ambiguousDir = path.join(os.tmpdir(), 'tmp');
  try { fs.rmSync(ambiguousDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(ambiguousDir, { recursive: true });
  const ext = _loadExtract();
  const r = ext.extract({ cwd: ambiguousDir });
  // Should exit cleanly with no records and a warning
  assert.equal(r.records.length, 0);
  assert.ok(r.warnings.some(w => w.includes('slugFromCwd returned null')),
    'expect ambiguous-basename warning');
  try { fs.rmSync(ambiguousDir, { recursive: true, force: true }); } catch {}
});

test('17. symlinked cwd → same slug as canonical (realpath canonicalization)', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-17');
  const linkPath = path.join(os.tmpdir(), 'vanta-v311-link-' + process.pid);
  try { fs.unlinkSync(linkPath); } catch {}
  fs.symlinkSync(repo, linkPath);
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-17', ts: _isoDaysAgo(1), decision: 'symlink test entry should match same slug from either path' },
  ]);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: linkPath });
  const eps = r.records.filter(c => c.source === 'episode');
  assert.equal(eps.length, 1, 'symlinked cwd resolves to same slug');
  fs.unlinkSync(linkPath);
});

test('18. transcript_hint emitted when sync-queue has unsynced entry for slug', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-18');
  // Create a fake transcript file
  const transcriptPath = path.join(VANTA_TMP, 'fake-transcript.jsonl');
  fs.writeFileSync(transcriptPath, '{}\n');
  _writeJsonl('sync-queue.jsonl', [
    { session_id: 'sess-A', project: 'testproj-18', cwd: repo,
      ts: _isoDaysAgo(0), transcript_path: transcriptPath, synced: false },
  ]);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const hints = r.records.filter(c => c.type === 'transcript_hint');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].path, transcriptPath);
  assert.equal(hints[0].session_id, 'sess-A');
});

test('19. transcript_hint absent when sync-queue empty or all synced', () => {
  _reset();
  const repo = _initGitRepo(REPO_TMP, 'testproj-19');
  // All entries already marked synced
  _writeJsonl('sync-queue.jsonl', [
    { session_id: 'sess-X', project: 'testproj-19', cwd: repo,
      ts: _isoDaysAgo(0), transcript_path: '/nonexistent/path', synced: true },
  ]);
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo });
  const hints = r.records.filter(c => c.type === 'transcript_hint');
  assert.equal(hints.length, 0);
});

test('20. --all-history bypasses consume ledger', () => {
  _reset();
  // Pre-populate consume so normal run would skip
  fs.writeFileSync(path.join(VANTA_TMP, 'sync-consumed.jsonl'), JSON.stringify({
    slug: 'testproj-20',
    source: 'episode',
    ref: 's1',
    ts: _isoDaysAgo(1),
    consumed_at: _isoDaysAgo(1),
  }) + '\n');
  _writeJsonl('episodes.jsonl', [
    { session_id: 's1', project: 'testproj-20', ts: _isoDaysAgo(1),
      decision: 'previously consumed — normally skipped, but all-history reads it' },
  ]);
  const repo = _initGitRepo(REPO_TMP, 'testproj-20');
  const ext = _loadExtract();
  const rNormal = ext.extract({ cwd: repo });
  assert.equal(rNormal.records.filter(c => c.source === 'episode').length, 0);
  const rAll = ext.extract({ cwd: repo, allHistory: true });
  assert.equal(rAll.records.filter(c => c.source === 'episode').length, 1);
});

test('21. bounded read: large file uses 8MB tail', () => {
  _reset();
  // Generate a >9MB episodes file. Most entries will be tail-readable only.
  const file = path.join(VANTA_TMP, 'episodes.jsonl');
  const big = 'X'.repeat(200);
  const entries = [];
  for (let i = 0; i < 50000; i++) {
    entries.push(JSON.stringify({
      session_id: 's' + i, project: 'testproj-21', ts: _isoDaysAgo(1),
      decision: 'entry-' + i + ' decision text padding ' + big,
    }));
  }
  fs.writeFileSync(file, entries.join('\n') + '\n');
  const stBefore = fs.statSync(file);
  assert.ok(stBefore.size > 9 * 1024 * 1024, 'fixture is large enough');
  const repo = _initGitRepo(REPO_TMP, 'testproj-21');
  const ext = _loadExtract();
  const r = ext.extract({ cwd: repo, max: 5 });
  // Test: extraction completed without OOM/error. Tail should produce some candidates.
  const eps = r.records.filter(c => c.source === 'episode');
  assert.ok(eps.length > 0, 'tail-read still produces candidates');
  assert.ok(eps.length <= 5, 'max=5 respected');
});

test('22. _stripCouncilProse helper isolates body sanitization', () => {
  // Direct unit test on the exported helper
  delete require.cache[require.resolve('../bin/vanta-sync-extract.js')];
  const ext = require('../bin/vanta-sync-extract.js');
  const dirty = `Real description goes here.

Constraint: must work cross-platform
[P1] CRITICAL — finding from gemini
## Round 2 — Convergence Check
Co-Authored-By: Bot <bot@example.com>

More real description after the trailers.`;
  const cleaned = ext._stripCouncilProse(dirty);
  assert.ok(cleaned.includes('Real description'));
  assert.ok(cleaned.includes('More real description'));
  assert.ok(!cleaned.includes('Constraint:'));
  assert.ok(!cleaned.includes('[P1]'));
  assert.ok(!cleaned.includes('Round 2'));
  assert.ok(!cleaned.includes('Co-Authored-By:'));
});

test.after(() => {
  try { fs.rmSync(VANTA_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(REPO_TMP, { recursive: true, force: true }); } catch {}
});
