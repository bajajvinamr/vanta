#!/usr/bin/env node
// vanta-extract-score — confidence scoring for invariant candidates.
//
// Tier 6 #16 deliverable. vanta-sync extracts invariants from session
// transcripts; if extraction is wrong, the polluted entry lands in
// ~/.claude/rules/vinamr-invariants.md and influences every future
// Claude/Gemini/Codex session forever, with no review gate.
//
// This module gates writes by confidence score:
//
//   ≥ 0.65 → auto       (R7 P1 fix — writes to STAGING ONLY, never global
//                        invariants directly; the vanta-sync skill enforces
//                        manual review before promotion. Earlier wrote
//                        directly to vinamr-invariants.md, which was a
//                        persistent prompt-injection vector.)
//   0.40–0.65 → staging (always staging — same path now)
//   < 0.40 → discard    (logged to hook.log for postmortem)
//   any near-dup ≥ 0.8 → update-in-place (don't add a 4th rephrasing)
//
// R10 P3 — docstring drift fix. The old comment claimed thresholds of
// ≥0.8 for auto and 0.5 for staging, but the code uses ≥0.65 / ≥0.40
// (see ROUTE_THRESHOLDS below at the actual decision site).
//
// Pure functions only — no I/O at module top level. CLI mode reads the
// existing invariants file only when explicitly invoked.
//
// Usage (CLI):
//   vanta-extract-score "candidate text" [--existing path/to/invariants.md]
//   vanta-extract-score list-staging
//
// Usage (programmatic):
//   const { routeCandidate, auditPrefix } = require('vanta-extract-score');
//   const r = routeCandidate(text, { existing: [...] });
//   if (r.route === 'auto') fs.appendFileSync(file, auditPrefix({...}) + '\n- ' + text);

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── classification constants ────────────────────────────────────────────────

// Skill-doc phrases that historically misclassified as invariants. Hard reject.
// Source: Tier 5 retrofit. Keep this list narrow — false positives here mean
// real invariants get discarded. Each pattern must come from an actual past
// extraction failure, not speculation.
const SKILL_DOC_PHRASES = [
  /\bstep\s+\d+(?:\s|:|—|-)/i,         // "Step 1:", "Step 3 —"
  /\bthis skill\b/i,                    // self-referential skill doc
  /\binvoke this skill\b/i,
  /\bmandatory workflow\b/i,
  /\b##\s+process\b/i,                  // markdown section header
  /^\s*\d+\.\s+\*\*[A-Z]/m,             // numbered list with bold header — typical SKILL.md cadence
  /\b(?:proactive|when to run|how to use)\b.*:/i,
  /\bAskUserQuestion\b/,                // skill-orchestration vocabulary
];

// Decision-language markers — invariants that include these are stronger.
const DECISION_MARKERS = [
  /\bmust(?:\s+not)?\b/i,
  /\balways\b/i, /\bnever\b/i,
  /\brequires?\b/i,
  /\bdefaults? to\b/i,
];

// Failure-mode framing — "X will fail / break / exit N" is a high-quality
// invariant shape because it tells you the consequence, not just the rule.
const FAILURE_FRAMING = [
  /\b(?:will|may)\s+fail\b/i,
  /\bsilently\b/i,
  /\bcrashes?\b/i,
  /\bexits?\s+(?:code\s+)?\d+/i,
  /\bbreaks?\s+(?:silently|on)\b/i,
  /\bOOM\b/, /\btimeouts?\b/i,
];

// Technical tokens that distinguish real invariants from prose. CamelCase
// identifiers, snake_case, dotted versions, env-var-style SCREAMING_SNAKE,
// flag-shaped tokens, common file extensions.
const TECH_TOKEN = /\b(?:[A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+|[A-Z]+_[A-Z_]+|--?[a-z]+(?:-[a-z]+)*|\d+\.\d+(?:\.\d+)?|[A-Z]{2,}\d{2,3}|\.(?:json|toml|ya?ml|md|sh|js|ts|tsx))\b/g;

// ── pure scoring ─────────────────────────────────────────────────────────────

function jaccard(a, b) {
  const tokenize = s => new Set(
    String(s).toLowerCase().split(/[^a-z0-9_.-]+/).filter(w => w.length > 2)
  );
  const aw = tokenize(a);
  const bw = tokenize(b);
  if (aw.size === 0 || bw.size === 0) return 0;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  const union = aw.size + bw.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bestSimilarity(text, existing) {
  let best = { index: -1, similarity: 0, match: null };
  for (let i = 0; i < existing.length; i++) {
    const s = jaccard(text, existing[i]);
    if (s > best.similarity) best = { index: i, similarity: s, match: existing[i] };
  }
  return best;
}

function scoreCandidate(text, opts = {}) {
  const reasons = [];
  if (typeof text !== 'string' || !text.trim()) {
    return { score: 0, reasons: ['empty-or-non-string'] };
  }

  // Hard reject — skill-doc phrasing. Bypasses all other scoring.
  for (const re of SKILL_DOC_PHRASES) {
    if (re.test(text)) {
      reasons.push(`skill-doc-reject: ${re.source}`);
      return { score: 0, reasons, hardReject: true };
    }
  }

  let score = 0;

  // Length sweet spot — invariants distill, so very short or very long is suspect.
  const len = text.length;
  let lenScore;
  if (len >= 40 && len <= 300) lenScore = 0.3;
  else if (len >= 20 && len < 40) lenScore = 0.18;
  else if (len > 300 && len <= 600) lenScore = 0.12;
  else lenScore = 0;
  score += lenScore;
  reasons.push(`length=${len} +${lenScore}`);

  // Decision-marker presence (must / always / never / requires / defaults to)
  let markers = 0;
  for (const re of DECISION_MARKERS) if (re.test(text)) markers++;
  const markerScore = Math.min(0.3, markers * 0.12);
  score += markerScore;
  reasons.push(`decision-markers=${markers} +${markerScore.toFixed(2)}`);

  // Failure-mode framing — high-quality invariants name consequences.
  let framing = 0;
  for (const re of FAILURE_FRAMING) if (re.test(text)) framing++;
  const framingScore = Math.min(0.2, framing * 0.1);
  score += framingScore;
  reasons.push(`failure-framing=${framing} +${framingScore.toFixed(2)}`);

  // Technical tokens — invariants are concrete (filenames, versions, flags).
  const tokens = (text.match(TECH_TOKEN) || []).length;
  const tokenScore = Math.min(0.3, tokens * 0.06);
  score += tokenScore;
  reasons.push(`tech-tokens=${tokens} +${tokenScore.toFixed(2)}`);

  // Inline-code backticks — vinamr-invariants.md format heavily uses
  // `code` markers around identifiers, env vars, file paths, and flags.
  // PII / project state typically doesn't, so this separates them well.
  const backticks = (text.match(/`[^`\n]{2,}`/g) || []).length;
  const backtickScore = Math.min(0.25, backticks * 0.08);
  score += backtickScore;
  reasons.push(`backticks=${backticks} +${backtickScore.toFixed(2)}`);

  // Dup penalty — if caller supplied existing invariants, check overlap.
  let dup = null;
  if (Array.isArray(opts.existing) && opts.existing.length > 0) {
    const sim = bestSimilarity(text, opts.existing);
    if (sim.similarity >= 0.8) {
      // Near-duplicate: don't add a 4th rephrasing of the same fact.
      // Caller should route as 'update-in-place'.
      reasons.push(`near-dup index=${sim.index} sim=${sim.similarity.toFixed(2)}`);
      dup = sim;
      // We still return a non-zero score so caller can decide; but the
      // dup signal flips the route below.
    } else if (sim.similarity >= 0.5) {
      score -= 0.25;
      reasons.push(`partial-dup sim=${sim.similarity.toFixed(2)} -0.25`);
    }
  }

  // v3.11 C-3 — staging dup check. Same near-dup threshold as global
  // (0.8). Caller routes 'staging-duplicate' so a candidate that's
  // already pending review doesn't get re-staged from a different source.
  let stagingDup = null;
  if (Array.isArray(opts.staging) && opts.staging.length > 0) {
    const sim = bestSimilarity(text, opts.staging);
    if (sim.similarity >= 0.8) {
      reasons.push(`staging-dup index=${sim.index} sim=${sim.similarity.toFixed(2)}`);
      stagingDup = sim;
    }
  }

  score = Math.max(0, Math.min(1, score));
  return {
    score: Math.round(score * 100) / 100,
    reasons,
    dup,
    stagingDup,
  };
}

// Routing thresholds calibrated against real entries in
// ~/.claude/rules/vinamr-invariants.md (typical scores 0.55–0.85)
// vs known reject cases (PII state, prose snippets, skill-doc paragraphs):
//   ≥ 0.65  → auto         (matches the well-formed invariant cluster)
//   0.40–0.65 → staging    (likely real, deserves human eyeball)
//   < 0.40  → discard      (PII, prose, skill-doc — already low-density)
function routeCandidate(text, opts = {}) {
  const sc = scoreCandidate(text, opts);
  let route;
  if (sc.hardReject)         route = 'discard';
  // v3.11 C-3 — staging hit takes precedence over global hit. The same
  // candidate already pending human review should NOT be re-staged from
  // a different source on a subsequent /vanta-sync run.
  else if (sc.stagingDup)    route = 'staging-duplicate';
  else if (sc.dup)           route = 'update-in-place';
  else if (sc.score >= 0.65) route = 'auto';
  else if (sc.score >= 0.40) route = 'staging';
  else                       route = 'discard';
  return {
    route,
    score: sc.score,
    reasons: sc.reasons,
    dup: sc.dup,
    stagingDup: sc.stagingDup,
    hardReject: sc.hardReject || false,
  };
}

// ── audit comment ───────────────────────────────────────────────────────────

function auditPrefix({ sessionId, confidence, ts, auto }) {
  const t = ts || new Date().toISOString();
  const sid = sessionId || 'unknown';
  const conf = (typeof confidence === 'number') ? confidence.toFixed(2) : 'unknown';
  // v3.12 — optional `auto` flag distinguishes Stop-hook auto-staged
  // entries from manually-distilled /vanta-sync entries. Reviewer can
  // tell the two apart; promotion paths can refuse auto=true entries
  // without explicit human confirmation. Backward-compat: when `auto`
  // is undefined the v3.10/v3.11 audit format is produced unchanged.
  const tail = (typeof auto === 'boolean') ? ` auto=${auto}` : '';
  return `<!-- vanta-sync: session=${sid} ts=${t} confidence=${conf}${tail} -->`;
}

// ── helpers for vanta-sync integration ─────────────────────────────────────

function readInvariantBullets(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter(l => /^\s*-\s+/.test(l))
      .map(l => l.replace(/^\s*-\s+/, '').trim());
  } catch { return []; }
}

const STAGING_FILE = path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.staging.md');
const INVARIANTS_FILE = path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.md');

function listStaging() {
  if (!fs.existsSync(STAGING_FILE)) {
    return { present: false, count: 0, entries: [] };
  }
  const content = fs.readFileSync(STAGING_FILE, 'utf8');
  const blocks = content.split(/\n(?=<!-- vanta-sync:)/g).filter(b => b.trim());
  return {
    present: true,
    count: blocks.length,
    entries: blocks.map((b, i) => ({ idx: i + 1, body: b.trim().slice(0, 400) })),
    file: STAGING_FILE,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function cli() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'list-staging') {
    const s = listStaging();
    if (!s.present) {
      console.log('No staging file at ' + STAGING_FILE);
      return;
    }
    console.log(`=== staging invariants (${s.count} pending) ===`);
    console.log(`File: ${s.file}`);
    console.log('');
    for (const e of s.entries) {
      console.log(`[${e.idx}]`);
      console.log(e.body);
      console.log('');
    }
    console.log('Edit the file directly to accept/reject.');
    console.log('After editing, move surviving entries to vinamr-invariants.md and clear the staging file.');
    return;
  }

  if (argv.length === 0 || argv[0].startsWith('--help')) {
    console.error('Usage:');
    console.error('  vanta-extract-score "candidate text" [--existing path]');
    console.error('  vanta-extract-score list-staging');
    process.exit(2);
  }

  const candidate = argv.find(a => !a.startsWith('--'));
  const existingArg = argv.find(a => a.startsWith('--existing='));
  const file = existingArg ? existingArg.slice('--existing='.length) : INVARIANTS_FILE;
  const existing = readInvariantBullets(file);
  // v3.11 C-3 — optional staging dedup. When present, candidates that
  // are already pending review in the staging file route as
  // 'staging-duplicate' (no write). Backward-compat: absent flag = old
  // behavior (no staging check).
  const stagingArg = argv.find(a => a.startsWith('--staging='));
  const staging = stagingArg
    ? readInvariantBullets(stagingArg.slice('--staging='.length))
    : [];
  const r = routeCandidate(candidate, { existing, staging });
  console.log(JSON.stringify(r, null, 2));
}

if (require.main === module) cli();

module.exports = {
  scoreCandidate,
  routeCandidate,
  auditPrefix,
  jaccard,
  bestSimilarity,
  readInvariantBullets,
  listStaging,
  SKILL_DOC_PHRASES,
  DECISION_MARKERS,
  FAILURE_FRAMING,
  STAGING_FILE,
  INVARIANTS_FILE,
};
