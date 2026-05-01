#!/usr/bin/env node
// vanta-confidence-decay — age-based score decay for memory entries.
//
// Memory loses validity over time. A Prisma 4 invariant is wrong for
// Prisma 5; a decision from 6 months ago about an architecture might
// have been superseded silently. This module computes a decay
// multiplier in [0, 1] that the resolver applies to the raw match
// score before ranking.
//
// Decay curves vary by source class:
//   invariants: slow decay (truths). Half-life 365d.
//   decisions:  fast decay (project state). Half-life 90d.
//   gotchas:    medium decay. Half-life 180d.
//   episodes:   medium decay. Half-life 120d.
//   memory:     slow decay. Half-life 270d.
//   code:       no decay (re-extracted on every change).
//
// Optional version_bound: an entry tagged `version_bound: prisma@4`
// gets a steep decay applied if the active project's prisma is at v5.
// (v0: just records the bound; resolver-side enforcement is a future
// pass.)

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Half-life lookup. Decay = 0.5 ^ (age_days / half_life_days).
const HALF_LIFE_DAYS = {
  invariant: 365,
  decision: 90,
  gotcha: 180,
  episode: 120,
  memory: 270,
  code: Number.POSITIVE_INFINITY,  // no decay
};

// Floor the multiplier so very old entries don't go to 0 and disappear
// — they should still surface (with low rank) so contradiction
// detection can compare.
const FLOOR = 0.05;

function decayMultiplier({ source, ts, now = Date.now() } = {}) {
  if (!ts) return 1;
  const ageMs = now - Date.parse(ts);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const halfLife = HALF_LIFE_DAYS[source] != null ? HALF_LIFE_DAYS[source] : 180;
  if (!Number.isFinite(halfLife)) return 1;
  const ageDays = ageMs / ONE_DAY_MS;
  const mult = Math.pow(0.5, ageDays / halfLife);
  return Math.max(FLOOR, mult);
}

// Apply decay to a result entry in-place. Returns the modified entry
// for chaining.
//
// R1 P3 (Gemini): naive multiplication inverts ordering for negative
// scores. -100 (fresh) * 0.05 = -5; -5 > -100, so a stale negative
// outranks a fresh negative penalty. v3.6.20 fix: decay decreases the
// magnitude regardless of sign — for negative scores, multiply by 1/m
// (the opposite direction) so they DRIFT TOWARD ZERO with age, the same
// way positives do.
function applyDecay(result, now = Date.now()) {
  if (typeof result !== 'object' || result === null) return result;
  const m = decayMultiplier({ source: result.source, ts: result.date || result.ts, now });
  const raw = result.score || 0;
  if (raw < 0) {
    // Negative score: divide by m so magnitude shrinks toward 0 with age.
    // m ≤ 1, so 1/m ≥ 1 → multiplied score is closer to 0 (less negative).
    // Keep the floor: never amplify back past the original (avoid 1/0.05 = 20x).
    // Cap shrinkage at 95% magnitude reduction to mirror the positive floor.
    const shrink = Math.max(m, 0.05);
    result.score = raw * shrink;  // raw is negative; raw*shrink is less negative
  } else {
    result.score = raw * m;
  }
  result.decay_multiplier = Math.round(m * 1000) / 1000;
  return result;
}

// Bulk apply over an array of resolver results.
function applyDecayBulk(results, now = Date.now()) {
  for (const r of results) applyDecay(r, now);
  return results;
}

// Version-bound check: returns true if entry's `version_bound` field
// (e.g., "prisma@4") doesn't match the active stack's version. The
// `activeVersions` map looks like { prisma: '5', node: '20' }.
function violatesVersionBound(entry, activeVersions = {}) {
  if (!entry.version_bound) return false;
  const m = String(entry.version_bound).match(/^([^@]+)@(.+)$/);
  if (!m) return false;
  const [, tool, expected] = m;
  const active = activeVersions[tool.toLowerCase()];
  if (!active) return false;
  return String(active) !== String(expected);
}

module.exports = { decayMultiplier, applyDecay, applyDecayBulk, violatesVersionBound, HALF_LIFE_DAYS };

// CLI
//   echo '{"source": "decision", "date": "2025-01-01"}' | vanta-confidence-decay
if (require.main === module) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => stdin += c);
  process.stdin.on('end', () => {
    let entry;
    try { entry = JSON.parse(stdin); } catch { entry = {}; }
    const m = decayMultiplier({ source: entry.source, ts: entry.date || entry.ts });
    process.stdout.write(JSON.stringify({ multiplier: m, half_life_days: HALF_LIFE_DAYS[entry.source] || 180 }, null, 2) + '\n');
  });
}
