#!/usr/bin/env node
// vanta-rewriter — turn a 1-line prompt into an actionable engineer chain.
//
// The single most user-visible feature of the v3.7 executor build. A
// prompt like "fix the bug" passes through this module and (when the
// pass-through gate doesn't bypass it) becomes:
//
//   1. Read the most recent error in `last_run.log` or stderr context.
//   2. Run `git blame` on the affected file to find recent changes.
//   3. Write a failing test that reproduces the error.
//   4. Apply the minimal fix.
//   5. Run `npm test` to verify; if green, commit with a clear message.
//
// Three modes:
//   passthrough   - rewriter stays out of the way (read/show/list/what-is)
//   rule          - template-matched against a curated intent->chain map
//   llm           - last resort, for ambiguous multi-step prompts
//
// Returns:
//   { mode: 'passthrough', original }                                — no rewrite
//   { mode: 'rule',  original, rewritten, intent, confidence, why }
//   { mode: 'llm',   original, rewritten, confidence: 'medium', why }
//
// Shadow mode (default): the consumer (UserPromptSubmit hook) injects
// the rewrite as ADDITIONAL CONTEXT alongside the original prompt, so
// Claude sees both and can pick. After 14d of trust-metric thresholds
// being met, can flip to inline (rewrite replaces original).
//
// SAFETY:
//   - safety-floor MUST be consulted first. Floor-matched prompts pass
//     through unrewritten (the rewriter must not "make easier" a prompt
//     the user is supposed to confirm).
//   - kill-switch off → passthrough, period.
//   - Untrusted memory entries (trust: untrusted) are NEVER used to
//     construct rewrite chains. v3.6.18 prompt-injection guard.

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

// ─── Pass-through gate ───────────────────────────────────────────────────────
// Single-step / lookup / clarification prompts that don't benefit from
// rewriting. Bypass keeps latency near zero and avoids overreach on
// trivial intents.

const PASSTHROUGH_PATTERNS = [
  // Read-only lookups
  { rx: /^\s*(what|where|who|when|which)\s+(is|are|was|were|does|do)\b/i,    intent: 'lookup' },
  { rx: /^\s*(show|display|print|cat|list|tell\s+me|read)\b/i,               intent: 'lookup' },
  { rx: /^\s*(explain|describe)\b/i,                                         intent: 'explain' },
  // Confirmations
  { rx: /^\s*(yes|no|y|n|ok|okay|yep|yeah|nope|sure|skip)\s*\.?\s*$/i,       intent: 'confirm' },
  // One-word commands
  { rx: /^\s*\/\w+(\s|$)/,                                                   intent: 'slash-command' },
  // Greetings / chit-chat
  { rx: /^\s*(hi|hello|hey|thanks|thank\s+you|cool|great|nice)\b/i,          intent: 'chat' },
  // Already-structured prompts with numbered / bulleted steps
  { rx: /^\s*\d+\.\s+\w/,                                                    intent: 'already-structured' },
  { rx: /^\s*[-*+]\s+\w/,                                                    intent: 'already-structured' },
  // Short prompts (< 4 words) that aren't action verbs
  // (filtered after the action-verb check below)
];

const ACTION_VERBS = /^\s*(fix|debug|investigate|test|ship|deploy|review|refactor|build|add|implement|write|create|make|run|check|verify|optimize|improve|update|migrate|plan)\b/i;

function _wordCount(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

function _isPassthrough(prompt) {
  if (!prompt) return { passthrough: true, intent: 'empty' };
  for (const p of PASSTHROUGH_PATTERNS) {
    if (p.rx.test(prompt)) return { passthrough: true, intent: p.intent };
  }
  return { passthrough: false };
}

// ─── Rule-based intent matcher ───────────────────────────────────────────────
// Curated intent -> chain mapping. Each entry: { rx, intent, chain }.
// `chain` is an array of step strings the rewritten prompt will list.
// Templates ({file}, {test_path}, etc.) are filled by `_fillTemplate`
// from the caller's context (cwd, recent files, etc.).

// v3.7.1 contract:
// - Each rule has skill_route — the slash command Vanta would invoke.
// - chain is ≤3 high-signal steps so the shadow injection stays terse.
// - Some rules emit `mode: 'ask'` instead of `mode: 'rule'` — these are
//   product/irreversible decisions where Vanta should NOT auto-rewrite a
//   chain. The hook surfaces "[Vanta] /<route> recommended · T3 ASK".
// - Intent matching is permissive on purpose: weak one-liners like "fix
//   this" / "write tests" / "make this better" are the make-or-break
//   prompts. The rule regex matches the bare verb form too.
const RULES = [
  // ── DIAGNOSTIC PATH (it-didnt-work BEFORE fix-broken so the bare
  //    "it didn't work" lands on diagnose-recent, not the looser fix rule)
  {
    id: 'it-didnt-work',
    rx: /^\s*(it\s+didn'?t\s+work|that\s+didn'?t\s+work|broken|still\s+failing|didn'?t\s+fix\s+it)\s*\.?\s*$/i,
    intent: 'diagnose-recent',
    skill_route: '/investigate',
    chain: [
      'Re-read the most recent test output / error context.',
      'Compare current state to last known good (`git diff HEAD~1` or `git status`).',
      'Form 3 hypotheses, verify the most likely with one targeted test.',
    ],
  },
  // ── FIX (broadened to catch bare "fix this" / "fix it" / "debug this")
  {
    id: 'fix-broken',
    rx: /^\s*(fix|debug|investigate)\s+(this|it|that|the\s+\w+)?\s*\.?\s*$|\b(fix|debug|investigate|figure\s+out)\b.*\b(bug|error|broken|fail|crash|doesn'?t\s+work|not\s+working|didn'?t\s+work|stopped\s+working)\b/i,
    intent: 'fix-bug',
    skill_route: '/investigate',
    chain: [
      'Read the most recent error context and `git log --oneline -5` for recent changes.',
      'Write a failing test that reproduces the bug before touching source.',
      'Apply the minimal fix; run tests to confirm no regressions.',
    ],
  },
  // ── SHIP (broadened to "push this" / "deploy this" / "merge this")
  {
    id: 'ship-this',
    rx: /^\s*(ship|deploy|push|merge|release)\s+(this|it|that|now)?\s*\.?\s*$/i,
    intent: 'ship',
    skill_route: '/ship',
    chain: [
      'Run full tests + typecheck + lint. Block on any failure.',
      'Confirm `git status` clean, on the right branch (not main).',
      'Open PR via `gh pr create` with summary and test plan. Never --no-verify.',
    ],
  },
  // ── REVIEW
  {
    id: 'review-this',
    rx: /^\s*(review|check|look\s+at)\s+(this|the\s+(code|diff|change|pr))?\s*\.?\s*$/i,
    intent: 'review',
    skill_route: '/review',
    chain: [
      'Run `git diff` (or `git diff main`) to scope the change.',
      'Flag safety-floor matches: DDL, pricing, auth, secrets, user-visible strings.',
      'Summarize as P1/P2/P3; suggest fixes for P1 only.',
    ],
  },
  // ── WRITE TESTS (broadened — bare "write tests" / "add tests" matches)
  {
    id: 'write-tests',
    rx: /^\s*(write|add|create)\s+tests?\s*(for|on|covering)?\s*(this|the|that|\w+)?\s*\.?\s*$|\b(write|add|create)\s+tests?\s+(for|on|covering)\s+\S/i,
    intent: 'tdd',
    skill_route: '/qa',
    chain: [
      'Read the function/module to test; list happy path + edges + error paths.',
      'Write failing tests for each case (red). Verify each fails for the right reason.',
      'Implement minimal code to pass (green) only if implementation is missing.',
    ],
  },
  // ── MAKE FASTER / BETTER / IMPROVE (broadened)
  {
    id: 'make-faster',
    rx: /^\s*(make|get|run)\s+(it|this|that)\s*(faster|quicker|better|sharper)\s*\.?\s*$|\b(make|get|run)\s+(it|this|that)?\s*(faster|quicker|better\s+perf|optimize|speed\s+up)\b|^\s*improve\s+(this|it|that)\s*\.?\s*$/i,
    intent: 'optimize',
    skill_route: '/review',
    chain: [
      'Measure first — capture current timing or quality metric. Never optimize without numbers.',
      'Identify the hot path or weak point; form a hypothesis about WHY before changing code.',
      'Apply ONE change. Re-measure. Keep if it helps; revert if not.',
    ],
  },
  // ── REFACTOR (broadened — "clean this up" / "tidy this" matches)
  {
    id: 'refactor',
    rx: /^\s*(clean|tidy|simplify|reorganize)\s+(this|it|that|up)?\s*\.?\s*$|\b(refactor|clean\s+up|tidy|simplify|reorganize)\b/i,
    intent: 'refactor',
    skill_route: '/review',
    chain: [
      'Confirm tests cover the area; write tests first if not.',
      'Make ONE structural change at a time; run tests after each.',
      'Commit as `refactor:` — separate from any feature or fix.',
    ],
  },
  // ── ADD FEATURE
  {
    id: 'add-feature',
    rx: /\b(add|implement|build|create)\b[^.?!\n]{0,80}\b(feature|endpoint|component|page|api|hook)\b/i,
    intent: 'feature',
    skill_route: '/ship',
    chain: [
      'Read the closest existing analogue; match its patterns.',
      'Plan files, tests, API contract; write tests first.',
      'Implement to pass tests; verify in browser if UI-facing.',
    ],
  },
  // ── NEW v3.7.1 RULES ──────────────────────────────────────────────────
  // Resume — "continue from last time" / "where were we" / "what's next"
  // Reads CONTINUE.md per global CLAUDE.md convention.
  {
    id: 'resume',
    rx: /^\s*(continue|resume|pick\s+up|where\s+were\s+we|what'?s?\s+next|next\s+up)\s*(from\s+(last\s+time|here|yesterday))?\s*\.?\s*$/i,
    intent: 'resume',
    skill_route: 'continue-state',
    chain: [
      'Read CONTINUE.md, latest `.planning/*.md` by mtime, and `git log -5 --oneline`.',
      'Pick the next unblocked item from the resume state.',
      'Execute end-to-end; only interrupt for one-way doors.',
    ],
  },
  // Audit gaps — "find gaps" / "what's missing" / "audit this"
  // Routes to Codex/adversarial review path.
  {
    id: 'audit-gaps',
    rx: /^\s*(find|show|list)\s+gaps?\s*\.?\s*$|\bwhat'?s?\s+missing\b|^\s*audit\s+(this|it|that|the\s+\w+)?\s*\.?\s*$/i,
    intent: 'audit-gaps',
    skill_route: '/codex',
    chain: [
      'Run `git diff main` (or current branch base) to scope the change set.',
      'Send to adversarial reviewer (`/codex` or `/council`) for blind-spot detection.',
      'Treat findings as hypotheses — verify each before fixing.',
    ],
  },
  // Diff summary — "what changed?" / "show me the diff"
  {
    id: 'diff-summary',
    rx: /^\s*(what\s+changed|what'?s?\s+different|show\s+(me\s+)?(the\s+)?diff)\s*\??\s*\.?\s*$/i,
    intent: 'diff-summary',
    skill_route: 'git-diff',
    chain: [
      'Run `git status --short` and `git diff --stat`.',
      'For each modified file, summarize what changed in 1 sentence.',
      'Flag any safety-floor matches (DDL, pricing, auth, secrets).',
    ],
  },
  // Taxonomy / rename — "rename X to Y" / "rename Z" → ASK (not rewrite).
  // This is the silent-product-decision miss the council flagged. Mode='ask'
  // tells the hook to surface "/council recommended · T3 ASK", not inject
  // a chain.
  {
    id: 'taxonomy-rename',
    rx: /^\s*(rename|change\s+name\s+of)\s+\S+\s+(to|->|→|=>)\s+\S+|^\s*rename\s+\w+\s*\.?\s*$/i,
    intent: 'taxonomy-rename',
    skill_route: '/council',
    mode: 'ask',
    tier: 'T3',
    why: 'rename touches taxonomy/API/schema/UX strings — product authority required',
    chain: [],
  },
];

// ─── LLM fallback (NOT implemented yet) ──────────────────────────────────────
// For ambiguous multi-step prompts not matched by RULES. Initially this
// is a stub that returns `{ mode: 'llm-stub' }` so we can wire the
// integration without burning model calls in tests/CI. The real
// implementation will:
//   - call Anthropic SDK with a tight rubric prompt
//   - require `latency < 2s` (cancel + passthrough on timeout)
//   - cost-cap via vanta-trust-metrics budget knob
//
// Until then, LLM-fallback returns null (caller treats it as passthrough).
function _llmRewrite(_prompt, _context) {
  return null;
}

// ─── Main entry point ────────────────────────────────────────────────────────

function rewrite(prompt, context = {}) {
  // 1. Kill switch — executor off → passthrough.
  const ks = killSwitch();
  if (ks) {
    const c = ks.check({ sessionId: context.sessionId, cwd: context.cwd });
    if (c.off) {
      return { mode: 'passthrough', original: prompt, why: `kill-switch:${c.scope}` };
    }
  }

  // 2. Safety floor — floor-matched prompts/commands/files must NOT be
  // auto-rewritten. The user is supposed to confirm; making it easier is
  // the wrong move. R1 (Codex P2): the original implementation only
  // consulted matchPrompt, so `rewrite('write tests', { file_path: '.env.local' })`
  // produced a `write-tests` chain instead of passthrough. v3.6.20:
  // also consult matchFile and matchCommand using the caller's context.
  const sf = safetyFloor();
  if (sf) {
    let f = sf.matchPrompt(prompt);
    if (!f && context.command) f = sf.matchCommand(context.command);
    if (!f && context.file_path) f = sf.matchFile(context.file_path);
    if (f) {
      // v3.7.1: floor matches that read as product-decision prompts get
      // a /council skill_route so the hook can surface the right next
      // step. Other floor matches (force-push, .env writes) leave
      // skill_route null — the user confirms or aborts; no skill flow.
      const isProductDecision = /^prompt-(pivot|launch|data-policy|taxonomy)/.test(f.id || '');
      return {
        mode: 'passthrough',
        original: prompt,
        why: `safety-floor:${f.id}`,
        floor_match: f,
        skill_route: isProductDecision ? '/council' : null,
        tier: 'T3',
      };
    }
  }

  // 3. Pass-through gate — single-step / lookup / chat.
  const pt = _isPassthrough(prompt);
  if (pt.passthrough) {
    return { mode: 'passthrough', original: prompt, intent: pt.intent };
  }

  // 4. Rule-based templates.
  for (const r of RULES) {
    if (r.rx.test(prompt)) {
      // Some rules emit `ask` mode for product/irreversible decisions.
      // The hook surfaces "/<route> recommended · T3 ASK" instead of
      // injecting a shadow chain. v3.7.1 — taxonomy-rename is the only
      // such rule today; the pattern is reusable.
      if (r.mode === 'ask') {
        return {
          mode: 'ask',
          original: prompt,
          intent: r.intent,
          rule_id: r.id,
          skill_route: r.skill_route || null,
          tier: r.tier || 'T3',
          confidence: 'high',
          why: r.why || `matched ask-rule:${r.id}`,
        };
      }
      const rewritten = _formatChain(prompt, r);
      return {
        mode: 'rule',
        original: prompt,
        rewritten,
        intent: r.intent,
        rule_id: r.id,
        skill_route: r.skill_route || null,
        confidence: 'high',
        why: `matched rule:${r.id}`,
      };
    }
  }

  // 5. LLM fallback for ambiguous multi-step prompts.
  const llm = _llmRewrite(prompt, context);
  if (llm) {
    return { mode: 'llm', original: prompt, ...llm };
  }

  // 6. Default — pass through. Better to do nothing than rewrite badly.
  return { mode: 'passthrough', original: prompt, intent: 'unmatched' };
}

// v3.7.1: terse output. Header line + ≤3 chain steps = 4 lines max.
// The hook adds a single "[Vanta]" prefix line (skill route + tier);
// _formatChain returns ONLY the numbered steps so the hook doesn't
// duplicate metadata.
function _formatChain(_original, rule) {
  const steps = rule.chain.slice(0, 3);
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

module.exports = { rewrite, RULES, _isPassthrough };

// ─── CLI ─────────────────────────────────────────────────────────────────────
//   echo "fix the bug" | vanta-rewriter
//   vanta-rewriter --prompt "ship this"
if (require.main === module) {
  const args = process.argv.slice(2);
  let prompt = '';
  const promptFlag = args.indexOf('--prompt');
  if (promptFlag >= 0 && args[promptFlag + 1]) {
    prompt = args[promptFlag + 1];
  } else {
    // Read from stdin.
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => stdin += c);
    process.stdin.on('end', () => {
      const out = rewrite(stdin.trim(), {});
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    });
    return;
  }
  const out = rewrite(prompt, {});
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
