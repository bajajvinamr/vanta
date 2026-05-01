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
let _killSwitch, _safetyFloor, _rewriter, _riskClassifier, _peerRouter;

function _resolve(name) {
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', name),
    path.join(__dirname, name),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', name),
  ]) {
    try { return require(p); } catch {}
  }
  return null;
}
function killSwitch()     { return _killSwitch     || (_killSwitch     = _resolve('vanta-kill-switch.js'));     }
function safetyFloor()    { return _safetyFloor    || (_safetyFloor    = _resolve('vanta-safety-floor.js'));    }
function rewriter()       { return _rewriter       || (_rewriter       = _resolve('vanta-rewriter.js'));        }
function riskClassifier() { return _riskClassifier || (_riskClassifier = _resolve('vanta-risk-classifier.js')); }
function peerRouter()     { return _peerRouter     || (_peerRouter     = _resolve('vanta-peer-router.js'));     }

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

  // 5. Compose final decision.
  //   - tier wins from classifier (it's the single source of risk truth)
  //   - decision combines rewriter routing + tier:
  //       T3                        → ask  (matches risk-classifier semantics)
  //       T0/T1/T2 + rewriter rule  → rewrite  (terse 4-line shadow)
  //       T0/T1/T2 + passthrough    → auto / passthrough (no shadow)
  const tier = cls.tier;
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
  ].filter(Boolean).join(' · ');

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
    peer: cls.peer,
    confidence: 'high',
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

module.exports = { decide, BUDGET_MS, SOURCES };

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
