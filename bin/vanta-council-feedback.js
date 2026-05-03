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

// R4 P2 — both feedback files were unbounded. 5MB cap, keep the recent half.
// Council feedback rows are typically ~500B; 5MB ≈ 10K findings, multiple
// years of history. Resolution rows are smaller still.
const MAX_BYTES = 5_000_000;

function _ensureDir() {
  const dir = _vantaDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

// Codex council R5 P2 fix — atomic rotation via rename, not read-trim-write.
function _rotateIfLarge(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    fs.renameSync(file, file + '.bak');
  } catch {}
}

function _appendLine(file, obj) {
  _ensureDir();
  _rotateIfLarge(file);
  // R9 P1 — torn-line guard. See bin/vanta-jsonl.js comment.
  try { fs.appendFileSync(file, '\n' + JSON.stringify(obj) + '\n'); } catch (e) {
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

function attribute({ hash, outcome, evidence, invariant_text = null }) {
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

  // v3.10 commit 2 — when a council finding is attributed as true-positive
  // by an invariant addition, mirror that into the evidence stream so the
  // invariant accumulates citation credit. The evidence stream is the
  // side-channel; vinamr-invariants.md itself stays human-edited (R7 P1
  // boundary preserved). Best-effort: load failure is non-fatal — the
  // attribution still records correctly in resolved.jsonl.
  if (outcome === 'true-positive' && invariant_text) {
    try {
      const evid = _evidenceLog();
      if (evid) {
        const invHash = evid.hashInvariant(invariant_text);
        if (invHash) {
          evid.recordCouncilTP({
            invariant_hash: invHash,
            project: null,  // attribution is council-scope, not project-scope
          });
        }
      }
    } catch (_) { /* never let evidence logging fail attribute() */ }
  }

  return entry;
}

// v3.10 commit 2 — lazy-loaded evidence-log (degrades gracefully).
let _evidence = null;
let _evidenceTried = false;
function _evidenceLog() {
  if (_evidence !== null) return _evidence;
  if (_evidenceTried) return null;
  _evidenceTried = true;
  for (const p of [
    path.join(__dirname, 'vanta-evidence-log.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-evidence-log.js'),
  ]) {
    try { _evidence = require(p); return _evidence; }
    catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') {
        try { process.stderr.write(`[vanta-council-feedback] WARN: evidence-log load failed: ${err.message}\n`); } catch {}
      }
    }
  }
  _evidence = null;
  return null;
}

// Find open findings (raised but not yet attributed) that an incoming
// invariant likely resolves. Used by vanta-sync Step 8 to turn prose
// matching into a deterministic CLI call:
//
//   vanta-council-feedback match-open \
//     --slug pi-perception \
//     --invariant 'ES256 asymmetric JWTs required'
//
// Match criteria (ALL must hold):
//   - finding.slug === slug
//   - finding ts within last 14 days (default; --days N to override)
//   - lexical overlap: word-set Jaccard ≥ 0.25 (the primary signal)
//
// Match modes (council Tier 6 #15 → Codex P1 fix):
//   - 'strong' (default): jaccard ≥ 0.25 — caller may auto-attribute the top match
//   - 'weak'  (topic-hit-only assist): jaccard 0.10–0.25 + topic substring hit —
//     surfaced for HUMAN review only. Topic alone is too generic (any invariant
//     mentioning "auth" matches every auth-topic finding) and auto-TP'ing on
//     this signal silently corrupts the accuracy dataset.
//
// `strength` field on each result tells the caller what they're looking at.
// vanta-sync Step 8 only auto-attributes 'strong' matches.
function matchOpen({ slug, invariant, days = 14 } = {}) {
  if (!slug || !invariant) {
    throw new Error('matchOpen() requires: slug, invariant');
  }
  const cutoff = Date.now() - days * 86400_000;
  const findings = _readJsonl(_feedbackFile())
    .filter(e => e.slug === slug && Date.parse(e.ts) >= cutoff);
  const resolved = new Set(_readJsonl(_resolvedFile()).map(r => r.finding_hash));
  const open = findings.filter(f => !resolved.has(f.finding_hash));

  const tokenize = s => new Set(
    String(s).toLowerCase().split(/[^a-z0-9_.-]+/).filter(w => w.length > 2)
  );
  const invTokens = tokenize(invariant);

  const matches = [];
  for (const f of open) {
    const topicStr = String(f.topic || '');
    const topicHit = (topicStr.length >= 3 &&
      invariant.toLowerCase().includes(topicStr.toLowerCase())) ? 1 : 0;
    const excerptTokens = tokenize(f.finding_excerpt || '');
    let inter = 0;
    for (const t of invTokens) if (excerptTokens.has(t)) inter++;
    const union = invTokens.size + excerptTokens.size - inter;
    const jaccard = union === 0 ? 0 : inter / union;

    let strength;
    if (jaccard >= 0.25)                       strength = 'strong';
    else if (jaccard >= 0.10 && topicHit)      strength = 'weak';
    else                                       continue;

    matches.push({
      hash: f.finding_hash,
      finding_excerpt: f.finding_excerpt,
      topic: f.topic,
      model: f.model,
      priority: f.priority,
      similarity: Math.round(jaccard * 100) / 100,
      topicHit: !!topicHit,
      strength,
      ts: f.ts,
    });
  }
  // Strong matches first, then weak — tiebreak by similarity desc.
  matches.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
    return b.similarity - a.similarity;
  });
  return matches;
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

function cliMatchOpen() {
  const a = parseArgs(process.argv);
  const days = parseInt(a.days, 10) || 14;
  const matches = matchOpen({
    slug: a.slug,
    invariant: a.invariant,
    days,
  });
  if (a.json || a.json === true) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }
  if (matches.length === 0) {
    console.log(`No open findings match (slug=${a.slug}, ${days}d window).`);
    return;
  }
  const strong = matches.filter(m => m.strength === 'strong');
  const weak = matches.filter(m => m.strength === 'weak');
  console.log(`${matches.length} open finding(s) match within ${days}d (${strong.length} strong, ${weak.length} weak):`);
  for (const m of matches) {
    const tag = m.strength === 'strong' ? 'STRONG' : 'weak  ';
    console.log(`  [${tag}] [${m.priority}] ${m.hash} · ${m.model} · sim=${m.similarity}${m.topicHit ? ' (topic-hit)' : ''}`);
    console.log(`     topic=${m.topic} ts=${m.ts.slice(0,10)}`);
    console.log(`     "${m.finding_excerpt.slice(0, 120)}"`);
  }
  console.log('');
  if (strong.length > 0) {
    const top = strong[0];
    console.log('Attribute the top STRONG match:');
    console.log(`  vanta-council-feedback attribute --hash ${top.hash} --outcome true-positive --evidence "..."`);
  } else {
    console.log('No STRONG matches — weak ones surfaced for human review only.');
    console.log('Auto-attribution on weak matches would corrupt the accuracy dataset (topic substring is too generic).');
  }
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
  if (cmd === 'record')          cliRecord();
  else if (cmd === 'attribute')  cliAttribute();
  else if (cmd === 'stats')      cliStats();
  else if (cmd === 'match-open') cliMatchOpen();
  else {
    console.error('Usage: vanta-council-feedback {record|attribute|stats|match-open} [args]');
    console.error('  record     --topic X --slug Y --council-run TS --finding-text "..." --priority P1 --model codex [--round N] [--mode FULL]');
    console.error('  attribute  --hash sha256:... --outcome true-positive|false-positive|unverified [--evidence "..."]');
    console.error('  stats      [--days 90] [--json]');
    console.error('  match-open --slug Y --invariant "..." [--days 14] [--json]');
    process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { record, attribute, stats, matchOpen, findingHash, FEEDBACK_FILE, RESOLVED_FILE };
