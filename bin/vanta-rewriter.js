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

const RULES = [
  {
    id: 'fix-broken',
    rx: /\b(fix|debug|investigate|figure\s+out)\b.*\b(bug|error|broken|fail|crash|doesn'?t\s+work|not\s+working|didn'?t\s+work|stopped\s+working)\b/i,
    intent: 'fix-bug',
    chain: [
      'Read the most recent error context (last_run.log, console output, or recently modified file).',
      'Run `git log --oneline -5` to see what changed recently.',
      'Write a failing test that reproduces the error before changing source.',
      'Apply the minimal fix. Do not refactor unrelated code.',
      'Run the test suite to verify the fix and check no regressions.',
      'Commit with a clear `fix:` message naming the symptom and root cause.',
    ],
  },
  {
    id: 'it-didnt-work',
    rx: /^\s*(it\s+didn'?t\s+work|that\s+didn'?t\s+work|broken|still\s+failing|didn'?t\s+fix\s+it)\s*\.?\s*$/i,
    intent: 'diagnose-recent',
    chain: [
      'Re-read the most recent test output / error context.',
      'Compare current state to last known good (`git diff HEAD~1` if no uncommitted, otherwise `git status`).',
      'List the top 3 hypotheses for why it failed, ranked by likelihood.',
      'Pick the most likely; verify with a single targeted test or read.',
      'Apply fix or escalate to /council if the failure mode is genuinely unclear.',
    ],
  },
  {
    id: 'ship-this',
    rx: /^\s*(ship|deploy|push|merge|release)\s+(this|it|that|now)?\s*\.?\s*$/i,
    intent: 'ship',
    chain: [
      'Run the full test suite. Block on any failure.',
      'Run `npx tsc --noEmit` (or language-equivalent typecheck).',
      'Check `git status` is clean and on the right branch.',
      'Open PR via `gh pr create` with a body summarizing the change and a test plan.',
      'Do NOT push to main directly. Do NOT use --no-verify.',
    ],
  },
  {
    id: 'review-this',
    rx: /^\s*(review|check|look\s+at)\s+(this|the\s+(code|diff|change|pr))?\s*\.?\s*$/i,
    intent: 'review',
    chain: [
      'Run `git diff` (or `git diff main` if reviewing a branch) to scope the change.',
      'Identify any safety-floor matches in the diff (DDL, pricing, auth, secrets).',
      'Look for: edge cases not covered, error paths missing, test gaps, security issues.',
      'Summarize findings as P1/P2/P3 priorities. Suggest fixes for P1 only.',
    ],
  },
  {
    id: 'write-tests',
    rx: /\b(write|add|create)\s+tests?\s+(for|on|covering)?\s*(this|the|that)?\b/i,
    intent: 'tdd',
    chain: [
      'Read the function/module you are testing. Understand the public surface.',
      'List the cases: happy path, edge cases, error paths, boundary inputs.',
      'Write failing tests for each case (red).',
      'Verify each test fails for the right reason.',
      'Implement minimal code to pass (green) — only if implementation is missing.',
    ],
  },
  {
    id: 'make-faster',
    rx: /\b(make|get|run)\s+(it|this|that)?\s*(faster|quicker|better\s+perf|optimize|speed\s+up)\b/i,
    intent: 'optimize',
    chain: [
      'Measure first. Run a benchmark or capture current timing — never optimize without numbers.',
      'Identify the hot path. `console.time` / profiler / explain plan as appropriate.',
      'Form a hypothesis about WHY it is slow before changing code.',
      'Apply ONE change. Re-measure. Keep if it helps; revert if not.',
      'Document the speedup and the trade-off (memory, complexity, readability).',
    ],
  },
  {
    id: 'refactor',
    rx: /\b(refactor|clean\s+up|tidy|simplify|reorganize)\b/i,
    intent: 'refactor',
    chain: [
      'Confirm tests cover the area you are about to refactor. If not, write tests first.',
      'Make ONE structural change at a time. Run tests after each.',
      'Do not change behavior. If you find a bug while refactoring, note it; fix in a separate commit.',
      'Commit the refactor as `refactor:` — separate from any feature/fix.',
    ],
  },
  {
    id: 'add-feature',
    rx: /\b(add|implement|build|create)\b[^.?!\n]{0,80}\b(feature|endpoint|component|page|api|hook)\b/i,
    intent: 'feature',
    chain: [
      'Read the closest existing analogue in the codebase. Match its patterns.',
      'Plan the change: what files, what tests, what API contract.',
      'Write the test(s) first.',
      'Implement to pass tests.',
      'Verify integration: run the dev server, exercise the feature in a browser if UI-facing.',
    ],
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

  // 2. Safety floor — floor-matched prompts must NOT be auto-rewritten.
  // The user is supposed to confirm; making it easier is the wrong move.
  const sf = safetyFloor();
  if (sf) {
    const f = sf.matchPrompt(prompt);
    if (f) {
      return { mode: 'passthrough', original: prompt, why: `safety-floor:${f.id}`, floor_match: f };
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
      const rewritten = _formatChain(prompt, r);
      return {
        mode: 'rule',
        original: prompt,
        rewritten,
        intent: r.intent,
        rule_id: r.id,
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

function _formatChain(original, rule) {
  const lines = [];
  lines.push(`[Vanta rewrite — intent=${rule.intent}, confidence=high]`);
  lines.push(`Original: ${original.trim()}`);
  lines.push('');
  lines.push('Suggested chain:');
  for (let i = 0; i < rule.chain.length; i++) {
    lines.push(`  ${i + 1}. ${rule.chain[i]}`);
  }
  return lines.join('\n');
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
