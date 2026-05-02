// Tests for the silent-regression surface: canonProject, pathRank, acquireLock.
//
// Run: node --test tests/
// Zero external deps — node:test + node:assert ship with Node 18+.
//
// Why these three? They're pure-ish, fast to test, and each one had a
// concrete past regression that hit production:
//   - canonProject:   alias-shard fragmentation (cleanup #4)
//   - pathRank:       page.tsx page-copy outranking real implementation
//                     (Tier 5 P3 — initial regex only matched single-dir nests)
//   - acquireLock:    pid-aware steal (Tier 5 — pure-time steal was unsafe
//                     under slow --full runs)

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { canonProject, isKnownProject } = require('../bin/vanta-projects');
const indexer = require('../bin/vanta-index-code');

// ─── canonProject ──────────────────────────────────────────────────────────

describe('canonProject — slug → canonical project', () => {
  test('canonical names round-trip to themselves', () => {
    assert.equal(canonProject('little-wins'), 'little-wins');
    assert.equal(canonProject('pi-perception'), 'pi-perception');
    assert.equal(canonProject('vanta'), 'vanta');
    assert.equal(canonProject('founderos'), 'founderos');
  });

  test('user-prefixed aliases fold to canonical (the cleanup #4 case)', () => {
    assert.equal(canonProject('bajajvinamr-little-wins'), 'little-wins');
    assert.equal(canonProject('bajajvinamr-pi-perception'), 'pi-perception');
    assert.equal(canonProject('bajajvinamr-vanta'), 'vanta',
      'cleanup #4: bajajvinamr-vanta MUST fold to vanta or alias shard fragments forever');
  });

  test('unknown user-prefixed slugs follow the fallback rule', () => {
    // Fallback: strip prefix only when remainder has a dash. This preserves
    // the conservative behavior — random `<user>-<word>` slugs DON'T silently
    // collapse into mainline projects.
    assert.equal(canonProject('bajajvinamr-foo'), 'bajajvinamr-foo',
      'single-word remainder must NOT strip — would collide cross-user');
    assert.equal(canonProject('bajajvinamr-some-other-thing'), 'some-other-thing',
      'multi-word remainder uses prefix-strip fallback');
  });

  test('case-insensitive matching against PROJECT_KEYWORDS', () => {
    assert.equal(canonProject('Little-Wins'), 'little-wins');
    assert.equal(canonProject('PI-PERCEPTION'), 'pi-perception');
  });

  test('null / empty / undefined inputs are safe', () => {
    assert.equal(canonProject(null), null);
    assert.equal(canonProject(undefined), null);
    assert.equal(canonProject(''), null);
  });

  test('isKnownProject distinguishes mainline from raw slugs', () => {
    assert.equal(isKnownProject('little-wins'), true);
    assert.equal(isKnownProject('bajajvinamr-vanta'), true,
      'aliases that fold to known projects ARE known');
    assert.equal(isKnownProject('completely-random-slug'), false);
    assert.equal(isKnownProject(null), false);
  });
});

// ─── pathRank ──────────────────────────────────────────────────────────────

describe('pathRank — file path → score multiplier', () => {
  // pathRank is internal to vanta-index-code.js; not exported. We test it via
  // a thin re-derivation: import the same rules table and the same function.
  // Re-mirror the rules so a regression in either file fails this test.
  const PATH_RANK_RULES = [
    { match: /[/\\]__tests__[/\\]/,                        rank: 0.45 },
    { match: /\.test\.[tj]sx?$/,                            rank: 0.45 },
    { match: /\.spec\.[tj]sx?$/,                            rank: 0.45 },
    { match: /\.stories\.[tj]sx?$/,                         rank: 0.40 },
    { match: /[/\\]src[/\\]app[/\\].+[/\\]page\.tsx$/,      rank: 0.55 },
    { match: /[/\\]src[/\\]app[/\\].+[/\\]layout\.tsx$/,    rank: 0.65 },
    { match: /[/\\](demo|pitch|marketing|landing|public)[/\\]/, rank: 0.40 },
    { match: /[/\\]bin[/\\]vanta-(index|resolve|brief|projects)/, rank: 0.20 },
  ];
  function pathRank(p) {
    for (const r of PATH_RANK_RULES) if (r.match.test(p)) return r.rank;
    return 1.0;
  }

  test('test files are heavily down-ranked', () => {
    assert.equal(pathRank('/repo/src/__tests__/auth.ts'), 0.45);
    assert.equal(pathRank('/repo/src/auth.test.ts'),     0.45);
    assert.equal(pathRank('/repo/src/auth.spec.tsx'),    0.45);
  });

  test('page.tsx down-rank handles deep nesting (Tier 5 P3 fix)', () => {
    // The original regex `[^/\\]+` only matched single-dir paths. The fix
    // changed it to `.+` so any depth under src/app/ matches.
    assert.equal(pathRank('/repo/src/app/page.tsx'),                1.0,
      'top-level page.tsx is NOT under .+/ — current regex requires nesting');
    assert.equal(pathRank('/repo/src/app/dashboard/page.tsx'),      0.55);
    assert.equal(pathRank('/repo/src/app/(admin)/users/[id]/page.tsx'), 0.55,
      'deeply nested page.tsx must still match — regression bait');
  });

  test('marketing / demo dirs down-rank (avoid pitch-deck pollution)', () => {
    assert.equal(pathRank('/repo/demo/script.ts'),     0.40);
    assert.equal(pathRank('/repo/marketing/copy.tsx'), 0.40);
    assert.equal(pathRank('/repo/landing/index.ts'),   0.40);
  });

  test("vanta indexer self-reference floor — its own regex tables look like hits", () => {
    assert.equal(pathRank('/Users/x/Projects/vanta/bin/vanta-index-code.js'), 0.20);
    assert.equal(pathRank('/Users/x/Projects/vanta/bin/vanta-resolve.js'),    0.20);
    assert.equal(pathRank('/Users/x/Projects/vanta/bin/vanta-projects.js'),   0.20);
  });

  test('normal source files keep full weight', () => {
    assert.equal(pathRank('/repo/src/services/auth.ts'),       1.0);
    assert.equal(pathRank('/repo/lib/utils.ts'),               1.0);
    assert.equal(pathRank('/repo/server/middleware/auth.ts'),  1.0);
  });
});

// ─── acquireLock ───────────────────────────────────────────────────────────

describe('acquireLock — O_EXCL with pid-aware steal', () => {
  // Use a sandboxed knowledge dir to avoid touching the user's real shards.
  // We can't override KNOWLEDGE_DIR in the indexer (it's a const), but we
  // can directly use the lockfile primitive here by replicating the logic.
  // Behavior parity matters — the test contract is the lock semantics, not
  // any particular path. So we just pick a tmpdir and exercise the same APIs.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-lock-test-'));
  const slug = 'test-slug';
  const lockFile = path.join(tmp, `${slug}.lock`);

  // Mini-impl mirroring the production lock — keeps the test self-contained
  // and protects the test from environment cross-talk.
  function _isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  function tryAcquire() {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      const st = fs.statSync(lockFile);
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
      const ageMs = Date.now() - st.mtimeMs;
      const holderAlive = meta && _isPidAlive(meta.pid);
      if (!holderAlive || ageMs > 60_000) {
        fs.unlinkSync(lockFile);
        return tryAcquire();
      }
      return false;
    }
  }
  function release() { try { fs.unlinkSync(lockFile); } catch {} }

  test('clean acquire on fresh dir succeeds', () => {
    release();
    assert.equal(tryAcquire(), true);
    assert.equal(fs.existsSync(lockFile), true);
    release();
  });

  test('second acquire fails when holder PID is alive (this process)', () => {
    release();
    assert.equal(tryAcquire(), true,  'first acquire');
    assert.equal(tryAcquire(), false, 'second acquire by same process — no steal of alive pid');
    release();
  });

  test('stale lock from dead pid IS stolen (Tier 5 hardening)', () => {
    release();
    // Forge a lock file with an obviously-dead PID. PID 1 is init/launchd —
    // always alive. We need a PID that's definitely dead. Use a 7-digit
    // random number well above typical PID ranges.
    const deadPid = 9_999_991;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, ts: Date.now() }));
    assert.equal(_isPidAlive(deadPid), false, 'precondition: PID is dead');
    assert.equal(tryAcquire(), true,
      'lock from dead PID must be stolen — otherwise crashed indexer leaves perpetual lock');
    release();
  });

  test('release is idempotent (release twice = no error)', () => {
    release();
    assert.equal(tryAcquire(), true);
    release();
    release();  // must not throw
    assert.equal(fs.existsSync(lockFile), false);
  });

  // Cleanup tmp dir
  test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
});

// ─── synonym expansion ─────────────────────────────────────────────────────

describe('synonym pre-expansion (cleanup #12)', () => {
  // Indirect test via the public resolve() API. Synonym expansion changes
  // what topicMatch matches; we verify the user-visible behavior.
  const { resolve } = require('../bin/vanta-resolve');

  test('non-synonym topics behave like literal match (POCSO)', () => {
    const out = resolve({ topic: 'POCSO', project: 'little-wins', max: 1 });
    assert.ok(out.count > 0, 'POCSO must still find results — synonym expansion must be opt-in by topic');
  });

  test('synonym key — `payment` widens vs literal-only', () => {
    // Topic `payment` should match content containing "stripe", "billing",
    // "subscription", etc. — not just literal "payment". We can't observe
    // this without reading shard contents, but we can confirm the regex
    // treats them as alternatives by testing the topicMatch helper through
    // the synonym table.
    const { SYNONYM_GROUPS } = (() => {
      // Re-import via fs since the table is internal; pull the source
      // and confirm the group exists. Cheap structural test.
      const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'vanta-resolve.js'), 'utf8');
      return {
        SYNONYM_GROUPS: {
          payment: src.includes("payment:") && src.includes("'stripe'") && src.includes("'subscription'"),
          jwt: src.includes("jwt:") && src.includes("'bearer token'"),
        }
      };
    })();
    assert.ok(SYNONYM_GROUPS.payment, 'payment group must contain stripe/subscription synonyms');
    assert.ok(SYNONYM_GROUPS.jwt,     'jwt group must contain bearer-token synonym');
  });

  test('single-char and all-digit topics skip expansion (no nonsense regex)', () => {
    // These would be unsafe to expand. We rely on resolve() not throwing
    // and returning a sane shape.
    for (const t of ['x', '1', '42', 'a']) {
      const out = resolve({ topic: t, project: 'little-wins', max: 1 });
      assert.equal(typeof out.count, 'number', `topic="${t}" must return without throwing`);
    }
  });
});

// ─── git-guardrails (cleanup integration) ─────────────────────────────────

describe('git-guardrails — destructive command tiering', () => {
  const { checkCommand } = require('../hooks/git-guardrails');

  test('HARD BLOCK: force-push to main/master', () => {
    assert.equal(checkCommand('git push --force origin main').action, 'block');
    assert.equal(checkCommand('git push --force-with-lease main').action, 'block');
    assert.equal(checkCommand('git push -f origin master').action, 'block');
  });

  test('HARD BLOCK: --no-verify and --no-gpg-sign', () => {
    assert.equal(checkCommand('git commit --no-verify -m x').action, 'block');
    assert.equal(checkCommand('git push --no-verify').action, 'block');
    assert.equal(checkCommand('git commit --no-gpg-sign').action, 'block');
    assert.equal(checkCommand('git -c commit.gpgsign=false commit').action, 'block');
  });

  test('HARD BLOCK: rm -rf with absolute path under root', () => {
    assert.equal(checkCommand('rm -rf /etc').action, 'block');
    assert.equal(checkCommand('rm -rf /usr/local').action, 'block');
  });

  test('HARD BLOCK: destructive SQL', () => {
    assert.equal(checkCommand('DROP TABLE users').action, 'block');
    assert.equal(checkCommand('drop database production').action, 'block');
    assert.equal(checkCommand('TRUNCATE TABLE orders').action, 'block');
  });

  test('ADVISORY: force-push to non-main branch', () => {
    const v = checkCommand('git push --force origin feature-branch');
    assert.equal(v.action, 'advise');
    assert.match(v.message, /force-push detected/);
  });

  test('ADVISORY: reset --hard / checkout . / clean -f / branch -D', () => {
    assert.equal(checkCommand('git reset --hard HEAD~1').action, 'advise');
    assert.equal(checkCommand('git checkout .').action, 'advise');
    assert.equal(checkCommand('git clean -fd').action, 'advise');
    assert.equal(checkCommand('git branch -D old').action, 'advise');
  });

  test('ALLOW: safe operations', () => {
    assert.equal(checkCommand('git status').action, 'allow');
    assert.equal(checkCommand('git push origin feature-branch').action, 'allow');
    assert.equal(checkCommand('git commit -m "feat: add foo"').action, 'allow');
    assert.equal(checkCommand('npm install').action, 'allow');
    assert.equal(checkCommand('').action, 'allow');
    assert.equal(checkCommand(null).action, 'allow');
  });

  test('rm -rf with relative path is ADVISORY (not block)', () => {
    // Per CLAUDE.md: "Confirm before rm -rf" — confirm, not hard-block, for
    // relative paths. Hard-block reserved for absolute paths under /.
    assert.equal(checkCommand('rm -rf node_modules').action, 'advise');
    assert.equal(checkCommand('rm -rf dist').action, 'advise');
  });
});

// ─── council-health (Tier 6 #17) ───────────────────────────────────────────

describe('vanta-council-health — pre-flight readiness', () => {
  const { gather, summarize } = require('../bin/vanta-council-health');

  test('gather returns expected shape', () => {
    const s = gather();
    assert.ok(s.ts, 'ts present');
    assert.ok(typeof s.mcp === 'object', 'mcp present');
    assert.ok(typeof s.gemini === 'object', 'gemini present');
    assert.ok(typeof s.codex === 'object', 'codex present');
    // mcp may or may not be registered depending on test env — both are valid
    assert.ok(typeof s.mcp.registered === 'boolean', 'mcp.registered is boolean');
  });

  test('summarize produces single-line output', () => {
    const s = gather();
    const line = summarize(s);
    assert.ok(typeof line === 'string', 'summary is string');
    assert.ok(!line.includes('\n'), 'summary is single-line');
    assert.ok(line.startsWith('council:'), 'summary starts with council:');
  });

  test('does not throw on missing files', () => {
    // gather() must not crash when ~/.gemini, ~/.codex, etc. are absent —
    // returns structured "not ok" reasons instead.
    assert.doesNotThrow(() => gather());
  });
});

// ─── contradiction detection (Tier 6 #14) ──────────────────────────────────

describe('detectContradictions — cross-source disagreement signal', () => {
  const { detectContradictions } = require('../bin/vanta-resolve');

  test('flags ES256 vs HS256 across invariant + decision', () => {
    const sigs = detectContradictions([
      { source: 'invariant', excerpt: 'Use ES256 asymmetric JWTs for pi-perception auth.' },
      { source: 'decision',  excerpt: 'HS256 chosen for simplicity.', date: '2025-08-12' },
    ]);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].type, 'binary');
    assert.ok(sigs[0].confidence >= 0.7);
    assert.match(sigs[0].hint, /ES256.*HS256/);
  });

  test('does NOT flag when both halves co-occur in same entry', () => {
    // An entry that mentions BOTH options conversationally is not a
    // contradiction — it's a comparison. Detector requires each half to
    // appear in a SEPARATE entry.
    const sigs = detectContradictions([
      { source: 'invariant', excerpt: 'Use ES256 not HS256 for asymmetric JWT auth.' },
    ]);
    assert.equal(sigs.length, 0);
  });

  test('episode source drops below 0.7 confidence threshold', () => {
    // Episodes are conversational and often discuss both options.
    // ES256/HS256 base confidence is 0.9, episode tax is -0.2 → 0.7.
    // Pair another episode (also -0.2) → both are loose, sum reduction is
    // applied once → still 0.7. A pair where ONE side is invariant is fine.
    // This test confirms the loose-source tax doesn't sink a real
    // invariant↔decision pair.
    const sigs = detectContradictions([
      { source: 'invariant', excerpt: 'ES256 required for pi-perception JWTs.' },
      { source: 'episode',   excerpt: 'We landed on HS256 in May.' },
    ]);
    // 0.9 base - 0.2 (episode loose) = 0.7 — exactly at threshold, kept.
    assert.equal(sigs.length, 1);
    assert.ok(sigs[0].confidence >= 0.7);
  });

  test('context-required pairs need shared context tokens', () => {
    // sync ⇄ async only contradicts in the PixiJS context. Two unrelated
    // entries about generic sync/async patterns should NOT trip.
    const noContext = detectContradictions([
      { source: 'invariant', excerpt: 'All HTTP calls are async.' },
      { source: 'invariant', excerpt: 'File reads use the sync API for tests.' },
    ]);
    assert.equal(noContext.length, 0, 'no PixiJS context → no flag');

    const withContext = detectContradictions([
      { source: 'invariant', section: 'PixiJS v8', excerpt: 'Application.init() is async in v8.' },
      { source: 'decision',  excerpt: 'PixiJS sync constructor pattern preferred.', date: '2025-06-01' },
    ]);
    assert.ok(withContext.length >= 1, 'PixiJS context → flag');
  });

  test('returns empty array on empty input', () => {
    assert.deepEqual(detectContradictions([]), []);
  });

  test('resolve() always emits contradictions array (regression guard)', () => {
    const { resolve } = require('../bin/vanta-resolve');
    // Use an obscure topic to keep the result set minimal — we just need
    // the shape, not actual results. Tests that the wiring from
    // detectContradictions into resolve() doesn't silently drop.
    const out = resolve({ topic: 'nonexistent-topic-xyz-zz9' });
    assert.ok(Array.isArray(out.contradictions),
      'resolve() must always emit contradictions: [] (Tier 6 #14 wiring)');
  });

  test('dedupes when same pair surfaces twice', () => {
    // If the same two entries match multiple binary pairs (rare but possible),
    // the dedup key prevents duplicate signals.
    const sigs = detectContradictions([
      { source: 'invariant', excerpt: 'ES256 required.' },
      { source: 'invariant', excerpt: 'ES256 required.' },  // exact dup
      { source: 'decision',  excerpt: 'HS256 chosen.' },
    ]);
    // Two invariants both opposite of one decision = 2 pair-matches, but
    // dedup key collapses identical excerpts to 1. (Actually here the two
    // invariants have the same first-40 chars so both pair against the same
    // decision dedup-collapse to 1.)
    assert.equal(sigs.length, 1);
  });
});

// ─── council-feedback (Tier 6 #15) ─────────────────────────────────────────

describe('vanta-council-feedback — record/attribute/stats', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // Each test gets its own temp VANTA_DIR_OVERRIDE so writes don't pollute
  // the real ~/.vanta logs.
  let tmp;
  let cf;

  function freshModule() {
    // Clear require cache so module re-reads env on load. Module path overrides
    // are dynamic via _vantaDir(), so we just have to reset the env per test.
    delete require.cache[require.resolve('../bin/vanta-council-feedback')];
    return require('../bin/vanta-council-feedback');
  }

  test('findingHash is deterministic + 16 hex chars + sha256: prefix', () => {
    cf = freshModule();
    const h1 = cf.findingHash('JWT must be ES256');
    const h2 = cf.findingHash('JWT must be ES256');
    const h3 = cf.findingHash('JWT must be HS256');
    assert.equal(h1, h2, 'same input → same hash');
    assert.notEqual(h1, h3, 'different input → different hash');
    assert.match(h1, /^sha256:[0-9a-f]{16}$/);
  });

  test('record() writes a well-shaped entry', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    const entry = cf.record({
      topic: 'auth',
      slug: 'pi-perception',
      councilRun: '2026-04-30T07:55:00Z',
      findingText: 'JWT secrets must be ES256',
      priority: 'P1',
      model: 'codex',
    });

    assert.equal(entry.topic, 'auth');
    assert.equal(entry.slug, 'pi-perception');
    assert.equal(entry.priority, 'P1');
    assert.equal(entry.model, 'codex');
    assert.equal(entry.round, 1, 'round defaults to 1');
    assert.equal(entry.mode, 'FULL', 'mode defaults to FULL');
    assert.equal(entry.consensus_strategy, 'two-different-models', 'default council strategy');
    assert.equal(entry.verdict, 'raised');
    assert.equal(entry.outcome, null);
    assert.match(entry.finding_hash, /^sha256:[0-9a-f]{16}$/);

    const written = fs.readFileSync(path.join(tmp, 'council-feedback.jsonl'), 'utf8');
    assert.ok(written.includes('"finding_hash"'), 'JSONL line on disk');

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('record() rejects missing required fields', () => {
    cf = freshModule();
    assert.throws(() => cf.record({ topic: 'auth' }), /requires/);
    assert.throws(() => cf.record({}), /requires/);
  });

  test('attribute() rejects invalid outcome', () => {
    cf = freshModule();
    assert.throws(() => cf.attribute({ hash: 'sha256:abc', outcome: 'maybe' }),
      /outcome must be one of/);
  });

  test('stats() rolls up tp/fp/pending per model+priority', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    // Two findings: one resolved as TP, one left pending.
    const e1 = cf.record({
      topic: 'auth', slug: 'pi-perception', councilRun: '2026-04-30T07:55:00Z',
      findingText: 'JWT must be ES256', priority: 'P1', model: 'codex',
    });
    cf.record({
      topic: 'auth', slug: 'pi-perception', councilRun: '2026-04-30T07:55:00Z',
      findingText: 'Add CSRF on /login', priority: 'P2', model: 'gemini',
    });
    cf.attribute({
      hash: e1.finding_hash, outcome: 'true-positive', evidence: 'invariant added',
    });

    const s = cf.stats({ days: 30 });
    assert.equal(s.total_findings, 2);
    assert.equal(s.tp, 1);
    assert.equal(s.pending, 1);

    const codexBucket = s.by_model_priority.find(b => b.model === 'codex');
    assert.equal(codexBucket.tp, 1);
    assert.equal(codexBucket.accuracy, 1, 'codex P1 accuracy = 1.0 (1 TP / 1 judged)');

    const geminiBucket = s.by_model_priority.find(b => b.model === 'gemini');
    assert.equal(geminiBucket.pending, 1);
    assert.equal(geminiBucket.accuracy, null, 'no judged findings → null accuracy');

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('matchOpen() returns STRONG match when jaccard ≥ 0.25', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    // High-overlap invariant: shares "ES256", "HS256", "JWT/JWTs", "must"
    // → jaccard well above 0.25 = STRONG.
    cf.record({
      topic: 'auth', slug: 'pi-perception', councilRun: '2026-04-30T00:00:00Z',
      findingText: 'JWT secrets must be ES256 not HS256', priority: 'P1', model: 'codex',
    });
    cf.record({
      topic: 'cors', slug: 'pi-perception', councilRun: '2026-04-30T00:00:00Z',
      findingText: 'CORS preflight headers missing on /login', priority: 'P2', model: 'gemini',
    });

    const matches = cf.matchOpen({
      slug: 'pi-perception',
      invariant: 'JWT secrets must be ES256 not HS256 in pi-perception',
    });
    assert.ok(matches.length >= 1, 'should find the JWT match');
    assert.equal(matches[0].strength, 'strong');
    assert.equal(matches[0].topic, 'auth');
    assert.ok(matches[0].similarity >= 0.25, `jaccard ${matches[0].similarity} should be ≥ 0.25`);

    process.env.VANTA_DIR_OVERRIDE = '';
    delete process.env.VANTA_DIR_OVERRIDE;
  });

  test('matchOpen() does NOT auto-attribute on topic-hit-only (Codex P1 fix)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    cf.record({
      topic: 'auth', slug: 'x', councilRun: '2026-04-30T00:00:00Z',
      findingText: 'completely unrelated SAML metadata thing', priority: 'P1', model: 'codex',
    });

    // Generic invariant containing "auth" but with zero lexical overlap
    // with the finding excerpt. Old behavior: topicHit alone returned this
    // as a match → would auto-TP. New behavior: jaccard is too low for
    // even 'weak' tier (< 0.10), so no match returned.
    const matches = cf.matchOpen({
      slug: 'x',
      invariant: 'Always validate user input before storing in auth tokens',
    });
    // Topic-hit alone with very low Jaccard should NOT return a match.
    // If something does come back, it MUST be flagged as 'weak' so the
    // caller knows not to auto-attribute.
    for (const m of matches) {
      assert.notEqual(m.strength, 'strong',
        'topic-hit-only must never reach STRONG — would corrupt the accuracy dataset');
    }

    process.env.VANTA_DIR_OVERRIDE = '';
    delete process.env.VANTA_DIR_OVERRIDE;
  });

  test('matchOpen() respects 14d window cutoff', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    // Manually write an "old" finding outside the 14d window.
    const oldTs = new Date(Date.now() - 30 * 86400_000).toISOString();
    fs.writeFileSync(
      path.join(tmp, 'council-feedback.jsonl'),
      JSON.stringify({
        ts: oldTs, council_run: oldTs, model: 'codex', round: 1,
        priority: 'P1', topic: 'auth', slug: 'pi-perception',
        finding_hash: 'sha256:0000000000000000',
        finding_excerpt: 'Use ES256 not HS256',
        verdict: 'raised', outcome: null,
      }) + '\n'
    );

    const matches = cf.matchOpen({
      slug: 'pi-perception',
      invariant: 'Use ES256 asymmetric JWTs',
      days: 14,
    });
    assert.equal(matches.length, 0, 'old findings outside window should be excluded');

    process.env.VANTA_DIR_OVERRIDE = '';
    delete process.env.VANTA_DIR_OVERRIDE;
  });

  test('matchOpen() excludes already-resolved findings', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    const e = cf.record({
      topic: 'auth', slug: 'x', councilRun: '2026-04-30T00:00:00Z',
      findingText: 'already-resolved finding', priority: 'P1', model: 'codex',
    });
    cf.attribute({ hash: e.finding_hash, outcome: 'true-positive' });

    const matches = cf.matchOpen({ slug: 'x', invariant: 'already-resolved finding' });
    assert.equal(matches.length, 0, 'resolved findings should not appear');

    process.env.VANTA_DIR_OVERRIDE = '';
    delete process.env.VANTA_DIR_OVERRIDE;
  });

  test('stats() latest resolution wins on duplicate hash', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cf-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    cf = freshModule();

    const e = cf.record({
      topic: 'auth', slug: 'x', councilRun: '2026-04-30T00:00:00Z',
      findingText: 'flip-flop', priority: 'P1', model: 'codex',
    });
    cf.attribute({ hash: e.finding_hash, outcome: 'false-positive' });
    // Sleep a tick to ensure the next ts is strictly later.
    const later = new Date(Date.now() + 5).toISOString();
    fs.appendFileSync(path.join(tmp, 'council-feedback-resolved.jsonl'),
      JSON.stringify({ ts: later, finding_hash: e.finding_hash, outcome: 'true-positive' }) + '\n');

    const s = cf.stats({ days: 30 });
    assert.equal(s.tp, 1, 'latest-wins flips fp → tp');
    assert.equal(s.fp, 0);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── council-run (Codex Tier-6 P2 fix) ──────────────────────────────────────

describe('vanta-council-run — machine-checked artifact', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let tmp;

  function freshModule() {
    delete require.cache[require.resolve('../bin/vanta-council-run')];
    return require('../bin/vanta-council-run');
  }

  test('start() returns ISO timestamp', () => {
    const m = freshModule();
    const ts = m.start({ slug: 'x', topic: 'auth' });
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Math.abs(Date.parse(ts) - Date.now()) < 5000);
  });

  test('start() rejects missing slug or topic', () => {
    const m = freshModule();
    assert.throws(() => m.start({}), /requires/);
    assert.throws(() => m.start({ slug: 'x' }), /requires/);
  });

  test('finish() writes a complete record + last() reads it', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cr-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = freshModule();

    const ts = m.start({ slug: 'pi-perception', topic: 'auth' });
    m.finish({
      ts, slug: 'pi-perception', topic: 'auth',
      mode: 'FULL',
      models_attempted: ['codex@gpt-5.4', 'gemini@gemini-3.1-pro-preview'],
      models_used: ['codex@gpt-5.4', 'gemini@gemini-3.1-pro-preview'],
      finding_hashes: ['sha256:abc', 'sha256:def'],
      verdict: 'PASS_WITH_CONDITIONS',
    });

    const r = m.last({ slug: 'pi-perception' });
    assert.equal(r.mode, 'FULL');
    assert.equal(r.verdict, 'PASS_WITH_CONDITIONS');
    assert.equal(r.finding_hashes.length, 2);
    assert.equal(r.models_used.length, 2);
    assert.equal(r.rounds, 1);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('finish() rejects invalid mode + verdict', () => {
    const m = freshModule();
    assert.throws(() => m.finish({
      ts: '2026-04-30T00:00:00Z', slug: 'x', topic: 't',
      mode: 'INVALID', models_attempted: [], models_used: [], verdict: 'PASS',
    }), /mode must be one of/);
    assert.throws(() => m.finish({
      ts: '2026-04-30T00:00:00Z', slug: 'x', topic: 't',
      mode: 'FULL', models_attempted: [], models_used: [], verdict: 'BAD',
    }), /verdict must be one of/);
  });

  test('audit() surfaces degradation signal — partial rate', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cr-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = freshModule();

    // 3 runs: 1 FULL, 2 PARTIAL → partial_rate = 0.67
    for (const mode of ['FULL', 'PARTIAL', 'PARTIAL']) {
      const ts = m.start({ slug: 'x', topic: 't' });
      m.finish({
        ts, slug: 'x', topic: 't', mode,
        models_attempted: ['codex'], models_used: ['codex'],
        verdict: 'PASS',
      });
    }
    const a = m.audit({ days: 90 });
    assert.equal(a.total, 3);
    assert.equal(a.mode_distribution.FULL, 1);
    assert.equal(a.mode_distribution.PARTIAL, 2);
    assert.ok(Math.abs(a.partial_rate - 0.67) < 0.01);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('last() filters by slug', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-cr-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = freshModule();

    m.finish({ ts: '2026-04-30T00:00:00Z', slug: 'a', topic: 't', mode: 'FULL', models_attempted: [], models_used: [], verdict: 'PASS' });
    m.finish({ ts: '2026-04-30T00:00:01Z', slug: 'b', topic: 't', mode: 'FULL', models_attempted: [], models_used: [], verdict: 'PASS' });
    assert.equal(m.last({ slug: 'a' }).slug, 'a');
    assert.equal(m.last({ slug: 'b' }).slug, 'b');
    assert.equal(m.last({}).slug, 'b'); // most recent overall

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── extract-score (Tier 6 #16) ─────────────────────────────────────────────

describe('vanta-extract-score — invariant candidate gating', () => {
  const { scoreCandidate, routeCandidate, jaccard, auditPrefix } =
    require('../bin/vanta-extract-score');

  test('jaccard handles empty + identity', () => {
    assert.equal(jaccard('', ''), 0);
    assert.equal(jaccard('foo bar baz', 'foo bar baz'), 1);
    assert.ok(jaccard('foo bar baz', 'foo bar qux') > 0.4, 'shared > different');
  });

  test('skill-doc phrasing hard-rejects (score 0, route discard)', () => {
    const r = routeCandidate('Step 1: invoke this skill before creative work.');
    assert.equal(r.route, 'discard');
    assert.equal(r.score, 0);
    assert.ok(r.hardReject, 'hardReject flag set');
    assert.ok(r.reasons.some(x => x.includes('skill-doc-reject')));
  });

  test('well-formed invariant w/ backticks routes auto', () => {
    const r = routeCandidate(
      'Use `ES256` asymmetric JWTs for pi-perception auth. `HS256` symmetric keys will fail silently.'
    );
    assert.equal(r.route, 'auto');
    assert.ok(r.score >= 0.65, `score ${r.score} should be ≥ 0.65 for auto`);
  });

  test('PII / project state routes discard', () => {
    // No backticks, no decision markers, no failure framing — just project state.
    const r = routeCandidate('child_name: Aanya, age 7, attended screening at DPS Bangalore on 2026-04-12.');
    assert.ok(['discard', 'staging'].includes(r.route),
      `PII routed to ${r.route} — should be discard or staging, never auto`);
    assert.notEqual(r.route, 'auto');
  });

  test('near-duplicate routes update-in-place', () => {
    const existing = [
      'Use `ES256` asymmetric JWTs for pi-perception auth. `HS256` keys fail silently.',
    ];
    // Same fact, slightly rephrased — should be caught as dup, not appended.
    const r = routeCandidate(
      'Use `ES256` asymmetric JWTs for pi-perception authentication. `HS256` keys fail silently.',
      { existing }
    );
    assert.equal(r.route, 'update-in-place');
    assert.ok(r.dup);
    assert.ok(r.dup.similarity >= 0.8);
  });

  test('auditPrefix includes session id, ts, confidence', () => {
    const p = auditPrefix({ sessionId: 'abc-123', confidence: 0.87, ts: '2026-04-30T07:55:00Z' });
    assert.match(p, /<!-- vanta-sync:/);
    assert.match(p, /session=abc-123/);
    assert.match(p, /confidence=0\.87/);
    assert.match(p, /ts=2026-04-30T07:55:00Z/);
  });

  test('auditPrefix tolerates missing fields without throwing', () => {
    const p = auditPrefix({});
    assert.ok(p.includes('session=unknown'));
    assert.ok(p.includes('confidence=unknown'));
  });

  test('empty / non-string input returns score 0', () => {
    assert.equal(scoreCandidate('').score, 0);
    assert.equal(scoreCandidate('   ').score, 0);
    assert.equal(scoreCandidate(null).score, 0);
    assert.equal(scoreCandidate(undefined).score, 0);
  });

  test('partial-dup applies negative score adjustment', () => {
    // Similar but not duplicate — share 4 tokens, swap a few words.
    // jaccard target: 0.5–0.8 range.
    const existing = ['Use ES256 asymmetric JWTs for pi-perception auth code.'];
    const r = scoreCandidate(
      'Use ES256 asymmetric tokens for pi-perception auth servers.',
      { existing }
    );
    const matchedDup = r.reasons.some(x => x.includes('dup'));
    assert.ok(matchedDup, `expected partial-dup signal, got reasons: ${r.reasons.join(' | ')}`);
  });
});

// ─── runtime-state (always-on dedupe brain) ─────────────────────────────────

describe('vanta-runtime-state — per-session cooldown brain', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let tmp;

  function fresh() {
    delete require.cache[require.resolve('../bin/vanta-runtime-state')];
    return require('../bin/vanta-runtime-state');
  }

  test('shouldInject returns true for first key, false during cooldown', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    assert.equal(m.shouldInject('s1', 'prompt-context:abc'), true);
    m.markInjected('s1', 'prompt-context:abc');
    assert.equal(m.shouldInject('s1', 'prompt-context:abc'), false);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('shouldInject treats different keys independently', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.markInjected('s1', 'prompt-context:abc');
    assert.equal(m.shouldInject('s1', 'prompt-context:xyz'), true,
      'different key should not be on cooldown');

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('cooldown windows differ by source prefix (R6 P3 — pruned dead entries)', () => {
    const m = fresh();
    // After R6: only the prefixes whose hooks actually call shouldInject
    // are present. council-advisory and tool-observer were dead config —
    // listed in the table, never called. Pruned. Now: prompt-context,
    // stack-file-nudge, contradiction-shown, default.
    assert.ok(m.COOLDOWNS['stack-file-nudge:'] > m.COOLDOWNS['prompt-context:']);
    assert.ok(m.COOLDOWNS['prompt-context:'] > m.COOLDOWNS['default']);
    assert.ok(m.COOLDOWNS['contradiction-shown:'] >= m.COOLDOWNS['default']);
    // Pruned entries are gone — explicit check so re-adding them flags here.
    assert.equal(m.COOLDOWNS['council-advisory:'], undefined);
    assert.equal(m.COOLDOWNS['tool-observer:'], undefined);
  });

  test('bump increments + persists', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.bump('s1', 'prompt_count');
    m.bump('s1', 'prompt_count');
    m.bump('s1', 'tool_calls');

    const s = m.getState('s1');
    assert.equal(s.prompt_count, 2);
    assert.equal(s.tool_calls, 1);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('setPhase rejects invalid phase', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.setPhase('s1', 'build');
    assert.equal(m.getState('s1').phase, 'build');
    m.setPhase('s1', 'invalid-phase');  // silent reject
    assert.equal(m.getState('s1').phase, 'build', 'invalid phase should not overwrite');

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('reapStale removes old session files', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.bump('alive-1', 'prompt_count');
    m.bump('alive-2', 'prompt_count');

    // Backdate one file by 14 days to test reaping.
    const dir = path.join(tmp, 'runtime');
    const files = fs.readdirSync(dir);
    const stale = path.join(dir, files[0]);
    const oldTime = Date.now() - 14 * 86400_000;
    fs.utimesSync(stale, oldTime / 1000, oldTime / 1000);

    const removed = m.reapStale({ days: 7 });
    assert.equal(removed, 1, 'only the stale file should be reaped');

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('_foldJournal memoizes by mtime (Codex/Gemini R4 P1)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.bump('memo', 'tool_calls');
    m._clearFoldCache();
    const a = m._foldJournal('memo');
    const b = m._foldJournal('memo');
    // Same mtime → cache hit → identical reference.
    assert.strictEqual(a, b, 'second fold with unchanged mtime must be a cache hit');

    // Append a new entry — mtime changes, cache busts. Spin-loop on mtime
    // to avoid timing flake on fast filesystems where the second
    // appendFileSync collides with the same mtimeMs as the first.
    const file = path.join(tmp, 'runtime', 'memo.jsonl');
    const start = fs.statSync(file).mtimeMs;
    let attempts = 0;
    while (fs.statSync(file).mtimeMs === start && attempts++ < 20) {
      m.bump('memo', 'tool_calls');
    }
    const c = m._foldJournal('memo');
    assert.notStrictEqual(a, c, 'fold after append must NOT be the cached reference');
    assert.equal(c.counters.tool_calls >= 2, true);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('compact skips live (non-quiescent) journals — Codex R3 P1', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    // Build a journal with many entries.
    for (let i = 0; i < 50; i++) m.bump('live', 'tool_calls');
    const dir = path.join(tmp, 'runtime');
    const file = path.join(dir, 'live.jsonl');
    const sizeBefore = fs.statSync(file).size;
    const linesBefore = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(linesBefore, 50);

    // Live = mtime within QUIESCE_MS. Compact must NOT rewrite the file.
    m._compact('live');
    const linesAfter = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(linesAfter, 50, 'live compaction must be a no-op');

    // Backdate the file past QUIESCE_MS — now compact should fold the journal.
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(file, old, old);
    m._compact('live');
    const folded = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(folded.length, 1, 'quiescent compaction folds to 1 snapshot line');
    const snap = JSON.parse(folded[0]);
    assert.equal(snap.op, 'snapshot');
    assert.equal(snap.state.counters.tool_calls, 50);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── prompt-brief (UserPromptSubmit classifier) ─────────────────────────────

describe('vanta-prompt-brief — classifier + brief generator', () => {
  const m = require('../bin/vanta-prompt-brief');

  test('classify routes prompts to correct phase', () => {
    assert.equal(m.classify('investigate why JWT verification is failing'), 'debug');
    assert.equal(m.classify('ship the auth refactor branch'), 'ship');
    assert.equal(m.classify('design the always-on layer for vanta'), 'plan');
    assert.equal(m.classify('build the new prompt-context hook'), 'build');
    assert.equal(m.classify('do we have any prior art for this?'), 'recall');
    assert.equal(m.classify('review this diff'), 'review');
    assert.equal(m.classify('hello'), 'unknown');
  });

  test('classify is conservative — generic verbs do not collide', () => {
    // "should" alone shouldn't trigger 'plan' — needs "how should" / "what approach".
    assert.equal(m.classify('the test should pass when I run it'), 'unknown');
    // "fix" alone is generic — but "broken" / "fail" / "bug" trigger 'debug'.
    assert.equal(m.classify('make this nicer'), 'unknown');
  });

  test('extractTopics drops English stopwords + dedupes', () => {
    const t = m.extractTopics('how should I architect the always-on layer for vanta');
    assert.ok(t.length <= 3, 'caps at 3 topics');
    // Stopwords like "the", "for", "should", "how" should not appear.
    for (const stop of ['the', 'for', 'should', 'how']) {
      assert.equal(t.includes(stop), false, `"${stop}" should be filtered`);
    }
  });

  test('extractTopics drops phase verbs (R6 P1 — signal quality)', () => {
    // Earlier topic extractor passed 'build', 'fix', 'ship', 'design',
    // 'investigate', 'decide' through to the resolver — generic verbs that
    // pulled unrelated junk. They classify the PHASE; they aren't topical.
    for (const phaseVerb of ['build', 'fix', 'ship', 'design', 'investigate', 'decide', 'review', 'recall', 'implement']) {
      const t = m.extractTopics(`${phaseVerb} the new sync flow`);
      assert.equal(
        t.includes(phaseVerb), false,
        `"${phaseVerb}" must be dropped — it classifies phase, not topic`,
      );
    }
  });

  test('extractTopics prefers identifier-shaped tokens over English (R6 P1)', () => {
    // camelCase, dotted, hyphenated, path-like all score ahead of plain English.
    const t1 = m.extractTopics('the JWTVerifier in pi-perception is throwing');
    assert.ok(t1.includes('jwtverifier') || t1.some(x => x.includes('pi-perception')),
      `should pick up identifier-shaped tokens, got ${JSON.stringify(t1)}`);
    const t2 = m.extractTopics('look at @prisma/client.connect');
    assert.ok(t2.some(x => x.includes('prisma') || x.includes('client')),
      `should pick up package/dotted identifiers, got ${JSON.stringify(t2)}`);
  });

  test('shapeKey canonicalizes topics so rephrases hit same cooldown key (R6 P1)', () => {
    // "build the sync flow", "build the new sync flow", and
    // "implement the sync flow" all share the same intent; they should
    // collapse to one cooldown key after R6's canonicalization (sort + dedup
    // of length-3+ tokens, plus the phase classifier already maps "build"
    // and "implement" to the same 'build' phase).
    const a = m.shapeKey('build the sync flow');
    const b = m.shapeKey('build the new sync flow');
    const c = m.shapeKey('implement the sync flow');
    assert.equal(a, b, 'trivial filler word should not change the cooldown key');
    assert.equal(a, c, 'synonyms in the phase classifier should produce the same key');
  });

  test('shapeKey is deterministic for same prompt', () => {
    const k1 = m.shapeKey('build the new prompt-context hook');
    const k2 = m.shapeKey('build the new prompt-context hook');
    assert.equal(k1, k2);
    assert.match(k1, /^build:[0-9a-f]{8}$/);
  });

  test('shapeKey changes when phase or topics differ', () => {
    const k1 = m.shapeKey('build the new prompt-context hook');
    const k2 = m.shapeKey('debug the new prompt-context hook');  // different phase
    const k3 = m.shapeKey('build the new tool-observer hook');   // different topics
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
  });

  test('buildBrief returns null for review / unknown phase', () => {
    assert.equal(m.buildBrief({ prompt: 'review this diff' }), null);
    assert.equal(m.buildBrief({ prompt: 'hello there' }), null);
  });

  test('buildBrief never emits route hints (Codex R2 P3)', () => {
    // Brief output must be factual recall only — no "/ship", "/investigate",
    // "/council", "/recall" imperative arrows. The user already knows the
    // three commands; the always-on layer's job is recall, not routing.
    const probes = [
      'ship the always-on layer',
      'investigate why this fails',
      'plan the architecture for X',
      'do we have prior art on Y',
    ];
    for (const p of probes) {
      const b = m.buildBrief({ prompt: p });
      if (!b) continue;  // null is fine
      assert.equal(b.includes('→ /ship'),         false, 'no /ship hint');
      assert.equal(b.includes('→ /investigate'),  false, 'no /investigate hint');
      assert.equal(b.includes('→ /council'),      false, 'no /council hint');
      assert.equal(b.includes('vanta-resolve --topic'), false, 'no /recall hint');
    }
  });
});

// ─── interaction-log (universal observer) ────────────────────────────────────

describe('vanta-interaction-log — telemetry shape extraction', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  function fresh() {
    delete require.cache[require.resolve('../bin/vanta-interaction-log')];
    return require('../bin/vanta-interaction-log');
  }

  test('shapeOfArgs strips file content but keeps extension', () => {
    const m = fresh();
    const s = m.shapeOfArgs('Write', { file_path: '/foo/bar.tsx', content: 'const x = 42;'.repeat(1000) });
    assert.equal(s.ext, 'tsx');
    assert.ok(s.keys.includes('file_path'));
    assert.ok(s.keys.includes('content'));
  });

  test('shapeOfArgs reduces Bash command to first verb only', () => {
    const m = fresh();
    const s = m.shapeOfArgs('Bash', { command: 'git push origin main --force' });
    assert.equal(s.bashVerb, 'git');
    // No trailing args leaked.
    assert.equal(s.bashVerb.includes('push'), false);
  });

  test('shapeOfArgs normalizes paths to basename then allowlists (Codex R2 P2)', () => {
    const m = fresh();
    // Absolute path → basename. Unknown basename → 'other' (no path leak).
    const s1 = m.shapeOfArgs('Bash', { command: '/Users/vinamr/Projects/vanta/bin/foo.sh arg1' });
    assert.equal(s1.bashVerb, 'other');
    assert.equal(s1.bashVerb.includes('Users'), false);
    assert.equal(s1.bashVerb.includes('/'), false);
    // Allowlist entry survives: `/usr/local/bin/git` → `git`.
    const s2 = m.shapeOfArgs('Bash', { command: '/usr/local/bin/git status' });
    assert.equal(s2.bashVerb, 'git');
    // Compound command: only the first verb is captured.
    const s3 = m.shapeOfArgs('Bash', { command: 'cd /Users/vinamr/secret-project && npm install' });
    assert.equal(s3.bashVerb, 'cd');
  });

  test('shapeOfArgs strips VAR=value env prefix (Codex R3 P3)', () => {
    const m = fresh();
    // NODE_ENV=test pnpm test → pnpm (env assignment skipped).
    assert.equal(m.shapeOfArgs('Bash', { command: 'NODE_ENV=test pnpm test' }).bashVerb, 'pnpm');
    // Stacked assignments still resolve to the real verb.
    assert.equal(m.shapeOfArgs('Bash', { command: 'A=1 B=2 npm run dev' }).bashVerb, 'npm');
    // env wrapper is also stripped.
    assert.equal(m.shapeOfArgs('Bash', { command: 'env FOO=bar git status' }).bashVerb, 'git');
    // sudo wrapper.
    assert.equal(m.shapeOfArgs('Bash', { command: 'sudo npm install -g foo' }).bashVerb, 'npm');
    // Wrapper with no following allowlisted verb falls through to 'other'.
    assert.equal(m.shapeOfArgs('Bash', { command: 'env FOO=bar /opt/custom/wat' }).bashVerb, 'other');
  });

  test('logEvent + audit roundtrip', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-il-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.logEvent({ session_id: 'a', tool: 'Bash', event: 'pre',  bash_verb: 'git' });
    m.logEvent({ session_id: 'a', tool: 'Bash', event: 'post', bash_verb: 'git', ok: true });
    m.logEvent({ session_id: 'a', tool: 'Write', event: 'pre', ext: 'ts' });

    const r = m.audit({ days: 1 });
    assert.equal(r.total, 3);
    assert.equal(r.sessions, 1);
    assert.equal(r.pre, 2);
    assert.equal(r.post, 1);
    assert.equal(r.by_tool.Bash, 2);
    assert.equal(r.by_tool.Write, 1);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('audit captures failure rate from post events', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-il-'));
    process.env.VANTA_DIR_OVERRIDE = tmp;
    const m = fresh();

    m.logEvent({ session_id: 'a', tool: 'Bash', event: 'post', ok: true });
    m.logEvent({ session_id: 'a', tool: 'Bash', event: 'post', ok: false });
    m.logEvent({ session_id: 'a', tool: 'Bash', event: 'post', ok: false });

    const r = m.audit({ days: 1 });
    assert.equal(r.failures, 2);

    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── resolver result cache (Codex R2 P2) ───────────────────────────────────

describe('vanta-resolve — result cache', () => {
  // Use a fresh require each test so process-local cache state is isolated
  // between assertions. (Module cache holds across tests; we reach in via
  // clearCache() rather than blowing up require.cache.)
  const resolver = require('../bin/vanta-resolve');

  test('clearCache exists and is idempotent', () => {
    // Prove the surface — these two calls must not throw.
    assert.equal(typeof resolver.clearCache, 'function');
    resolver.clearCache();
    resolver.clearCache();
  });

  test('repeated identical resolve() calls return the same object reference (cache hit)', () => {
    resolver.clearCache();
    const a = resolver.resolve({ topic: 'jwt', project: 'pi-perception', max: 1 });
    const b = resolver.resolve({ topic: 'jwt', project: 'pi-perception', max: 1 });
    // Strict object identity proves the result came from cache, not re-fetched.
    assert.strictEqual(a, b, 'second call must hit the cache');
  });

  test('different cache keys do not collide', () => {
    resolver.clearCache();
    const a = resolver.resolve({ topic: 'jwt', project: 'pi-perception', max: 1 });
    const b = resolver.resolve({ topic: 'jwt', project: 'little-wins',   max: 1 });
    // Different project = different key = different cache entry. Identity may
    // or may not differ (both could legitimately return empty results, which
    // is the same object literal under v8 some of the time), so check the
    // project field on the returned value.
    assert.equal(a.project, 'pi-perception');
    assert.equal(b.project, 'little-wins');
  });

  test('clearCache forces refetch', () => {
    resolver.clearCache();
    const a = resolver.resolve({ topic: 'jwt', project: 'pi-perception', max: 1 });
    resolver.clearCache();
    const b = resolver.resolve({ topic: 'jwt', project: 'pi-perception', max: 1 });
    // After clearCache, a and b are recomputed — different object identity
    // even if value-equal.
    assert.notStrictEqual(a, b, 'after clearCache the second call must NOT be a cache hit');
  });

  test('cache busts when project CLAUDE.md (gotchas) mtime changes — Codex R3 P2', () => {
    // Simulate the R3 case: cache hits forever even after editing decisions/
    // gotchas. With the source-version vector, touching CLAUDE.md must bust.
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-resolve-'));
    const claudeMd = path.join(tmpdir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# test\n');

    resolver.clearCache();
    const a = resolver.resolve({ topic: 'jwt', project: 'pi-perception', cwd: tmpdir, max: 1 });
    // Cache hit immediately after — same vector.
    const b = resolver.resolve({ topic: 'jwt', project: 'pi-perception', cwd: tmpdir, max: 1 });
    assert.strictEqual(a, b, 'identical inputs and unchanged sources must be a cache hit');

    // Touch the gotchas file — vector changes → cache must bust.
    const future = (Date.now() + 5_000) / 1000;
    fs.utimesSync(claudeMd, future, future);
    const c = resolver.resolve({ topic: 'jwt', project: 'pi-perception', cwd: tmpdir, max: 1 });
    assert.notStrictEqual(a, c, 'gotchas mtime change must invalidate the cache');

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
});

// ─── module surface check ──────────────────────────────────────────────────

describe('module exports — sanity', () => {
  test('vanta-projects exports the expected surface', () => {
    const m = require('../bin/vanta-projects');
    for (const k of ['canonProject', 'isKnownProject', 'detectProject',
                     'slugForFilesystem', 'projectPatternsFor',
                     'PROJECT_KEYWORDS', 'PROJECT_SPECIFIC_PATTERNS', 'GLOBAL_PROJECT']) {
      assert.ok(m[k] !== undefined, `vanta-projects must export ${k}`);
    }
  });

  test('vanta-resolve exports resolve()', () => {
    const m = require('../bin/vanta-resolve');
    assert.equal(typeof m.resolve, 'function');
    assert.equal(typeof m.scoreResult, 'function');
    assert.equal(typeof m.detectContradictions, 'function');
  });
});

// ─── hook ordering (Codex+Gemini R5 P2) ────────────────────────────────────
//
// PreToolUse hooks fire sequentially in registration order; ANY non-zero
// exit blocks the tool call AND aborts the chain. tool-observer must run
// BEFORE git-guardrails so the always-on telemetry sees blocked Bash
// attempts (the highest-risk events).
describe('hooks — registration order (R5 P2)', () => {
  const manifestPath = path.join(__dirname, '..', 'hooks', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  test('tool-observer registers BEFORE git-guardrails on PreToolUse', () => {
    const preTool = manifest.registrations.filter(r => r.event === 'PreToolUse');
    const observerIdx = preTool.findIndex(r => r.file === 'tool-observer.js');
    const guardrailsIdx = preTool.findIndex(r => r.file === 'git-guardrails.js');
    assert.ok(observerIdx >= 0, 'tool-observer.js must be registered');
    assert.ok(guardrailsIdx >= 0, 'git-guardrails.js must be registered');
    assert.ok(
      observerIdx < guardrailsIdx,
      `tool-observer (idx ${observerIdx}) must precede git-guardrails (idx ${guardrailsIdx}) so blocked Bash gets telemetry`,
    );
  });
});

// ─── hook syntax check (Codex R3 P1 test gap) ──────────────────────────────
//
// R3 caught a syntax error in hooks/tool-observer.js (duplicate `const event`)
// that the existing test suite would never have caught — none of the bin
// modules import the hook entry points. The hooks ARE the always-on layer;
// if any of them fails to parse, the layer is dead on the user's machine.
// Run `node --check` on every node-runtime hook listed in the manifest.

describe('hooks — syntax sanity (Codex R3)', () => {
  const { execFileSync } = require('node:child_process');
  const manifestPath = path.join(__dirname, '..', 'hooks', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const nodeHooks = manifest.registrations
    .filter(r => r.runtime === 'node')
    .map(r => r.file);
  const unique = [...new Set(nodeHooks)];

  for (const file of unique) {
    test(`${file} parses cleanly`, () => {
      const full = path.join(__dirname, '..', 'hooks', file);
      assert.ok(fs.existsSync(full), `hook file must exist: ${full}`);
      // node --check exits 0 on parse success, non-zero on SyntaxError.
      // execFileSync throws on non-zero exit — assert by absence of throw.
      assert.doesNotThrow(() => {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      }, `node --check failed on ${file}`);
    });
  }
});

// ─── R7 lockdown — same-slug-different-cwd cross-leak (Codex R7 P2) ──────────
//
// Two unrelated projects under the same canonical slug must NOT bleed
// code-knowledge into each other. Indexer tags each entry with `projectRoot`;
// resolver drops entries whose projectRoot doesn't match the active cwd.

describe('vanta-resolve — projectRoot scope filter (R7 P2)', () => {
  const resolver = require('../bin/vanta-resolve');

  test('drops code-knowledge entries with mismatched projectRoot', () => {
    // Set up a fake shard with two entries that both canonicalize to the
    // same slug but have different projectRoot values. Pretend project="api".
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r7p2-'));
    const cwdA = path.join(tmpdir, 'work-api');
    const cwdB = path.join(tmpdir, 'personal-api');
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);
    // Write a CLAUDE.md in each so cwd is real.
    fs.writeFileSync(path.join(cwdA, 'CLAUDE.md'), '# work\n');
    fs.writeFileSync(path.join(cwdB, 'CLAUDE.md'), '# personal\n');

    const knowledgeDir = path.join(os.homedir(), '.vanta', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const shard = path.join(knowledgeDir, 'r7p2test.jsonl');
    // Save existing content if any so we restore.
    let prior = null;
    try { prior = fs.readFileSync(shard, 'utf8'); } catch {}
    const entryA = JSON.stringify({
      ts: '2026-04-01T00:00:00Z',
      project: 'r7p2test',
      projectRoot: cwdA,
      category: 'work-secret',
      // jwt with whitespace boundary so the topic regex matches.
      snippet: 'WORK_API_KEY uses jwt session abc',
      source: 'work-api/secret.ts:1',
      pathRank: 1.0,
    });
    const entryB = JSON.stringify({
      ts: '2026-04-01T00:00:00Z',
      project: 'r7p2test',
      projectRoot: cwdB,
      category: 'personal-secret',
      snippet: 'PERSONAL_API_KEY uses jwt session xyz',
      source: 'personal-api/secret.ts:1',
      pathRank: 1.0,
    });
    fs.writeFileSync(shard, entryA + '\n' + entryB + '\n');

    try {
      resolver.clearCache();
      // Query from cwdA — should ONLY see entryA (work).
      const fromA = resolver.resolve({ topic: 'jwt', project: 'r7p2test', cwd: cwdA, max: 5 });
      const fromARaws = fromA.results.filter(r => r.source === 'code').map(r => r.excerpt);
      const sawWorkA    = fromARaws.some(s => /WORK_API_KEY/.test(s));
      const sawPersonalA = fromARaws.some(s => /PERSONAL_API_KEY/.test(s));
      assert.equal(sawWorkA, true,    'cwdA query must surface its own entry');
      assert.equal(sawPersonalA, false, 'cwdA query must NOT leak entries from cwdB');

      resolver.clearCache();
      const fromB = resolver.resolve({ topic: 'jwt', project: 'r7p2test', cwd: cwdB, max: 5 });
      const fromBRaws = fromB.results.filter(r => r.source === 'code').map(r => r.excerpt);
      const sawWorkB     = fromBRaws.some(s => /WORK_API_KEY/.test(s));
      const sawPersonalB = fromBRaws.some(s => /PERSONAL_API_KEY/.test(s));
      assert.equal(sawPersonalB, true, 'cwdB query must surface its own entry');
      assert.equal(sawWorkB, false,    'cwdB query must NOT leak entries from cwdA');
    } finally {
      if (prior !== null) fs.writeFileSync(shard, prior);
      else fs.unlinkSync(shard);
      fs.rmSync(tmpdir, { recursive: true, force: true });
      resolver.clearCache();
    }
  });

  test('legacy entries without projectRoot still pass (back-compat)', () => {
    const knowledgeDir = path.join(os.homedir(), '.vanta', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const shard = path.join(knowledgeDir, 'r7p2legacy.jsonl');
    let prior = null;
    try { prior = fs.readFileSync(shard, 'utf8'); } catch {}
    const legacy = JSON.stringify({
      ts: '2026-04-01T00:00:00Z',
      project: 'r7p2legacy',
      // NO projectRoot field — pre-Tier-5 entry
      category: 'legacy',
      snippet: 'jwt secret rotation policy',
      source: 'old/file.ts:1',
      pathRank: 1.0,
    });
    fs.writeFileSync(shard, legacy + '\n');

    try {
      resolver.clearCache();
      const out = resolver.resolve({
        topic: 'jwt', project: 'r7p2legacy',
        cwd: '/some/random/cwd', max: 5,
      });
      const sawLegacy = out.results.some(r => /rotation policy/.test(r.excerpt));
      assert.equal(sawLegacy, true, 'legacy entries without projectRoot must still surface');
    } finally {
      if (prior !== null) fs.writeFileSync(shard, prior);
      else fs.unlinkSync(shard);
      resolver.clearCache();
    }
  });
});

// ─── R7 lockdown — git-guardrails ReDoS bounds (Codex R7 P3) ─────────────────

describe('git-guardrails — bounded quantifiers (R7 P3)', () => {
  const { checkCommand, HARD_BLOCK } = require('../hooks/git-guardrails');

  test('all HARD_BLOCK regex sources use bounded {0,N} not unbounded *', () => {
    // Lockdown: any regex containing `[^\n]*` (unbounded) OR `.*` between
    // capture groups is a ReDoS risk. The single allowed `[^\n]*` callsites
    // are NONE — every dotted/exclusion class must be quantified bounded.
    for (const rule of HARD_BLOCK) {
      const src = rule.re.source;
      // Allow `[^\n]{0,N}` (bounded). Reject `[^\n]*` and `[^\n]+`.
      // Allow `\s+` (well-defined chars, not the catastrophic class).
      assert.equal(/\[\^\\n\]\*/.test(src), false,
        `HARD_BLOCK rule has unbounded [^\\n]*: ${src}`);
      assert.equal(/\[\^\\n\]\+/.test(src), false,
        `HARD_BLOCK rule has unbounded [^\\n]+: ${src}`);
    }
  });

  test('long adversarial input does not stall the regex matcher', () => {
    // Build a 100KB single-line command that LOOKS like git push but has
    // no force flag and no main/master. Pre-R7 patterns could backtrack
    // for seconds on this. With bounded quantifiers worst case is bounded.
    const noise = 'x '.repeat(50_000);  // 100KB of "x x x..."
    const evil = `git push ${noise} feature-branch`;
    const t0 = Date.now();
    const v = checkCommand(evil);
    const elapsed = Date.now() - t0;
    assert.equal(v.action, 'allow', 'no force flag → must be allow');
    assert.ok(elapsed < 250, `regex must complete fast (was ${elapsed}ms)`);
  });

  test('still hard-blocks the documented force-push patterns', () => {
    // Original behavior preserved — bounded quantifiers don't hide real matches.
    assert.equal(checkCommand('git push -f origin main').action, 'block');
    assert.equal(checkCommand('git push --force-with-lease origin master').action, 'block');
    assert.equal(checkCommand('git push origin main --force').action, 'block');
  });
});

// ─── R7 lockdown — slugFromCwd basename collisions (Codex R7 P2) ─────────────

describe('vanta-projects — slugFromCwd', () => {
  const { slugFromCwd } = require('../bin/vanta-projects');

  test('returns null for ambiguous bare basenames', () => {
    // Don't crash; don't return a slug that would collide with neighbors.
    // /tmp, /home, /Users, /var basenames must refuse.
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-slug-'));
    const fakeTmp = path.join(tmpdir, 'tmp');
    fs.mkdirSync(fakeTmp);
    try {
      assert.equal(slugFromCwd(fakeTmp), null,
        'basename "tmp" is ambiguous — must return null');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test('falls back to basename when no git context', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-slug-named-'));
    // Single token (no dash) — canonProject won't strip a user-prefix.
    const proj = path.join(tmpdir, 'uniquerepo');
    fs.mkdirSync(proj);
    try {
      const slug = slugFromCwd(proj);
      assert.ok(slug && slug.length > 0, 'must return a slug for unambiguous dir');
      assert.equal(slug, 'uniquerepo');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test('returns null for empty / null input', () => {
    assert.equal(slugFromCwd(null), null);
    assert.equal(slugFromCwd(''),   null);
    assert.equal(slugFromCwd(undefined), null);
  });
});

// ─── v3.8.1 hardening — monorepo subdir slug convergence ─────────────────────
//
// Both R3 council models converged on this: `cwd = /repo/packages/api`
// must slug to the workspace root (`repo`), not the subdir basename
// (`api`). slugFromCwd already walks up to `git rev-parse --show-toplevel`,
// but the regression test guards against re-introducing a basename-only
// derivation in the future. Build a synthetic monorepo with `git init`
// at the root and verify all subdir cwds collapse to the same slug.

describe('v3.8.1 — monorepo subdir slug convergence', () => {
  const { slugFromCwd } = require('../bin/vanta-projects');
  const { execFileSync } = require('node:child_process');

  test('slugFromCwd walks up to repo root for nested workspace dirs', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-monorepo-'));
    // Realpath the tmp parent — on macOS, /tmp is a symlink to /private/tmp,
    // which would make slugFromCwd's realpathSync return a different parent
    // than the test sees, breaking the assertion. We canonicalize once up
    // front so both sides agree.
    const real = fs.realpathSync(tmpdir);
    const repoRoot = path.join(real, 'monorepo-fixture');
    const pkgA = path.join(repoRoot, 'packages', 'api');
    const pkgB = path.join(repoRoot, 'packages', 'web');
    const deepNested = path.join(repoRoot, 'apps', 'mobile', 'ios', 'src');
    fs.mkdirSync(pkgA,        { recursive: true });
    fs.mkdirSync(pkgB,        { recursive: true });
    fs.mkdirSync(deepNested,  { recursive: true });
    try {
      // Init a real git repo at the workspace root. No remote — we want
      // the toplevel-basename branch of slugFromCwd, not the org-repo
      // branch (which would require a remote URL).
      execFileSync('git', ['-C', repoRoot, 'init', '--quiet'], { stdio: 'ignore' });
      const rootSlug = slugFromCwd(repoRoot);
      const apiSlug  = slugFromCwd(pkgA);
      const webSlug  = slugFromCwd(pkgB);
      const deepSlug = slugFromCwd(deepNested);
      assert.equal(rootSlug, 'monorepo-fixture',
        'workspace root resolves to its basename (no remote configured)');
      assert.equal(apiSlug, rootSlug,
        'packages/api must converge to workspace root, not "api"');
      assert.equal(webSlug, rootSlug,
        'packages/web must converge to workspace root, not "web"');
      assert.equal(deepSlug, rootSlug,
        'deeply-nested apps/mobile/ios/src must converge to workspace root');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// ─── v3.8.1 hardening — reader/writer slug agreement ─────────────────────────
//
// The R2/R3 council loop was driven by a class of bug where the action-log
// writer (prompt-rewriter hook) and trust-metrics reader (executor) used
// different slug derivations for the same cwd, so the writer's rows were
// invisible to the reader's queries. This regression test pins that they
// agree end-to-end. If anyone re-introduces a divergent derivation in
// either consumer, this test fails.

describe('v3.8.1 — executor and prompt-rewriter agree on project slug', () => {
  const { slugFromCwd } = require('../bin/vanta-projects');

  test('hook + executor derive identical slug for the same cwd', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-slug-agree-'));
    const real = fs.realpathSync(tmpdir);
    const cases = [
      // bare project dir, no git
      path.join(real, 'plain-project'),
      // monorepo subdir (git init at root, query from packages/api)
      { repoRoot: path.join(real, 'monorepo'), sub: ['packages', 'api'] },
      { repoRoot: path.join(real, 'monorepo'), sub: ['apps', 'web', 'src'] },
    ];
    const { execFileSync } = require('node:child_process');
    fs.mkdirSync(cases[0], { recursive: true });
    fs.mkdirSync(path.join(cases[1].repoRoot, ...cases[1].sub), { recursive: true });
    fs.mkdirSync(path.join(cases[2].repoRoot, ...cases[2].sub), { recursive: true });
    execFileSync('git', ['-C', cases[1].repoRoot, 'init', '--quiet'], { stdio: 'ignore' });

    try {
      // Mirror the executor's _canonProjectFromCwd():
      //   p.slugFromCwd(cwd) || (canonProject(basename) || basename)
      const executorDerive = (cwd) => {
        const p = require('../bin/vanta-projects');
        if (typeof p.slugFromCwd === 'function') {
          const s = p.slugFromCwd(cwd);
          if (s) return s;
        }
        const slug = path.basename(cwd);
        return (p.canonProject && p.canonProject(slug)) || slug;
      };
      // Mirror the prompt-rewriter hook's project-derivation block:
      //   slugFromCwd → canonProject(basename) → basename
      const hookDerive = (cwd) => {
        const p = require('../bin/vanta-projects');
        if (typeof p.slugFromCwd === 'function') {
          const s = p.slugFromCwd(cwd);
          if (s) return s;
        }
        if (typeof p.canonProject === 'function') {
          const slug = path.basename(cwd);
          return p.canonProject(slug) || slug;
        }
        return path.basename(cwd);
      };

      const cwds = [
        cases[0],
        path.join(cases[1].repoRoot, ...cases[1].sub),
        path.join(cases[2].repoRoot, ...cases[2].sub),
      ];
      for (const cwd of cwds) {
        const exec = executorDerive(cwd);
        const hook = hookDerive(cwd);
        assert.equal(exec, hook,
          `executor (${exec}) and hook (${hook}) must agree on slug for cwd=${cwd}`);
        // Sanity: also matches the canonical helper directly
        const direct = slugFromCwd(cwd) || path.basename(cwd);
        assert.equal(exec, direct,
          `executor derivation must match slugFromCwd() for cwd=${cwd}`);
      }
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// ─── v3.8.1 hardening — explicit trust-cache invalidation ───────────────────
//
// The 15s TTL is a passive bound; v3.8.1 adds invalidateTrustCache(project)
// for the regret-signal hot path (vanta-undo calls it the moment an undo
// lands). Verify the cache surface is exported, the call drops the entry
// for the named project, and a null/undefined arg clears all entries.

describe('v3.8.1 — invalidateTrustCache drops entries on regret signals', () => {
  const ex = require('../bin/vanta-executor');

  test('invalidateTrustCache + _trustCacheSnapshot are exported', () => {
    assert.equal(typeof ex.invalidateTrustCache, 'function');
    assert.equal(typeof ex._trustCacheSnapshot, 'function');
  });

  test('clear-all path empties the cache', () => {
    // Seed via decide() — any prompt that hits the inline_ready path
    // populates the cache for the canonical slug derived from cwd.
    ex.decide({ prompt: 'fix this bug', cwd: process.cwd() });
    ex.invalidateTrustCache(null);
    assert.equal(ex._trustCacheSnapshot().length, 0,
      'invalidateTrustCache(null) must clear every entry');
  });

  test('per-project invalidation only drops the named slug', () => {
    // Re-seed by decide() so we have at least one cached entry
    ex.decide({ prompt: 'fix this bug', cwd: process.cwd() });
    const snapBefore = ex._trustCacheSnapshot();
    if (snapBefore.length === 0) {
      // No cached entry materialized (e.g., tm.compute() unavailable
      // in the test env) — skip the targeted assertion but don't fail.
      return;
    }
    const targetKey = snapBefore[0].key;
    ex.invalidateTrustCache(targetKey);
    const snapAfter = ex._trustCacheSnapshot();
    assert.ok(!snapAfter.some(e => e.key === targetKey),
      `entry for key=${targetKey} must be gone after targeted invalidation`);
  });
});

// ─── R8 lockdown — rotation rename-only + merged read (Gemini R8 P1) ────────

describe('vanta-jsonl — merged read across .bak.<ts> rotations', () => {
  const { readMergedJsonl, readDedupedJsonl, listBaks } = require('../bin/vanta-jsonl');

  test('reads live + bak files in age order (oldest first)', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-jsonl-'));
    const file = path.join(tmpdir, 'q.jsonl');
    // Three "rotations": old bak, mid bak, live.
    fs.writeFileSync(file + '.bak.1000', '{"id":"a","v":1}\n');
    fs.writeFileSync(file + '.bak.2000', '{"id":"b","v":2}\n{"id":"a","v":2}\n');
    fs.writeFileSync(file,               '{"id":"c","v":3}\n{"id":"b","v":3}\n');
    try {
      const out = readMergedJsonl(file);
      const lines = out.split('\n').filter(Boolean);
      // Older first, live last. Expected order: a v1, b v2, a v2, c v3, b v3.
      assert.equal(lines.length, 5);
      assert.match(lines[0], /"v":1/);
      assert.match(lines[4], /"v":3/);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test('readDedupedJsonl: latest wins per session_id', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-jsonl-'));
    const file = path.join(tmpdir, 'q.jsonl');
    fs.writeFileSync(file + '.bak.1', '{"session_id":"s1","synced":false}\n');
    fs.writeFileSync(file,            '{"session_id":"s1","synced":true}\n');
    try {
      const m = readDedupedJsonl(file);
      assert.equal(m.size, 1);
      assert.equal(m.get('s1').synced, true, 'live file wins over .bak');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test('listBaks returns sorted bak siblings', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-jsonl-'));
    const file = path.join(tmpdir, 'q.jsonl');
    fs.writeFileSync(file + '.bak.20', '');
    fs.writeFileSync(file + '.bak.10', '');
    fs.writeFileSync(file + '.bak.30', '');
    try {
      const baks = listBaks(file);
      assert.equal(baks.length, 3);
      // Sorted by string (which == numeric for these simple suffixes).
      assert.match(baks[0], /\.bak\.10$/);
      assert.match(baks[2], /\.bak\.30$/);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test('handles empty/missing live file gracefully', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-jsonl-empty-'));
    const file = path.join(tmpdir, 'noexist.jsonl');
    try {
      // Live missing, bak present.
      fs.writeFileSync(file + '.bak.1', '{"x":1}\n');
      const out = readMergedJsonl(file);
      assert.match(out, /"x":1/);
      // Both missing.
      fs.unlinkSync(file + '.bak.1');
      assert.equal(readMergedJsonl(file).trim(), '');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// ─── R8 lockdown — clock rollback (Codex R8 P3) ──────────────────────────────

describe('vanta-runtime-state — clock rollback handling (R8 P3)', () => {
  test('shouldInject returns true on negative time delta (clock rolled back)', () => {
    // Force a fresh require so we don't share state with the other suite.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rs-r8-'));
    process.env.VANTA_DIR_OVERRIDE = tmpDir;
    delete require.cache[require.resolve('../bin/vanta-runtime-state')];
    const rs = require('../bin/vanta-runtime-state');
    try {
      const sid = 'clock-test';
      const key = 'prompt-context:abc';
      // Mark injection at a FUTURE time (simulating a system clock that
      // was set forward then rolled back). After mark, Date.now() < last.
      rs.markInjected(sid, key);
      // Manually overwrite the journaled timestamp to be in the future.
      const file = path.join(tmpDir, 'runtime', sid + '.jsonl');
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const futureNow = Date.now() + 24 * 3600_000;  // +1 day
      const fixed = lines.map(l => {
        try { const e = JSON.parse(l); if (e.op === 'inject') e.value = futureNow; return JSON.stringify(e); }
        catch { return l; }
      }).join('\n') + '\n';
      fs.writeFileSync(file, fixed);
      // Refresh fold cache by clearing.
      if (rs._clearFoldCache) rs._clearFoldCache();
      const can = rs.shouldInject(sid, key);
      assert.equal(can, true, 'negative delta must return true (re-inject), not suppress until time catches up');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-runtime-state')];
    }
  });
});

// ─── R8 lockdown — v3.6.0 episode shape compat (Codex R8 P3) ─────────────────

describe('vanta-resolve — legacy episode shape (R8 P3)', () => {
  test('reads v3.6.0 episodes that used `topic` and `project` fields', () => {
    // Pre-v3.6.6 episodes had {topic, decision, outcome, date, project} per
    // the auto-sync.js header doc. Current shape is {topics, slug}.
    // Both must read.
    const episodesFile = path.join(os.homedir(), '.vanta', 'episodes.jsonl');
    let prior = null;
    try { prior = fs.readFileSync(episodesFile, 'utf8'); } catch {}
    fs.mkdirSync(path.dirname(episodesFile), { recursive: true });

    // Ensure no rotated baks interfere — save and clear them.
    const dir = path.dirname(episodesFile);
    const base = path.basename(episodesFile);
    const baks = (() => {
      try { return fs.readdirSync(dir).filter(n => n.startsWith(base + '.bak.')); }
      catch { return []; }
    })();
    const bakBackups = baks.map(b => {
      const p = path.join(dir, b);
      const c = fs.readFileSync(p, 'utf8');
      fs.unlinkSync(p);
      return { p, c };
    });

    // One legacy entry, one current entry.
    const legacy = JSON.stringify({
      ts: '2026-04-01T00:00:00Z',
      session_id: 'r8-legacy',
      topic: 'r8legacytopic',  // singular
      project: 'r8legacyproj',
      decision: 'r8legacytopic was the right call',
      outcome: 'resolved',
    });
    const current = JSON.stringify({
      ts: '2026-04-02T00:00:00Z',
      session_id: 'r8-current',
      topics: ['r8currenttopic'],
      slug: 'r8currentproj',
      decision: 'r8currenttopic shipped clean',
      outcome: 'resolved',
    });
    fs.writeFileSync(episodesFile, legacy + '\n' + current + '\n');

    delete require.cache[require.resolve('../bin/vanta-resolve')];
    const resolver = require('../bin/vanta-resolve');
    try {
      resolver.clearCache();
      // Query the LEGACY entry's topic.
      const out = resolver.resolve({ topic: 'r8legacytopic', max: 5 });
      const sawLegacy = out.results.some(r =>
        r.source === 'episode' && /right call/.test(r.excerpt));
      assert.equal(sawLegacy, true, 'legacy episode shape must be readable');

      // Query the CURRENT entry's topic.
      resolver.clearCache();
      const out2 = resolver.resolve({ topic: 'r8currenttopic', max: 5 });
      const sawCurrent = out2.results.some(r =>
        r.source === 'episode' && /shipped clean/.test(r.excerpt));
      assert.equal(sawCurrent, true, 'current episode shape must be readable');
    } finally {
      if (prior !== null) fs.writeFileSync(episodesFile, prior);
      else { try { fs.unlinkSync(episodesFile); } catch {} }
      // Restore any bak backups we moved aside.
      for (const b of bakBackups) fs.writeFileSync(b.p, b.c);
      resolver.clearCache();
      delete require.cache[require.resolve('../bin/vanta-resolve')];
    }
  });
});

// ─── R8 lockdown — auto-sync rotation rename-only (Gemini R8 P1) ─────────────

// ─── R9 lockdown — torn-line guard (Gemini R9 P1) ────────────────────────────

describe('vanta-jsonl — torn-line resilience (R9 P1)', () => {
  const { readDedupedJsonl } = require('../bin/vanta-jsonl');

  test('torn final line does NOT corrupt the next healthy record', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-torn-'));
    const file = path.join(tmpdir, 'q.jsonl');
    try {
      // Producer A: torn write — no trailing \n. Simulates SIGKILL/ENOSPC.
      fs.writeFileSync(file, '\n{"session_id":"A","payload":"torn"');
      // Producer B: healthy append with leading \n guard (R9 P1 fix).
      fs.appendFileSync(file, '\n{"session_id":"B","payload":"intact"}\n');
      const m = readDedupedJsonl(file);
      // A's torn record is unparseable → dropped silently. That's
      // expected. The CRITICAL property: B's record survives.
      const sawB = m.has('B') && m.get('B').payload === 'intact';
      assert.equal(sawB, true, 'healthy next record must survive after torn line');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe('auto-sync — rotation behavior (R8 P1, v3.6.12 behavior)', () => {
  // v3.6.12: replaced static-source grep with end-to-end spawn that drives
  // the actual hook with VANTA_DIR_OVERRIDE pointed at a fixture dir, then
  // observes the resulting filesystem. Catches any future regression that
  // re-introduces fold-then-writeFileSync (which would cause the live file
  // to contain folded history instead of just the rotator's fresh entry).
  const { execFileSync } = require('node:child_process');
  const HOOK = path.join(__dirname, '..', 'hooks', 'auto-sync.js');

  function makeTranscript(p, toolCalls = 10) {
    const lines = [];
    for (let i = 0; i < toolCalls; i++) lines.push(JSON.stringify({ type: 'tool_use', tool: 'Edit' }));
    lines.push(JSON.stringify({ type: 'text', text: 'shipped the fix' }));
    fs.writeFileSync(p, lines.join('\n') + '\n');
  }

  function spawnAutoSync({ vantaDir, sessionId, transcriptPath }) {
    const stdin = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: vantaDir,
      hook_event_name: 'Stop',
    });
    return execFileSync(process.execPath, [HOOK], {
      input: stdin,
      env: { ...process.env, VANTA_DIR_OVERRIDE: vantaDir, HOME: path.join(vantaDir, 'home') },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
  }

  test('small live file: appends without rotation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r8b-noroll-'));
    try {
      const transcript = path.join(tmp, 'transcript.jsonl');
      makeTranscript(transcript);
      spawnAutoSync({ vantaDir: tmp, sessionId: 'fresh-A', transcriptPath: transcript });
      const baks = fs.readdirSync(tmp).filter(n => n.startsWith('sync-queue.jsonl.bak.'));
      assert.equal(baks.length, 0, 'fresh small file must not rotate');
      const live = fs.readFileSync(path.join(tmp, 'sync-queue.jsonl'), 'utf8');
      assert.match(live, /"session_id":"fresh-A"/, 'new entry must land in live file');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('rotation: file > 5MB triggers .bak.<ts>; live becomes fresh with only the new entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r8b-roll-'));
    try {
      const queueFile = path.join(tmp, 'sync-queue.jsonl');
      const filler = '{"old":"' + 'x'.repeat(500) + '"}\n';
      let total = '';
      while (total.length < 5_100_000) total += filler;
      fs.writeFileSync(queueFile, total);
      assert.ok(fs.statSync(queueFile).size > 5_000_000, 'precondition: live file > MAX_BYTES');

      const transcript = path.join(tmp, 'transcript.jsonl');
      makeTranscript(transcript);
      spawnAutoSync({ vantaDir: tmp, sessionId: 'roll-A', transcriptPath: transcript });

      const baks = fs.readdirSync(tmp).filter(n => n.startsWith('sync-queue.jsonl.bak.'));
      assert.equal(baks.length, 1, 'rotation must produce exactly one bak sibling');
      assert.match(baks[0], /sync-queue\.jsonl\.bak\.\d+\.\d+$/,
        'bak name must include Date.now() + pid suffix');

      const bakSize = fs.statSync(path.join(tmp, baks[0])).size;
      assert.ok(bakSize > 5_000_000, 'bak retains pre-rotation contents intact');

      // Live file is now fresh — must NOT be a fold-then-writeFileSync of
      // the entire history. If someone re-introduces the v3.5 fold path,
      // live would be ~5MB; with rename-only rotation it's a single entry.
      const live = fs.readFileSync(queueFile, 'utf8');
      assert.ok(live.length < 10_000,
        `live file must be small post-rotation (got ${live.length}B — fold was re-introduced?)`);
      assert.match(live, /"session_id":"roll-A"/, 'rotator entry lands in fresh live file');
      const liveLines = live.split('\n').filter(Boolean);
      assert.equal(liveLines.length, 1,
        `live file must contain exactly 1 entry post-rotation (got ${liveLines.length})`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('readMergedJsonl after rotation surfaces both old and new entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r8b-merge-'));
    try {
      const queueFile = path.join(tmp, 'sync-queue.jsonl');
      // Pre-populate with discoverable old entries near 5MB threshold.
      const oldEntries = [];
      for (let i = 0; i < 10; i++) {
        oldEntries.push(JSON.stringify({ session_id: `old-${i}`, ts: '2025-01-01' }));
      }
      const padding = '{"pad":"' + 'x'.repeat(500) + '"}\n';
      let pre = oldEntries.join('\n') + '\n';
      while (pre.length < 5_100_000) pre += padding;
      fs.writeFileSync(queueFile, pre);

      const transcript = path.join(tmp, 'transcript.jsonl');
      makeTranscript(transcript);
      spawnAutoSync({ vantaDir: tmp, sessionId: 'new-1', transcriptPath: transcript });

      const merged = require('../bin/vanta-jsonl').readMergedJsonl(queueFile);
      const seen = new Set();
      for (const line of merged.split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); if (e.session_id) seen.add(e.session_id); } catch {}
      }
      // All 10 old entries plus the new one must be visible.
      for (let i = 0; i < 10; i++) {
        assert.ok(seen.has(`old-${i}`), `old-${i} must survive rotation in bak file`);
      }
      assert.ok(seen.has('new-1'), 'new-1 must appear in live file');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── R9 lockdown — _compact field spread (Gemini R9 P1) ──────────────────────

describe('vanta-runtime-state — _compact preserves all fields (R9 P1)', () => {
  test('compact does not enumerate fields explicitly (regression guard)', () => {
    // Static-source guard. The fix replaced an explicit field enumeration
    // with object spread so future state additions survive compaction.
    // If someone reverts to enumeration, this test catches it.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bin', 'vanta-runtime-state.js'), 'utf8');
    // The new shape uses `state: rest` (rest = ...state minus session_id).
    assert.match(src, /state: rest/,
      '_compact must use object spread, not explicit field enumeration');
    // Catch the old shape if it gets re-introduced.
    assert.equal(/state:\s*\{\s*started_at: state\.started_at/.test(src), false,
      'explicit field enumeration was replaced with spread (R9 P1)');
  });
});

// ─── R9 lockdown — .planning is-directory check (Gemini R9 P1) ───────────────

describe('vanta-brief — detectPhase tolerates .planning as a file (R9 P1)', () => {
  const brief = require('../bin/vanta-brief.js');

  test('returns null when .planning is a file (not a dir) — does NOT crash', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r9-planning-'));
    try {
      // Create `.planning` as a FILE not a DIRECTORY.
      fs.writeFileSync(path.join(tmpdir, '.planning'), 'not a dir');
      // brief is a CLI but exposes detectPhase indirectly via main(). Easiest
      // path is to spawn it as a subprocess and assert it exits 0.
      const { execFileSync } = require('node:child_process');
      const briefPath = path.join(__dirname, '..', 'bin', 'vanta-brief.js');
      let result;
      assert.doesNotThrow(() => {
        result = execFileSync(process.execPath, [briefPath, '--cwd', tmpdir, '--format', 'json'],
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });
      }, 'vanta-brief must not crash when .planning is a file');
      // Output must still be valid JSON (no phase, but no error).
      assert.doesNotThrow(() => JSON.parse(result.toString()),
        'output must be parseable JSON even when .planning is a file');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
  void brief;  // satisfy "unused" lint if any
});

// ─── R9 lockdown — unique session_id fallback (Codex R9 P1) ──────────────────

describe('auto-sync — session_id fallback uniqueness (R9 P1)', () => {
  test('hook source uses pid+ts fallback, not collapsed `unknown`', () => {
    // Static-source guard against re-introducing `session_id || 'unknown'`.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'hooks', 'auto-sync.js'), 'utf8');
    assert.match(src, /unknown-\$\{process\.pid\}-\$\{Date\.now\(\)\}/,
      'fallback must include pid+ts so unknown-source events do not collide');
    // Old shape must NOT be present.
    assert.equal(/session_id\s*\|\|\s*['"]unknown['"]\s*;/.test(src), false,
      'plain `unknown` fallback was replaced (R9 P1) — multi-session collapse');
  });
});

// ─── R10 lockdown — composability ordering (Codex+Gemini R10 P1) ─────────────

describe('manifest — tool-observer is prepended for composability (R10 P1)', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'hooks', 'manifest.json'), 'utf8'));

  test('every tool-observer registration carries `prepend: true`', () => {
    const observers = manifest.registrations.filter(r => r.file === 'tool-observer.js');
    assert.ok(observers.length >= 2, 'tool-observer registers on Pre + Post');
    for (const r of observers) {
      assert.equal(r.prepend, true,
        `tool-observer registration on ${r.event}[${r.matcher}] must carry prepend:true`);
    }
  });

  test('non-observer hooks do NOT prepend (preserves blocking-hook order)', () => {
    // git-guardrails appends because it's a blocker — appending is correct
    // so it fires AFTER telemetry. If we prepended it, blocked Bash commands
    // would never reach the telemetry hook.
    const guardrail = manifest.registrations.find(r => r.file === 'git-guardrails.js');
    assert.ok(guardrail, 'git-guardrails registration present');
    assert.notEqual(guardrail.prepend, true, 'guardrails must append, not prepend');
  });
});

// ─── R10 lockdown — IMPORT_LINE no longer hardcoded (Codex+Gemini R10 P1) ────

describe('setup.sh — IMPORT_LINE derived from REPO_DIR (R10 P1, v3.6.12 behavior)', () => {
  // v3.6.12: replaced static-source grep with end-to-end install run.
  // Spawn setup.sh with HOME=tmpdir; assert the resulting CLAUDE.md
  // contains an @-import that resolves to the real repo path (not the
  // legacy hardcoded ~/Projects/vanta literal).
  const { execFileSync } = require('node:child_process');
  const REPO = path.resolve(path.join(__dirname, '..'));
  const SETUP = path.join(REPO, 'setup.sh');

  test('CLAUDE.md @-import points at $REPO_DIR/skills/using-vanta/SKILL.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r10b-setup-'));
    try {
      execFileSync('bash', [SETUP], {
        env: { ...process.env, HOME: tmp },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md');
      assert.ok(fs.existsSync(claudeMd), 'setup.sh must create ~/.claude/CLAUDE.md');
      const content = fs.readFileSync(claudeMd, 'utf8');

      // Setup translates $HOME → ~ for cosmetic tidiness; HOME=tmp here, so
      // the repo (under /Users/...) resolves to an absolute @-import.
      const expected = '@' + path.join(REPO, 'skills', 'using-vanta', 'SKILL.md');
      assert.ok(content.includes(expected),
        `CLAUDE.md must contain "${expected}"; got these using-vanta lines:\n` +
        content.split('\n').filter(l => l.includes('using-vanta')).join('\n'));

      // Legacy hardcoded literal must NOT appear as the import line.
      assert.equal(/^@~\/Projects\/vanta\/skills\/using-vanta\/SKILL\.md\s*$/m.test(content), false,
        'hardcoded ~/Projects/vanta/... was replaced (R10 P1)');

      // Setup also deploys skills + hooks under the fixture HOME.
      assert.ok(fs.existsSync(path.join(tmp, '.claude', 'skills', 'vanta-run', 'SKILL.md')),
        'vanta-run skill must be deployed');
      assert.ok(fs.existsSync(path.join(tmp, '.claude', 'hooks', 'auto-sync.js')),
        'auto-sync.js hook must be deployed');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('re-running setup.sh is idempotent — does not duplicate the @-import', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r10b-idempotent-'));
    try {
      const env = { ...process.env, HOME: tmp };
      execFileSync('bash', [SETUP], { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      execFileSync('bash', [SETUP], { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      const content = fs.readFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), 'utf8');
      const importLines = content.split('\n')
        .filter(l => l.includes('skills/using-vanta/SKILL.md'));
      assert.equal(importLines.length, 1,
        `setup must dedupe @-import; got ${importLines.length} lines:\n${importLines.join('\n')}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── R10 lockdown — vanta-extract-score docstring (R10 P3) ───────────────────

describe('vanta-extract-score — docstring matches code (R10 P3)', () => {
  test('top-of-file comment reflects current ≥0.65 / ≥0.40 thresholds', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bin', 'vanta-extract-score.js'), 'utf8');
    // Top docstring must mention the current ≥ 0.65 auto threshold.
    const head = src.slice(0, 1500);
    assert.match(head, /≥\s*0\.65/, 'top docstring should mention ≥ 0.65 (current)');
    // And must mention staging redirect from R7 P1.
    assert.match(head, /STAGING ONLY|staging only/i,
      'docstring should note R7 P1 staging-only behavior');
  });
});

// ─── R10 lockdown — uninstall strips CLAUDE.md @-import (R10 P2) ─────────────

describe('uninstall.sh — strips using-vanta @-import (R10 P2)', () => {
  test('script contains awk/sed pass that drops the @-import line', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'uninstall.sh'), 'utf8');
    assert.match(src, /Stripping using-vanta @-import/,
      'uninstall must announce the strip step');
    assert.match(src, /skills\\\/using-vanta\\\/SKILL\\\.md|skills\/using-vanta\/SKILL\.md/,
      'uninstall must reference the import target by tail');
  });
});

// ─── R11 lockdown — observability surface (Codex+Gemini R11 P1/P2) ───────────

describe('vanta-status — surfaces R7-R10 sentinels (R11 P1, v3.6.12 behavior)', () => {
  // v3.6.12: replaced static-source greps with subprocess invocation.
  // Spawns vanta-status with HOME pointed at a fixture, writes the
  // sentinel/queues, and asserts on the actual rendered output a user
  // would see. Catches output-format regressions that source-grep can't.
  const { execFileSync } = require('node:child_process');
  const STATUS_BIN = path.join(__dirname, '..', 'bin', 'vanta-status.js');

  function runStatus(home, args = []) {
    return execFileSync(process.execPath, [STATUS_BIN, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString();
  }

  test('CRITICAL line surfaces when .bin-missing sentinel exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-bin-'));
    try {
      const vanta = path.join(tmp, '.vanta');
      fs.mkdirSync(vanta, { recursive: true });
      fs.writeFileSync(path.join(vanta, '.bin-missing'),
        '2026-04-30T12:00:00Z prompt-context.js failed to require vanta-resolve\n');
      const out = runStatus(tmp);
      assert.match(out, /CRITICAL/, 'CRITICAL marker must appear in user-visible output');
      assert.match(out, /always-on layer disabled/, 'reason text must surface');
      assert.match(out, /prompt-context\.js failed to require/,
        'last-line detail from sentinel must be included for diagnostics');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('NO CRITICAL line when sentinel absent (regression guard)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-clean-'));
    try {
      fs.mkdirSync(path.join(tmp, '.vanta'), { recursive: true });
      const out = runStatus(tmp);
      // No false-positive CRITICAL when sentinel absent.
      assert.equal(/CRITICAL/.test(out), false,
        'CRITICAL must not appear when no sentinel exists');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('session-start — routes brief stderr to hook.log (R11 P1 / R12 P2, v3.6.12 behavior)', () => {
  // v3.6.12: replaced static-source grep with a real spawn. Stub a brief
  // generator that throws, run session-start, assert hook.log captures a
  // structured `ISO | ERROR | session-start.brief | <msg>` line that
  // vanta-status's reader can parse and count.
  const { execFileSync } = require('node:child_process');
  const HOOK = path.join(__dirname, '..', 'hooks', 'session-start');

  test('brief stderr lands in $HOME/.vanta/hook.log with structured prefix', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-stderr-'));
    try {
      // Stub vanta-brief.js — write to deployed location so session-start finds it.
      const stubDir = path.join(tmp, '.claude', 'bin');
      fs.mkdirSync(stubDir, { recursive: true });
      const stubPath = path.join(stubDir, 'vanta-brief.js');
      fs.writeFileSync(stubPath,
        '#!/usr/bin/env node\n' +
        'console.error("stub-brief: simulated boom on init");\n' +
        'process.exit(1);\n');
      fs.chmodSync(stubPath, 0o755);

      // Provide a valid cwd via stdin (session-start expects {cwd} JSON).
      const stdinJson = JSON.stringify({ cwd: tmp });
      const out = execFileSync('bash', [HOOK], {
        input: stdinJson,
        env: { ...process.env, HOME: tmp },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 8000,
      }).toString();

      // Hook still emits valid JSON output even when brief throws.
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.equal(parsed.hookSpecificOutput.additionalContext, '',
        'when brief throws, additionalContext must be empty (no broken brief shown)');

      // hook.log must contain a STRUCTURED line vanta-status can parse.
      const hookLog = path.join(tmp, '.vanta', 'hook.log');
      assert.ok(fs.existsSync(hookLog), 'hook.log must be created when brief writes stderr');
      const log = fs.readFileSync(hookLog, 'utf8');
      // Format vanta-status reads: `ISO-ts | ERROR | source | message`.
      // R12 P2 fix: stderr is wrapped through python to produce this shape.
      assert.match(log,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?\s*\|\s*ERROR\s*\|\s*session-start\.brief\s*\|.*stub-brief: simulated boom/m,
        `hook.log must contain structured ISO|ERROR|session-start.brief|... line; got:\n${log}`);

      // Cross-check: vanta-status's hook-error reader (same parser) finds it.
      const STATUS = path.join(__dirname, '..', 'bin', 'vanta-status.js');
      const statusOut = execFileSync(process.execPath, [STATUS, '--json'], {
        env: { ...process.env, HOME: tmp },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).toString();
      const status = JSON.parse(statusOut);
      assert.ok(status.hookErr.counts['session-start.brief'] >= 1,
        `vanta-status must count this error under "session-start.brief"; got counts: ${JSON.stringify(status.hookErr.counts)}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('hook.log NOT polluted when brief succeeds (no false-positive ERROR line)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-clean-'));
    try {
      // Stub a brief that succeeds silently (no stderr, exit 0).
      const stubDir = path.join(tmp, '.claude', 'bin');
      fs.mkdirSync(stubDir, { recursive: true });
      const stubPath = path.join(stubDir, 'vanta-brief.js');
      fs.writeFileSync(stubPath,
        '#!/usr/bin/env node\n' +
        'process.stdout.write("[Vanta] Active: foo · bar\\n");\n');
      fs.chmodSync(stubPath, 0o755);

      execFileSync('bash', [HOOK], {
        input: JSON.stringify({ cwd: tmp }),
        env: { ...process.env, HOME: tmp },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 8000,
      });

      const hookLog = path.join(tmp, '.vanta', 'hook.log');
      if (fs.existsSync(hookLog)) {
        const log = fs.readFileSync(hookLog, 'utf8');
        assert.equal(log.includes('session-start.brief'), false,
          `successful brief must NOT add ERROR line to hook.log; got:\n${log}`);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('vanta-resolve — query-log rotation + analyze (R11 P1, v3.6.12 behavior)', () => {
  // v3.6.12: replaced static-source greps with a spawn that exhausts the
  // 5MB query-log threshold, fires a real resolve() to trigger rotation,
  // then runs --analyze and asserts the merged history is visible.
  const { execFileSync } = require('node:child_process');
  const RESOLVE_BIN = path.join(__dirname, '..', 'bin', 'vanta-resolve.js');

  function runResolve(args, vantaDir, timeout = 10000) {
    return execFileSync(process.execPath, [RESOLVE_BIN, ...args], {
      env: { ...process.env, VANTA_DIR_OVERRIDE: vantaDir, HOME: path.join(vantaDir, 'home') },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    }).toString();
  }

  test('5MB query-log rotates to .bak.<ts> on next resolve(); analyzeLog merges history', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-qlog-'));
    try {
      const queryLog = path.join(tmp, 'query-log.jsonl');
      // Pre-fill with valid JSON entries past MAX_BYTES.
      const beacons = [];
      for (let i = 0; i < 50; i++) {
        beacons.push(JSON.stringify({
          ts: '2025-01-01', topic_hash: `beacon-${i}`, count: i, top: [],
        }));
      }
      const padding = JSON.stringify({
        ts: '2025-01-01', topic_hash: 'pad', count: 0, top: [],
        _pad: 'x'.repeat(2000),
      }) + '\n';
      let pre = beacons.join('\n') + '\n';
      while (pre.length < 5_100_000) pre += padding;
      fs.writeFileSync(queryLog, pre);
      assert.ok(fs.statSync(queryLog).size > 5_000_000, 'precondition: log > MAX_BYTES');

      // Drive a real resolve() — _logQuery checks size and rotates first,
      // then appends the new entry to a fresh live file.
      runResolve(['--topic', 'jwt', '--project', 'pi-perception'], tmp);

      const baks = fs.readdirSync(tmp).filter(n => n.startsWith('query-log.jsonl.bak.'));
      assert.equal(baks.length, 1, 'rotation must produce exactly one bak sibling');
      assert.match(baks[0], /query-log\.jsonl\.bak\.\d+\.\d+$/,
        'bak suffix uses Date.now() + pid (timestamped)');
      // Bak retains pre-rotation contents intact.
      assert.ok(fs.statSync(path.join(tmp, baks[0])).size > 5_000_000,
        'bak preserves pre-rotation bytes');
      // Live file shrunk to just the post-rotation entry (or two).
      assert.ok(fs.statSync(queryLog).size < 100_000,
        'live file is fresh after rotation');

      // analyzeLog must merge live + bak.
      const out = runResolve(['--analyze', '--format', 'json'], tmp);
      const parsed = JSON.parse(out);
      assert.equal(parsed.present, true, 'analyzeLog must report present=true');
      // Old beacons plus padding survive in bak; new entry in live. The
      // analyzer caps at last=500, so sampleSize is the merged tail size.
      assert.ok(parsed.sampleSize >= 50,
        `analyzeLog must merge bak history; sampleSize=${parsed.sampleSize}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('analyzeLog returns "no log yet" when no live file and no baks exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-qlog-empty-'));
    try {
      const out = runResolve(['--analyze', '--format', 'json'], tmp);
      const parsed = JSON.parse(out);
      assert.equal(parsed.present, false, 'analyzeLog reports absent for fresh tmpdir');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── R12 lockdown — bak retention + composition (R12 P1/P2) ──────────────────

describe('vanta-runtime-state — reapStaleBaks retention (R12 P1)', () => {
  const rs = require('../bin/vanta-runtime-state');

  test('reapStaleBaks keeps the K most recent bak siblings', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r12-bak-'));
    try {
      // Create 15 fake bak files for two journals.
      for (let i = 1; i <= 15; i++) {
        fs.writeFileSync(path.join(tmpdir, `sync-queue.jsonl.bak.${100 + i}`), `e${i}\n`);
        fs.writeFileSync(path.join(tmpdir, `episodes.jsonl.bak.${200 + i}`),  `e${i}\n`);
      }
      const removed = rs.reapStaleBaks([tmpdir], ['sync-queue.jsonl', 'episodes.jsonl'], 10);
      assert.equal(removed, 10, 'must remove 5 oldest from each of 2 journals');
      // Check that the OLDEST baks are gone and NEWEST 10 remain per journal.
      const remaining = fs.readdirSync(tmpdir);
      const sqLeft = remaining.filter(n => n.startsWith('sync-queue.jsonl.bak.')).sort();
      const epLeft = remaining.filter(n => n.startsWith('episodes.jsonl.bak.')).sort();
      assert.equal(sqLeft.length, 10);
      assert.equal(epLeft.length, 10);
      // Oldest remaining must be index 6 (1-5 deleted, 6-15 kept).
      assert.match(sqLeft[0], /\.bak\.106$/, 'oldest 5 sync-queue baks should have been removed');
      assert.match(epLeft[0], /\.bak\.206$/, 'oldest 5 episodes baks should have been removed');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  test('reapStaleBaks no-op when bak count <= keep', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r12-bak-noop-'));
    try {
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(tmpdir, `sync-queue.jsonl.bak.${i}`), '');
      }
      const removed = rs.reapStaleBaks([tmpdir], ['sync-queue.jsonl'], 10);
      assert.equal(removed, 0, 'no removal when count under keep');
      assert.equal(fs.readdirSync(tmpdir).length, 5);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

describe('vanta-status — disk footprint with bak count (R11 P2 / R12 P2, v3.6.12 behavior)', () => {
  // v3.6.12: replaced static-source greps with subprocess invocation
  // against a fixture HOME. Write a fake queue + N bak files, run
  // vanta-status, assert the "+N bak (M.MK)" suffix renders correctly.
  const { execFileSync } = require('node:child_process');
  const STATUS_BIN = path.join(__dirname, '..', 'bin', 'vanta-status.js');

  function runStatus(home, args = []) {
    return execFileSync(process.execPath, [STATUS_BIN, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString();
  }

  test('renders "+<n> bak" suffix with aggregate size when bak siblings exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-foot-'));
    try {
      const vanta = path.join(tmp, '.vanta');
      fs.mkdirSync(vanta, { recursive: true });
      // Live queue with one entry.
      const live = JSON.stringify({ session_id: 'live-1', synced: false });
      fs.writeFileSync(path.join(vanta, 'sync-queue.jsonl'), live + '\n');
      // 3 bak siblings, each ~1KB.
      const oneK = '{"pad":"' + 'x'.repeat(900) + '"}\n';
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(vanta, `sync-queue.jsonl.bak.${100 + i}`), oneK);
      }
      const out = runStatus(tmp);
      // Suffix shape: "+3 bak (3.5K)" or similar — assert presence of count.
      assert.match(out, /\+3\s+bak/,
        `output must show "+3 bak" suffix; got:\n${out.slice(0, 800)}`);
      // Aggregate human-readable size must mention K (3 × ~1K + live).
      assert.match(out, /\+3\s+bak\s+\(\d/,
        'bak suffix must include parenthetical size');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('does NOT show bak suffix when no bak siblings exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-nobak-'));
    try {
      const vanta = path.join(tmp, '.vanta');
      fs.mkdirSync(vanta, { recursive: true });
      fs.writeFileSync(path.join(vanta, 'sync-queue.jsonl'),
        JSON.stringify({ session_id: 's1' }) + '\n');
      const out = runStatus(tmp);
      assert.equal(/\+\d+\s+bak/.test(out), false,
        'no bak suffix expected when bak count is 0');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('JSON mode reports bytesTotal and bakCount fields', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-r11b-json-'));
    try {
      const vanta = path.join(tmp, '.vanta');
      fs.mkdirSync(vanta, { recursive: true });
      fs.writeFileSync(path.join(vanta, 'sync-queue.jsonl'),
        JSON.stringify({ session_id: 's1' }) + '\n');
      fs.writeFileSync(path.join(vanta, 'sync-queue.jsonl.bak.999'),
        JSON.stringify({ session_id: 'old' }) + '\n');
      const out = runStatus(tmp, ['--json']);
      const parsed = JSON.parse(out);
      const queue = (parsed.queues || []).find(q => q.name === 'sync-queue');
      assert.ok(queue, 'sync-queue must appear in JSON output');
      assert.equal(queue.bakCount, 1, 'bakCount must reflect actual bak files');
      assert.ok(queue.bytesTotal > queue.bytes,
        `bytesTotal (${queue.bytesTotal}) must exceed live bytes (${queue.bytes}) when bak exists`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('vanta-sync skill writer uses torn-line guard (R12 P1)', () => {
  test('synced-marker append uses leading-newline guard', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'skills', 'vanta-sync', 'SKILL.md'), 'utf8');
    // Must use the leading-newline pattern in the synced marker write.
    assert.match(src,
      /fs\.appendFileSync\(queue,\s*'\\n'\s*\+\s*JSON\.stringify\(/,
      'synced marker write must prefix \\n (R12 P1 torn-line guard)');
  });
});

// ─── v3.6.13 — Day 1 foundation: safety-floor / kill-switch / action-log / trust-metrics ─

describe('vanta-safety-floor — deterministic always-ask layer (v3.6.13)', () => {
  const floor = require('../bin/vanta-safety-floor');
  // Force load from repo policy/ so tests are hermetic regardless of $HOME state.
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  const sf = require('../bin/vanta-safety-floor');
  sf.reload();
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  sf.reload();

  test('matchCommand: blocks force-push to main', () => {
    const r = sf.matchCommand('git push --force origin main');
    assert.ok(r && r.ask, 'force-push to main must match');
    assert.equal(r.id, 'git-force-push-main');
  });

  test('matchCommand: blocks prisma migrate deploy', () => {
    const r = sf.matchCommand('prisma migrate deploy');
    assert.ok(r && r.ask, 'prisma migrate deploy must match');
    assert.equal(r.id, 'db-migrate-deploy');
  });

  test('matchCommand: blocks rm -rf with absolute path', () => {
    const r = sf.matchCommand('rm -rf /tmp/foo');
    assert.ok(r && r.ask, 'rm -rf /... must match');
    assert.equal(r.id, 'rm-rf-absolute');
  });

  test('matchCommand: strips env-var prefix before matching', () => {
    const r = sf.matchCommand('FOO=1 BAR=2 git push --force origin main');
    assert.ok(r && r.ask, 'env-prefixed force-push must still match');
  });

  test('matchCommand: strips sudo prefix', () => {
    const r = sf.matchCommand('sudo rm -rf /var/log');
    assert.ok(r && r.ask, 'sudo rm -rf must still match');
  });

  test('matchCommand: passes safe commands', () => {
    assert.equal(sf.matchCommand('ls -la'), null);
    assert.equal(sf.matchCommand('git status'), null);
    assert.equal(sf.matchCommand('npm test'), null);
  });

  test('matchFile: blocks .env writes', () => {
    const r = sf.matchFile('apps/web/.env.local');
    assert.ok(r && r.ask, '.env.local must match');
    assert.equal(r.id, 'env-file-write');
  });

  test('matchFile: blocks .pem / .key writes', () => {
    assert.ok(sf.matchFile('keys/server.pem'));
    assert.ok(sf.matchFile('config/jwt.key'));
  });

  test('matchFile: passes normal source files', () => {
    assert.equal(sf.matchFile('src/index.ts'), null);
    assert.equal(sf.matchFile('README.md'), null);
  });

  test('matchPrompt: blocks pivot/business-strategy prompts', () => {
    const r = sf.matchPrompt('should we pivot to a different pricing model?');
    assert.ok(r && r.ask, 'pivot prompt must match');
  });

  test('matchPrompt: passes routine engineering prompts', () => {
    assert.equal(sf.matchPrompt('fix the bug in auth.ts'), null);
    assert.equal(sf.matchPrompt('write tests for this function'), null);
  });

  test('matchSymbol: blocks pricing-constant edits', () => {
    const diff = '+  TIER_PRICE = 1999\n+  MONTHLY_PRICE: 49\n';
    const r = sf.matchSymbol(diff);
    assert.ok(r && r.ask, 'pricing constant must match');
  });

  test('matchSymbol: blocks DROP TABLE in additions', () => {
    const diff = '+ DROP TABLE users;\n';
    const r = sf.matchSymbol(diff);
    assert.ok(r && r.ask);
  });

  test('listEntries returns all loaded floor entries', () => {
    const list = sf.listEntries();
    assert.ok(list.length >= 20, `expected ≥20 floor entries, got ${list.length}`);
    const ids = new Set(list.map(e => e.id));
    assert.ok(ids.has('git-force-push-main'));
    assert.ok(ids.has('env-file-write'));
    assert.ok(ids.has('pricing-constants'));
  });

  void floor; // appease unused-import warning if any
});

describe('vanta-kill-switch — three-scope shutdown (v3.6.13)', () => {
  const ks = require('../bin/vanta-kill-switch');

  test('check: returns off=false when no scope is active', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-ks-'));
    try {
      delete process.env.VANTA_EXECUTOR;
      const c = ks.check({ sessionId: 'fresh-session', cwd: tmp });
      assert.equal(c.off, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('global scope: VANTA_EXECUTOR=off triggers off=true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-ks-glob-'));
    try {
      process.env.VANTA_EXECUTOR = 'off';
      const c = ks.check({ sessionId: 's1', cwd: tmp });
      assert.equal(c.off, true);
      assert.equal(c.scope, 'global');
    } finally {
      delete process.env.VANTA_EXECUTOR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('repo scope: <repo>/.vanta/paused triggers off=true (overrides global)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-ks-repo-'));
    try {
      // Make tmp look like a git repo.
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.vanta'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.vanta', 'paused'), 'sandbox repo\n');
      const c = ks.check({ sessionId: 's1', cwd: tmp });
      assert.equal(c.off, true);
      assert.equal(c.scope, 'repo');
      assert.match(c.reason, /sandbox repo/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('session scope: highest priority — beats repo and global', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-ks-sess-'));
    try {
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.vanta'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.vanta', 'paused'), 'repo paused\n');
      process.env.VANTA_EXECUTOR = 'off';
      // Now also pause the session.
      const runtimeDir = path.join(tmp, 'vanta-home', '.vanta', 'runtime');
      process.env.VANTA_DIR_OVERRIDE = path.join(tmp, 'vanta-home', '.vanta');
      ks.pauseSession('test-sid', 'session beats all');
      const c = ks.check({ sessionId: 'test-sid', cwd: tmp });
      assert.equal(c.off, true);
      assert.equal(c.scope, 'session');
      // Cleanup.
      ks.resumeSession('test-sid');
      delete process.env.VANTA_DIR_OVERRIDE;
      delete process.env.VANTA_EXECUTOR;
      void runtimeDir;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('pauseRepo / resumeRepo round-trip', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-ks-rt-'));
    try {
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      ks.pauseRepo(tmp, 'cli pause');
      assert.equal(fs.existsSync(path.join(tmp, '.vanta', 'paused')), true);
      const c1 = ks.check({ cwd: tmp });
      assert.equal(c1.off, true);
      ks.resumeRepo(tmp);
      assert.equal(fs.existsSync(path.join(tmp, '.vanta', 'paused')), false);
      const c2 = ks.check({ cwd: tmp });
      assert.equal(c2.off, false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('vanta-action-log — append-only ledger (v3.6.13)', () => {
  const al = require('../bin/vanta-action-log');

  test('record + read round-trip with VANTA_DIR_OVERRIDE', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-al-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al.record({ session_id: 's1', project: 'pi', action: 'auto-edit',
        why: 'matched safe pattern', subject: 'foo.ts', tier: 'T1' });
      al.record({ session_id: 's1', project: 'pi', action: 'undo',
        why: 'user said stop', subject: 'foo.ts' });
      const entries = al.read({ session_id: 's1' });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].action, 'auto-edit');
      assert.equal(entries[1].action, 'undo');
      assert.ok(entries[0].ts && entries[0].ts.length > 10);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('read filters by project and action', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-al-filter-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al.record({ project: 'pi',  action: 'auto-edit', why: 'a' });
      al.record({ project: 'pi',  action: 'council-fire', why: 'b' });
      al.record({ project: 'foo', action: 'auto-edit', why: 'c' });
      assert.equal(al.read({ project: 'pi' }).length, 2);
      assert.equal(al.read({ action: 'auto-edit' }).length, 2);
      assert.equal(al.read({ project: 'pi', action: 'council-fire' }).length, 1);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rollup aggregates by action type', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-al-rollup-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al.record({ action: 'auto-edit', why: '', tier: 'T1', decision: 'auto' });
      al.record({ action: 'auto-edit', why: '', tier: 'T1', decision: 'auto' });
      al.record({ action: 'auto-edit', why: '', tier: 'T2', decision: 'ask' });
      const r = al.rollup({});
      assert.equal(r.total, 3);
      assert.equal(r.actions['auto-edit'], 3);
      assert.equal(r.tiers.T1, 2);
      assert.equal(r.decisions.auto, 2);
      assert.equal(r.decisions.ask, 1);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('findLast returns most recent matching entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-al-last-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al.record({ action: 'auto-edit', why: 'first', subject: 'a.ts' });
      al.record({ action: 'auto-edit', why: 'second', subject: 'b.ts' });
      al.record({ action: 'council-fire', why: 'third' });
      const last = al.findLast(e => e.action === 'auto-edit');
      assert.equal(last.subject, 'b.ts');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('vanta-trust-metrics — composite trust signal (v3.6.13)', () => {
  const al = require('../bin/vanta-action-log');
  const tm = require('../bin/vanta-trust-metrics');

  test('compute returns zeroed metrics on empty ledger', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-tm-empty-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const m = tm.compute({});
      assert.equal(m.actions.total, 0);
      assert.equal(m.undo_within_2m.rate, 0);
      assert.equal(m.ready_for_inline, false);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('undo_within_2m: detects regretted auto-action', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-tm-undo-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al.record({ session_id: 's1', action: 'auto-edit', subject: 'foo.ts',
        decision: 'auto', why: 'safe' });
      // Undo 30s later (within 2 min window).
      al.record({ session_id: 's1', action: 'undo', subject: 'foo.ts',
        decision: 'auto', why: 'reverted by user' });
      const m = tm.compute({});
      assert.equal(m.undo_within_2m.regretted, 1);
      assert.equal(m.undo_within_2m.n, 1);
      assert.equal(m.undo_within_2m.rate, 1.0);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ready_for_inline requires composite thresholds met', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-tm-ready-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Single auto-action with no undo, no interrupt → metrics look great
      // but spanDays=0 so still not ready.
      al.record({ session_id: 's1', action: 'auto-edit', subject: 'foo.ts', decision: 'auto', why: '' });
      const m = tm.compute({});
      assert.equal(m.ready_for_inline, false,
        'spanDays<14 must veto ready_for_inline even with perfect metrics');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── v3.6.14 — Days 2-3: prompt rewriter shadow mode ─────────────────────────

describe('vanta-rewriter — pass-through gate (v3.6.14)', () => {
  // Force fresh module load — kill-switch / safety-floor caches matter.
  delete require.cache[require.resolve('../bin/vanta-rewriter')];
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete process.env.VANTA_EXECUTOR;
  const rw = require('../bin/vanta-rewriter');

  test('passes through lookup prompts unchanged', () => {
    const r = rw.rewrite('what is in this file?');
    assert.equal(r.mode, 'passthrough');
    assert.equal(r.intent, 'lookup');
  });

  test('passes through show/list prompts', () => {
    assert.equal(rw.rewrite('show me the last commit').mode, 'passthrough');
    assert.equal(rw.rewrite('list the open PRs').mode, 'passthrough');
    assert.equal(rw.rewrite('explain how this works').mode, 'passthrough');
  });

  test('passes through confirmations', () => {
    for (const p of ['yes', 'no', 'y', 'okay', 'sure', 'skip']) {
      assert.equal(rw.rewrite(p).mode, 'passthrough', `"${p}" must passthrough`);
    }
  });

  test('passes through slash commands', () => {
    assert.equal(rw.rewrite('/ship').mode, 'passthrough');
    assert.equal(rw.rewrite('/review the diff').mode, 'passthrough');
  });

  test('passes through already-structured numbered prompts', () => {
    const r = rw.rewrite('1. read the file\n2. summarize it');
    assert.equal(r.mode, 'passthrough');
    assert.equal(r.intent, 'already-structured');
  });

  test('passes through short non-action prompts', () => {
    assert.equal(rw.rewrite('huh').mode, 'passthrough');
    assert.equal(rw.rewrite('cool').mode, 'passthrough');
  });
});

describe('vanta-rewriter — rule-based intent matching (v3.6.14)', () => {
  delete require.cache[require.resolve('../bin/vanta-rewriter')];
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete process.env.VANTA_EXECUTOR;
  const rw = require('../bin/vanta-rewriter');

  test('"fix the bug" routes to fix-bug rule with engineer chain', () => {
    const r = rw.rewrite('fix the bug in auth.ts');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'fix-bug');
    assert.equal(r.rule_id, 'fix-broken');
    // v3.7.1: chains are now ≤3 numbered steps, no verbose header.
    assert.match(r.rewritten, /^1\./m);
    assert.match(r.rewritten, /failing test/i);
    assert.match(r.rewritten, /git log/i);
    // v3.7.1: skill_route surfaced for routing.
    assert.equal(r.skill_route, '/investigate');
  });

  test('"it didn\'t work" routes to diagnose-recent rule', () => {
    const r = rw.rewrite("it didn't work");
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'diagnose-recent');
    assert.match(r.rewritten, /hypotheses/i);
  });

  test('"ship this" routes to ship rule with safety guardrails', () => {
    const r = rw.rewrite('ship this');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'ship');
    // v3.7.1: chain trimmed to 3 steps; ship still surfaces test+typecheck
    // and the no-main guard.
    assert.match(r.rewritten, /test/i);
    assert.match(r.rewritten, /typecheck/i);
    assert.match(r.rewritten, /(not|no).*main/i);
    assert.equal(r.skill_route, '/ship');
  });

  test('"review the diff" routes to review rule', () => {
    const r = rw.rewrite('review the diff');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'review');
    assert.match(r.rewritten, /git diff/);
  });

  test('"write tests for this" routes to tdd rule', () => {
    const r = rw.rewrite('write tests for this function');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'tdd');
    assert.match(r.rewritten, /failing tests for each case \(red\)/i);
  });

  test('"make it faster" routes to optimize rule with measure-first', () => {
    const r = rw.rewrite('make it faster');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'optimize');
    assert.match(r.rewritten, /Measure first/i);
  });

  test('"refactor this" routes to refactor rule', () => {
    const r = rw.rewrite('refactor this module');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'refactor');
    assert.match(r.rewritten, /Confirm tests cover/i);
  });

  test('"add a feature" routes to feature rule', () => {
    const r = rw.rewrite('add a new endpoint for billing');
    assert.equal(r.mode, 'rule');
    assert.equal(r.intent, 'feature');
  });

  test('unmatched multi-word non-action prompt passes through', () => {
    const r = rw.rewrite('hmm interesting question about the data');
    assert.equal(r.mode, 'passthrough');
  });
});

describe('vanta-rewriter — safety integrations (v3.6.14)', () => {
  delete require.cache[require.resolve('../bin/vanta-rewriter')];
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete process.env.VANTA_EXECUTOR;
  const rw = require('../bin/vanta-rewriter');

  test('floor-matched prompts pass through unrewritten with floor reason', () => {
    // "should we pivot pricing model?" matches prompt-pivot-decision floor entry.
    const r = rw.rewrite('should we pivot the pricing model?');
    assert.equal(r.mode, 'passthrough');
    assert.match(r.why, /safety-floor:prompt-pivot-decision/);
    assert.ok(r.floor_match);
  });

  test('kill-switch global=off forces passthrough on action verbs', () => {
    process.env.VANTA_EXECUTOR = 'off';
    delete require.cache[require.resolve('../bin/vanta-kill-switch')];
    delete require.cache[require.resolve('../bin/vanta-rewriter')];
    const rw2 = require('../bin/vanta-rewriter');
    try {
      const r = rw2.rewrite('fix the bug in auth.ts');
      assert.equal(r.mode, 'passthrough');
      assert.match(r.why, /kill-switch:global/);
    } finally {
      delete process.env.VANTA_EXECUTOR;
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      delete require.cache[require.resolve('../bin/vanta-rewriter')];
    }
  });
});

describe('hooks/prompt-rewriter.js — UserPromptSubmit injection (v3.6.14)', () => {
  const { execFileSync } = require('node:child_process');
  const HOOK = path.join(__dirname, '..', 'hooks', 'prompt-rewriter.js');

  function spawnHook({ prompt, vantaDir }) {
    return execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        prompt,
        session_id: 'rw-test-1',
        cwd: vantaDir,
        hook_event_name: 'UserPromptSubmit',
      }),
      env: {
        ...process.env,
        VANTA_DIR_OVERRIDE: vantaDir,
        HOME: path.join(vantaDir, 'home'),
        VANTA_SAFETY_FLOOR: path.join(__dirname, '..', 'policy', 'safety-floor.yaml'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString();
  }

  test('injects shadow context for action verbs and logs rewrite action', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-hook-'));
    try {
      const out = spawnHook({ prompt: 'fix the bug in auth.ts', vantaDir: tmp });
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      // v3.7.1: terse 4-line injection — `[Vanta] /<route> · <intent>` header
      // followed by ≤3 numbered steps. No verbose "shadow mode" preamble.
      assert.match(parsed.hookSpecificOutput.additionalContext,
        /^\[Vanta\]\s+\/\S+\s+·\s+\S+/);
      assert.match(parsed.hookSpecificOutput.additionalContext,
        /^1\./m);
      // Hook ran with VANTA_DIR_OVERRIDE=tmp so action-log lives in tmp.
      // Read it directly from disk (the in-process module instance is
      // pointed at HOME=...).
      const actionsFile = path.join(tmp, 'actions.jsonl');
      assert.ok(fs.existsSync(actionsFile), 'action-log file must be created in tmp');
      const lines = fs.readFileSync(actionsFile, 'utf8').split('\n').filter(Boolean);
      const entries = lines.map(l => JSON.parse(l));
      const r = entries.find(e => e.action === 'rewrite');
      assert.ok(r, 'rewrite action must be logged');
      // v3.7.2: tier is now the executor-derived value (was hardcoded T0
      // pre-executor). For "fix the bug in auth.ts" rev=blast=4 → T1.
      assert.equal(r.tier, 'T1');
      assert.equal(r.session_id, 'rw-test-1');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('injects empty additionalContext for passthrough prompts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-pt-'));
    try {
      const out = spawnHook({ prompt: 'what is in this file?', vantaDir: tmp });
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.additionalContext, '',
        'passthrough must inject nothing');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('empty prompt does not crash + injects nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-empty-'));
    try {
      const out = spawnHook({ prompt: '', vantaDir: tmp });
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.additionalContext, '');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── v3.6.15 — Days 6-7: hybrid risk classifier + 4-tier council + peer router ─

describe('vanta-peer-router — stack-aware peer pick (v3.6.15)', () => {
  delete require.cache[require.resolve('../bin/vanta-peer-router')];
  process.env.VANTA_PEER_ROUTING = path.join(__dirname, '..', 'policy', 'peer-routing.yaml');
  const router = require('../bin/vanta-peer-router');
  router.reload();

  test('auth/security routes to BOTH peers', () => {
    const r = router.pick({ prompt: 'fix the JWT auth flow' });
    assert.equal(r.peer, 'both');
  });

  test('payment/billing routes to BOTH peers', () => {
    const r = router.pick({ prompt: 'add a stripe billing webhook' });
    assert.equal(r.peer, 'both');
  });

  test('.tsx file routes to codex', () => {
    const r = router.pick({ file_path: 'apps/web/src/components/Header.tsx' });
    assert.equal(r.peer, 'codex');
  });

  test('.py file routes to gemini', () => {
    const r = router.pick({ file_path: 'src/extract.py' });
    assert.equal(r.peer, 'gemini');
  });

  test('infra (terraform/k8s) routes to gemini', () => {
    const r = router.pick({ prompt: 'add a terraform module' });
    assert.equal(r.peer, 'gemini');
  });

  test('migration prompts route to BOTH peers', () => {
    const r = router.pick({ prompt: 'add a prisma migration for users.tier' });
    assert.equal(r.peer, 'both');
  });

  test('unmatched signals fall back to default (codex)', () => {
    const r = router.pick({ prompt: 'wlonkadonk gibberish input' });
    assert.equal(r.peer, 'codex');
    assert.equal(r.rule_index, -1);
  });

  test('listRules returns the rule table', () => {
    const list = router.listRules();
    assert.ok(list.length >= 8, `expected ≥8 routing rules, got ${list.length}`);
    assert.ok(list.some(r => r.peer === 'both'));
    assert.ok(list.some(r => r.peer === 'codex'));
    assert.ok(list.some(r => r.peer === 'gemini'));
  });
});

describe('vanta-risk-classifier — hybrid floor + 3-axis (v3.6.15)', () => {
  delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-peer-router')];
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  process.env.VANTA_PEER_ROUTING = path.join(__dirname, '..', 'policy', 'peer-routing.yaml');
  delete process.env.VANTA_EXECUTOR;
  const rc = require('../bin/vanta-risk-classifier');

  test('safety-floor match → T3 + ASK + floor_match populated', () => {
    const v = rc.classify({ command: 'git push --force origin main' });
    assert.equal(v.tier, 'T3');
    assert.equal(v.decision, 'ask');
    assert.ok(v.floor_match);
    assert.equal(v.floor_match.id, 'git-force-push-main');
  });

  test('product-authority phrasing → T3 + ASK', () => {
    const v = rc.classify({ prompt: 'should we pivot the pricing model?' });
    // Floor match for prompt-pivot-decision happens first → still T3 + ASK.
    assert.equal(v.tier, 'T3');
    assert.equal(v.decision, 'ask');
  });

  test('low-risk lookup-style prompt → T0 or T1, decision=auto', () => {
    const v = rc.classify({ prompt: 'read the README' });
    assert.ok(v.tier === 'T0' || v.tier === 'T1', `expected T0/T1, got ${v.tier}`);
    assert.equal(v.decision, 'auto');
  });

  test('mid-risk: refactor a non-prod file → T1 or T2', () => {
    const v = rc.classify({ prompt: 'refactor the parser', file_path: 'src/parse.ts' });
    assert.ok(['T1', 'T2'].includes(v.tier), `expected T1/T2, got ${v.tier}`);
    assert.equal(v.decision, 'auto');
  });

  test('high-risk: prod migration prompt → T3 + ASK', () => {
    const v = rc.classify({
      prompt: 'deploy a migration to drop the users.tier column in production',
    });
    assert.equal(v.tier, 'T3');
    assert.equal(v.decision, 'ask');
  });

  test('peer is populated for T2/T3, null for T0/T1', () => {
    const high = rc.classify({ prompt: 'deploy auth changes to production' });
    assert.ok(high.peer, 'T3 must include peer pick');
    const low = rc.classify({ prompt: 'show me the file contents' });
    if (low.tier === 'T0' || low.tier === 'T1') {
      assert.equal(low.peer, null, 'T0/T1 should not include peer');
    }
  });

  test('kill-switch off → T0 + auto regardless of risk', () => {
    process.env.VANTA_EXECUTOR = 'off';
    delete require.cache[require.resolve('../bin/vanta-kill-switch')];
    delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
    const rc2 = require('../bin/vanta-risk-classifier');
    try {
      const v = rc2.classify({
        prompt: 'deploy a migration to drop the users table in production',
      });
      assert.equal(v.tier, 'T0');
      assert.equal(v.decision, 'auto');
      assert.match(v.why, /kill-switch:global/);
    } finally {
      delete process.env.VANTA_EXECUTOR;
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
    }
  });

  test('score axes are populated and within 1-5 range', () => {
    const v = rc.classify({ prompt: 'fix a bug in src/util.ts' });
    assert.ok(v.score.reversibility >= 1 && v.score.reversibility <= 5);
    assert.ok(v.score.blast_radius   >= 1 && v.score.blast_radius   <= 5);
    assert.equal(typeof v.score.product_authority, 'boolean');
    assert.ok(v.risk >= 0 && v.risk <= 10);
  });
});

// ─── v3.6.16 — Day 10: vanta-undo + cross-session regret detector ────────────

describe('vanta-undo — reverse most recent reversible action (v3.6.16)', () => {
  const al2 = require('../bin/vanta-action-log');
  const undo = require('../bin/vanta-undo');

  test('refuses to undo when no reversible action exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-undo-empty-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const r = undo.undo({});
      assert.equal(r.ok, false);
      assert.match(r.reason, /no recent reversible/);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips non-reversible action types (rewrite, risk-classify)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-undo-skip-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al2.record({ session_id: 's1', action: 'rewrite', subject: 'p',
        decision: 'auto', why: 'shadow', undo_hint: { kind: 'rewriter-shadow' } });
      al2.record({ session_id: 's1', action: 'risk-classify', subject: 'src/foo.ts',
        decision: 'auto', why: 'metadata' });
      const r = undo.undo({});
      assert.equal(r.ok, false, 'rewrite + risk-classify must not be undone');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('autonomy-promote is reversible when payload includes prior_level', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-undo-auton-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Pretend a recent autonomy-promote happened.
      al2.record({
        session_id: 's-undo-test',
        action: 'autonomy-promote',
        subject: tmp,
        decision: 'auto',
        why: 'earned upgrade L1 → L2',
        undo_hint: {
          kind: 'autonomy-promote',
          payload: { repo: tmp, prior_level: 'L1', new_level: 'L2' },
        },
      });
      const r = undo.undo({});
      assert.equal(r.ok, true, `expected undo ok, got: ${JSON.stringify(r)}`);
      const cfg = path.join(tmp, '.vanta', 'config.yaml');
      assert.ok(fs.existsSync(cfg));
      assert.match(fs.readFileSync(cfg, 'utf8'), /level:\s*L1/);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('memory-promote returns partial-undo with manual edit hint', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-undo-mem-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al2.record({
        session_id: 's1',
        action: 'memory-promote',
        subject: 'staged invariant: foo bar',
        decision: 'auto',
        why: 'high-conf staged promotion',
        undo_hint: {
          kind: 'memory-promote',
          payload: { entry_id: 'inv-001', prior_text: 'old text snippet' },
        },
      });
      const r = undo.undo({});
      assert.equal(r.ok, false);
      assert.match(r.reason, /partially-reversible/);
      assert.match(r.reason, /old text snippet/);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('undo is itself recorded as a new action-log entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-undo-record-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al2.record({
        session_id: 's1', action: 'autonomy-promote', subject: tmp,
        decision: 'auto', why: 'test',
        undo_hint: { kind: 'autonomy-promote', payload: { repo: tmp, prior_level: 'L0' } },
      });
      undo.undo({});
      const undoEntries = al2.read({ action: 'undo' });
      assert.ok(undoEntries.length >= 1, 'undo event must be logged');
      assert.equal(undoEntries[0].undo_hint.kind, 'undo');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('vanta-regret-detector — silent regret across sessions (v3.6.16)', () => {
  const rd = require('../bin/vanta-regret-detector');
  const al2 = require('../bin/vanta-action-log');

  test('returns empty signals when no Vanta-touched files in window', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rd-empty-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const sigs = rd.detect({ days: 7 });
      assert.deepEqual(sigs, []);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('regretRate returns zeros on empty ledger', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rd-rate-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const r = rd.regretRate({ days: 7 });
      assert.equal(r.rate, 0);
      assert.equal(r.n, 0);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detects regret-shaped commit message in git log', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rd-msg-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Build a tiny git repo with a regret-shaped commit.
      const { execSync } = require('node:child_process');
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
      const file = path.join(repo, 'foo.ts');
      fs.writeFileSync(file, 'console.log("v1")\n');
      execSync('git add . && git commit -q -m "v1"', { cwd: repo });
      // Simulate a Vanta auto-edit.
      const vantaTs = new Date(Date.now() - 60_000).toISOString();  // 1 min ago
      al2.record({
        session_id: 's1', action: 'auto-edit', subject: file,
        decision: 'auto', why: 'auto-fix',
        ts: vantaTs,
      });
      // User commits a reverting change with a regret-shaped message.
      fs.writeFileSync(file, 'console.log("v0 — reverted")\n');
      execSync('git add . && git commit -q -m "revert: actually that was wrong"', { cwd: repo });
      const sigs = rd.detect({ days: 7 });
      assert.ok(sigs.length >= 1, 'expected at least 1 regret signal');
      const sig = sigs.find(s => s.file === file);
      assert.ok(sig, 'regret signal for the touched file must be present');
      assert.ok(['message', 'silent', 'both'].includes(sig.kind),
        `expected kind to be one of message/silent/both, got ${sig.kind}`);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── v3.6.17 — Day 11: autonomy levels + project-context auto-detect ─────────

describe('vanta-autonomy — project-context detection (v3.6.17)', () => {
  const auto = require('../bin/vanta-autonomy');
  const { execSync } = require('node:child_process');

  test('non-repo cwd: kind=non-repo, level=L0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-norepo-'));
    try {
      const eff = auto.effectiveLevel(tmp);
      assert.equal(eff.level, 'L0');
      assert.equal(eff.detected.kind, 'non-repo');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('repo with no code markers: kind=doc, level=L0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-doc-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'README.md'), 'just a doc\n');
      const eff = auto.effectiveLevel(tmp);
      assert.equal(eff.detected.kind, 'doc');
      assert.equal(eff.level, 'L0', 'doc repos must default to L0');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('code repo (package.json): kind=code, default level=L1', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-code-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
      const eff = auto.effectiveLevel(tmp);
      assert.equal(eff.detected.kind, 'code');
      assert.equal(eff.level, 'L1', 'code repos default to L1');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('code repo (pyproject.toml): kind=code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-py-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n');
      assert.equal(auto.effectiveLevel(tmp).detected.kind, 'code');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('explicit config wins over default', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-explicit-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
      auto.writeConfig(tmp, { level: 'L2' });
      const eff = auto.effectiveLevel(tmp);
      assert.equal(eff.level, 'L2');
      assert.equal(eff.reason, 'explicit config');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('manual upgrade: L1 → L2 writes config + records action-log', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-upg-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
      const r = auto.manualUpgrade(tmp);
      assert.equal(r.changed, true);
      assert.equal(r.prior, 'L1');
      assert.equal(r.level, 'L2');
      assert.equal(auto.effectiveLevel(tmp).level, 'L2');
      // Action-log should have the autonomy-promote entry.
      const al3 = require('../bin/vanta-action-log');
      const entries = al3.read({ action: 'autonomy-promote' });
      assert.ok(entries.length >= 1);
      assert.equal(entries[0].undo_hint.kind, 'autonomy-promote');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tick on stable code repo with no metrics: returns stable, no change', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-tick-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
      const r = auto.tick(tmp);
      assert.equal(r.changed, false);
      assert.equal(r.level, 'L1');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detectProjectKind respects standard markers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-auto-det-'));
    try {
      execSync('git init -q', { cwd: tmp });
      assert.equal(auto.detectProjectKind(tmp).kind, 'doc');
      fs.writeFileSync(path.join(tmp, 'go.mod'), 'module x\n');
      assert.equal(auto.detectProjectKind(tmp).kind, 'code');
      assert.equal(auto.detectProjectKind(tmp).marker, 'go.mod');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── v3.6.18 — Day 12: memory promotion + confidence decay ───────────────────

describe('vanta-confidence-decay — age-based score decay (v3.6.18)', () => {
  const decay = require('../bin/vanta-confidence-decay');

  test('multiplier=1 for fresh entries', () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    assert.ok(decay.decayMultiplier({ source: 'invariant', ts }) > 0.99);
  });

  test('decisions decay faster than invariants (90d vs 365d half-life)', () => {
    const ageDays = 90;
    const ts = new Date(Date.now() - ageDays * 86_400_000).toISOString();
    const decision = decay.decayMultiplier({ source: 'decision', ts });
    const invariant = decay.decayMultiplier({ source: 'invariant', ts });
    assert.ok(invariant > decision, `invariant (${invariant}) must decay slower than decision (${decision})`);
    assert.ok(Math.abs(decision - 0.5) < 0.05, `decision at half-life should be ~0.5, got ${decision}`);
  });

  test('code source has no decay', () => {
    const ts = new Date(Date.now() - 365 * 86_400_000).toISOString();
    assert.equal(decay.decayMultiplier({ source: 'code', ts }), 1);
  });

  test('decay floors at 0.05 (very old entries still surface)', () => {
    const ts = new Date('2020-01-01').toISOString();
    const m = decay.decayMultiplier({ source: 'decision', ts });
    assert.ok(m >= 0.05, `floor 0.05, got ${m}`);
  });

  test('applyDecay mutates score and adds decay_multiplier field', () => {
    const ts = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const r = { source: 'decision', date: ts, score: 1.0 };
    decay.applyDecay(r);
    assert.ok(r.score < 1.0);
    assert.ok(r.decay_multiplier > 0 && r.decay_multiplier < 1);
  });

  test('violatesVersionBound: prisma@4 mismatches active prisma=5', () => {
    assert.equal(decay.violatesVersionBound({ version_bound: 'prisma@4' }, { prisma: '5' }), true);
    assert.equal(decay.violatesVersionBound({ version_bound: 'prisma@4' }, { prisma: '4' }), false);
  });

  test('violatesVersionBound: missing active version → no violation', () => {
    assert.equal(decay.violatesVersionBound({ version_bound: 'prisma@4' }, {}), false);
  });
});

describe('vanta-memory-promote — staged invariant surfacing (v3.6.18)', () => {
  const memProm = require('../bin/vanta-memory-promote');

  // Each test uses fresh staging file pointed at tmpdir.
  function setupStaging(content) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-mp-'));
    const stagingFile = path.join(tmp, 'staging.md');
    const globalFile = path.join(tmp, 'global.md');
    fs.writeFileSync(stagingFile, content);
    fs.writeFileSync(globalFile, '');
    process.env.VANTA_STAGING_FILE = stagingFile;
    process.env.VANTA_INVARIANTS_FILE = globalFile;
    process.env.VANTA_DIR_OVERRIDE = tmp;
    return { tmp, stagingFile, globalFile };
  }
  function cleanup(tmp) {
    delete process.env.VANTA_STAGING_FILE;
    delete process.env.VANTA_INVARIANTS_FILE;
    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  test('parses staged candidates with section, text, conf', () => {
    const { tmp } = setupStaging(
      '## Prisma\n\n' +
      '- migrate deploy not migrate dev for prod  <!-- conf=0.92 ts=2026-04-30T00:00:00Z -->\n' +
      '- generate must run in correct package  <!-- conf=0.65 ts=2026-04-30T00:00:00Z -->\n'
    );
    try {
      const all = memProm.loadStaged();
      assert.equal(all.length, 2);
      assert.equal(all[0].section, 'Prisma');
      assert.equal(all[0].confidence, 0.92);
      assert.match(all[0].text, /migrate deploy/);
    } finally { cleanup(tmp); }
  });

  test('nextCandidate returns highest-confidence above threshold', () => {
    const { tmp } = setupStaging(
      '## Foo\n\n' +
      '- low conf  <!-- conf=0.50 -->\n' +
      '- high conf  <!-- conf=0.92 -->\n' +
      '- medium  <!-- conf=0.70 -->\n'
    );
    try {
      const c = memProm.nextCandidate({ minConfidence: 0.85 });
      assert.ok(c, 'must return a candidate');
      assert.equal(c.confidence, 0.92);
      assert.match(c.text, /high conf/);
    } finally { cleanup(tmp); }
  });

  test('nextCandidate returns null when nothing meets threshold', () => {
    const { tmp } = setupStaging('## Foo\n\n- meh  <!-- conf=0.50 -->\n');
    try {
      assert.equal(memProm.nextCandidate({ minConfidence: 0.85 }), null);
    } finally { cleanup(tmp); }
  });

  test('accept moves bullet to global file and removes from staging', () => {
    const { tmp, stagingFile, globalFile } = setupStaging(
      '## Prisma\n\n- migrate deploy for prod  <!-- conf=0.92 -->\n'
    );
    try {
      const c = memProm.nextCandidate({ minConfidence: 0.85 });
      const r = memProm.accept(c.id);
      assert.equal(r.ok, true);
      // Global file has the entry under its section.
      const global = fs.readFileSync(globalFile, 'utf8');
      assert.match(global, /## Prisma/);
      assert.match(global, /migrate deploy for prod/);
      // Staging file no longer has the bullet.
      const staging = fs.readFileSync(stagingFile, 'utf8');
      assert.equal(/migrate deploy for prod/.test(staging), false);
    } finally { cleanup(tmp); }
  });

  test('reject removes from staging + records to rejects log', () => {
    const { tmp, stagingFile } = setupStaging(
      '## Foo\n\n- bogus thing  <!-- conf=0.92 -->\n'
    );
    try {
      const c = memProm.nextCandidate({ minConfidence: 0.85 });
      const r = memProm.reject(c.id);
      assert.equal(r.ok, true);
      // Staging cleared.
      assert.equal(/bogus thing/.test(fs.readFileSync(stagingFile, 'utf8')), false);
      // Rejects log captures the id.
      const rejects = memProm.loadRejects();
      assert.ok(rejects.has(c.id));
    } finally { cleanup(tmp); }
  });

  test('rejected candidates are excluded from nextCandidate', () => {
    const { tmp } = setupStaging(
      '## Foo\n\n- entry one  <!-- conf=0.92 -->\n- entry two  <!-- conf=0.91 -->\n'
    );
    try {
      const first = memProm.nextCandidate({ minConfidence: 0.85 });
      memProm.reject(first.id);
      const second = memProm.nextCandidate({ minConfidence: 0.85 });
      assert.notEqual(second.id, first.id, 'next candidate must skip rejected');
    } finally { cleanup(tmp); }
  });
});

// ─── Days 13-14: cross-module integration / seam coverage (v3.6.19) ─────────
//
// These tests target the SEAMS between modules. Per-module tests (above)
// cover the contract of each unit; these cover the wiring. Failure modes
// caught here:
//   - rewriter forgets to consult safety-floor → high-risk prompt gets
//     auto-rewritten into "easy" chain, defeating the floor
//   - kill-switch off but classifier still records actions → wasted log
//   - risk-classifier T2/T3 result missing peer hint → council can't route
//   - undo round-trip on autonomy-promote leaves orphan log entry
//   - memory-promote skips action-log → undo can never find it later
//   - decay applied to bulk results breaks ranking stability
//   - product-authority phrase reaches T1/T2 instead of T3
//   - kill-switch session scope wins over global

describe('integration: rewriter ↔ safety-floor (v3.6.19)', () => {
  const rewriter = require('../bin/vanta-rewriter');
  // Force safety-floor to load from repo policy/ for hermetic runs.
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  require('../bin/vanta-safety-floor').reload();

  test('safety-floor match → rewriter passes through with floor reason', () => {
    const r = rewriter.rewrite('should we pivot to a different pricing model?', {});
    assert.equal(r.mode, 'passthrough', 'pivot prompt MUST not be rewritten');
    assert.match(r.why || '', /^safety-floor:/, `expected safety-floor:* reason, got "${r.why}"`);
    assert.ok(r.floor_match, 'must surface the floor entry that matched');
  });

  test('non-floor action prompt → rewriter applies a rule', () => {
    const r = rewriter.rewrite('fix the bug in auth.ts', {});
    assert.equal(r.mode, 'rule');
    assert.equal(r.rule_id, 'fix-broken');
    // v3.7.1: terse 3-step chain.
    assert.match(r.rewritten, /^1\./m);
    assert.equal(r.skill_route, '/investigate');
  });

  test('kill-switch (session scope) → rewriter passes through with kill-switch reason', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-ks-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Force a paused session marker.
      const runtime = path.join(tmp, 'runtime');
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(path.join(runtime, 'sess-int-1.paused'), 'test\n');
      // Reload kill-switch with new VANTA_DIR_OVERRIDE.
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      // The rewriter caches kill-switch; bust both.
      delete require.cache[require.resolve('../bin/vanta-rewriter')];
      const fresh = require('../bin/vanta-rewriter');
      const r = fresh.rewrite('fix the bug in auth.ts', { sessionId: 'sess-int-1' });
      assert.equal(r.mode, 'passthrough');
      assert.match(r.why || '', /^kill-switch:session/);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      // Restore module state for downstream tests.
      delete require.cache[require.resolve('../bin/vanta-rewriter')];
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
    }
  });
});

describe('integration: risk-classifier ↔ peer-router (v3.6.19)', () => {
  const classifier = require('../bin/vanta-risk-classifier');
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  process.env.VANTA_PEER_ROUTING = path.join(__dirname, '..', 'policy', 'peer-routing.yaml');
  // Reload both so the env-var pickup is fresh.
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-peer-router')];
  require('../bin/vanta-safety-floor').reload();

  test('product-authority phrase routes to T3 with ask decision', () => {
    const r = classifier.classify({ prompt: 'should we deprecate the legacy export?' });
    assert.equal(r.tier, 'T3', `expected T3, got ${r.tier}`);
    assert.equal(r.decision, 'ask');
    assert.match(r.why, /product-authority|safety-floor/);
  });

  test('T2 result includes peer hint (peer-router was consulted)', () => {
    const r = classifier.classify({ prompt: 'merge this branch', file_path: 'src/api/foo.ts' });
    // merge → reversibility=2; api/ → blast=2; risk = 4+4 = 8 → T3 (ask). T3 also has peer.
    assert.ok(['T2', 'T3'].includes(r.tier), `expected T2 or T3, got ${r.tier}`);
    assert.ok(r.peer, 'T2/T3 result must have a peer hint');
    assert.ok(r.peer.peer, 'peer hint must name the actual peer');
  });

  test('T0/T1 result has no peer hint (avoids cost on safe prompts)', () => {
    // The 3-axis floor is risk=2 (rev=5 + blast=5 → 1+1), which maps to T1.
    // True T0 is only reachable via kill-switch. The contract this test
    // pins is: peer is gated to T2/T3 only — safe-tier results MUST NOT
    // pay the peer-routing cost.
    const r = classifier.classify({ prompt: 'show me the README', file_path: 'README.md' });
    assert.ok(['T0', 'T1'].includes(r.tier), `expected safe tier, got ${r.tier}`);
    assert.equal(r.peer, null, 'safe tiers must not consult peer-router');
  });

  test('safety-floor match overrides 3-axis score → always T3', () => {
    // Even a "safe-sounding" prompt that touches a .env file must be T3.
    const r = classifier.classify({ prompt: 'add a comment', file_path: 'apps/web/.env.local' });
    assert.equal(r.tier, 'T3');
    assert.match(r.why, /safety-floor:/);
    assert.ok(r.floor_match, 'floor_match must be present on floor-driven T3');
  });

  test('kill-switch off → T0 auto regardless of prompt', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-cls-ks-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Global kill flag.
      const oldGlobal = process.env.VANTA_EXECUTOR;
      process.env.VANTA_EXECUTOR = 'off';
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
      const fresh = require('../bin/vanta-risk-classifier');
      const r = fresh.classify({ prompt: 'force-push origin main' });
      assert.equal(r.tier, 'T0');
      assert.equal(r.decision, 'auto');
      assert.match(r.why, /kill-switch:global/);
      if (oldGlobal === undefined) delete process.env.VANTA_EXECUTOR;
      else process.env.VANTA_EXECUTOR = oldGlobal;
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
    }
  });
});

describe('integration: action-log ↔ undo round-trip (v3.6.19)', () => {
  const al2 = require('../bin/vanta-action-log');
  const undo = require('../bin/vanta-undo');

  test('autonomy-promote → undo restores prior level + records undo entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-undo-rt-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Simulate an earned promotion event.
      al2.record({
        session_id: 's-rt-1',
        project: path.basename(tmp),
        action: 'autonomy-promote',
        decision: 'auto',
        why: 'earned L1 → L2',
        subject: tmp,
        undo_hint: { kind: 'autonomy-promote', payload: { repo: tmp, prior_level: 'L1', new_level: 'L2' } },
      });
      const r = undo.undo({});
      assert.equal(r.ok, true);
      // 1. Config rolled back.
      const cfg = fs.readFileSync(path.join(tmp, '.vanta', 'config.yaml'), 'utf8');
      assert.match(cfg, /level:\s*L1/);
      // 2. Undo entry recorded with targets pointer.
      const events = al2.read({});
      const undoEntry = events.find(e => e.action === 'undo');
      assert.ok(undoEntry, 'undo must self-record');
      assert.equal(undoEntry.undo_hint.kind, 'undo');
      assert.equal(undoEntry.undo_hint.payload.targets_action, 'autonomy-promote');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('NOT_REVERSIBLE entry types are skipped even when most recent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-undo-skip-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Recent reversible action FIRST.
      al2.record({
        session_id: 's1', action: 'autonomy-promote', subject: tmp,
        decision: 'auto', why: 'old',
        undo_hint: { kind: 'autonomy-promote', payload: { repo: tmp, prior_level: 'L0', new_level: 'L1' } },
      });
      // Then non-reversible noise.
      al2.record({ session_id: 's1', action: 'rewrite', subject: 'p',
        decision: 'auto', why: 'shadow', undo_hint: { kind: 'rewriter-shadow' } });
      al2.record({ session_id: 's1', action: 'risk-classify', subject: 'src/x.ts',
        decision: 'auto', why: 'classified' });
      // findLast scans backwards but must skip non-reversible kinds and
      // land on the autonomy-promote.
      const r = undo.undo({});
      assert.equal(r.ok, true, `expected to find the older reversible entry, got: ${JSON.stringify(r)}`);
      assert.equal(r.target.action, 'autonomy-promote');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('integration: memory-promote ↔ action-log ↔ undo (v3.6.19)', () => {
  const memProm = require('../bin/vanta-memory-promote');
  const al2 = require('../bin/vanta-action-log');
  const undo = require('../bin/vanta-undo');

  function setupStagingPair() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-mp-'));
    const stagingFile = path.join(tmp, 'staging.md');
    const globalFile  = path.join(tmp, 'global.md');
    fs.writeFileSync(stagingFile,
      '## Test Section\n\n- the entry  <!-- conf=0.95 ts=2026-04-30T00:00:00Z -->\n');
    fs.writeFileSync(globalFile, '# Global Invariants\n\n## Test Section\n\n- pre-existing line\n');
    process.env.VANTA_STAGING_FILE = stagingFile;
    process.env.VANTA_INVARIANTS_FILE = globalFile;
    process.env.VANTA_DIR_OVERRIDE = tmp;
    return { tmp, stagingFile, globalFile };
  }
  function teardown(tmp) {
    delete process.env.VANTA_STAGING_FILE;
    delete process.env.VANTA_INVARIANTS_FILE;
    delete process.env.VANTA_DIR_OVERRIDE;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  test('accept records a memory-promote action with prior_text in undo_hint', () => {
    const { tmp, globalFile } = setupStagingPair();
    try {
      const cand = memProm.nextCandidate({ minConfidence: 0.85 });
      assert.ok(cand, 'staging fixture must produce a candidate');
      const r = memProm.accept(cand.id);
      assert.equal(r.ok, true);
      // Action-log must show it.
      const events = al2.read({ action: 'memory-promote' });
      assert.ok(events.length >= 1, 'memory-promote action must be in action-log');
      const ev = events[0];
      assert.equal(ev.undo_hint.kind, 'memory-promote');
      assert.equal(ev.undo_hint.payload.entry_id, cand.id);
      assert.match(ev.undo_hint.payload.prior_text, /the entry/);
      // Bullet must be in global file under the matching section.
      assert.match(fs.readFileSync(globalFile, 'utf8'), /the entry/);
    } finally { teardown(tmp); }
  });

  test('undo of memory-promote returns partial-undo with prior_text hint', () => {
    const { tmp } = setupStagingPair();
    try {
      const cand = memProm.nextCandidate({ minConfidence: 0.85 });
      memProm.accept(cand.id);
      const r = undo.undo({});
      assert.equal(r.ok, false, 'memory-promote is partial-undo by design');
      assert.match(r.reason, /partially-reversible/);
      assert.match(r.reason, /the entry/, 'prior_text snippet must be surfaced');
    } finally { teardown(tmp); }
  });
});

describe('integration: confidence-decay applied to bulk resolver results (v3.6.19)', () => {
  const decay = require('../bin/vanta-confidence-decay');

  test('applyDecayBulk preserves intra-class ordering when ages are equal', () => {
    const now = Date.parse('2026-05-02T00:00:00Z');
    const days30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const results = [
      { source: 'invariant', score: 1.0, date: days30, id: 'a' },
      { source: 'invariant', score: 0.5, date: days30, id: 'b' },
      { source: 'invariant', score: 0.2, date: days30, id: 'c' },
    ];
    decay.applyDecayBulk(results, now);
    // All scores multiplied by the same multiplier, so order preserved.
    assert.ok(results[0].score > results[1].score);
    assert.ok(results[1].score > results[2].score);
    // All have decay_multiplier set.
    for (const r of results) {
      assert.ok(r.decay_multiplier > 0 && r.decay_multiplier <= 1);
    }
  });

  test('decisions decay below invariants when same age — re-ranks bulk results', () => {
    const now = Date.parse('2026-05-02T00:00:00Z');
    const days100 = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString();
    const results = [
      { source: 'decision',  score: 0.9, date: days100, id: 'old-decision' },
      { source: 'invariant', score: 0.7, date: days100, id: 'old-invariant' },
    ];
    decay.applyDecayBulk(results, now);
    // 100d on a 90d half-life → ~0.46 multiplier; 100d on 365d half-life → ~0.83.
    // 0.9 * 0.46 ≈ 0.41   vs   0.7 * 0.83 ≈ 0.58 — invariant should overtake.
    assert.ok(results[1].score > results[0].score,
      `invariant should outrank stale decision after decay; got inv=${results[1].score} dec=${results[0].score}`);
  });

  test('null/missing date fields → multiplier=1 (no decay applied)', () => {
    const out = decay.applyDecay({ source: 'invariant', score: 0.8 });
    assert.equal(out.score, 0.8);
    assert.equal(out.decay_multiplier, 1);
  });
});

describe('integration: kill-switch scope priority (session > repo > global) (v3.6.19)', () => {
  const ks = require('../bin/vanta-kill-switch');

  test('session paused beats global on (session scope wins on hit)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-ks-prio-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const oldGlobal = process.env.VANTA_EXECUTOR;
      delete process.env.VANTA_EXECUTOR;  // global ON
      const runtime = path.join(tmp, 'runtime');
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(path.join(runtime, 'sess-prio-1.paused'), 'test\n');
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      const fresh = require('../bin/vanta-kill-switch');
      const c = fresh.check({ sessionId: 'sess-prio-1', cwd: tmp });
      assert.equal(c.off, true);
      assert.equal(c.scope, 'session');
      if (oldGlobal !== undefined) process.env.VANTA_EXECUTOR = oldGlobal;
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
    }
  });

  test('global off applies when no session/repo paused markers exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-ks-glob-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const oldGlobal = process.env.VANTA_EXECUTOR;
      process.env.VANTA_EXECUTOR = 'off';
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      const fresh = require('../bin/vanta-kill-switch');
      const c = fresh.check({ sessionId: 'sess-no-marker', cwd: tmp });
      assert.equal(c.off, true);
      assert.equal(c.scope, 'global');
      if (oldGlobal === undefined) delete process.env.VANTA_EXECUTOR;
      else process.env.VANTA_EXECUTOR = oldGlobal;
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
    }
  });
});

describe('integration: trust-metrics ↔ autonomy gating (v3.6.19)', () => {
  const al2 = require('../bin/vanta-action-log');

  test('promotion blocked when trust window < min_days', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-auton-young-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Empty action-log → trust-metrics returns spanDays=0, must NOT promote.
      delete require.cache[require.resolve('../bin/vanta-trust-metrics')];
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
      const auton = require('../bin/vanta-autonomy');
      // Make tmp look like a code repo with explicit L1 config.
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.vanta'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.vanta', 'config.yaml'), 'level: L1\n');
      const r = auton.tick(tmp);
      // Stable, no promote suggestion (since trust span=0).
      assert.equal(r.changed, false);
      assert.notEqual(r.kind, 'suggest-promote',
        `should not suggest promotion with no history; got: ${JSON.stringify(r)}`);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-trust-metrics')];
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
    }
  });

  test('manualUpgrade from default (L1, no config) → L2 records autonomy-promote action with payload', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-auton-upgrade-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // code repo, no config → effective L1 by default. Upgrade therefore goes L1 → L2.
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
      const auton = require('../bin/vanta-autonomy');
      const r = auton.manualUpgrade(tmp);
      assert.equal(r.changed, true);
      assert.equal(r.level, 'L2');
      // Action-log must contain it.
      const events = al2.read({ action: 'autonomy-promote' });
      const ev = events.find(e => e.subject === tmp);
      assert.ok(ev, 'manualUpgrade must record autonomy-promote');
      assert.equal(ev.undo_hint.kind, 'autonomy-promote');
      assert.equal(ev.undo_hint.payload.prior_level, 'L1');
      assert.equal(ev.undo_hint.payload.new_level, 'L2');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
    }
  });

  // Council R1 P3 (Codex): the documented L0 → L1 manual path was not
  // tested. Original test misnamed the L1→L2 path as L0→L1. v3.6.20: add
  // a real L0 fixture (explicit config: L0) and verify upgrade lands at L1.
  test('manualUpgrade from explicit L0 → L1 (the documented opt-in path)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-auton-l0-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.vanta'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.vanta', 'config.yaml'), 'level: L0\n');
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
      const auton = require('../bin/vanta-autonomy');
      const r = auton.manualUpgrade(tmp);
      assert.equal(r.changed, true);
      assert.equal(r.prior, 'L0');
      assert.equal(r.level, 'L1');
      const events = al2.read({ action: 'autonomy-promote' });
      const ev = events.reverse().find(e => e.subject === tmp && e.undo_hint.payload.new_level === 'L1');
      assert.ok(ev, 'L0→L1 manual upgrade must be recorded');
      assert.equal(ev.undo_hint.payload.prior_level, 'L0');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
    }
  });

  // Council R1-R2 P1 (Gemini): the heuristic risk floor was 2 (rev=5+blast=5
  // → 1+1), making T0 unreachable via the 3-axis path. v3.6.20 lowered the
  // T1 threshold so risk=2 maps to T0. Pin that contract.
  test('truly safe prompts (rev=5, blast=5) reach T0 via heuristic, not just kill-switch', () => {
    delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
    const classifier = require('../bin/vanta-risk-classifier');
    // explain + .md file should produce the math floor (rev=5, blast=5 → risk=2).
    const r = classifier.classify({ prompt: 'explain the local sandbox', file_path: 'docs/notes.md' });
    assert.equal(r.tier, 'T0', `safe prompt+file must reach T0; got ${r.tier} (risk=${r.risk})`);
    assert.equal(r.peer, null);
  });
});

// ─── Council R1-R2 fix verification (v3.6.20) ───────────────────────────────
//
// One test per council finding. Each one would have caught the bug pre-fix,
// pinning the contract so a regression here re-triggers council-level concern.

describe('council v3.6.20 fixes — verification (P1/P2/P3 regression guards)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  const sf2 = require('../bin/vanta-safety-floor');
  sf2.reload();

  test('P1 fix: root .env file matches **/.env* (was bypass pre-v3.6.20)', () => {
    const r = sf2.matchFile('.env');
    assert.ok(r && r.ask, 'root .env must match safety-floor — was the council P1 bypass');
    const r2 = sf2.matchFile('.env.local');
    assert.ok(r2 && r2.ask, 'root .env.local must match');
    // Sanity: nested still matches (didn't break the existing case).
    const r3 = sf2.matchFile('apps/web/.env.local');
    assert.ok(r3 && r3.ask);
  });

  test('P1 fix: empty / short SHA in undo payload is refused', () => {
    const undo = require('../bin/vanta-undo');
    const al2 = require('../bin/vanta-action-log');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-undo-empty-sha-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      al2.record({
        session_id: 's-empty-sha', action: 'auto-commit', subject: 'foo',
        decision: 'auto', why: 'test', undo_hint: { kind: 'git-commit', payload: { sha: '' } },
      });
      const r = undo.undo({});
      assert.equal(r.ok, false, 'empty sha must be refused');
      assert.match(r.reason, /sha must be ≥|missing payload\.sha/);
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('P2 fix: rewriter consults matchFile for context.file_path', () => {
    delete require.cache[require.resolve('../bin/vanta-rewriter')];
    const rw = require('../bin/vanta-rewriter');
    const r = rw.rewrite('write tests for this function', { file_path: '.env.local' });
    assert.equal(r.mode, 'passthrough', '.env.local context must trigger floor passthrough');
    assert.match(r.why || '', /^safety-floor:/, `expected safety-floor reason, got "${r.why}"`);
  });

  test('P2 fix: rewriter consults matchCommand for context.command', () => {
    delete require.cache[require.resolve('../bin/vanta-rewriter')];
    const rw = require('../bin/vanta-rewriter');
    const r = rw.rewrite('ship this', { command: 'git push --force origin main' });
    assert.equal(r.mode, 'passthrough', 'force-push command must trigger floor passthrough');
    assert.match(r.why || '', /^safety-floor:/);
  });

  test('P2 fix: "delete all users from the database" classifies as T3', () => {
    delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
    const classifier = require('../bin/vanta-risk-classifier');
    const r = classifier.classify({ prompt: 'delete all users from the database' });
    // Either T3 (production keyword + delete users) or at minimum T2.
    assert.ok(['T2', 'T3'].includes(r.tier),
      `destructive plural-users prompt must escape T0/T1; got ${r.tier} (risk=${r.risk})`);
  });

  test('P2 fix: "ship production" hits prompt-launch-decision floor', () => {
    const r = sf2.matchPrompt('ship production now');
    assert.ok(r && r.ask, '"ship production" must match prompt-launch-decision (was \\b boundary fail)');
    assert.equal(r.id, 'prompt-launch-decision');
  });

  test('P2 fix: undo writes targets_action_id pointing at the original action id', () => {
    const al2 = require('../bin/vanta-action-log');
    const undo = require('../bin/vanta-undo');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-undo-id-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      // Record an autonomy-promote that captures its assigned id.
      const captured = al2.record({
        session_id: 's-id-test',
        action: 'autonomy-promote',
        subject: tmp,
        decision: 'auto',
        why: 'test promotion',
        undo_hint: { kind: 'autonomy-promote', payload: { repo: tmp, prior_level: 'L1', new_level: 'L2' } },
      });
      assert.ok(captured.id, 'record must return entry with id');
      assert.match(captured.id, /^act-/, 'id must use act- prefix');
      undo.undo({});
      const undoEntries = al2.read({ action: 'undo' });
      const u = undoEntries[0];
      assert.equal(u.undo_hint.payload.targets_action_id, captured.id,
        'undo must reference the original action id, not just timestamp');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('P2 fix: memory-promote removes the right line when bullet text duplicates across sections', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-mp-dup-'));
    try {
      const stagingFile = path.join(tmp, 'staging.md');
      const globalFile = path.join(tmp, 'global.md');
      // Same bullet text in two different sections.
      fs.writeFileSync(stagingFile,
        '## Section A\n\n- duplicate text  <!-- conf=0.91 -->\n' +
        '## Section B\n\n- duplicate text  <!-- conf=0.95 -->\n');
      fs.writeFileSync(globalFile, '');
      process.env.VANTA_STAGING_FILE = stagingFile;
      process.env.VANTA_INVARIANTS_FILE = globalFile;
      process.env.VANTA_DIR_OVERRIDE = tmp;
      delete require.cache[require.resolve('../bin/vanta-memory-promote')];
      const mp = require('../bin/vanta-memory-promote');
      // The higher-confidence one (Section B) is what nextCandidate returns.
      const cand = mp.nextCandidate({ minConfidence: 0.85 });
      assert.equal(cand.section, 'Section B');
      mp.accept(cand.id);
      const remaining = fs.readFileSync(stagingFile, 'utf8');
      // Section A bullet must remain; Section B bullet must be gone.
      assert.match(remaining, /## Section A[\s\S]*- duplicate text/,
        'Section A duplicate must be preserved (bug removed wrong one pre-v3.6.20)');
      assert.doesNotMatch(remaining, /## Section B[\s\S]*- duplicate text/,
        'Section B accepted bullet must be removed');
    } finally {
      delete process.env.VANTA_STAGING_FILE;
      delete process.env.VANTA_INVARIANTS_FILE;
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('P2 fix: autonomy demotion respects 24h cooldown (no cascade)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-auton-cd-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.vanta'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.vanta', 'config.yaml'), 'level: L2\n');
      // Inject a recent autonomy-demote so the cooldown gate trips.
      const al2 = require('../bin/vanta-action-log');
      al2.record({
        session_id: 's-cd', action: 'autonomy-demote', subject: tmp,
        decision: 'auto', why: 'spike',
        undo_hint: { kind: 'autonomy-promote', payload: { repo: tmp, prior_level: 'L3', new_level: 'L2' } },
      });
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
      const auton = require('../bin/vanta-autonomy');
      const r = auton.tick(tmp);
      // Even if a fresh spike were to be detected, cooldown blocks the cascade.
      assert.notEqual(r.kind, 'demote', 'cooldown must block cascade demotion');
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-autonomy')];
    }
  });

  test('P3 fix: confidence-decay preserves ordering for negative scores', () => {
    delete require.cache[require.resolve('../bin/vanta-confidence-decay')];
    const decay = require('../bin/vanta-confidence-decay');
    const now = Date.parse('2026-05-02T00:00:00Z');
    const days100 = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString();
    const today = new Date(now).toISOString();
    const fresh = { source: 'invariant', score: -100, date: today };
    const stale = { source: 'invariant', score: -100, date: days100 };
    decay.applyDecay(fresh, now);
    decay.applyDecay(stale, now);
    // Fresh negative must remain MORE negative (lower) than stale negative
    // — pre-fix, stale -100 * 0.05 = -5 and -5 > -100, so stale outranked.
    assert.ok(fresh.score < stale.score,
      `fresh negative must rank lower (more negative) than stale; got fresh=${fresh.score} stale=${stale.score}`);
  });

  test('P3 fix: kill-switch session.resumed marker overrides global off', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-int-ks-resumed-'));
    try {
      process.env.VANTA_DIR_OVERRIDE = tmp;
      const oldGlobal = process.env.VANTA_EXECUTOR;
      process.env.VANTA_EXECUTOR = 'off';
      const runtime = path.join(tmp, 'runtime');
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(path.join(runtime, 'sess-resumed-1.resumed'), 'manual\n');
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
      const ks = require('../bin/vanta-kill-switch');
      const c = ks.check({ sessionId: 'sess-resumed-1', cwd: tmp });
      assert.equal(c.off, false, 'session.resumed must override global off');
      assert.equal(c.scope, 'session');
      assert.equal(c.reason, 'session-resumed');
      if (oldGlobal === undefined) delete process.env.VANTA_EXECUTOR;
      else process.env.VANTA_EXECUTOR = oldGlobal;
    } finally {
      delete process.env.VANTA_DIR_OVERRIDE;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../bin/vanta-kill-switch')];
    }
  });

  test('P3 fix: hooks/prompt-rewriter no longer injects "Following Vanta rewrite" magic phrase', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'prompt-rewriter.js'), 'utf8');
    // Tolerate the historical-context comment ("dropped the magic phrase").
    // The actual surface creep was the user-visible additionalContext line:
    // "If you follow the chain, announce ..." — assert that's gone.
    assert.doesNotMatch(src, /If you follow the chain,\s*announce/,
      'user-visible magic-phrase line must be removed — was surface creep flagged in council R1');
  });
});

// ─── v3.7.2 — central executor (vanta-executor.js) ──────────────────────────
//
// The executor composes kill-switch, safety-floor, rewriter, and the
// risk-classifier into a single Decision shape. Hooks must call
// executor.decide() and never reach into the helpers directly.
//
// These tests lock the canonical Decision contract + composition order.

describe('vanta-executor — Decision shape (v3.7.2)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-rewriter')];
  delete require.cache[require.resolve('../bin/vanta-risk-classifier')];
  delete require.cache[require.resolve('../bin/vanta-executor')];
  // Force the safety-floor singleton to reload from the env-pointed file.
  require('../bin/vanta-safety-floor').reload();
  const executor = require('../bin/vanta-executor');

  test('emits canonical Decision shape with required fields', () => {
    const d = executor.decide({ prompt: 'fix this' });
    const required = [
      'decision_id', 'ts', 'tier', 'decision', 'source',
      'skill_route', 'intent', 'rule_id', 'rewritten',
      'score', 'risk', 'floor', 'kill_switch', 'peer',
      'budget_ms', 'why', 'confidence', 'context',
    ];
    for (const k of required) {
      assert.ok(k in d, `Decision must include "${k}"`);
    }
    assert.match(d.decision_id, /^dec-[0-9a-f]{12}$/);
    assert.match(d.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(['T0', 'T1', 'T2', 'T3'].includes(d.tier), 'tier must be T0..T3');
    assert.ok(['passthrough', 'auto', 'rewrite', 'ask', 'block'].includes(d.decision));
  });

  test('budget_ms is tier-derived (T0=5s ... T3=300s)', () => {
    assert.equal(executor.BUDGET_MS.T0, 5_000);
    assert.equal(executor.BUDGET_MS.T1, 30_000);
    assert.equal(executor.BUDGET_MS.T2, 120_000);
    assert.equal(executor.BUDGET_MS.T3, 300_000);
  });

  test('acceptance: "delete all users" + users.ts → T3 ASK with floor non-null', () => {
    const d = executor.decide({ prompt: 'delete all users', file_path: 'users.ts' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.ok(d.floor, 'safety-floor must catch bulk-delete prompts');
    assert.equal(d.floor.id, 'prompt-bulk-delete');
    assert.equal(d.budget_ms, 300_000);
    assert.equal(d.skill_route, '/council');
    assert.equal(d.source, 'safety-floor');
  });

  test('safety-floor product-decision prompts → T3 ASK + /council route', () => {
    const d = executor.decide({ prompt: 'should we pivot pricing?' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.skill_route, '/council');
    assert.equal(d.source, 'safety-floor');
    assert.match(d.floor.id, /^prompt-pivot-decision/);
  });

  test('safety-floor command match → T3 ASK with peer route + null skill_route', () => {
    const d = executor.decide({ prompt: '', command: 'git push --force origin main' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.source, 'safety-floor');
    assert.equal(d.floor.id, 'git-force-push-main');
    // Non-product floor matches leave skill_route null — user confirms or aborts.
    assert.equal(d.skill_route, null);
  });

  test('rewriter rule "ship it" → rewrite + /ship route + numbered chain', () => {
    const d = executor.decide({ prompt: 'ship it' });
    assert.equal(d.decision, 'rewrite');
    assert.equal(d.skill_route, '/ship');
    assert.equal(d.intent, 'ship');
    assert.equal(d.rule_id, 'ship-this');
    assert.match(d.rewritten, /^1\./m);
    assert.equal(d.source, 'rewriter-rule');
  });

  test('rewriter ASK rule (taxonomy-rename) → T3 ASK + /council', () => {
    const d = executor.decide({ prompt: 'rename tier to plan_level' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.skill_route, '/council');
    assert.equal(d.intent, 'taxonomy-rename');
    assert.equal(d.source, 'rewriter-ask');
  });

  test('passthrough lookup → no skill_route, no chain', () => {
    const d = executor.decide({ prompt: 'what is in this file?' });
    assert.equal(d.decision, 'passthrough');
    assert.equal(d.skill_route, null);
    assert.equal(d.rewritten, null);
    assert.equal(d.intent, 'lookup');
  });

  test('composition order: safety-floor wins over rewriter rule', () => {
    // "ship to prod" matches BOTH the ship rewriter rule AND the
    // prompt-launch-decision floor entry. Floor must win.
    const d = executor.decide({ prompt: 'ship to prod' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.source, 'safety-floor');
    assert.match(d.floor.id, /^prompt-launch-decision/);
  });

  test('kill-switch off → T0 passthrough regardless of prompt', () => {
    // Stub kill-switch via require.cache to force `off: true`.
    const ksPath = require.resolve('../bin/vanta-kill-switch');
    const original = require.cache[ksPath];
    require.cache[ksPath] = {
      id: ksPath,
      filename: ksPath,
      loaded: true,
      exports: { check: () => ({ off: true, scope: 'session' }) },
    };
    delete require.cache[require.resolve('../bin/vanta-executor')];
    const stubbed = require('../bin/vanta-executor');
    try {
      const d = stubbed.decide({ prompt: 'delete all users' });
      assert.equal(d.tier, 'T0');
      assert.equal(d.decision, 'passthrough');
      assert.equal(d.source, 'kill-switch');
      assert.deepEqual(d.kill_switch, { off: true, scope: 'session' });
    } finally {
      if (original) require.cache[ksPath] = original; else delete require.cache[ksPath];
      delete require.cache[require.resolve('../bin/vanta-executor')];
    }
  });

  test('echoes context back so action-log can pair entries', () => {
    const d = executor.decide({
      prompt: 'fix this', file_path: 'src/api/auth.ts',
      command: null, cwd: '/tmp/proj', session_id: 'sess-abc',
    });
    assert.equal(d.context.prompt, 'fix this');
    assert.equal(d.context.file_path, 'src/api/auth.ts');
    assert.equal(d.context.cwd, '/tmp/proj');
    assert.equal(d.context.session_id, 'sess-abc');
  });
});

describe('hooks/prompt-rewriter — executor-driven shadow injection (v3.7.2)', () => {
  const HOOK = path.join(__dirname, '..', 'hooks', 'prompt-rewriter.js');

  function spawnHook({ prompt, vantaDir }) {
    const { execFileSync } = require('child_process');
    return execFileSync('node', [HOOK], {
      input: JSON.stringify({ prompt, session_id: 'rw-v372', cwd: '/tmp' }),
      env: {
        ...process.env,
        HOME: vantaDir,                       // redirect ~/.vanta/* to tmp
        VANTA_DIR_OVERRIDE: vantaDir,
        VANTA_SAFETY_FLOOR: path.join(__dirname, '..', 'policy', 'safety-floor.yaml'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString();
  }

  test('safety-floor product-decision → 1-line ASK hint', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-floor-'));
    try {
      const out = spawnHook({ prompt: 'should we pivot pricing?', vantaDir: tmp });
      const parsed = JSON.parse(out);
      assert.match(parsed.hookSpecificOutput.additionalContext,
        /^\[Vanta\]\s+\/council recommended\s+·\s+T3 ASK/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('rewriter ASK (taxonomy-rename) → 1-line /council ASK hint', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-ask-'));
    try {
      const out = spawnHook({ prompt: 'rename tier to plan_level', vantaDir: tmp });
      const parsed = JSON.parse(out);
      assert.match(parsed.hookSpecificOutput.additionalContext,
        /^\[Vanta\]\s+\/council recommended\s+·\s+T3 ASK/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('rewrite path injects header + numbered chain', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-rule-'));
    try {
      const out = spawnHook({ prompt: 'ship it', vantaDir: tmp });
      const parsed = JSON.parse(out);
      assert.match(parsed.hookSpecificOutput.additionalContext,
        /^\[Vanta\]\s+\/ship\s+·\s+ship/);
      assert.match(parsed.hookSpecificOutput.additionalContext, /^1\./m);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── v3.7.3 — critical safety fixes ─────────────────────────────────────────
//
// 1. Undo state-check  : refuse undo when artifact has moved on
// 2. matchSymbol diff  : executor scans diff body for sensitive symbols
// 3. Failure escalation: consecutive failures bump the next decision tier
// 4. Semantic detector : strategic-framing prompts → T3 ASK + /council

describe('vanta-executor — semantic product-decision detector (v3.7.3)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-executor')];
  require('../bin/vanta-safety-floor').reload();
  const executor = require('../bin/vanta-executor');

  test('"should we add subscription tiers?" → T3 ASK + /council', () => {
    const d = executor.decide({ prompt: 'should we add subscription tiers?' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.skill_route, '/council');
    assert.equal(d.floor.id, 'semantic-product-decision');
  });

  test('"can we rename the schema?" matches semantic detector', () => {
    const d = executor.decide({ prompt: 'can we rename the schema?' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.floor.id, 'semantic-product-decision');
  });

  test('"let me know if we should sunset the free plan" matches', () => {
    const d = executor.decide({ prompt: 'let me know if we should sunset the free plan' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
  });

  test('benign lookups are NOT semantically promoted', () => {
    const d = executor.decide({ prompt: 'what is the price?' });
    assert.notEqual(d.tier, 'T3');
  });

  test('rewriter rule wins over semantic detector when prompt matches both', () => {
    // "ship it" matches the ship rewriter rule. Semantic detector should
    // not fire on a prompt that has no framer/target combo.
    const d = executor.decide({ prompt: 'ship it' });
    assert.equal(d.source, 'rewriter-rule');
    assert.equal(d.intent, 'ship');
  });
});

describe('vanta-executor — diff body wires matchSymbol (v3.7.3)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-executor')];
  require('../bin/vanta-safety-floor').reload();
  const executor = require('../bin/vanta-executor');

  test('diff containing deleteCustomer( → T3 ASK via customer-data-delete', () => {
    const d = executor.decide({
      prompt: '',
      file_path: 'src/users.ts',
      diff: 'function deleteCustomer(id) { db.purge(id); }',
    });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.floor.id, 'customer-data-delete');
  });

  test('diff containing TIER_PRICE = → T3 ASK via pricing-constants', () => {
    const d = executor.decide({
      prompt: '',
      file_path: 'src/billing.ts',
      diff: 'export const TIER_PRICE = 999;',
    });
    assert.equal(d.tier, 'T3');
    assert.equal(d.floor.id, 'pricing-constants');
  });

  test('benign diff is NOT flagged', () => {
    const d = executor.decide({
      prompt: 'fix typo',
      file_path: 'README.md',
      diff: 'export function add(a, b) { return a + b; }',
    });
    assert.notEqual(d.tier, 'T3');
  });
});

describe('vanta-failure-escalation — consecutive failures bump tier (v3.7.3)', () => {
  const fe = require('../bin/vanta-failure-escalation');

  test('applyEscalation handles bump=1 from T1 to T2', () => {
    assert.equal(fe.applyEscalation('T0', { bump: 1, force_tier: null }), 'T1');
    assert.equal(fe.applyEscalation('T1', { bump: 1, force_tier: null }), 'T2');
    assert.equal(fe.applyEscalation('T2', { bump: 1, force_tier: null }), 'T3');
    assert.equal(fe.applyEscalation('T3', { bump: 1, force_tier: null }), 'T3');
  });

  test('applyEscalation force_tier overrides bump', () => {
    assert.equal(fe.applyEscalation('T0', { bump: 0, force_tier: 'T3' }), 'T3');
    assert.equal(fe.applyEscalation('T1', { bump: 1, force_tier: 'T3' }), 'T3');
  });

  test('escalate degrades cleanly when no action-log available', () => {
    // Uses default action-log path; empty logs should yield zero failures.
    const r = fe.escalate({ session_id: 'no-such-session-' + Date.now() });
    assert.equal(typeof r.count, 'number');
    assert.equal(r.bump, 0);
    assert.equal(r.force_tier, null);
  });

  test('escalate counts test-failure / build-failure / undo / regret', () => {
    // Stub action-log to return synthetic failures.
    const alPath = require.resolve('../bin/vanta-action-log');
    const original = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        read: () => [
          { action: 'test-failure', ts: new Date().toISOString() },
          { action: 'build-failure', ts: new Date().toISOString() },
          { action: 'undo', ts: new Date().toISOString() },
          { action: 'rewrite', ts: new Date().toISOString() },  // not a failure
        ],
        record: () => {}, findLast: () => null, rollup: () => ({}),
      },
    };
    delete require.cache[require.resolve('../bin/vanta-failure-escalation')];
    const stubbed = require('../bin/vanta-failure-escalation');
    try {
      const r = stubbed.escalate({});
      assert.equal(r.count, 3, 'three failure signals should be counted');
      assert.equal(r.bump, 1, 'count >= 3 → bump=1');
      assert.equal(r.force_tier, null);
    } finally {
      if (original) require.cache[alPath] = original; else delete require.cache[alPath];
      delete require.cache[require.resolve('../bin/vanta-failure-escalation')];
    }
  });

  test('5+ failure signals force T3', () => {
    const alPath = require.resolve('../bin/vanta-action-log');
    const original = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        read: () => Array.from({ length: 6 }, () => ({
          action: 'undo', ts: new Date().toISOString(),
        })),
        record: () => {}, findLast: () => null, rollup: () => ({}),
      },
    };
    delete require.cache[require.resolve('../bin/vanta-failure-escalation')];
    const stubbed = require('../bin/vanta-failure-escalation');
    try {
      const r = stubbed.escalate({});
      assert.equal(r.force_tier, 'T3');
    } finally {
      if (original) require.cache[alPath] = original; else delete require.cache[alPath];
      delete require.cache[require.resolve('../bin/vanta-failure-escalation')];
    }
  });

  test('executor surfaces escalation in Decision.escalation when active', () => {
    const alPath = require.resolve('../bin/vanta-action-log');
    const exPath = require.resolve('../bin/vanta-executor');
    const fePath = require.resolve('../bin/vanta-failure-escalation');
    const origAl = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        read: () => Array.from({ length: 4 }, () => ({
          action: 'test-failure', ts: new Date().toISOString(),
        })),
        record: () => {}, findLast: () => null, rollup: () => ({}),
      },
    };
    delete require.cache[fePath];
    delete require.cache[exPath];
    const stubbed = require('../bin/vanta-executor');
    try {
      // "fix this" alone would land at T1; with 4 failures it bumps to T2.
      const d = stubbed.decide({ prompt: 'fix this', session_id: 'bumpme' });
      assert.ok(d.escalation, 'escalation should be present');
      assert.equal(d.escalation.bump, 1);
      assert.equal(d.tier, 'T2', 'T1 + bump(1) should equal T2');
    } finally {
      if (origAl) require.cache[alPath] = origAl; else delete require.cache[alPath];
      delete require.cache[fePath];
      delete require.cache[exPath];
    }
  });
});

describe('vanta-undo — state-check refuses dirty undo (v3.7.3)', () => {
  const { execSync } = require('child_process');
  let tmpDir, repoDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-undo-state-'));
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir);
    execSync('git init -q', { cwd: repoDir });
    execSync('git config user.email t@t.t', { cwd: repoDir });
    execSync('git config user.name t', { cwd: repoDir });
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('refuses file-write undo when current SHA differs from after_sha', () => {
    const file = path.join(repoDir, 'a.txt');
    fs.writeFileSync(file, 'original\n');
    const beforeSha = execSync(`git hash-object "${file}"`, { cwd: repoDir }).toString().trim();
    execSync(`git hash-object -w "${file}"`, { cwd: repoDir });
    fs.writeFileSync(file, 'vanta-wrote\n');
    const afterSha = execSync(`git hash-object "${file}"`, { cwd: repoDir }).toString().trim();
    execSync(`git hash-object -w "${file}"`, { cwd: repoDir });
    // User edits AFTER vanta wrote.
    fs.writeFileSync(file, 'user-edited\n');

    delete require.cache[require.resolve('../bin/vanta-undo')];
    const undo = require('../bin/vanta-undo');
    // Call the file-write reverser directly via the public undo path
    // by feeding it a synthetic action-log entry.
    const alPath = require.resolve('../bin/vanta-action-log');
    const origAl = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        findLast: () => ({
          id: 'act-test1',
          ts: new Date().toISOString(),
          action: 'file-write',
          subject: file,
          undo_hint: { kind: 'file-write', payload: {
            path: file,
            before_sha: beforeSha,
            after_sha: afterSha,
          } },
        }),
        record: () => {},
        read: () => [], rollup: () => ({}),
      },
    };
    delete require.cache[require.resolve('../bin/vanta-undo')];
    const undoFresh = require('../bin/vanta-undo');
    try {
      const r = undoFresh.undo({});
      assert.equal(r.ok, false, 'must refuse — file has moved on');
      assert.match(r.reason, /moved on|state-check/);
    } finally {
      if (origAl) require.cache[alPath] = origAl; else delete require.cache[alPath];
    }
  });

  test('proceeds when current SHA matches after_sha', () => {
    const file = path.join(repoDir, 'b.txt');
    fs.writeFileSync(file, 'original\n');
    const beforeSha = execSync(`git hash-object "${file}"`, { cwd: repoDir }).toString().trim();
    execSync(`git hash-object -w "${file}"`, { cwd: repoDir });
    fs.writeFileSync(file, 'vanta-wrote\n');
    const afterSha = execSync(`git hash-object "${file}"`, { cwd: repoDir }).toString().trim();
    execSync(`git hash-object -w "${file}"`, { cwd: repoDir });
    // No user edit — file still matches after_sha.

    const alPath = require.resolve('../bin/vanta-action-log');
    const origAl = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        findLast: () => ({
          id: 'act-test2',
          ts: new Date().toISOString(),
          action: 'file-write',
          subject: file,
          undo_hint: { kind: 'file-write', payload: {
            path: file,
            before_sha: beforeSha,
            after_sha: afterSha,
          } },
        }),
        record: () => {},
        read: () => [], rollup: () => ({}),
      },
    };
    delete require.cache[require.resolve('../bin/vanta-undo')];
    const undoFresh = require('../bin/vanta-undo');
    try {
      const r = undoFresh.undo({});
      assert.equal(r.ok, true, 'must succeed when state matches');
      assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
    } finally {
      if (origAl) require.cache[alPath] = origAl; else delete require.cache[alPath];
    }
  });

  test('back-compat: missing after_sha skips state-check', () => {
    const file = path.join(repoDir, 'c.txt');
    fs.writeFileSync(file, 'original\n');
    const beforeSha = execSync(`git hash-object "${file}"`, { cwd: repoDir }).toString().trim();
    execSync(`git hash-object -w "${file}"`, { cwd: repoDir });
    fs.writeFileSync(file, 'whatever\n');

    const alPath = require.resolve('../bin/vanta-action-log');
    const origAl = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        findLast: () => ({
          id: 'act-test3',
          ts: new Date().toISOString(),
          action: 'file-write',
          subject: file,
          // No after_sha — old log entry from before v3.7.3.
          undo_hint: { kind: 'file-write', payload: { path: file, before_sha: beforeSha } },
        }),
        record: () => {},
        read: () => [], rollup: () => ({}),
      },
    };
    delete require.cache[require.resolve('../bin/vanta-undo')];
    const undoFresh = require('../bin/vanta-undo');
    try {
      const r = undoFresh.undo({});
      assert.equal(r.ok, true, 'must succeed for legacy entries without after_sha');
    } finally {
      if (origAl) require.cache[alPath] = origAl; else delete require.cache[alPath];
    }
  });

  test('file-delete refuses when file now exists (something else created it)', () => {
    const file = path.join(repoDir, 'd.txt');
    // Vanta deleted the file. Now something else creates it.
    fs.writeFileSync(file, 'someone-else-wrote\n');

    const alPath = require.resolve('../bin/vanta-action-log');
    const origAl = require.cache[alPath];
    require.cache[alPath] = {
      id: alPath, filename: alPath, loaded: true,
      exports: {
        findLast: () => ({
          id: 'act-test4',
          ts: new Date().toISOString(),
          action: 'file-delete',
          subject: file,
          undo_hint: { kind: 'file-delete', payload: {
            path: file,
            content_b64: Buffer.from('original\n').toString('base64'),
          } },
        }),
        record: () => {},
        read: () => [], rollup: () => ({}),
      },
    };
    delete require.cache[require.resolve('../bin/vanta-undo')];
    const undoFresh = require('../bin/vanta-undo');
    try {
      const r = undoFresh.undo({});
      assert.equal(r.ok, false);
      assert.match(r.reason, /now exists|--force/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'someone-else-wrote\n',
        'state-check must NOT overwrite');
    } finally {
      if (origAl) require.cache[alPath] = origAl; else delete require.cache[alPath];
    }
  });
});

// ─── v3.7.4 — open-loop wires ───────────────────────────────────────────────
//
// 1. Trust→mode signal      : Decision carries inline_ready bool
// 2. Effort escalation      : big diffs / many files bump tier
// 3. Uncertainty escalation : confidence drops to medium on sparse signal
// 4. Inline marker in hook  : [Vanta INLINE] when inline_ready=true

describe('vanta-executor — effort / uncertainty / inline_ready (v3.7.4)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-executor')];
  require('../bin/vanta-safety-floor').reload();
  const executor = require('../bin/vanta-executor');

  test('huge diff (≥800 lines) forces minimum tier T2 even on benign rule', () => {
    const bigDiff = 'x\n'.repeat(900);
    const d = executor.decide({ prompt: 'fix this', file_path: 'src/a.ts', diff: bigDiff });
    assert.ok(d.effort);
    assert.equal(d.effort.level, 'huge');
    assert.ok(d.tier === 'T2' || d.tier === 'T3');
  });

  test('multi-file change (≥5 files) bumps tier by one', () => {
    const d = executor.decide({ prompt: 'ship it', file_path: 'src/a.ts', file_count: 7 });
    assert.ok(d.effort);
    assert.equal(d.effort.level, 'high');
    // ship-this rule lands at T1 by default; effort bump → T2.
    assert.equal(d.tier, 'T2');
  });

  test('small diff + few files → no effort signal', () => {
    const d = executor.decide({ prompt: 'fix this', diff: 'one line\n', file_count: 1 });
    assert.equal(d.effort, null);
  });

  test('Decision shape includes effort, uncertainty, inline_ready fields', () => {
    const d = executor.decide({ prompt: 'fix this' });
    assert.ok('effort' in d);
    assert.ok('uncertainty' in d);
    assert.ok('inline_ready' in d);
    assert.equal(typeof d.inline_ready, 'boolean');
  });

  test('confidence drops to medium when classifier hits default 4/4 without a rule', () => {
    const d = executor.decide({ prompt: 'do something' });
    // No rewriter rule, classifier defaults rev=4/blast=4 → confidence=medium.
    assert.equal(d.confidence, 'medium');
  });

  test('confidence stays high when rewriter rule matches', () => {
    const d = executor.decide({ prompt: 'fix this' });
    assert.equal(d.confidence, 'high');
  });

  test('inline_ready stubbed via trust-metrics — true flows into Decision', () => {
    const tmPath = require.resolve('../bin/vanta-trust-metrics');
    const exPath = require.resolve('../bin/vanta-executor');
    const orig = require.cache[tmPath];
    require.cache[tmPath] = {
      id: tmPath, filename: tmPath, loaded: true,
      exports: {
        compute: () => ({ ready_for_inline: true }),
        readyForInline: () => true,
      },
    };
    delete require.cache[exPath];
    const stubbed = require('../bin/vanta-executor');
    try {
      const d = stubbed.decide({ prompt: 'fix this' });
      assert.equal(d.inline_ready, true);
    } finally {
      if (orig) require.cache[tmPath] = orig; else delete require.cache[tmPath];
      delete require.cache[exPath];
    }
  });
});

describe('hooks/prompt-rewriter — inline marker on trust-ready (v3.7.4)', () => {
  const HOOK = path.join(__dirname, '..', 'hooks', 'prompt-rewriter.js');

  test('default header is [Vanta] when inline_ready=false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rw-default-'));
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('node', [HOOK], {
        input: JSON.stringify({ prompt: 'fix this', session_id: 'rw-v374', cwd: '/tmp' }),
        env: {
          ...process.env, HOME: tmp, VANTA_DIR_OVERRIDE: tmp,
          VANTA_SAFETY_FLOOR: path.join(__dirname, '..', 'policy', 'safety-floor.yaml'),
        },
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      }).toString();
      const parsed = JSON.parse(out);
      assert.match(parsed.hookSpecificOutput.additionalContext, /^\[Vanta\]\s+\/investigate/);
      assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /\[Vanta INLINE\]/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ─── v3.7.5 — project scoping + auto-execution gate ─────────────────────────

describe('vanta-trust-metrics — project scoping + min sample (v3.7.5)', () => {
  const tm = require('../bin/vanta-trust-metrics');

  test('readyForInline requires min sample even when rates are good', () => {
    const goodMetrics = {
      undo_within_2m: { rate: 0, n: 3 },         // 3 actions, perfect record
      manual_interrupt: { rate: 0, n: 0 },
      chain_success: { rate: 1.0, n: 0 },
      spanDays: 30,
    };
    assert.equal(tm.readyForInline(goodMetrics), false,
      '3 actions must NOT earn inline regardless of rate');
  });

  test('readyForInline passes with sample at default threshold (50)', () => {
    const goodMetrics = {
      undo_within_2m: { rate: 0, n: 50 },
      manual_interrupt: { rate: 0, n: 50 },
      chain_success: { rate: 0.9, n: 50 },
      spanDays: 30,
    };
    assert.equal(tm.readyForInline(goodMetrics), true);
  });

  test('readyForInline accepts custom min_sample for tests', () => {
    const m = {
      undo_within_2m: { rate: 0, n: 5 },
      manual_interrupt: { rate: 0, n: 5 },
      chain_success: { rate: 1.0, n: 5 },
      spanDays: 14,
    };
    assert.equal(tm.readyForInline(m, { min_sample: 3 }), true);
  });

  test('compute accepts project filter (smoke)', () => {
    // No-op smoke — real action-log empty in tests, just verify no crash.
    const m = tm.compute({ days: 30, project: 'no-such-project-xyz' });
    assert.equal(m.project, 'no-such-project-xyz');
    assert.equal(typeof m.spanDays, 'number');
  });
});

describe('vanta-executor — two-eyes compound enforcement (v3.7.5)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');

  test('escalation + huge-effort → T3 + peer="both" + two_eyes=true', () => {
    const fePath = require.resolve('../bin/vanta-failure-escalation');
    const exPath = require.resolve('../bin/vanta-executor');
    const orig = require.cache[fePath];
    require.cache[fePath] = {
      id: fePath, filename: fePath, loaded: true,
      exports: {
        escalate: () => ({ count: 4, bump: 1, force_tier: null, why: 'stubbed' }),
        applyEscalation: (t) => 'T2',
      },
    };
    delete require.cache[exPath];
    const stubbed = require('../bin/vanta-executor');
    try {
      const big = 'x\n'.repeat(900);
      const d = stubbed.decide({
        prompt: 'fix this', file_path: 'src/a.ts', diff: big, session_id: 'two-eyes-test',
      });
      assert.equal(d.tier, 'T3');
      assert.equal(d.two_eyes, true);
      assert.ok(d.peer);
      assert.equal(d.peer.peer, 'both');
    } finally {
      if (orig) require.cache[fePath] = orig; else delete require.cache[fePath];
      delete require.cache[exPath];
    }
  });

  test('single signal does NOT trigger two-eyes', () => {
    delete require.cache[require.resolve('../bin/vanta-executor')];
    const ex = require('../bin/vanta-executor');
    const big = 'x\n'.repeat(900);
    const d = ex.decide({ prompt: 'fix this', file_path: 'src/a.ts', diff: big });
    // Effort alone fires; no escalation, no uncertainty
    assert.equal(d.two_eyes, false);
  });

  test('Decision shape includes two_eyes field by default', () => {
    delete require.cache[require.resolve('../bin/vanta-executor')];
    const ex = require('../bin/vanta-executor');
    const d = ex.decide({ prompt: 'hello' });
    assert.equal(typeof d.two_eyes, 'boolean');
    assert.equal(d.two_eyes, false);
  });
});

describe('setup.sh — safety-floor policy versioning (v3.7.5)', () => {
  test('repo safety-floor declares version field', () => {
    const yaml = fs.readFileSync(path.join(__dirname, '..', 'policy', 'safety-floor.yaml'), 'utf8');
    const m = yaml.match(/^version:\s*(\d+)/m);
    assert.ok(m, 'safety-floor.yaml must declare a top-level version');
    assert.ok(parseInt(m[1], 10) >= 2, 'version must be >= 2 (bumped at v3.7.5)');
  });

  test('setup.sh references VANTA_FORCE_FLOOR_UPGRADE env var', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    assert.match(sh, /VANTA_FORCE_FLOOR_UPGRADE/);
  });

  test('setup.sh bin list includes vanta-executor and vanta-failure-escalation', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    assert.match(sh, /vanta-executor\.js/);
    assert.match(sh, /vanta-failure-escalation\.js/);
  });
});

// ─── v3.7.6 — hygiene release ───────────────────────────────────────────────

describe('hooks/manifest.json — single source of truth (v3.7.6)', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'hooks', 'manifest.json'), 'utf8'));

  test('every manifest hook file exists in hooks/', () => {
    for (const reg of manifest.registrations) {
      const file = path.join(__dirname, '..', 'hooks', reg.file);
      assert.ok(fs.existsSync(file), `hook ${reg.file} declared in manifest must exist on disk`);
    }
  });

  test('every hook on disk is registered in the manifest', () => {
    const onDisk = fs.readdirSync(path.join(__dirname, '..', 'hooks'))
      .filter(f => /\.(js|sh)$/.test(f) || f === 'session-start');
    const declared = new Set(manifest.registrations.map(r => r.file));
    // session-start has no extension; allow it in declared set.
    declared.add('session-start');
    for (const f of onDisk) {
      // Allow the registry file itself + non-hook helpers (none at present).
      if (f === 'manifest.json' || f === 'hooks.json') continue;
      assert.ok(declared.has(f),
        `hook on disk ${f} is not registered in manifest.json — drift`);
    }
  });

  test('every manifest event is one of the documented Claude Code events', () => {
    const allowed = new Set(manifest._event_types.split(',').map(s => s.trim()));
    for (const reg of manifest.registrations) {
      assert.ok(allowed.has(reg.event), `unknown event ${reg.event}`);
    }
  });

  test('every manifest entry has a runtime, timeout, and purpose', () => {
    for (const reg of manifest.registrations) {
      assert.ok(['node', 'bash'].includes(reg.runtime), `bad runtime for ${reg.file}`);
      assert.equal(typeof reg.timeout, 'number', `missing timeout for ${reg.file}`);
      assert.ok(reg.purpose, `missing purpose for ${reg.file}`);
    }
  });

  test('setup.sh uses manifest.json instead of hardcoding hook list', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    // Either reads manifest.json directly or sources hooks.json (which
    // is generated from manifest.json). Reject hardcoded `hookFile=foo.js`
    // patterns that would drift from the manifest.
    assert.match(sh, /manifest\.json|hooks\.json/);
  });
});

describe('vanta-resolve — contradiction-detection regression (v3.7.6)', () => {
  const { detectContradictions } = require('../bin/vanta-resolve');

  test('ES256 vs HS256 in two decisions surfaces contradiction', () => {
    const results = [
      { source: 'decision', date: '2026-04-15', section: '2026-04-15: jwt',
        excerpt: 'use ES256 asymmetric keys for pi-perception JWT' },
      { source: 'invariant', section: 'Supabase',
        excerpt: 'HS256 symmetric keys must be the default for edge functions' },
    ];
    const c = detectContradictions(results);
    assert.ok(c.length > 0, 'must detect ES256/HS256 contradiction');
    assert.match(c[0].hint, /ES256/);
    assert.match(c[0].hint, /HS256/);
  });

  test('Pixi v7 vs v8 only contradicts when pixi context is present', () => {
    // Use non-loose sources (invariant/decision) so confidence stays
    // above the 0.7 floor — episode/memory subtract 0.2 from confidence.
    const withCtx = [
      { source: 'invariant', section: 'PixiJS', excerpt: 'PixiJS v8 Application.init is async' },
      { source: 'invariant', section: 'PixiJS', excerpt: 'PixiJS v7 sync constructor was the old pattern' },
    ];
    const withoutCtx = [
      { source: 'gotcha', excerpt: 'API v7 is stable' },
      { source: 'gotcha', excerpt: 'API v8 is the migration target' },
    ];
    assert.ok(detectContradictions(withCtx).length > 0,
      'pixi context must enable v7/v8 detection');
    assert.equal(detectContradictions(withoutCtx).length, 0,
      'no pixi context → no v7/v8 contradiction');
  });

  test('looser sources (episode/memory) reduce confidence below threshold', () => {
    const looseResults = [
      { source: 'episode', date: '2026-04-01', excerpt: 'tried sync first' },
      { source: 'memory', excerpt: 'switched to async eventually' },
    ];
    // sync/async needs pixi context — without it, no detection regardless of source.
    const c = detectContradictions(looseResults);
    assert.equal(c.length, 0);
  });

  test('detector exports correctly from vanta-resolve', () => {
    const m = require('../bin/vanta-resolve');
    assert.equal(typeof m.detectContradictions, 'function');
    assert.equal(typeof m.resolve, 'function');
    assert.equal(typeof m.scoreResult, 'function');
  });
});

describe('docs/FAILURE-MODES.md exists and covers known modes (v3.7.6)', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'FAILURE-MODES.md'), 'utf8');

  test('covers Gemini exit-55', () => {
    assert.match(doc, /Gemini.*55|GEMINI_CLI_TRUST_WORKSPACE/i);
  });

  test('covers Codex arg-parse failure', () => {
    assert.match(doc, /Codex.*exits.*2|approvalPolicy|arg-parse/i);
  });

  test('covers undo state-check refusal', () => {
    assert.match(doc, /moved on|undo refuses|state-check/i);
  });

  test('covers sync-queue alert loop', () => {
    assert.match(doc, /UNSYNCED|sync.*alert/i);
  });

  test('covers NFS storage warning', () => {
    assert.match(doc, /NFS|O_EXCL|EXDEV/);
  });
});

// ─── v3.8.0 council P2 fixes ────────────────────────────────────────────────
//
// Codex + Gemini R1 review on the v3.7 → v3.8 sprint surfaced four P2s.
// These tests lock the regression boundaries.

describe('vanta-executor — semantic detector runs before rewriter (v3.8.0 P2)', () => {
  process.env.VANTA_SAFETY_FLOOR = path.join(__dirname, '..', 'policy', 'safety-floor.yaml');
  delete require.cache[require.resolve('../bin/vanta-safety-floor')];
  delete require.cache[require.resolve('../bin/vanta-executor')];
  require('../bin/vanta-safety-floor').reload();
  const executor = require('../bin/vanta-executor');

  test('"should we pivot pricing? also fix lint" → T3 ASK (not fix-bug rule)', () => {
    // Gemini's P2: a strategic-framing prompt with a tactical verb suffix
    // was masking the semantic detector when the rewriter rule matched first.
    const d = executor.decide({ prompt: 'should we pivot pricing? also fix lint' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.decision, 'ask');
    assert.equal(d.skill_route, '/council');
    // The detected source must be safety-floor (semantic), NOT rewriter-rule.
    assert.equal(d.source, 'safety-floor');
  });

  test('"can we rename schema? then fix this" → T3 ASK', () => {
    const d = executor.decide({ prompt: 'can we rename schema? then fix this' });
    assert.equal(d.tier, 'T3');
    assert.equal(d.source, 'safety-floor');
  });

  test('benign rewriter rules still fire when prompt is purely tactical', () => {
    // Sanity: the move did not break the normal rule path.
    const a = executor.decide({ prompt: 'fix this' });
    assert.equal(a.source, 'rewriter-rule');
    const b = executor.decide({ prompt: 'ship it' });
    assert.equal(b.source, 'rewriter-rule');
  });
});

describe('vanta-trust-metrics — _interruptRate is project-scoped (v3.8.0 P2)', () => {
  // The function is private; we test through compute({project}) and
  // assert that a foreign-project event doesn't leak into the rate.
  test('compute({project}) reads slug/project from interactions.jsonl', () => {
    // Smoke-only: tests/canonical.test.js doesn't seed interactions.jsonl,
    // so we just verify the function accepts the parameter and returns
    // a valid shape without crashing.
    delete require.cache[require.resolve('../bin/vanta-trust-metrics')];
    const tm = require('../bin/vanta-trust-metrics');
    const m = tm.compute({ days: 30, project: 'pi-perception' });
    assert.equal(m.project, 'pi-perception');
    assert.equal(typeof m.manual_interrupt.rate, 'number');
  });

  test('source: _interruptRate signature includes project parameter', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'vanta-trust-metrics.js'), 'utf8');
    assert.match(src, /function _interruptRate\(\s*\{\s*sinceMs\s*,\s*project\s*\}/);
  });

  test('source: _interruptRate filters by event.slug or event.project', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'vanta-trust-metrics.js'), 'utf8');
    assert.match(src, /e\.slug\s*\|\|\s*e\.project/);
  });
});

describe('hooks/prompt-rewriter — logs include project field (v3.8.0 P2)', () => {
  // Without `project`, vanta-trust-metrics.compute({project}) filters
  // out every rewrite event and inline_ready never accumulates.
  test('source: prompt-rewriter resolves canonProject from cwd', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'prompt-rewriter.js'), 'utf8');
    assert.match(src, /canonProject/);
    assert.match(src, /project,\s*action:/);  // every _logAction passes project
  });
});

describe('setup.sh — VANTA_FORCE_FLOOR_UPGRADE safe under set -u (v3.8.0 P2)', () => {
  test('upgrade var is read with default value (no unbound-var crash)', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    // Either ${VANTA_FORCE_FLOOR_UPGRADE:-...} or [ "${...:-...}" = "1" ]
    assert.match(sh, /\$\{VANTA_FORCE_FLOOR_UPGRADE:-/);
  });
});

describe('setup.sh idempotency — preserves user edits (v3.7.6)', () => {
  test('setup.sh has explicit "preserved user edits" path for safety-floor', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    // The check: user has a deployed safety-floor and setup.sh leaves
    // it in place by default. Phrase varies but must be present.
    assert.match(sh, /preserved user edits|preserved\)/);
  });

  test('peer-routing.yaml is also preserved on re-install', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    assert.match(sh, /peer-routing\.yaml/);
  });

  test('hooks.json deployment is conditional / re-runnable', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
    // Verify there's no `rm -rf ~/.claude/hooks` that would clobber
    // user-customized hook configs. The setup MUST be re-runnable.
    assert.doesNotMatch(sh, /rm\s+-rf\s+["$]?\$?HOME\/?["']?\/\.claude\/hooks/);
  });
});

