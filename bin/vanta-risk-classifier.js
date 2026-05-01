#!/usr/bin/env node
// vanta-risk-classifier — pick { tier, decision } for a prompt + context.
//
// The picker is metadata over the prompt, NOT a self-decision by the
// executing model. The hybrid policy:
//
//   1. Deterministic floor (safety-floor.yaml) — wins on conflict.
//      Floor match → ASK + tier T3 (full council).
//   2. 3-axis heuristic score:
//      - reversibility (1 hard / 5 trivial) — based on action class
//      - blast_radius (1 self / 5 prod customer-facing)
//      - product_authority (bool) — product/business call needed
//      Score → tier mapping:
//        score ≥ 12 OR product_authority → T3 (full council, ASK)
//        score 8-11                       → T2 (single peer, AUTO)
//        score 4-7                        → T1 (claude self-review, AUTO)
//        score < 4                        → T0 (skip, AUTO)
//   3. Kill-switch off → T0, decision=auto, no review.
//
// The 3-axis score uses keyword + file-pattern heuristics, NOT an LLM
// call. That keeps the classifier fast (<5ms) and deterministic.
// LLM-based scoring can be wired in later as a refinement layer for
// ambiguous prompts.

const path = require('path');

let _safetyFloor;
function safetyFloor() {
  if (_safetyFloor) return _safetyFloor;
  try { _safetyFloor = require('./vanta-safety-floor'); } catch {}
  return _safetyFloor;
}

let _killSwitch;
function killSwitch() {
  if (_killSwitch) return _killSwitch;
  try { _killSwitch = require('./vanta-kill-switch'); } catch {}
  return _killSwitch;
}

let _peerRouter;
function peerRouter() {
  if (_peerRouter) return _peerRouter;
  try { _peerRouter = require('./vanta-peer-router'); } catch {}
  return _peerRouter;
}

// ─── 3-axis scoring heuristics ───────────────────────────────────────────────
//
// Each axis returns 1-5. We sum then map to tier.

// Reversibility: how easy is it to undo? 1 = irreversible (deleted prod
// data), 5 = trivial (a doc edit that git can revert).
const REVERSIBILITY_SIGNALS = [
  { rx: /\b(deploy|prod|production|migrate|drop\s+table|truncate)\b/i, score: 1, axis: 'reversibility' },
  // R1 P2 (Codex): the `delete.{0,30}user` form was singular — "delete
  // all users from the database" escaped to T1. v3.6.20 widens to plural
  // user(s)/account(s)/customer(s)/record(s) and adds the bare DELETE
  // FROM / DROP DATABASE / wipe-state phrasings.
  { rx: /\b(force.?push|reset.?--hard|rm\s+-rf)\b/i,                     score: 1, axis: 'reversibility' },
  { rx: /\bdelete\b[^.?!\n]{0,40}\b(user|users|account|accounts|customer|customers|record|records|row|rows|database|table)s?\b/i, score: 1, axis: 'reversibility' },
  { rx: /\b(delete\s+from|drop\s+database|wipe|nuke|purge)\b/i,          score: 1, axis: 'reversibility' },
  { rx: /\b(merge|push|publish|release)\b/i,                            score: 2, axis: 'reversibility' },
  { rx: /\b(commit|tag)\b/i,                                            score: 3, axis: 'reversibility' },
  { rx: /\b(refactor|rename|move\s+file)\b/i,                           score: 4, axis: 'reversibility' },
  { rx: /\b(read|show|list|explain|comment|format|lint)\b/i,            score: 5, axis: 'reversibility' },
];

// Blast radius: how many systems / users affected? 1 = global prod,
// 5 = scratch file in tmp.
const BLAST_RADIUS_SIGNALS = [
  { rx: /\b(production|prod|customer|user.?facing|public|launched)\b/i, score: 1, axis: 'blast_radius' },
  { rx: /\b(ddl|schema|migration|api\s+contract|webhook|cron)\b/i,      score: 2, axis: 'blast_radius' },
  { rx: /\b(staging|qa|test\s+env|preview)\b/i,                         score: 3, axis: 'blast_radius' },
  { rx: /\b(local|dev|sandbox|scratch|playground)\b/i,                  score: 5, axis: 'blast_radius' },
];

// Product authority: does the change make a product decision? Only
// the user can make these.
const PRODUCT_AUTHORITY_SIGNALS = [
  /\b(pivot|sunset|kill\s+feature|deprecate|launch|go.?live)\b/i,
  /\b(pricing|business\s+model|gtm|positioning)\b/i,
  /\b(privacy\s+policy|terms\s+of\s+service|gdpr|hipaa|compliance)\b/i,
  /\b(rename.{0,30}feature|rename.{0,30}product|brand)\b/i,
];

// File-path scoring overlays — caller may pass `file_path` in context.
// Some paths are inherently low/high blast-radius regardless of prompt.
const FILE_PATH_SIGNALS = [
  { rx: /\.(test|spec)\.(ts|js|py)$/, axis: 'blast_radius',  score: 5 },
  { rx: /\b__tests__\b|\btests\b/,    axis: 'blast_radius',  score: 5 },
  { rx: /\bmigrations?\b/,            axis: 'reversibility', score: 1 },
  { rx: /\b(api|routes|controllers)\b/, axis: 'blast_radius', score: 2 },
  { rx: /\.md$|^README/,               axis: 'reversibility', score: 5 },
  { rx: /\.(env|pem|key|p12)$/,       axis: 'blast_radius',  score: 1 },
];

function _scoreAxis(prompt, filePath, axisName, signalsList) {
  // Score range: 1 (worst/riskiest) → 5 (safest). Aggregation:
  //   - RISKY signals (score ≤ 4) lower the worst score → take MIN.
  //   - SAFE  signals (score = 5) raise it → take MAX.
  // R1-R2 P1 (Gemini): the original implementation only took MIN, so
  //   safe signals (e.g., README.md → rev=5) had no effect when default
  //   started at 4 — risk floor was 4, T0 unreachable. v3.6.20 splits:
  //   safety markers can confirm-up; risky markers always pull-down.
  let worst = 4;     // default = "mostly safe but no positive signal"
  let safest = 4;    // default = same; max from any explicit safe rule
  let why = null;
  const apply = (s, source) => {
    if (s.axis && s.axis !== axisName) return;
    if (s.score >= 5 && s.score > safest) {
      safest = s.score;
      why = `${source}: "${s.rx.source}" (safe)`;
    } else if (s.score < worst) {
      worst = s.score;
      why = `${source}: "${s.rx.source}" (risky)`;
    }
  };
  for (const s of signalsList) {
    if (s.rx.test(prompt)) apply(s, 'prompt');
  }
  if (filePath) {
    for (const s of FILE_PATH_SIGNALS) {
      if (s.rx.test(filePath)) apply(s, 'file');
    }
  }
  // Risky wins over safe by design (safety bias): if a risky signal hit,
  // ignore the safe override. Otherwise return the highest safe score.
  return { score: worst < 4 ? worst : safest, why };
}


function _hasProductAuthority(prompt) {
  for (const rx of PRODUCT_AUTHORITY_SIGNALS) {
    if (rx.test(prompt)) return { yes: true, rx: rx.source };
  }
  return { yes: false };
}

function _scoreToTier(reversibility, blastRadius, productAuthority) {
  if (productAuthority) return 'T3';
  // Higher score = safer. Convert to risk: 6 - score per axis (1..5).
  // R1-R2 P1 (Gemini): the risk floor is 2 (rev=5 + blast=5 → 1+1).
  // The original `risk >= 2` made T0 unreachable via heuristic. v3.6.20
  // shifts the threshold so risk=2 (the safest reachable state) maps
  // to T0 — restoring the documented "skip auto-execute on truly safe
  // prompts" path. Still requires kill-switch behavior unchanged.
  const risk = (6 - reversibility) + (6 - blastRadius);
  if (risk >= 8)  return 'T3';
  if (risk >= 5)  return 'T2';
  if (risk >= 3)  return 'T1';
  return 'T0';
}

function classify({ prompt, file_path: filePath, command, sessionId, cwd } = {}) {
  // 1. Kill switch — if executor off, T0 + auto, no review.
  const ks = killSwitch();
  if (ks) {
    const c = ks.check({ sessionId, cwd });
    if (c.off) {
      return {
        tier: 'T0',
        decision: 'auto',
        score: { reversibility: 5, blast_radius: 5, product_authority: false },
        risk: 0,
        why: `kill-switch:${c.scope}`,
        peer: null,
        floor_match: null,
      };
    }
  }

  // 2. Safety floor — match wins, returns ASK + T3.
  const sf = safetyFloor();
  let floor = null;
  if (sf) {
    if (prompt) floor = sf.matchPrompt(prompt) || floor;
    if (!floor && command) floor = sf.matchCommand(command) || floor;
    if (!floor && filePath) floor = sf.matchFile(filePath) || floor;
    if (floor) {
      const peer = peerRouter() ? peerRouter().pick({ prompt, file_path: filePath, command }) : null;
      return {
        tier: 'T3',
        decision: 'ask',
        score: { reversibility: 1, blast_radius: 1, product_authority: false },
        risk: 10,
        why: `safety-floor:${floor.id}`,
        peer,
        floor_match: floor,
      };
    }
  }

  // 3. 3-axis heuristic score.
  const reversibility = _scoreAxis(prompt || '', filePath, 'reversibility', REVERSIBILITY_SIGNALS);
  const blastRadius   = _scoreAxis(prompt || '', filePath, 'blast_radius',  BLAST_RADIUS_SIGNALS);
  const product       = _hasProductAuthority(prompt || '');

  const tier = _scoreToTier(reversibility.score, blastRadius.score, product.yes);
  const decision = tier === 'T3' ? 'ask' : 'auto';
  const peer = (tier === 'T2' || tier === 'T3') && peerRouter()
    ? peerRouter().pick({ prompt, file_path: filePath, command })
    : null;

  return {
    tier,
    decision,
    score: {
      reversibility: reversibility.score,
      blast_radius: blastRadius.score,
      product_authority: product.yes,
    },
    risk: (6 - reversibility.score) + (6 - blastRadius.score),
    why: [
      reversibility.why ? `rev=${reversibility.score} (${reversibility.why})` : `rev=${reversibility.score}`,
      blastRadius.why   ? `blast=${blastRadius.score} (${blastRadius.why})`   : `blast=${blastRadius.score}`,
      product.yes       ? `product-authority (${product.rx})`                 : null,
    ].filter(Boolean).join(' · '),
    peer,
    floor_match: null,
  };
}

module.exports = { classify };

// CLI:
//   echo '{"prompt": "fix the auth bug"}' | vanta-risk-classifier
//   vanta-risk-classifier --prompt "ship to prod" --file src/auth.ts
if (require.main === module) {
  const args = process.argv.slice(2);
  const find = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let signals = {
    prompt: find('--prompt'),
    file_path: find('--file'),
    command: find('--command'),
  };
  if (signals.prompt || signals.file_path || signals.command) {
    process.stdout.write(JSON.stringify(classify(signals), null, 2) + '\n');
    process.exit(0);
  }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => stdin += c);
  process.stdin.on('end', () => {
    try { signals = { ...signals, ...JSON.parse(stdin || '{}') }; } catch {}
    process.stdout.write(JSON.stringify(classify(signals), null, 2) + '\n');
  });
}
