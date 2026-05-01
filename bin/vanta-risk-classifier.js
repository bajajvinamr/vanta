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
  { rx: /\b(force.?push|reset.?--hard|rm\s+-rf|delete.{0,30}user)\b/i,  score: 1, axis: 'reversibility' },
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
  // We want the WORST (lowest = riskiest) score across all matches.
  // Default 4 (mostly-safe) when no signal hits.
  let worst = 4;
  let why = null;
  for (const s of signalsList) {
    if (s.axis && s.axis !== axisName) continue;
    if (s.rx.test(prompt) && s.score < worst) {
      worst = s.score;
      why = `prompt: "${s.rx.source}"`;
    }
  }
  if (filePath) {
    for (const s of FILE_PATH_SIGNALS) {
      if (s.axis !== axisName) continue;
      if (s.rx.test(filePath) && s.score < worst) {
        worst = s.score;
        why = `file: ${s.rx.source}`;
      }
    }
  }
  return { score: worst, why };
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
  const risk = (6 - reversibility) + (6 - blastRadius);
  if (risk >= 8)  return 'T3';
  if (risk >= 5)  return 'T2';
  if (risk >= 2)  return 'T1';
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
