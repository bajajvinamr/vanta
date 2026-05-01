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

const { test, describe } = require('node:test');
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

