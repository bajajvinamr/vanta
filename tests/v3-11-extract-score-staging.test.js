'use strict';
// v3.11 commit 3 — vanta-extract-score --staging flag tests.
//
// Verifies C-3 fix: candidate matched against staging file routes as
// 'staging-duplicate' so the same fix doesn't re-stage from a different
// source on subsequent sync runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { routeCandidate } = require('../bin/vanta-extract-score.js');

// Reference candidate — well-formed invariant with high signal score.
const HQ_TEXT =
  'Cloudflare Pages requires `output: \'export\'` in `next.config`. ' +
  'Server components and API routes do not work on Cloudflare Pages — ' +
  'static export only.';

const STAGING_BULLET_NEAR =
  'Cloudflare Pages requires `output: \'export\'` in next.config. ' +
  'Server components and API routes do not work — static only.';

const GLOBAL_BULLET_DIFFERENT =
  'PixiJS v8: Application.init() is async. v7 sync constructor produces empty canvas.';

test('1. --staging flag accepted; candidate matched against staging returns staging-duplicate', () => {
  const r = routeCandidate(HQ_TEXT, {
    existing: [GLOBAL_BULLET_DIFFERENT],
    staging:  [STAGING_BULLET_NEAR],
  });
  assert.equal(r.route, 'staging-duplicate');
  assert.ok(r.stagingDup, 'stagingDup should be populated with similarity match');
  assert.ok(r.stagingDup.similarity >= 0.8);
});

test('2. --staging absent → existing behavior unchanged (backward-compat)', () => {
  // No staging passed at all
  const r = routeCandidate(HQ_TEXT, {
    existing: [GLOBAL_BULLET_DIFFERENT],
  });
  // Should land in 'auto' or 'staging' based on score, NOT staging-duplicate
  assert.notEqual(r.route, 'staging-duplicate');
  assert.equal(r.stagingDup, null);
});

test('3. candidate hits global → returns update-in-place even with empty staging', () => {
  // Same candidate already exists in global; staging is empty.
  const r = routeCandidate(HQ_TEXT, {
    existing: [STAGING_BULLET_NEAR],   // global match (≥0.8 similarity)
    staging:  [],
  });
  assert.equal(r.route, 'update-in-place');
  assert.ok(r.dup, 'dup populated for global match');
  assert.equal(r.stagingDup, null);
});

test('4. candidate hits BOTH staging AND global → staging-duplicate wins', () => {
  // Edge case: same fix has been promoted to global AND is also pending
  // in staging. Staging-duplicate takes precedence (skip = quietly drop)
  // because re-staging an already-staged item is the noisier outcome.
  const r = routeCandidate(HQ_TEXT, {
    existing: [STAGING_BULLET_NEAR],   // global match
    staging:  [STAGING_BULLET_NEAR],   // staging match too
  });
  assert.equal(r.route, 'staging-duplicate');
  assert.ok(r.dup,        'global dup still detected');
  assert.ok(r.stagingDup, 'staging dup detected');
});
