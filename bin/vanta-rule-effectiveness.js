#!/usr/bin/env node
// vanta-rule-effectiveness — pure-compute rule scorer.
//
// v3.10 commit 1. Per the v3.10 PLAN.md (post-council R1+R2):
//
//   rule (in vanta-rewriter.js)
//     → decision (decision_id in route-quality.jsonl)
//     → action (decision_id in actions.jsonl, post-v3.9.1 schema)
//     → outcome (lifecycle terminal state + nearby undo/stop/reroute/manual-recall)
//
// This module reads the four telemetry streams (route-quality, actions,
// manual-recalls, cancellations) and joins them on decision_id to
// compute per-rule effectiveness with Wilson CI lower bound. The result
// drives quarantine eligibility (commits 3+).
//
// Council fixes in this implementation:
//   C-1 — Lineage required (decision_id from v3.9.1 schema).
//   C-3 — Auto-rehab via per-rule content hash, NOT file mtime.
//         The rule corpus lives in vanta-rewriter.js as object literals;
//         we extract each rule block via brace-counting and SHA-256 it.
//   C-4 — Lineage REQUIRED for scoring; without decision_id match the
//         outcome is `unscorable` and counted separately.
//   C-5 — scoring_epoch_start_ts filters pre-rehab fires from re-quarantine.
//   C-6 — No process-local TTL cache; readers revalidate via mtime each
//         call (cache invalidation is the rewriter's responsibility, not
//         ours — this module is pure compute).
//   C-8 — Monotonic status_seq with deterministic precedence on tie.
//   C-11 — readActions defaults to live file only (not bak siblings).
//
// Surface Impact Discipline: INTERNAL MACHINERY. No new commands. Read
// from existing JSONL streams; write to one new side-channel JSONL.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _effectivenessFile() { return path.join(_vantaDir(), 'rule-effectiveness.jsonl'); }
function _routeQualityFile()  { return path.join(_vantaDir(), 'route-quality.jsonl'); }
function _recallsFile()       { return path.join(_vantaDir(), 'manual-recalls.jsonl'); }
function _cancellationsFile() { return path.join(_vantaDir(), 'cancellations.jsonl'); }

let _jsonl, _action;
function jsonl() {
  if (_jsonl) return _jsonl;
  for (const p of [
    path.join(__dirname, 'vanta-jsonl.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-jsonl.js'),
  ]) {
    try { _jsonl = require(p); return _jsonl; } catch (_) { /* try next */ }
  }
  throw new Error('vanta-jsonl.js not resolvable');
}
function action() {
  if (_action) return _action;
  for (const p of [
    path.join(__dirname, 'vanta-action.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-action.js'),
  ]) {
    try { _action = require(p); return _action; } catch (_) { /* try next */ }
  }
  return null;  // optional — degraded mode if missing
}

// Quarantine thresholds. Wilson lower bound at 95%, 50-fire minimum,
// 30% rolling-window floor. These are deliberately conservative —
// auditable, documented, easy to write tests against. v3.11 may tune.
const QUARANTINE_MIN_FIRES = 50;
const QUARANTINE_CI_THRESHOLD = 0.30;
const QUARANTINE_WINDOW_THRESHOLD = 0.30;
const ROLLING_WINDOW_SIZE = 50;
// 30-min RECENT_WINDOW for joining outcomes to fires by decision_id.
// Matches vanta-intent-undo's RECENT_WINDOW_MS — same semantic.
const OUTCOME_WINDOW_MS = 30 * 60 * 1000;

// ─── Wilson CI lower bound at 95% ────────────────────────────────────
//
// p̂ = successes / n
// z = 1.959963984540054 (95% two-sided)
// lower = (p̂ + z²/(2n) - z·√(p̂(1-p̂)/n + z²/(4n²))) / (1 + z²/n)
//
// Returns 0 for n=0 (cold start — never quarantine an unobserved rule).
const Z_95 = 1.959963984540054;
function wilsonLowerBound(successes, n) {
  if (n <= 0) return 0;
  const p = successes / n;
  const z = Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const inner = p * (1 - p) / n + z2 / (4 * n * n);
  if (inner < 0) return 0;
  const margin = z * Math.sqrt(inner);
  const lower = (center - margin) / denom;
  // Clamp to [0,1] for floating-point safety
  return Math.max(0, Math.min(1, lower));
}

// ─── Rule corpus content-hash extractor (C-3 fix) ────────────────────
//
// Read vanta-rewriter.js source and extract each rule object literal
// by id, hashing the block. Auto-rehab compares the hash at quarantine
// time with the current hash — if changed, the rule was edited and
// should be rehabbed with a fresh epoch.
//
// Why content hash and not mtime: vanta-rewriter.js is one shared file;
// any unrelated rule edit bumps mtime and would falsely rehabilitate
// EVERY quarantined rule. Per-block hash is precise.
//
// v3.10 ships with regex+brace-counting; v3.11 may switch to AST.
function extractRuleBlockHashes(rewriterSource) {
  const out = new Map();
  const idRx = /id:\s*['"]([\w-]+)['"]/g;
  let m;
  while ((m = idRx.exec(rewriterSource))) {
    const ruleId = m[1];
    // Walk back from m.index to find the opening `{` of THIS rule object.
    // We stop if we hit `}` first (means we already left the previous
    // rule and the id was inside something else, not a rule block).
    let openPos = -1;
    for (let i = m.index; i >= 0; i--) {
      const ch = rewriterSource[i];
      if (ch === '{') { openPos = i; break; }
      if (ch === '}') break;
    }
    if (openPos === -1) continue;
    const closePos = _findMatchingBrace(rewriterSource, openPos);
    if (closePos === -1) continue;
    const block = rewriterSource.slice(openPos, closePos + 1);
    out.set(ruleId, crypto.createHash('sha256').update(block).digest('hex'));
  }
  return out;
}

// v3.10 commit 3 R1 council fix (Gemini P1): naive brace counting
// breaks on literal `{` or `}` inside regex literals (`rx: /[{}]/`),
// strings, template literals, or comments. The current corpus is
// internally balanced (`{0,80}`) but a future rule like `rx: /[}]/`
// would corrupt depth. Tokenizer skips:
//   - line comments  (// ... \n)
//   - block comments (/* ... */)
//   - single-quoted strings ('...' with \\ escape)
//   - double-quoted strings ("..." with \\ escape)
//   - template literals (`...` with ${} interpolation, recurses on braces)
//   - regex literals (/.../ with [...] char-class awareness)
// Returns the position of the matching `}` for the `{` at openPos, or
// -1 if unbalanced.
function _findMatchingBrace(src, openPos) {
  let depth = 0;
  let i = openPos;
  // Stack tracks template-literal nesting so ${} interpolation can recurse.
  const tmplStack = [];
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // Line comment
    if (ch === '/' && next === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) return -1;
      i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    // Single-quoted string
    if (ch === "'") {
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') i += 2; else i++;
      }
      i++;
      continue;
    }
    // Double-quoted string
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i += 2; else i++;
      }
      i++;
      continue;
    }
    // Template literal
    if (ch === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Recurse on the interpolation: count braces inside, return
          // here when depth balances.
          const innerOpen = i + 1;
          const innerClose = _findMatchingBrace(src, innerOpen);
          if (innerClose === -1) return -1;
          i = innerClose + 1;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    // Regex literal — only when context permits (after `=`, `(`, `,`, `:`, `[`, `!`, `&`, `|`, `?`, `;`, `{`, return, etc.)
    if (ch === '/' && _canStartRegex(src, i)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') { inClass = true; i++; continue; }
        if (c === ']') { inClass = false; i++; continue; }
        if (c === '/' && !inClass) { i++; break; }
        if (c === '\n') break;  // unterminated — bail
        i++;
      }
      // Skip regex flags
      while (i < src.length && /[gimsuy]/.test(src[i])) i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Heuristic: a `/` starts a regex literal if the previous non-whitespace
// char is one that allows a regex in JS grammar (operators, openers,
// keywords). Otherwise it's division.
function _canStartRegex(src, slashPos) {
  for (let k = slashPos - 1; k >= 0; k--) {
    const c = src[k];
    if (/\s/.test(c)) continue;
    if (/[=([,:!&|?;{+\-*%^~<>]/.test(c)) return true;
    // Word context: check if the trailing word is a keyword that allows regex
    if (/\w/.test(c)) {
      let end = k + 1;
      while (k >= 0 && /\w/.test(src[k])) k--;
      const word = src.slice(k + 1, end);
      return /^(return|typeof|in|of|instanceof|new|delete|void|throw|case|do|else|yield|await)$/.test(word);
    }
    return false;
  }
  return true;  // start of file
}

// Read the raw rewriter source. v3.10 commit 3 R1 council fix
// (Codex P1 + Gemini P2): the rewriter uses __filename to compute its
// OWN content hash. If we prefer ~/.claude/bin/vanta-rewriter.js here
// while the live rewriter is running from the repo (dev), the hashes
// will diverge → instant auto-rehab on every quarantined rule. Always
// prefer the file ADJACENT to this module (i.e., the rewriter that
// shipped together with us in the same install location). This keeps
// CLI quarantine and runtime check evaluating the same source.
function readRewriterSource() {
  // R2 council fix (Codex P3): canonicalize via realpath so symlinks,
  // npm-link, and monorepo duplicate installs converge to one path.
  // The rewriter ALSO realpath()s its own __filename — they must agree.
  for (const p of [
    path.join(__dirname, 'vanta-rewriter.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-rewriter.js'),
  ]) {
    try {
      const real = fs.realpathSync(p);
      return fs.readFileSync(real, 'utf8');
    } catch (_) { /* try next */ }
  }
  return null;
}

// ─── Telemetry readers ───────────────────────────────────────────────
function _readJsonlLive(file) {
  // C-11: hot-path reader — live file only, no bak merge.
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* torn — skip */ }
    }
    return out;
  } catch (_) { return []; }
}

// ─── Score one rule from telemetry ───────────────────────────────────
//
// Inputs: routeEntries (rule fires from route-quality), outcomes
// (decision_id-keyed map of undo/stop/reroute/cancellation events),
// recalls (manual-recalls), epochStart (filter ts).
//
// Output: RuleEffectiveness object (sans status — that's set by the
// snapshot writer based on quarantine eligibility).
function scoreRule(ruleId, routeEntries, outcomesByDecision, recalls, epochStart) {
  let fires = 0;
  let unscorable = 0;
  let proceeded = 0;
  let recalled = 0;
  let undone = 0;
  let rerouted = 0;
  let stopped = 0;

  // Sort fires by ts; we'll use the last 50 for the rolling window.
  const filtered = routeEntries
    .filter(e => e.suggested_route || e.skill_route)  // rewriter actually picked something
    .filter(e => e.rule_id === ruleId)
    .filter(e => !epochStart || (e.ts || '') >= epochStart)
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  // Per-fire: look up outcome by decision_id. C-4: lineage required;
  // no match = unscorable, NOT proceeded.
  const fireOutcomes = [];  // parallel to filtered: 'proceeded' | 'undone' | 'rerouted' | 'stopped' | 'recalled' | 'unscorable'
  for (const fire of filtered) {
    if (!fire.decision_id) {
      unscorable++;
      fireOutcomes.push('unscorable');
      continue;
    }
    const outcome = outcomesByDecision.get(fire.decision_id);
    if (outcome) {
      // Only count outcomes within the OUTCOME_WINDOW_MS of the fire.
      const dtMs = Date.parse(outcome.ts || '') - Date.parse(fire.ts || '');
      if (Number.isFinite(dtMs) && dtMs >= 0 && dtMs <= OUTCOME_WINDOW_MS) {
        switch (outcome.kind) {
          case 'undone':   undone++;   fireOutcomes.push('undone');   break;
          case 'rerouted': rerouted++; fireOutcomes.push('rerouted'); break;
          case 'stopped':  stopped++;  fireOutcomes.push('stopped');  break;
          default:         unscorable++; fireOutcomes.push('unscorable');
        }
        continue;
      }
    }
    // Manual recall: matched on (project, session) proximity rather than
    // decision_id, because manual-recall is itself the user typing /skill
    // after the rewriter fired (no downstream action carries decision_id).
    const recall = recalls.find(r =>
      r.project === fire.project &&
      r.session_id === fire.session_id &&
      Date.parse(r.ts || '') > Date.parse(fire.ts || '') &&
      Date.parse(r.ts || '') - Date.parse(fire.ts || '') < OUTCOME_WINDOW_MS,
    );
    if (recall) {
      recalled++;
      fireOutcomes.push('recalled');
      continue;
    }
    // No outcome event in window → proceeded.
    proceeded++;
    fireOutcomes.push('proceeded');
  }

  fires = proceeded + undone + rerouted + stopped + recalled;
  const successRate = fires > 0 ? proceeded / fires : 0;
  const ciLower = wilsonLowerBound(proceeded, fires);

  // Rolling window: last N scorable fires.
  const tail = fireOutcomes.filter(o => o !== 'unscorable').slice(-ROLLING_WINDOW_SIZE);
  const tailProceeded = tail.filter(o => o === 'proceeded').length;
  const last50WindowRate = tail.length > 0 ? tailProceeded / tail.length : 0;

  return {
    rule_id: ruleId,
    fires,
    unscorable,
    proceeded,
    recalled,
    undone,
    rerouted,
    stopped,
    success_rate: successRate,
    ci_lower: ciLower,
    last_50_window_rate: last50WindowRate,
  };
}

// ─── Outcome map builder ─────────────────────────────────────────────
//
// Build a Map<decision_id, {kind, ts}> from the v3.9.0 action ledger
// + cancellations stream. An action with lifecycle 'rolled_back' from
// undo intent → kind='undone'. Cancellation with kind='user-initiated-stop'
// → 'stopped'. 'user-initiated-reroute' → 'rerouted'. 'user-initiated-undo'
// → 'undone'.
function buildOutcomeMap() {
  const out = new Map();
  // Cancellations (v3.9.0 stream) carry decision_id post-v3.9.1.
  const cancellations = _readJsonlLive(_cancellationsFile());
  for (const c of cancellations) {
    if (!c.decision_id) continue;
    const ts = c.cancelled_at || c.ts;
    let kind;
    switch (c.cancellation_kind) {
      case 'user-initiated-stop':    kind = 'stopped';  break;
      case 'user-initiated-reroute': kind = 'rerouted'; break;
      case 'user-initiated-undo':    kind = 'undone';   break;
      default: continue;
    }
    // Latest cancellation per decision_id wins (in case the same decision
    // had multiple cancellations recorded — shouldn't happen, but defensive).
    const prior = out.get(c.decision_id);
    if (!prior || (ts || '') > (prior.ts || '')) {
      out.set(c.decision_id, { kind, ts });
    }
  }
  return out;
}

// ─── Top-level: compute scores for all rules ────────────────────────
//
// Returns { rules: RuleEffectiveness[], current_block_hashes: Map }.
// Caller (commit 3 — rule-tune CLI / rewriter) decides whether to
// snapshot, quarantine, or rehabilitate based on these.
function compute({ project = null, ruleIds = null } = {}) {
  const routeEntries = _readJsonlLive(_routeQualityFile())
    .filter(e => !project || e.project === project);
  const recalls = _readJsonlLive(_recallsFile())
    .filter(e => !project || e.project === project);
  const outcomes = buildOutcomeMap();

  // Discover rules from EITHER the source (preferred) or from the
  // telemetry (degraded mode if source unavailable).
  const source = readRewriterSource();
  const blockHashes = source ? extractRuleBlockHashes(source) : new Map();
  let rulesToScore;
  if (ruleIds && ruleIds.length > 0) {
    rulesToScore = ruleIds;
  } else if (blockHashes.size > 0) {
    rulesToScore = [...blockHashes.keys()];
  } else {
    // Degraded — derive rule list from telemetry.
    const seen = new Set();
    for (const e of routeEntries) if (e.rule_id) seen.add(e.rule_id);
    rulesToScore = [...seen];
  }

  // Get prior status entries to discover scoring epochs (C-5).
  const priorStatus = readLatestStatus();

  const scored = rulesToScore.map(ruleId => {
    const epochStart = priorStatus.get(ruleId)?.scoring_epoch_start_ts || null;
    const r = scoreRule(ruleId, routeEntries, outcomes, recalls, epochStart);
    r.rule_content_hash = blockHashes.get(ruleId) || null;
    return r;
  });
  return { rules: scored, current_block_hashes: blockHashes };
}

// ─── Quarantine eligibility check ───────────────────────────────────
//
// Returns { eligible: boolean, reason: string }. ALL conditions must
// hold for eligibility:
//   fires >= QUARANTINE_MIN_FIRES (50)
//   ci_lower < QUARANTINE_CI_THRESHOLD (0.30)
//   last_50_window_rate < QUARANTINE_WINDOW_THRESHOLD (0.30)
function quarantineEligible(rule) {
  if (!rule || rule.fires < QUARANTINE_MIN_FIRES) {
    return { eligible: false, reason: `fires=${rule?.fires || 0} < min=${QUARANTINE_MIN_FIRES}` };
  }
  if (rule.ci_lower >= QUARANTINE_CI_THRESHOLD) {
    return { eligible: false, reason: `ci_lower=${rule.ci_lower.toFixed(3)} >= threshold=${QUARANTINE_CI_THRESHOLD}` };
  }
  if (rule.last_50_window_rate >= QUARANTINE_WINDOW_THRESHOLD) {
    return { eligible: false, reason: `last_50_window=${rule.last_50_window_rate.toFixed(3)} >= threshold=${QUARANTINE_WINDOW_THRESHOLD}` };
  }
  return { eligible: true, reason: 'all thresholds met' };
}

// ─── Persistence layer ──────────────────────────────────────────────
//
// rule-effectiveness.jsonl is append-only with monotonic status_seq
// per rule (C-8). Latest entry per rule wins on read; ties broken by
// max status_seq (deterministic precedence).
//
// snapshot() — write a new entry per rule for the current scores.
// Used by Phase A scorer + by rule-tune CLI when manually changing
// status. Each call increments status_seq globally (monotonic) and
// per-rule (also monotonic).

function snapshot(scoredRules, { reason = null } = {}) {
  if (!Array.isArray(scoredRules) || scoredRules.length === 0) return [];
  const file = _effectivenessFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const written = [];
  for (const rule of scoredRules) {
    // v3.10 commit 3 R1 council fix (Codex P1 + Gemini P1):
    // Re-read status per-rule so we never overwrite a manual setStatus()
    // that landed during this snapshot batch. snapshot() is OBSERVATION,
    // not policy — it must NOT increment status_seq, otherwise a
    // concurrent setStatus(quarantined) gets stomped by the next
    // snapshot's higher-seq entry. Manual decisions (setStatus +1) always
    // dominate; snapshots tie on seq and lose to any newer setStatus.
    const prior = readLatestStatus().get(rule.rule_id);
    const seq = (prior?.status_seq || 0);  // observe — do NOT bump
    const elig = quarantineEligible(rule);
    let status = prior?.status || 'active';
    let statusReason = prior?.status_reason || null;
    let statusChangedAt = prior?.status_changed_at || now;
    let scoringEpochStartTs = prior?.scoring_epoch_start_ts || null;
    // If this is a fresh observation that crossed the threshold AND the
    // rule isn't already quarantined, flag it. The actual quarantine
    // (status flip + writing a quarantined-status entry) is the rule-tune
    // CLI's job — snapshot() is observation, not policy.
    if (elig.eligible && status === 'active') {
      status = 'flagged';
      statusReason = `auto-flagged: ${elig.reason}`;
      statusChangedAt = now;
    }
    const entry = {
      ts: now,
      rule_id: rule.rule_id,
      kind: 'snapshot',
      fires: rule.fires,
      unscorable: rule.unscorable,
      proceeded: rule.proceeded,
      recalled: rule.recalled,
      undone: rule.undone,
      rerouted: rule.rerouted,
      stopped: rule.stopped,
      success_rate: rule.success_rate,
      ci_lower: rule.ci_lower,
      last_50_window_rate: rule.last_50_window_rate,
      status,
      status_reason: statusReason,
      status_changed_at: statusChangedAt,
      status_seq: seq,
      rule_content_hash: rule.rule_content_hash || null,
      scoring_epoch_start_ts: scoringEpochStartTs,
      snapshot_reason: reason,
    };
    jsonl().appendJsonlLine(file, entry);
    written.push(entry);
  }
  return written;
}

// Read the latest status entry per rule_id.
//   - dedup by rule_id; tiebreaker max(status_seq); on equal seq, latest ts.
// C-11: live file only by default.
function readLatestStatus({ allHistory = false } = {}) {
  const file = _effectivenessFile();
  if (!fs.existsSync(file)) return new Map();
  let raw;
  if (allHistory) {
    raw = jsonl().readMergedJsonl(file, { includeBaks: true });
  } else {
    raw = jsonl().readMergedJsonl(file, { includeBaks: false });
  }
  const byRule = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    if (!e || !e.rule_id) continue;
    const prior = byRule.get(e.rule_id);
    if (!prior) { byRule.set(e.rule_id, e); continue; }
    if ((e.status_seq || 0) > (prior.status_seq || 0)) {
      byRule.set(e.rule_id, e);
    } else if ((e.status_seq || 0) === (prior.status_seq || 0) && (e.ts || '') >= (prior.ts || '')) {
      byRule.set(e.rule_id, e);
    }
  }
  return byRule;
}

// ─── Status change writer ───────────────────────────────────────────
//
// Used by the rule-tune CLI to persist quarantine / rehabilitate
// decisions. Distinct from snapshot() in two ways:
//   - kind: 'status_change' (vs 'snapshot') — soak report can filter
//     human-driven changes from auto-flagging observations.
//   - On rehabilitate, scoring_epoch_start_ts is reset to `now` (C-5)
//     so subsequent scoring ignores pre-rehab fires.
//
// Returns the entry written (for tests / CLI confirm output). Throws
// on an unknown status. The caller is responsible for confirming
// rule_id exists in the corpus — we don't validate that here so the
// CLI can tear-down rules that were removed from the rewriter.
const VALID_STATUSES = Object.freeze(['active', 'flagged', 'quarantined']);
function setStatus(ruleId, newStatus, { reason = null, contentHash = null } = {}) {
  if (!ruleId || typeof ruleId !== 'string') throw new Error('setStatus: rule_id required');
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`setStatus: status must be one of ${VALID_STATUSES.join('|')}, got ${newStatus}`);
  }
  const file = _effectivenessFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const priorStatus = readLatestStatus();
  const prior = priorStatus.get(ruleId);
  const seq = (prior?.status_seq || 0) + 1;
  // On rehabilitate (status flipping back to active from quarantined),
  // open a new scoring epoch so prior fires don't pull the rule back
  // into quarantine immediately. C-5 fix.
  let scoringEpochStartTs = prior?.scoring_epoch_start_ts || null;
  if (newStatus === 'active' && prior?.status === 'quarantined') {
    scoringEpochStartTs = now;
  }
  // If quarantining and no contentHash provided, try to extract from
  // current rewriter source. Required for auto-rehab to work later.
  let resolvedHash = contentHash;
  if (newStatus === 'quarantined' && !resolvedHash) {
    const source = readRewriterSource();
    if (source) {
      const hashes = extractRuleBlockHashes(source);
      resolvedHash = hashes.get(ruleId) || null;
    }
  }
  if (!resolvedHash && prior?.rule_content_hash) {
    resolvedHash = prior.rule_content_hash;
  }
  const entry = {
    ts: now,
    rule_id: ruleId,
    kind: 'status_change',
    status: newStatus,
    status_reason: reason,
    status_changed_at: now,
    status_seq: seq,
    rule_content_hash: resolvedHash || null,
    scoring_epoch_start_ts: scoringEpochStartTs,
    prior_status: prior?.status || null,
  };
  jsonl().appendJsonlLine(file, entry);
  return entry;
}

// Convenience: list of rule_ids currently in `quarantined` status.
function listQuarantined() {
  const status = readLatestStatus();
  const out = [];
  for (const [ruleId, entry] of status) {
    if (entry.status === 'quarantined') out.push(ruleId);
  }
  return out;
}

module.exports = {
  // Public scoring API
  compute,
  scoreRule,
  buildOutcomeMap,
  quarantineEligible,
  snapshot,
  setStatus,
  VALID_STATUSES,
  readLatestStatus,
  listQuarantined,
  extractRuleBlockHashes,
  readRewriterSource,
  // Math helpers (exported for tests)
  wilsonLowerBound,
  // Constants
  QUARANTINE_MIN_FIRES,
  QUARANTINE_CI_THRESHOLD,
  QUARANTINE_WINDOW_THRESHOLD,
  ROLLING_WINDOW_SIZE,
  OUTCOME_WINDOW_MS,
  Z_95,
};
