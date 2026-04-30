#!/usr/bin/env node
// vanta-council-run — machine-checked council run artifact.
//
// Codex Tier-6 follow-up P2: Tier 6 #17 promised "no silent degradation"
// but kept it as prose in skills/council/SKILL.md. This bin gives /council
// a deterministic place to write per-run shape, and gives vanta-status +
// vanta-council-feedback a single source of truth for "what was actually
// consulted vs what was skipped."
//
// File: ~/.vanta/council-runs.jsonl
// Schema (one line per run):
//   {
//     ts:                 ISO timestamp of council START (the council_run id)
//     slug:               gstack project slug
//     topic:              short topic label
//     mode:               'FULL' | 'PARTIAL' | 'SOLO'
//     models_attempted:   ['codex@gpt-5.4', 'gemini@gemini-3.1-pro-preview']
//     models_used:        ['codex@gpt-5.4']  // a subset of attempted that actually returned
//     fallbacks:          [{ model: 'gemini-3.1-pro-preview', to: 'gemini-3-pro-preview', reason: '429' }]
//     finding_hashes:     ['sha256:6e58...', ...]   // every P1/P2 hash recorded for this run
//     verdict:            'PASS' | 'PASS_WITH_CONDITIONS' | 'BLOCK'
//     rounds:             1 | 2
//   }
//
// Usage:
//   vanta-council-run start  --slug X --topic Y                → emits ts; caller stores it
//   vanta-council-run finish --ts <ts> --slug X --topic Y \
//     --mode FULL --models-used codex@gpt-5.4,gemini@gemini-3.1-pro-preview \
//     --models-attempted codex@gpt-5.4,gemini@gemini-3.1-pro-preview \
//     --finding-hashes sha256:abc,sha256:def \
//     --verdict PASS_WITH_CONDITIONS --rounds 1
//   vanta-council-run last [--slug X]   → most recent run (text or --json)
//   vanta-council-run audit [--days 90] → degradation analysis: how often
//                                          mode != FULL, fallback frequency
//
// This is INTERNAL MACHINERY (Surface Impact Discipline): no new commands
// or skills, just a CLI helper for /council to call from its wrap-up step.

const fs = require('fs');
const path = require('path');
const os = require('os');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _runsFile() { return path.join(_vantaDir(), 'council-runs.jsonl'); }

function _ensureDir() {
  const d = _vantaDir();
  if (!fs.existsSync(d)) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

function _appendLine(obj) {
  _ensureDir();
  try { fs.appendFileSync(_runsFile(), JSON.stringify(obj) + '\n'); }
  catch (e) { process.stderr.write(`vanta-council-run: ${e.message}\n`); }
}

function _readJsonl() {
  const f = _runsFile();
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ─── public API ────────────────────────────────────────────────────────────

function start({ slug, topic } = {}) {
  if (!slug || !topic) throw new Error('start() requires: slug, topic');
  return new Date().toISOString();
}

function finish(entry) {
  const required = ['ts', 'slug', 'topic', 'mode', 'models_attempted', 'models_used', 'verdict'];
  for (const k of required) {
    if (!(k in entry)) throw new Error(`finish() requires: ${required.join(', ')} (missing: ${k})`);
  }
  const validModes = ['FULL', 'PARTIAL', 'SOLO'];
  if (!validModes.includes(entry.mode)) {
    throw new Error(`mode must be one of: ${validModes.join(', ')}`);
  }
  const validVerdicts = ['PASS', 'PASS_WITH_CONDITIONS', 'BLOCK'];
  if (!validVerdicts.includes(entry.verdict)) {
    throw new Error(`verdict must be one of: ${validVerdicts.join(', ')}`);
  }

  const record = {
    ts:                entry.ts,
    finished_ts:       new Date().toISOString(),
    slug:              entry.slug,
    topic:             entry.topic,
    mode:              entry.mode,
    models_attempted:  Array.isArray(entry.models_attempted) ? entry.models_attempted : [],
    models_used:       Array.isArray(entry.models_used) ? entry.models_used : [],
    fallbacks:         Array.isArray(entry.fallbacks) ? entry.fallbacks : [],
    finding_hashes:    Array.isArray(entry.finding_hashes) ? entry.finding_hashes : [],
    verdict:           entry.verdict,
    rounds:            entry.rounds || 1,
  };
  _appendLine(record);
  return record;
}

function last({ slug } = {}) {
  const all = _readJsonl();
  const filtered = slug ? all.filter(r => r.slug === slug) : all;
  if (filtered.length === 0) return null;
  return filtered[filtered.length - 1];
}

// Audit recent runs for silent-degradation patterns.
function audit({ days = 90 } = {}) {
  const cutoff = Date.now() - days * 86400_000;
  const runs = _readJsonl().filter(r => Date.parse(r.ts) >= cutoff);
  if (runs.length === 0) {
    return { window_days: days, total: 0, message: 'no council runs in window' };
  }
  const byMode = { FULL: 0, PARTIAL: 0, SOLO: 0 };
  let withFallback = 0;
  let zeroFinding = 0;
  const fallbackReasons = new Map();
  const verdicts = { PASS: 0, PASS_WITH_CONDITIONS: 0, BLOCK: 0 };
  for (const r of runs) {
    byMode[r.mode] = (byMode[r.mode] || 0) + 1;
    verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
    if (r.fallbacks && r.fallbacks.length > 0) {
      withFallback++;
      for (const fb of r.fallbacks) {
        const k = (fb.reason || 'unknown').slice(0, 40);
        fallbackReasons.set(k, (fallbackReasons.get(k) || 0) + 1);
      }
    }
    if (!r.finding_hashes || r.finding_hashes.length === 0) zeroFinding++;
  }
  return {
    window_days: days,
    total: runs.length,
    mode_distribution: byMode,
    partial_rate: Math.round((byMode.PARTIAL / runs.length) * 100) / 100,
    solo_rate:    Math.round((byMode.SOLO    / runs.length) * 100) / 100,
    fallback_rate: Math.round((withFallback / runs.length) * 100) / 100,
    fallback_reasons: Object.fromEntries(fallbackReasons),
    zero_finding_rate: Math.round((zeroFinding / runs.length) * 100) / 100,
    verdict_distribution: verdicts,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

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

function csvList(s) {
  if (!s || s === true) return [];
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

function cliStart() {
  const a = parseArgs(process.argv);
  console.log(start({ slug: a.slug, topic: a.topic }));
}

function cliFinish() {
  const a = parseArgs(process.argv);
  const r = finish({
    ts: a.ts,
    slug: a.slug,
    topic: a.topic,
    mode: a.mode,
    models_attempted: csvList(a['models-attempted']),
    models_used:      csvList(a['models-used']),
    fallbacks:        a.fallbacks ? JSON.parse(a.fallbacks) : [],
    finding_hashes:   csvList(a['finding-hashes']),
    verdict: a.verdict,
    rounds: parseInt(a.rounds, 10) || 1,
  });
  console.log(JSON.stringify(r, null, 2));
}

function cliLast() {
  const a = parseArgs(process.argv);
  const r = last({ slug: a.slug });
  if (!r) { console.log('no runs yet'); return; }
  if (a.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Last council run for ${r.slug || '(any)'}: ${r.ts}`);
  console.log(`  topic: ${r.topic}`);
  console.log(`  mode: ${r.mode} · verdict: ${r.verdict} · rounds: ${r.rounds}`);
  console.log(`  models attempted: ${r.models_attempted.join(', ')}`);
  console.log(`  models used:      ${r.models_used.join(', ')}`);
  if (r.fallbacks.length) console.log(`  fallbacks: ${JSON.stringify(r.fallbacks)}`);
  console.log(`  findings recorded: ${r.finding_hashes.length}`);
}

function cliAudit() {
  const a = parseArgs(process.argv);
  const days = parseInt(a.days, 10) || 90;
  const s = audit({ days });
  if (a.json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`=== council-run audit (${s.window_days}d) ===`);
  console.log(`total runs: ${s.total}`);
  if (s.total === 0) return;
  console.log(`mode distribution: FULL=${s.mode_distribution.FULL || 0} · PARTIAL=${s.mode_distribution.PARTIAL || 0} · SOLO=${s.mode_distribution.SOLO || 0}`);
  console.log(`partial rate: ${(s.partial_rate * 100).toFixed(0)}%   solo rate: ${(s.solo_rate * 100).toFixed(0)}%`);
  console.log(`fallback rate: ${(s.fallback_rate * 100).toFixed(0)}%`);
  if (Object.keys(s.fallback_reasons).length) {
    console.log('fallback reasons:');
    for (const [k, v] of Object.entries(s.fallback_reasons)) console.log(`  ${v}× ${k}`);
  }
  console.log(`zero-finding rate: ${(s.zero_finding_rate * 100).toFixed(0)}%`);
  console.log(`verdicts: ${JSON.stringify(s.verdict_distribution)}`);
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'start')       cliStart();
  else if (cmd === 'finish') cliFinish();
  else if (cmd === 'last')   cliLast();
  else if (cmd === 'audit')  cliAudit();
  else {
    console.error('Usage: vanta-council-run {start|finish|last|audit} [args]');
    console.error('  start  --slug X --topic Y                            → emits ISO ts');
    console.error('  finish --ts ISO --slug X --topic Y --mode FULL --models-attempted A,B \\');
    console.error('         --models-used A,B [--fallbacks JSON] [--finding-hashes A,B] \\');
    console.error('         --verdict PASS|PASS_WITH_CONDITIONS|BLOCK [--rounds N]');
    console.error('  last   [--slug X] [--json]');
    console.error('  audit  [--days 90] [--json]');
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { start, finish, last, audit, _runsFile };
