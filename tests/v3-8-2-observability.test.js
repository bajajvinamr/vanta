// v3.8.2 — Hidden Observability tests.
//
// Three surfaces under test:
//   1. executor `--explain` mode + `explain()` formatter + Decision shape
//      now carrying `n_candidates` and `top1_top2_margin`.
//   2. `bin/vanta-route-quality.js` writer module — append, schema,
//      detectRecall, separation between route-quality and recall files.
//   3. `tools/vanta-soak-report.js` — markdown structure on synthetic
//      data; resilience to empty dirs and torn lines.
//
// Run with the rest of the suite: `node --test tests/`.
// Zero external deps. Each test isolates I/O via VANTA_DIR_OVERRIDE.

'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const executor = require('../bin/vanta-executor');
const routeQuality = require('../bin/vanta-route-quality');
const rewriter = require('../bin/vanta-rewriter');
const soak = require('../tools/vanta-soak-report');

// ─── helpers ──────────────────────────────────────────────────────────

function _tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vanta-3-8-2-${prefix}-`));
}
function _rmTmp(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// ─── 1. Decision shape carries margin + candidates ─────────────────────

describe('v3.8.2 — executor Decision shape', () => {
  test('includes n_candidates and top1_top2_margin on every decision', () => {
    const d = executor.decide({ prompt: 'fix this' });
    assert.ok('n_candidates' in d, 'Decision missing n_candidates');
    assert.ok('top1_top2_margin' in d, 'Decision missing top1_top2_margin');
    assert.ok(typeof d.n_candidates === 'number');
    assert.ok(typeof d.top1_top2_margin === 'number');
    assert.ok(d.top1_top2_margin >= 0 && d.top1_top2_margin <= 1);
  });

  test('margin == 1.0 when only one rule fires', () => {
    const d = executor.decide({ prompt: 'fix this' });
    // 'fix this' → only fix-broken rule
    const cands = rewriter.candidatesFor('fix this');
    assert.equal(cands.length, 1, 'precondition: only fix-broken matches');
    assert.equal(d.n_candidates, 1);
    assert.equal(d.top1_top2_margin, 1.0);
  });

  test('margin == 0.0 when multiple rules match (R1 council fix)', () => {
    // R1 council both-flagged P2: the prior `1/N` formula could not
    // trip the v3.9.1 catch-all `<0.10` threshold. Margin is now
    // `n_candidates >= 2 ? 0.0 : 1.0`. When N >= 2 the rules are
    // priority-ordered with no numeric scoring, so the top-1 vs top-2
    // gap is structurally 0.
    let multi = null;
    for (const probe of ['ship and review this', 'review and ship this', 'fix and ship']) {
      if (rewriter.candidatesFor(probe).length >= 2) { multi = probe; break; }
    }
    if (!multi) {
      // Self-skipping if the rule corpus has no overlap probe.
      return;
    }
    const d = executor.decide({ prompt: multi });
    assert.ok(d.n_candidates >= 2);
    assert.equal(d.top1_top2_margin, 0.0,
      'multi-rule overlap must produce margin=0 to feed v3.9.1 catch-all');
    assert.ok(d.top1_top2_margin < 0.10, 'must trip the v3.9.1 <0.10 threshold');
  });

  test('rewriter_error present and null on healthy paths (R1 Codex P3)', () => {
    const d = executor.decide({ prompt: 'fix this' });
    assert.ok('rewriter_error' in d);
    assert.equal(d.rewriter_error, null);
  });

  test('empty prompt → margin 1.0, n_candidates 0', () => {
    const d = executor.decide({ command: 'ls' });
    assert.equal(d.n_candidates, 0);
    assert.equal(d.top1_top2_margin, 1.0);
  });
});

// ─── 2. explain() formatter ────────────────────────────────────────────

describe('v3.8.2 — explain() formatter', () => {
  test('renders required fields', () => {
    const d = executor.decide({ prompt: 'fix this' });
    const out = executor.explain(d);
    for (const field of ['prompt:', 'intent:', 'route:', 'tier:', 'decision:', 'confidence:', 'margin:', 'risk:', 'why:', 'budget_ms:']) {
      assert.match(out, new RegExp(field), `explain output missing "${field}"`);
    }
  });

  test('truncates long prompts in the prompt: line', () => {
    const longPrompt = 'fix this ' + 'x'.repeat(200);
    const d = executor.decide({ prompt: longPrompt });
    const out = executor.explain(d);
    const promptLine = out.split('\n').find(l => l.startsWith('prompt:'));
    assert.ok(promptLine.length < 130, 'prompt line too long: ' + promptLine.length);
  });

  test('handles missing decision gracefully', () => {
    assert.doesNotThrow(() => executor.explain(null));
    assert.doesNotThrow(() => executor.explain(undefined));
    assert.doesNotThrow(() => executor.explain({}));
  });

  test('completes well under the <2s acceptance bar', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      const d = executor.decide({ prompt: 'ship the auth migration to prod' });
      executor.explain(d);
    }
    const dt = Date.now() - t0;
    assert.ok(dt < 2000, `10 decisions+explain took ${dt}ms`);
  });
});

// ─── 3. route-quality writer ──────────────────────────────────────────

describe('v3.8.2 — route-quality writer', () => {
  let dir, prevOverride;
  beforeEach(() => {
    dir = _tmpDir('route');
    prevOverride = process.env.VANTA_DIR_OVERRIDE;
    process.env.VANTA_DIR_OVERRIDE = dir;
  });
  afterEach(() => {
    if (prevOverride === undefined) delete process.env.VANTA_DIR_OVERRIDE;
    else process.env.VANTA_DIR_OVERRIDE = prevOverride;
    _rmTmp(dir);
  });

  test('recordRoute appends a JSONL entry with the v3.8.2 schema', () => {
    routeQuality.recordRoute({
      decision_id: 'dec-abc123',
      prompt: 'fix this',
      detected_intent: 'fix-bug',
      confidence: 'high',
      top1_top2_margin: 1.0,
      n_candidates: 1,
      suggested_route: '/investigate',
      tier: 'T1',
      decision: 'rewrite',
      source: 'rewriter:rule',
      project: 'vanta',
      session_id: 'sess-1',
    });
    const file = path.join(dir, 'route-quality.jsonl');
    assert.ok(fs.existsSync(file), 'route-quality.jsonl not written');
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    // R1 council fixes added prompt_redacted + rewriter_error fields.
    for (const field of [
      'ts', 'decision_id', 'prompt', 'prompt_redacted', 'detected_intent',
      'confidence', 'top1_top2_margin', 'n_candidates', 'suggested_route',
      'tier', 'decision', 'source', 'rewriter_error',
      'user_followed_route', 'user_used_different_command',
      'later_undo', 'later_manual_correction', 'session_ended_state',
      'project', 'session_id',
    ]) {
      assert.ok(field in entry, `route-quality entry missing "${field}"`);
    }
    assert.equal(entry.detected_intent, 'fix-bug');
    assert.equal(entry.confidence, 0.9, 'confidence string mapped to numeric 0.9');
    assert.equal(entry.suggested_route, '/investigate');
    assert.equal(entry.prompt_redacted, false, 'clean prompt → not redacted');
  });

  test('recordRoute redacts common secret patterns (R1 Codex P2)', () => {
    routeQuality.recordRoute({
      prompt: 'fix this; my key is sk-AbCdEfGhIjKlMnOpQrStUvWxYz12345678',
      detected_intent: 'fix-bug',
      project: 'vanta',
    });
    const raw = fs.readFileSync(path.join(dir, 'route-quality.jsonl'), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter(Boolean)[0]);
    assert.equal(entry.prompt_redacted, true);
    assert.ok(!entry.prompt.includes('sk-AbCdEfGhIjKlMnOpQrStUvWxYz12345678'),
      'raw API key must not survive in logged prompt');
    assert.ok(entry.prompt.includes('[REDACTED]'),
      'redaction marker should appear');
  });

  test('recordRoute redacts GitHub fine-grained PATs (R2 Codex P2)', () => {
    routeQuality.recordRoute({
      prompt: 'use github_pat_11ABCDEFG0_AbCdEfGhIjKlMnOpQrStUvWxYz12345 to clone',
      detected_intent: 'unmatched',
      project: 'vanta',
    });
    const raw = fs.readFileSync(path.join(dir, 'route-quality.jsonl'), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter(Boolean)[0]);
    assert.equal(entry.prompt_redacted, true);
    assert.ok(!entry.prompt.includes('github_pat_11ABCDEFG'),
      'github_pat_ fine-grained PAT must be redacted');
  });

  test('recordRoute redacts JWTs and bearer headers', () => {
    routeQuality.recordRoute({
      prompt: 'curl with Authorization: Bearer abc123def456ghi789',
      detected_intent: 'unmatched',
      project: 'vanta',
    });
    routeQuality.recordRoute({
      prompt: 'use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepart',
      detected_intent: 'unmatched',
      project: 'vanta',
    });
    const raw = fs.readFileSync(path.join(dir, 'route-quality.jsonl'), 'utf8');
    const entries = raw.split('\n').filter(Boolean).map(JSON.parse);
    for (const e of entries) {
      assert.equal(e.prompt_redacted, true);
      assert.ok(e.prompt.includes('[REDACTED]'));
    }
  });

  test('recordRecall persists decision_id for v3.9.1 join (R1 both-confirmed)', () => {
    routeQuality.recordRecall({
      prompt: '/ship now',
      project: 'vanta',
      session_id: 'sess-x',
      decision_id: 'dec-xyz789',
    });
    const raw = fs.readFileSync(path.join(dir, 'manual-recalls.jsonl'), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter(Boolean)[0]);
    assert.equal(entry.decision_id, 'dec-xyz789',
      'decision_id must be persisted to enable user_used_different_command backfill');
    assert.ok('prompt_redacted' in entry, 'recalls also flag redaction');
  });

  test('detectRecall surfaces vanta-internal for /vanta-* debug commands (R1 Codex P3)', () => {
    // Surface allowlist tightening: only the three promised commands
    // are exempt. /vanta-status etc. are now classified as
    // vanta-internal so the soak report can spot debug-only usage.
    assert.deepEqual(routeQuality.detectRecall('/vanta-status'),
      { surface: 'vanta-internal', command: 'vanta-status' });
    assert.deepEqual(routeQuality.detectRecall('/vanta-undo'),
      { surface: 'vanta-internal', command: 'vanta-undo' });
    assert.deepEqual(routeQuality.detectRecall('/vanta-trust'),
      { surface: 'vanta-internal', command: 'vanta-trust' });
    // Three promised commands still exempt.
    assert.equal(routeQuality.detectRecall('/vanta'), null);
    assert.equal(routeQuality.detectRecall('/vanta-sync'), null);
    assert.equal(routeQuality.detectRecall('/council'), null);
  });

  test('truncates oversized prompts in the entry', () => {
    routeQuality.recordRoute({
      prompt: 'x'.repeat(500),
      detected_intent: 'unmatched',
      project: 'vanta',
    });
    const raw = fs.readFileSync(path.join(dir, 'route-quality.jsonl'), 'utf8');
    const entry = JSON.parse(raw.split('\n').filter(Boolean)[0]);
    assert.ok(entry.prompt.length <= 200, 'prompt should be truncated to 200 chars');
  });

  test('detectRecall classifies known surfaces', () => {
    assert.deepEqual(routeQuality.detectRecall('/ship now'), { surface: 'gstack', command: 'ship' });
    assert.deepEqual(routeQuality.detectRecall('/qa'), { surface: 'gstack', command: 'qa' });
    assert.deepEqual(routeQuality.detectRecall('/gsd-plan-phase whatever'), { surface: 'gsd', command: 'gsd-plan-phase' });
    assert.deepEqual(routeQuality.detectRecall('/brainstorm'), { surface: 'superpowers', command: 'brainstorm' });
  });

  test('detectRecall ignores Vanta surfaces (the three commands)', () => {
    assert.equal(routeQuality.detectRecall('/vanta'), null);
    assert.equal(routeQuality.detectRecall('/vanta-sync'), null);
    assert.equal(routeQuality.detectRecall('/council'), null);
  });

  test('detectRecall returns null for non-slash prompts', () => {
    assert.equal(routeQuality.detectRecall('fix this'), null);
    assert.equal(routeQuality.detectRecall(''), null);
    assert.equal(routeQuality.detectRecall(null), null);
  });

  test('recordRecall writes only when prompt is a non-Vanta slash command', () => {
    assert.equal(routeQuality.recordRecall({ prompt: '/ship', project: 'vanta' }), true);
    assert.equal(routeQuality.recordRecall({ prompt: '/vanta', project: 'vanta' }), false);
    assert.equal(routeQuality.recordRecall({ prompt: 'fix this', project: 'vanta' }), false);
    const file = path.join(dir, 'manual-recalls.jsonl');
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'only the /ship prompt should have recorded a recall');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.command, 'ship');
    assert.equal(entry.surface, 'gstack');
  });

  test('route-quality and recalls write to separate files', () => {
    routeQuality.recordRoute({ prompt: '/ship', detected_intent: 'unmatched', project: 'vanta' });
    routeQuality.recordRecall({ prompt: '/ship', project: 'vanta' });
    assert.ok(fs.existsSync(path.join(dir, 'route-quality.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'manual-recalls.jsonl')));
    // Cardinality check: route-quality may include recall prompts too;
    // recalls file only contains slash-recall entries.
    const recallEntries = fs.readFileSync(path.join(dir, 'manual-recalls.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(recallEntries.length, 1);
  });
});

// ─── 4. soak report on synthetic data ─────────────────────────────────

describe('v3.8.2 — soak report', () => {
  let dir, prevOverride;
  beforeEach(() => {
    dir = _tmpDir('soak');
    prevOverride = process.env.VANTA_DIR_OVERRIDE;
    process.env.VANTA_DIR_OVERRIDE = dir;
  });
  afterEach(() => {
    if (prevOverride === undefined) delete process.env.VANTA_DIR_OVERRIDE;
    else process.env.VANTA_DIR_OVERRIDE = prevOverride;
    _rmTmp(dir);
  });

  test('renders a complete report on empty dirs', () => {
    const md = soak.buildReport();
    assert.match(md, /Vanta Soak Report/);
    for (const heading of [
      'Manual command recall', 'Top ignored suggestions',
      'Top routing misses', 'Top undo causes',
      'Confidence histogram', 'Margin histogram',
    ]) {
      assert.ok(md.includes(heading), `report missing section: ${heading}`);
    }
  });

  test('counts manual recalls by surface', () => {
    const now = new Date().toISOString();
    routeQuality.recordRecall({ prompt: '/ship', project: 'vanta', ts: now });
    routeQuality.recordRecall({ prompt: '/qa', project: 'vanta', ts: now });
    routeQuality.recordRecall({ prompt: '/brainstorm', project: 'vanta', ts: now });
    const md = soak.buildReport();
    assert.match(md, /gstack.*: 2/, 'expected gstack=2 (ship+qa)');
    assert.match(md, /superpowers.*: 1/, 'expected superpowers=1 (brainstorm)');
  });

  test('honors the window-days filter', () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    routeQuality.recordRecall({ prompt: '/ship', project: 'vanta', ts: old });
    routeQuality.recordRecall({ prompt: '/qa', project: 'vanta', ts: fresh });
    const md = soak.buildReport({ windowDays: 7 });
    // only the fresh /qa is in window
    assert.match(md, /Manual recalls.*\*\*1\*\*/);
  });

  test('survives torn JSONL lines', () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'route-quality.jsonl');
    const goodEntry = JSON.stringify({
      ts: new Date().toISOString(),
      prompt: 'fix this',
      detected_intent: 'fix-bug',
      confidence: 0.9,
      top1_top2_margin: 1.0,
    });
    fs.writeFileSync(file, '\n' + goodEntry + '\n{torn-line-not-json\n' + goodEntry + '\n');
    const md = soak.buildReport();
    // Should not throw, and should report 2 valid entries.
    assert.match(md, /Vanta-routed prompts: \*\*2\*\*/);
  });

  test('bypass rate uses recall/total denominator (R1 Codex P3)', () => {
    // 10 routed prompts (recall is a subset) → bypass = 3/10 = 30%.
    // The prior buggy denominator was 3/(10+3) = ~23%.
    const now = new Date().toISOString();
    fs.mkdirSync(dir, { recursive: true });
    const route = path.join(dir, 'route-quality.jsonl');
    const recall = path.join(dir, 'manual-recalls.jsonl');
    let routeLines = '';
    for (let i = 0; i < 10; i++) {
      routeLines += '\n' + JSON.stringify({ ts: now, prompt: `p${i}`, detected_intent: 'fix-bug', confidence: 0.9, top1_top2_margin: 1.0 }) + '\n';
    }
    fs.writeFileSync(route, routeLines);
    let recallLines = '';
    for (let i = 0; i < 3; i++) {
      recallLines += '\n' + JSON.stringify({ ts: now, prompt: '/ship', surface: 'gstack', command: 'ship' }) + '\n';
    }
    fs.writeFileSync(recall, recallLines);
    const md = soak.buildReport();
    assert.match(md, /\(30% bypass\)/, 'bypass rate must be recall/total = 30%, not 3/13 = 23%');
  });
});

// ─── 5. Bak rotation pruning + concurrent-rotation safety ────────────

describe('v3.8.2 — bak rotation', () => {
  let dir, prevOverride;
  beforeEach(() => {
    dir = _tmpDir('rotate');
    prevOverride = process.env.VANTA_DIR_OVERRIDE;
    process.env.VANTA_DIR_OVERRIDE = dir;
  });
  afterEach(() => {
    if (prevOverride === undefined) delete process.env.VANTA_DIR_OVERRIDE;
    else process.env.VANTA_DIR_OVERRIDE = prevOverride;
    _rmTmp(dir);
  });

  test('keeps only the last 5 .bak siblings (R1 Gemini P3)', () => {
    fs.mkdirSync(dir, { recursive: true });
    const baseFile = path.join(dir, 'route-quality.jsonl');
    // Seed 8 .bak siblings with monotonically-increasing mtimes by
    // creating them with controlled mtime stamps.
    for (let i = 0; i < 8; i++) {
      const bak = `${baseFile}.bak.${1000 + i}`;
      fs.writeFileSync(bak, `synthetic-${i}\n`);
      const t = new Date(1_700_000_000_000 + i * 1000);
      fs.utimesSync(bak, t, t);
    }
    // Now write a >5MB record to trigger rotation, which calls _pruneBaks.
    const big = 'x'.repeat(6_000_000);
    fs.writeFileSync(baseFile, big);
    routeQuality.recordRoute({ prompt: 'fix this', detected_intent: 'fix-bug', project: 'vanta' });
    const remaining = fs.readdirSync(dir).filter(f => f.startsWith('route-quality.jsonl.bak.'));
    assert.ok(remaining.length <= 5,
      `pruner should retain at most 5 baks; saw ${remaining.length}`);
  });

  test('post-rotation: subsequent writes go to a fresh file without throwing', () => {
    // R2 Codex P4 honest scope statement: this test verifies post-
    // rotation CONTINUITY (caller A rotates, caller B writes to the
    // new tiny file without throwing). It does NOT exercise the
    // single-millisecond dual-rotate ENOENT race where two processes
    // both pass the `size > MAX_BYTES` check before either calls
    // renameSync. That race is bounded by the outer try/catch in
    // _maybeRotate and the re-stat-after-rename guard, but exercising
    // it deterministically requires worker_threads with a barrier —
    // outside v3.8.2 scope. Tracked for v3.8.3 (cross-process JSONL
    // hardening) along with the same race in action-log.js.
    fs.mkdirSync(dir, { recursive: true });
    const baseFile = path.join(dir, 'route-quality.jsonl');
    const big = 'y'.repeat(6_000_000);
    fs.writeFileSync(baseFile, big);
    let errs = 0;
    try { routeQuality.recordRoute({ prompt: 'a', detected_intent: 'fix-bug', project: 'vanta' }); } catch (_) { errs++; }
    try { routeQuality.recordRoute({ prompt: 'b', detected_intent: 'fix-bug', project: 'vanta' }); } catch (_) { errs++; }
    assert.equal(errs, 0, 'post-rotation writes must not throw');
    assert.ok(fs.existsSync(baseFile));
    const live = fs.readFileSync(baseFile, 'utf8');
    assert.ok(live.includes('"detected_intent":"fix-bug"'));
    // Verify the rotation actually happened: the .bak file exists.
    const baks = fs.readdirSync(dir).filter(f => f.startsWith('route-quality.jsonl.bak.'));
    assert.ok(baks.length >= 1, 'rotation should have produced a .bak sibling');
  });
});
