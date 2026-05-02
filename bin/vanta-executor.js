#!/usr/bin/env node
// vanta-executor — central decision authority for every Vanta hook.
//
// One call site. One Decision shape. The hooks should NEVER reach into
// rewriter / risk-classifier / safety-floor / kill-switch / peer-router
// directly — they call decide() and read the canonical Decision back.
//
// Composition (in order, each step can short-circuit):
//
//   1. kill-switch         → terminal: T0 + passthrough
//   2. safety-floor        → terminal: T3 + ask (deterministic always-ask)
//   3. rewriter (ASK mode) → terminal: T3 + ask (e.g. taxonomy-rename)
//   4. rewriter (rule)     → captures intent + skill_route + chain
//   5. risk-classifier     → final tier + composite decision
//
// The Decision shape is documented inline below. Every hook + every test
// reads it the same way; that's the whole point of the executor.
//
// Latency budgets per tier are baked in (BUDGET_MS); hooks can cap
// downstream LLM calls accordingly.

'use strict';
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Lazy-load helpers so hooks/tests can stub them and so a missing helper
// degrades to a permissive default rather than crashing the executor.
let _killSwitch, _safetyFloor, _rewriter, _riskClassifier, _peerRouter, _escalation, _trust, _projects;

// v3.8.1 hardening — distinguish "module not present" from "module
// crashed at load time". Swallowing every require error silently
// downgrades the executor to its degraded-no-helper path, which masks
// real syntax/runtime regressions in helper modules. Codex council R3
// P3: only swallow MODULE_NOT_FOUND; warn loudly on anything else so
// the operator notices that a dependency broke instead of inferring
// "Vanta is just being permissive today" from the lack of routing.
function _resolve(name) {
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', name),
    path.join(__dirname, name),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', name),
  ]) {
    try {
      return require(p);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND') continue;
      // Non-MODULE_NOT_FOUND = the file exists but failed to load
      // (syntax error, runtime throw at require-time, or a require()
      // inside the file that itself fails). Surface this — silent
      // degradation here is exactly the failure mode v3.8.1 fixes.
      try {
        const stderr = process.stderr;
        if (stderr && typeof stderr.write === 'function') {
          stderr.write(
            `[vanta-executor] WARN: ${p} failed to load (${err.code || 'no-code'}): ${err.message || String(err)}\n`,
          );
        }
      } catch (_) { /* never let logging break the resolver */ }
      // Continue to the next candidate path — the helper might exist
      // at a fallback location even if the preferred copy is broken.
      // If every path fails, the helper still ends up null and the
      // executor degrades, but the operator now has a stderr breadcrumb.
    }
  }
  return null;
}
function killSwitch()       { return _killSwitch     || (_killSwitch     = _resolve('vanta-kill-switch.js'));     }
function safetyFloor()      { return _safetyFloor    || (_safetyFloor    = _resolve('vanta-safety-floor.js'));    }
function rewriter()         { return _rewriter       || (_rewriter       = _resolve('vanta-rewriter.js'));        }
function riskClassifier()   { return _riskClassifier || (_riskClassifier = _resolve('vanta-risk-classifier.js')); }
function peerRouter()       { return _peerRouter     || (_peerRouter     = _resolve('vanta-peer-router.js'));     }
function failureEscalation(){ return _escalation    || (_escalation    = _resolve('vanta-failure-escalation.js'));}
function trustMetrics()     { return _trust         || (_trust         = _resolve('vanta-trust-metrics.js'));    }
function projects()         { return _projects      || (_projects      = _resolve('vanta-projects.js'));        }

// R3 council fix — delegate to the shared `slugFromCwd()` resolver in
// vanta-projects.js, which already handles:
//   - symlinks (fs.realpathSync)
//   - git remote.origin.url org-repo slugs (globally unique)
//   - monorepo subdirs (git rev-parse --show-toplevel takes basename
//     of repo root, not cwd, so /repo/packages/api → 'repo' not 'api')
//   - ambiguous basenames ($HOME, /tmp, etc. → null)
//   - canonical keyword aliases (PROJECT_KEYWORDS lookup)
//
// R2's basename + canonProject sandwich missed the monorepo case because
// `path.basename('/repo/packages/api')` is `api`, fragmenting trust per
// subdirectory. slugFromCwd walks up to the git root first.
//
// Mirrored in hooks/prompt-rewriter.js — keep in sync.
function _canonProjectFromCwd(cwd) {
  if (!cwd) return null;
  const p = projects();
  if (p && typeof p.slugFromCwd === 'function') {
    try { return p.slugFromCwd(cwd) || null; } catch (_) { /* fall through */ }
  }
  // Defensive fallback only fires if vanta-projects.js fails to load
  // or throws. Keeps decide() from crashing in degraded environments.
  if (p && typeof p.canonProject === 'function') {
    const slug = path.basename(cwd);
    return p.canonProject(slug) || slug;
  }
  return path.basename(cwd);
}

// v3.7.4 — effort signal. A "big" change is risk-elevating regardless
// of file path or prompt. Two cheap inputs: diff-body size and
// multi-file edits (when caller passes file_count). The signals stack
// with failure-escalation (both can fire in the same Decision).
const EFFORT_DIFF_LINES_HIGH    = 200;     // > 200 lines added/removed → elevated
const EFFORT_DIFF_LINES_HUGE    = 800;     // > 800 lines → force at least T2
const EFFORT_FILE_COUNT_HIGH    = 5;
function _effortSignal(diff, fileCount) {
  if (!diff && (fileCount || 0) < EFFORT_FILE_COUNT_HIGH) return null;
  const lines = diff ? (diff.match(/\n/g) || []).length : 0;
  if (lines >= EFFORT_DIFF_LINES_HUGE) {
    return { level: 'huge', lines, file_count: fileCount || 0,
             why: `huge diff: ${lines} lines (≥${EFFORT_DIFF_LINES_HUGE})`, force_min_tier: 'T2' };
  }
  if (lines >= EFFORT_DIFF_LINES_HIGH || (fileCount || 0) >= EFFORT_FILE_COUNT_HIGH) {
    return { level: 'high', lines, file_count: fileCount || 0,
             why: `effort: ${lines} diff lines / ${fileCount || 0} files`, bump: 1 };
  }
  return null;
}

// v3.7.4 — uncertainty signal. The risk-classifier returns a score
// in 1..5 per axis. Borderline values (rev=2, blast=2..3) are exactly
// where the heuristic is least trustworthy — bump up by one tier when
// both axes land in the borderline band AND no rule matched.
function _uncertaintySignal(cls, routingMode) {
  if (!cls || routingMode === 'rule' || routingMode === 'llm') return null;
  const r = cls.score && cls.score.reversibility;
  const b = cls.score && cls.score.blast_radius;
  // Borderline band: both axes in 2..3 AND we don't have a high-confidence
  // rule. The classifier produced a tier from sparse signal — distrust it.
  if (r != null && b != null && r >= 2 && r <= 3 && b >= 2 && b <= 3) {
    return { bump: 1, why: `borderline-risk (rev=${r}, blast=${b}); no rule match` };
  }
  return null;
}

// R2 council fix — trust-metrics cache. `tm.compute()` reads the entire
// `~/.vanta/interactions.jsonl` (and any rotated `.bak` siblings) into
// memory and JSON-parses each line; on a heavy user this is tens of MBs
// of work re-done on every UserPromptSubmit. The cache lives at module
// scope so the same node-process executor reuses the entry across
// decide() calls.
//
// R3 council tuning:
//  - TTL 60s → 15s. Gemini R3 P3 noted that an undo/interrupt should
//    flip trust immediately. 15s still relieves the hot path (typical
//    session: << 1 prompt/sec) but caps the lag where inline_ready
//    stays true after a regret signal.
//  - Cache size capped at 64 entries. Gemini R3 P4 — long-running
//    daemon with churning cwds would bleed memory unbounded. 64 is
//    well above realistic project counts for any single user.
const _TRUST_TTL_MS = 15_000;
const _TRUST_CACHE_MAX = 64;
const _trustCache = new Map(); // key = project || '__null__' → {ts, m}
function _cachedTrust(tm, project) {
  if (!tm || typeof tm.compute !== 'function') return null;
  const key = project || '__null__';
  const now = Date.now();
  const hit = _trustCache.get(key);
  if (hit && (now - hit.ts) < _TRUST_TTL_MS) return hit.m;
  let m = null;
  try { m = tm.compute({ days: 30, project }); } catch (_) { m = null; }
  if (_trustCache.size >= _TRUST_CACHE_MAX) {
    // Evict oldest by insertion order — Map preserves insertion order
    // for iteration. Cheap, deterministic, no extra bookkeeping.
    const firstKey = _trustCache.keys().next().value;
    if (firstKey !== undefined) _trustCache.delete(firstKey);
  }
  _trustCache.set(key, { ts: now, m });
  return m;
}

// v3.8.1 — explicit cache invalidation on regret signals. The 15s TTL
// is a passive bound on stale-trust lag; this function lets callers
// (vanta-undo, interrupt-detection paths) drop the cached entry the
// instant a regret signal lands, so the next `decide()` re-reads the
// action-log and reflects the new manual_interrupt / undo_within_2m
// rate immediately.
//
// `project` is the canonical slug from `_canonProjectFromCwd(cwd)`.
// Pass null/undefined to clear the entire cache (used after global
// state events like sync-queue drain or large-scale revert).
function invalidateTrustCache(project) {
  if (project == null) {
    _trustCache.clear();
    return { cleared: 'all' };
  }
  const key = project || '__null__';
  const had = _trustCache.delete(key);
  return { cleared: had ? key : null };
}

// Test-seam — exposes the cache state for regression tests. Not part
// of the public API; consumers should never read this. Returns a
// shallow snapshot so the test can't accidentally mutate the live
// cache.
function _trustCacheSnapshot() {
  return Array.from(_trustCache.entries()).map(([k, v]) => ({
    key: k, ts: v.ts, ready: !!(v.m && v.m.ready_for_inline),
  }));
}

// Apply tier bumps in priority order. Higher priority signals dominate.
const TIER_BUMP = { T0: 'T1', T1: 'T2', T2: 'T3', T3: 'T3' };
function _bumpTier(tier, n) {
  let t = tier;
  for (let i = 0; i < (n || 0); i++) t = TIER_BUMP[t] || t;
  return t;
}
const TIER_ORDER = ['T0', 'T1', 'T2', 'T3'];
function _maxTier(...tiers) {
  return tiers.filter(Boolean).reduce((max, t) =>
    TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(max) ? t : max, 'T0');
}

// v3.7.3 — semantic product-decision detector. Cheap regex over phrases
// that read like "asking for a strategic call" combined with strategic
// keywords. Catches things like "should we add subscription tiers?" or
// "let's rename the API surface" that the existing prompt-* floor
// entries miss because they require a specific verb anchor. Heuristic
// only — no LLM call.
const SEMANTIC_PRODUCT_FRAMERS = /\b(should|ought|do)\s+(we|i|you)\b|^\s*(let'?s|let\s+me|can\s+we|why\s+don'?t\s+we|what\s+if\s+we|maybe\s+we)\b/i;
const SEMANTIC_PRODUCT_TARGETS = /\b(prices?|pricing|tiers?|plans?|features?|products?|launch(?:es|ing)?|deprecate|sunset|scope|renames?|renaming|brand(?:s|ing)?|positioning|strateg(?:y|ies)|gtm|api\s+contract|schemas?|business\s+models?|subscriptions?)\b/i;
function _semanticProductDecision(prompt) {
  if (!prompt) return null;
  if (!SEMANTIC_PRODUCT_FRAMERS.test(prompt)) return null;
  if (!SEMANTIC_PRODUCT_TARGETS.test(prompt)) return null;
  return {
    id: 'semantic-product-decision',
    why: 'phrasing reads as a strategic call (framer + target)',
  };
}

// ─── Tier latency budgets ────────────────────────────────────────────────────
// Hooks consume budget_ms to cap downstream LLM/peer/council calls. The
// budgets reflect the call-graph: T0 is local rewrite only; T3 may fire
// a 2-round Gemini+Codex council loop.
const BUDGET_MS = Object.freeze({
  T0: 5_000,    // 5s   — local rewrite + maybe one short context fetch
  T1: 30_000,   // 30s  — claude self-review
  T2: 120_000,  // 2m   — single peer (codex or gemini)
  T3: 300_000,  // 5m   — full council, R1 + optional R2
});

// ─── Decision id ─────────────────────────────────────────────────────────────
// Stable per-call id so action-log entries can pair-up rewriter +
// council + sync events from the same prompt. Format matches the
// per-action ids used by vanta-action-log (`act-<hex>`).
function _decisionId() {
  return 'dec-' + crypto.randomBytes(6).toString('hex');
}

// Decision-source classifier strings hooks can grep on.
const SOURCES = Object.freeze({
  KILL:       'kill-switch',
  FLOOR:      'safety-floor',
  REWRITER_A: 'rewriter-ask',
  REWRITER_R: 'rewriter-rule',
  RISK:       'risk-classifier',
  DEFAULT:    'default',
});

// Floor ids that read as product-decision prompts get a /council route.
// Anything else (force-push, env writes, etc.) leaves skill_route null
// — the user confirms or aborts; no skill flow.
const PRODUCT_FLOOR_IDS_RX = /^prompt-(pivot|launch|data-policy|taxonomy|bulk-delete)/;

// ─── Main entry ──────────────────────────────────────────────────────────────
//
// decide({prompt, file_path, command, diff, context, cwd, session_id}) -> Decision
//
// Decision = {
//   decision_id:  'dec-<hex>',
//   ts:           ISO-8601,
//   tier:         'T0' | 'T1' | 'T2' | 'T3',
//   decision:     'passthrough' | 'auto' | 'rewrite' | 'ask' | 'block',
//   source:       one of SOURCES above,
//   skill_route:  '/ship' | '/investigate' | ... | null,
//   intent:       'fix-bug' | 'ship' | ... | null,
//   rule_id:      'fix-broken' | ... | null,
//   rewritten:    string | null,                    // numbered chain steps when rewrite
//   score:        { reversibility 1..5, blast_radius 1..5, product_authority bool },
//   risk:         0..10,
//   floor:        { id, kind, why, ... } | null,
//   kill_switch:  { off, scope } | null,
//   peer:         'codex' | 'gemini' | 'both' | null,
//   budget_ms:    integer,
//   why:          composite human-readable string,
//   confidence:   'low' | 'medium' | 'high',
//   context:      { prompt, file_path, command, diff, cwd, session_id },
// }

function decide(input = {}) {
  const ctx = {
    prompt:     input.prompt || '',
    file_path:  input.file_path || null,
    command:    input.command || null,
    diff:       input.diff || null,
    cwd:        input.cwd || process.cwd(),
    session_id: input.session_id || null,
  };
  const ts = new Date().toISOString();
  const decision_id = _decisionId();

  // 1. Kill-switch — terminal short-circuit.
  const ks = killSwitch();
  if (ks && ks.check) {
    const c = ks.check({ sessionId: ctx.session_id, cwd: ctx.cwd });
    if (c && c.off) {
      return _make(ctx, ts, decision_id, {
        tier: 'T0',
        decision: 'passthrough',
        source: SOURCES.KILL,
        why: `kill-switch:${c.scope}`,
        kill_switch: c,
        score: { reversibility: 5, blast_radius: 5, product_authority: false },
        risk: 0,
        confidence: 'high',
      });
    }
  }

  // 2. Safety floor — terminal short-circuit.
  const sf = safetyFloor();
  let floor = null;
  if (sf) {
    if (ctx.prompt   && sf.matchPrompt)  floor = sf.matchPrompt(ctx.prompt)   || null;
    if (!floor && ctx.command  && sf.matchCommand) floor = sf.matchCommand(ctx.command) || null;
    if (!floor && ctx.file_path && sf.matchFile)   floor = sf.matchFile(ctx.file_path)  || null;
    if (!floor && ctx.diff     && sf.matchSymbol)  floor = sf.matchSymbol(ctx.diff)     || null;
    if (floor) {
      const isProduct = PRODUCT_FLOOR_IDS_RX.test(floor.id || '');
      const peer = peerRouter() && peerRouter().pick
        ? peerRouter().pick({ prompt: ctx.prompt, file_path: ctx.file_path, command: ctx.command })
        : null;
      return _make(ctx, ts, decision_id, {
        tier: 'T3',
        decision: 'ask',
        source: SOURCES.FLOOR,
        why: `safety-floor:${floor.id}${floor.why ? ': ' + floor.why : ''}`,
        floor,
        skill_route: isProduct ? '/council' : null,
        peer,
        score: { reversibility: 1, blast_radius: 1, product_authority: isProduct },
        risk: 10,
        confidence: 'high',
      });
    }
  }

  // 2.5 Semantic product-decision detector (v3.8.0 council P2 fix).
  //     Originally ran AFTER the rewriter, which meant a prompt like
  //     "should we pivot pricing? also fix lint" matched the fix-bug
  //     rule first and BYPASSED the T3 ASK gate. Gemini caught this.
  //     Now runs BEFORE the rewriter so semantic strategic phrasing
  //     terminates regardless of trailing tactical verbs.
  {
    const sem = _semanticProductDecision(ctx.prompt);
    if (sem) {
      return _make(ctx, ts, decision_id, {
        tier: 'T3',
        decision: 'ask',
        source: SOURCES.FLOOR,
        why: `semantic-product:${sem.why}`,
        floor: { id: sem.id, why: sem.why, kind: 'semantic' },
        skill_route: '/council',
        score: { reversibility: 2, blast_radius: 3, product_authority: true },
        risk: 8,
        confidence: 'medium',
      });
    }
  }

  // 3. Rewriter — routing + chain. ASK mode is terminal at T3.
  const rw = rewriter();
  let routing = {
    mode: 'passthrough',
    skill_route: null,
    intent: null,
    rule_id: null,
    rewritten: null,
    why: null,
  };
  if (rw && rw.rewrite && ctx.prompt) {
    let r;
    try {
      r = rw.rewrite(ctx.prompt, {
        sessionId: ctx.session_id,
        cwd:       ctx.cwd,
        file_path: ctx.file_path,
        command:   ctx.command,
      });
    } catch (_) { r = null; }
    if (r) {
      // ASK mode (e.g. taxonomy-rename) → terminal T3 ASK.
      if (r.mode === 'ask') {
        return _make(ctx, ts, decision_id, {
          tier: r.tier || 'T3',
          decision: 'ask',
          source: SOURCES.REWRITER_A,
          why: r.why || `rewriter-ask:${r.rule_id || r.intent}`,
          skill_route: r.skill_route || '/council',
          intent: r.intent || null,
          rule_id: r.rule_id || null,
          score: { reversibility: 2, blast_radius: 3, product_authority: true },
          risk: 7,
          confidence: r.confidence || 'high',
        });
      }
      // Rewriter passthrough may still surface a skill_route + floor_match
      // for safety-floor product-decision matches. Step 2 above already
      // ran safety-floor with the same context, so this branch is reached
      // only when rewriter saw a route the executor should respect.
      if (r.mode === 'passthrough') {
        if (r.floor_match) {
          // Belt-and-braces: the executor's safety-floor pass should have
          // caught this. Treat as T3 ASK for parity.
          return _make(ctx, ts, decision_id, {
            tier: 'T3',
            decision: 'ask',
            source: SOURCES.FLOOR,
            why: `safety-floor:${r.floor_match.id}`,
            floor: r.floor_match,
            skill_route: r.skill_route || null,
            score: { reversibility: 1, blast_radius: 1, product_authority: !!r.floor_match.id?.startsWith('prompt-') },
            risk: 10,
            confidence: 'high',
          });
        }
        // Empty / lookup / chat — no routing.
        routing = { mode: 'passthrough', skill_route: null, intent: r.intent || null, rule_id: null, rewritten: null, why: r.why || null };
      } else if (r.mode === 'rule') {
        routing = {
          mode: 'rule',
          skill_route: r.skill_route || null,
          intent: r.intent || null,
          rule_id: r.rule_id || null,
          rewritten: r.rewritten || null,
          why: r.why || null,
        };
      } else if (r.mode === 'llm') {
        routing = {
          mode: 'llm',
          skill_route: r.skill_route || null,
          intent: r.intent || null,
          rule_id: null,
          rewritten: r.rewritten || null,
          why: r.why || null,
        };
      }
    }
  }

  // (Semantic product-decision detector moved to step 2.5 — see above.)

  // 4. Risk classifier — independent score over prompt+file+command.
  const rc = riskClassifier();
  let cls;
  if (rc && rc.classify) {
    try {
      cls = rc.classify({
        prompt:    ctx.prompt,
        file_path: ctx.file_path,
        command:   ctx.command,
        sessionId: ctx.session_id,
        cwd:       ctx.cwd,
      });
    } catch (_) { cls = null; }
  }
  if (!cls) {
    cls = {
      tier: 'T0',
      decision: 'auto',
      score: { reversibility: 5, blast_radius: 5, product_authority: false },
      risk: 0,
      why: 'no-classifier',
      peer: null,
      floor_match: null,
    };
  }

  // 4a. Failure escalation — bump tier when the session is stuck. The
  //     escalation module reads the action-log for consecutive failure
  //     signals (test-failure, build-failure, undo, regret) and emits
  //     a bump or a force-T3 verdict. Cheap (<10ms on a typical log).
  let escalation = null;
  const fe = failureEscalation();
  if (fe && fe.escalate) {
    try {
      escalation = fe.escalate({ session_id: ctx.session_id });
    } catch (_) { escalation = null; }
  }
  let escalatedTier = cls.tier;
  if (escalation && (escalation.bump > 0 || escalation.force_tier)) {
    escalatedTier = fe.applyEscalation(cls.tier, escalation);
  }

  // 4b. Effort signal — big diffs / many files elevate risk.
  const effort = _effortSignal(ctx.diff, input.file_count);
  if (effort) {
    if (effort.force_min_tier) {
      escalatedTier = _maxTier(escalatedTier, effort.force_min_tier);
    } else if (effort.bump) {
      escalatedTier = _bumpTier(escalatedTier, effort.bump);
    }
  }

  // 4c. Uncertainty signal — borderline classifier output without a
  //     matching rewriter rule means the heuristic is firing on sparse
  //     signal. Bump by one to surface the doubt to the user.
  const uncertainty = _uncertaintySignal(cls, routing.mode);
  if (uncertainty && uncertainty.bump) {
    escalatedTier = _bumpTier(escalatedTier, uncertainty.bump);
  }

  // 4c-bis. Two-eyes compound enforcement (v3.7.5) — when 2+ high-risk
  //         signals fire simultaneously (failure-escalation +
  //         huge-effort, semantic-product + uncertainty, etc.) the
  //         single-tier bump isn't enough. Force T3 AND require both
  //         peers (codex + gemini) for the council pass, instead of
  //         the single peer the risk-classifier picked.
  const compoundSignals = [
    escalation && (escalation.bump > 0 || escalation.force_tier),
    effort && (effort.level === 'huge' || effort.level === 'high'),
    uncertainty && uncertainty.bump,
  ].filter(Boolean).length;
  let twoEyes = false;
  if (compoundSignals >= 2) {
    escalatedTier = 'T3';
    twoEyes = true;
  }

  // 4d. Trust→inline mode signal. The Decision carries `inline_ready:
  //     bool` so consumers (prompt-rewriter hook) can opt to flip from
  //     shadow to inline once trust thresholds clear (14d span, low
  //     undo / interrupt rates). v3.7.4 only SURFACES the signal —
  //     the actual mode flip lands in v3.8 once the migration design
  //     is council-reviewed.
  let inline_ready = false;
  const tm = trustMetrics();
  if (tm && tm.compute) {
    try {
      // v3.7.5 — project-scoped trust. R2 fix: derive slug via the same
      // canonical helper hooks use, so the project key matches what
      // prompt-rewriter wrote into action-log. Cached for 60s — see
      // _cachedTrust comment for why.
      const project = _canonProjectFromCwd(ctx.cwd);
      const m = _cachedTrust(tm, project);
      inline_ready = !!(m && m.ready_for_inline);
    } catch (_) { inline_ready = false; }
  }

  // 5. Compose final decision.
  //   - tier wins from classifier, optionally bumped by failure escalation
  //   - decision combines rewriter routing + tier:
  //       T3                        → ask  (matches risk-classifier semantics)
  //       T0/T1/T2 + rewriter rule  → rewrite  (terse 4-line shadow)
  //       T0/T1/T2 + passthrough    → auto / passthrough (no shadow)
  const tier = escalatedTier;
  let decision;
  if (tier === 'T3') {
    decision = 'ask';
  } else if (routing.mode === 'rule' || routing.mode === 'llm') {
    decision = 'rewrite';
  } else {
    decision = routing.intent ? 'passthrough' : 'auto';
  }

  const why = [
    cls.why,
    routing.rule_id ? `rule:${routing.rule_id}` : null,
    routing.mode === 'passthrough' && routing.intent ? `passthrough:${routing.intent}` : null,
    escalation && (escalation.bump > 0 || escalation.force_tier)
      ? `escalation:${escalation.why}`
      : null,
    effort      ? `effort:${effort.why}`            : null,
    uncertainty ? `uncertainty:${uncertainty.why}`  : null,
  ].filter(Boolean).join(' · ');

  // v3.7.4: confidence reflects all three signals. Any uncertainty
  // bump or borderline-classifier hit drops it to medium.
  const confidence = (uncertainty || (cls.score && cls.score.reversibility === 4 && cls.score.blast_radius === 4 && !routing.rule_id))
    ? 'medium'
    : 'high';

  return _make(ctx, ts, decision_id, {
    tier,
    decision,
    source: routing.mode === 'rule' || routing.mode === 'llm' ? SOURCES.REWRITER_R : SOURCES.RISK,
    why,
    skill_route: routing.skill_route,
    intent: routing.intent,
    rule_id: routing.rule_id,
    rewritten: routing.rewritten,
    score: cls.score,
    risk: cls.risk,
    peer: twoEyes ? { peer: 'both', why: 'two-eyes compound enforcement' } : cls.peer,
    escalation: escalation && (escalation.bump > 0 || escalation.force_tier) ? escalation : null,
    effort:     effort      || null,
    uncertainty: uncertainty || null,
    two_eyes:   twoEyes,
    inline_ready,
    confidence,
  });
}

function _make(ctx, ts, decision_id, d) {
  return {
    decision_id,
    ts,
    tier:        d.tier,
    decision:    d.decision,
    source:      d.source,
    skill_route: d.skill_route || null,
    intent:      d.intent || null,
    rule_id:     d.rule_id || null,
    rewritten:   d.rewritten || null,
    score:       d.score || { reversibility: 4, blast_radius: 4, product_authority: false },
    risk:        d.risk != null ? d.risk : 0,
    floor:       d.floor || null,
    kill_switch: d.kill_switch || null,
    peer:        d.peer || null,
    escalation:  d.escalation || null,
    effort:      d.effort || null,
    uncertainty: d.uncertainty || null,
    two_eyes:    d.two_eyes === true,
    inline_ready: d.inline_ready === true,
    budget_ms:   BUDGET_MS[d.tier] || BUDGET_MS.T0,
    why:         d.why || '',
    confidence:  d.confidence || 'high',
    context: {
      prompt:     ctx.prompt,
      file_path:  ctx.file_path,
      command:    ctx.command,
      diff:       ctx.diff,
      cwd:        ctx.cwd,
      session_id: ctx.session_id,
    },
  };
}

module.exports = { decide, BUDGET_MS, SOURCES, invalidateTrustCache, _trustCacheSnapshot };

// ─── CLI ─────────────────────────────────────────────────────────────────────
//   echo '{"prompt":"delete all users"}' | vanta-executor
//   vanta-executor --prompt "ship this" --file src/api/auth.ts
if (require.main === module) {
  const args = process.argv.slice(2);
  const find = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flagInput = {
    prompt:    find('--prompt'),
    file_path: find('--file'),
    command:   find('--command'),
    diff:      find('--diff'),
  };
  const hasFlag = !!(flagInput.prompt || flagInput.file_path || flagInput.command || flagInput.diff);

  if (hasFlag) {
    process.stdout.write(JSON.stringify(decide(flagInput), null, 2) + '\n');
    process.exit(0);
  }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => stdin += c);
  process.stdin.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(stdin || '{}'); } catch {}
    process.stdout.write(JSON.stringify(decide(parsed), null, 2) + '\n');
  });
}
