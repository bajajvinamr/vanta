#!/usr/bin/env node
// vanta-council-feedback — record council findings + later outcomes.
//
// Tier 6 #15 deliverable. Two-stage data flow:
//
//   Stage 1: every /council run records findings via record() (called
//            from skills/council/SKILL.md in the wrap-up step).
//   Stage 2: vanta-sync later attributes outcomes by fuzzy-matching
//            recent invariant additions / episodes against open
//            findings (within 14d window, same project + topic).
//
// Files:
//   ~/.vanta/council-feedback.jsonl           — findings + verdicts
//   ~/.vanta/council-feedback-resolved.jsonl  — outcome attributions
//
// Schema enforced for downstream consumers; new fields are added,
// existing fields are never repurposed.
//
// Usage:
//   vanta-council-feedback record --topic auth --slug pi-perception \
//     --council-run 2026-04-30T07:55:00Z \
//     --finding-text 'JWT secrets must be ES256' \
//     --priority P1 --model codex --round 1
//   vanta-council-feedback attribute --hash <sha> --outcome true-positive \
//     --evidence 'invariant added 2026-05-04'
//   vanta-council-feedback stats [--days 90]

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Paths resolved per-call so tests can override VANTA_DIR via env var.
function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _feedbackFile() { return path.join(_vantaDir(), 'council-feedback.jsonl'); }
function _resolvedFile() { return path.join(_vantaDir(), 'council-feedback-resolved.jsonl'); }

// Back-compat exports — frozen to default ~/.vanta path; live override via env.
const VANTA_DIR = path.join(os.homedir(), '.vanta');
const FEEDBACK_FILE = path.join(VANTA_DIR, 'council-feedback.jsonl');
const RESOLVED_FILE = path.join(VANTA_DIR, 'council-feedback-resolved.jsonl');

function _ensureDir() {
  const dir = _vantaDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

function _appendLine(file, obj) {
  _ensureDir();
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (e) {
    process.stderr.write(`failed to append to ${file}: ${e.message}\n`);
  }
}

function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ── public API (used as require'd module from council skill or tests) ─────

function findingHash(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function record({ topic, slug, councilRun, findingText, priority, model, round = 1, mode = 'FULL', consensusStrategy = 'two-different-models' }) {
  if (!topic || !slug || !councilRun || !findingText || !priority || !model) {
    throw new Error('record() requires: topic, slug, councilRun, findingText, priority, model');
  }
  const entry = {
    ts: new Date().toISOString(),
    council_run: councilRun,
    model,                          // 'codex' | 'gemini' | 'synthesis' | 'solo'
    round,                          // 1 | 2
    priority,                       // 'P1' | 'P2' | 'P3' | 'P4'
    topic,
    slug,
    finding_hash: findingHash(findingText),
    finding_excerpt: String(findingText).slice(0, 500),
    verdict: 'raised',
    outcome: null,
    outcome_ts: null,
    mode,                           // FULL / PARTIAL / SOLO
    consensus_strategy: consensusStrategy,  // 'two-different-models' (default council)
                                            // | 'n-of-same-model' (stochastic — never use,
                                            //   tracked here for accuracy comparison only)
                                            // | 'self' (solo)
  };
  _appendLine(_feedbackFile(), entry);
  return entry;
}

function attribute({ hash, outcome, evidence }) {
  if (!hash || !outcome) throw new Error('attribute() requires: hash, outcome');
  const valid = ['true-positive', 'false-positive', 'unverified'];
  if (!valid.includes(outcome)) throw new Error('outcome must be one of: ' + valid.join(', '));
  const entry = {
    ts: new Date().toISOString(),
    finding_hash: hash,
    outcome,
    evidence: evidence || null,
  };
  _appendLine(_resolvedFile(), entry);
  return entry;
}

// Compute per-model accuracy stats over a window.
function stats({ days = 90 } = {}) {
  const cutoff = Date.now() - days * 86400_000;
  const findings = _readJsonl(_feedbackFile()).filter(e => Date.parse(e.ts) >= cutoff);
  const resolved = _readJsonl(_resolvedFile());

  // Index resolutions by hash for quick lookup
  const byHash = new Map();
  for (const r of resolved) {
    // Latest resolution wins
    if (!byHash.has(r.finding_hash) || Date.parse(r.ts) > Date.parse(byHash.get(r.finding_hash).ts)) {
      byHash.set(r.finding_hash, r);
    }
  }

  // Per-model + per-priority bucketing
  const buckets = new Map();
  for (const f of findings) {
    const key = `${f.model}|${f.priority}`;
    if (!buckets.has(key)) buckets.set(key, { model: f.model, priority: f.priority, total: 0, tp: 0, fp: 0, unverified: 0, pending: 0 });
    const b = buckets.get(key);
    b.total++;
    const r = byHash.get(f.finding_hash);
    if (!r) { b.pending++; continue; }
    if (r.outcome === 'true-positive')  b.tp++;
    else if (r.outcome === 'false-positive') b.fp++;
    else b.unverified++;
  }

  const out = [...buckets.values()].sort((a, b) => {
    if (a.model !== b.model) return a.model.localeCompare(b.model);
    return a.priority.localeCompare(b.priority);
  });

  // Compute accuracy where we have outcome data
  for (const b of out) {
    const judged = b.tp + b.fp;
    b.accuracy = judged > 0 ? Math.round((b.tp / judged) * 100) / 100 : null;
  }

  // Total findings + tp/fp rollup
  const total = findings.length;
  const tp = out.reduce((s, b) => s + b.tp, 0);
  const fp = out.reduce((s, b) => s + b.fp, 0);
  const unverified = out.reduce((s, b) => s + b.unverified, 0);
  const pending = out.reduce((s, b) => s + b.pending, 0);

  return {
    window_days: days,
    total_findings: total,
    tp, fp, unverified, pending,
    by_model_priority: out,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { args[k] = argv[++i]; }
      else { args[k] = true; }
    }
  }
  return args;
}

function cliRecord() {
  const a = parseArgs(process.argv);
  const result = record({
    topic: a.topic,
    slug: a.slug,
    councilRun: a['council-run'],
    findingText: a['finding-text'],
    priority: a.priority,
    model: a.model,
    round: parseInt(a.round, 10) || 1,
    mode: a.mode || 'FULL',
    consensusStrategy: a['consensus-strategy'] || 'two-different-models',
  });
  console.log(JSON.stringify(result, null, 2));
}

function cliAttribute() {
  const a = parseArgs(process.argv);
  const result = attribute({
    hash: a.hash,
    outcome: a.outcome,
    evidence: a.evidence,
  });
  console.log(JSON.stringify(result, null, 2));
}

function cliStats() {
  const a = parseArgs(process.argv);
  const days = parseInt(a.days, 10) || 90;
  const s = stats({ days });
  if (a.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  console.log(`=== council-feedback stats (last ${s.window_days}d) ===`);
  console.log(`total findings: ${s.total_findings}   tp: ${s.tp}   fp: ${s.fp}   unverified: ${s.unverified}   pending: ${s.pending}`);
  console.log('');
  if (s.by_model_priority.length === 0) {
    console.log('  — no findings yet. Council runs populate this via record().');
    return;
  }
  console.log('Per model × priority:');
  console.log('  model      pri   total  tp  fp  unver  pend  accuracy');
  for (const b of s.by_model_priority) {
    const acc = b.accuracy !== null ? (b.accuracy * 100).toFixed(0) + '%' : '—';
    console.log('  ' +
      b.model.padEnd(9) + '  ' +
      b.priority.padEnd(3) + '   ' +
      String(b.total).padStart(5) + '  ' +
      String(b.tp).padStart(2) + '  ' +
      String(b.fp).padStart(2) + '  ' +
      String(b.unverified).padStart(5) + '  ' +
      String(b.pending).padStart(4) + '  ' +
      acc.padStart(8)
    );
  }
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'record')         cliRecord();
  else if (cmd === 'attribute') cliAttribute();
  else if (cmd === 'stats')     cliStats();
  else {
    console.error('Usage: vanta-council-feedback {record|attribute|stats} [args]');
    console.error('  record  --topic X --slug Y --council-run TS --finding-text "..." --priority P1 --model codex [--round N] [--mode FULL]');
    console.error('  attribute --hash sha256:... --outcome true-positive|false-positive|unverified [--evidence "..."]');
    console.error('  stats [--days 90] [--json]');
    process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { record, attribute, stats, findingHash, FEEDBACK_FILE, RESOLVED_FILE };
