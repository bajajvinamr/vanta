---
name: council
description: Adversarial multi-model review with convergence loop. Fires Gemini and Codex in parallel, synthesizes findings, runs R2 if P1s found. Use before high-stakes decisions — architecture changes, security-sensitive code, large refactors, anything you'd lose sleep over.
argument-hint: "[what to review — blank uses current diff/plan]"
user-invocable: true
model: opus
---

# Council — Multi-Model Adversarial Review

Fire Gemini and Codex in parallel on the same problem. Each has different training data and different blind spots. Synthesize into a single verdict. If P1 findings exist after Round 1, run Round 2 where each model reacts to the other's findings — loop until convergence (no new P1s) or 2 rounds max.

## When to Run (suggest proactively)

Suggest without being asked when:
- Architecture decision involving >2 services or >10 files
- Auth, payments, data privacy, or security-sensitive code
- A refactor where the wrong move is hard to reverse
- After implementing something you're not confident about
- Before any PR that touches shared infrastructure

## Step 0 — Capability Check

Before firing, check what's available:

```
GEMINI_AVAILABLE = mcp__Multi-CLI__Ask-Gemini is in the active tool list
CODEX_AVAILABLE  = mcp__Multi-CLI__Ask-Codex is in the active tool list
```

- **Both available** → Full council mode (Steps 1–5 below)
- **One available** → Single-model council. Run that one. Label output "PARTIAL COUNCIL (one model)".
- **Neither available** → Solo adversarial review (Step 0b below). Label output "SOLO REVIEW (Multi-CLI not configured)".

### Step 0b — Solo Adversarial Review (fallback)

When Multi-CLI is absent, Claude performs a structured self-review:

1. Assume the role of a skeptical senior engineer who did not write this code
2. Re-read the diff/plan/files with fresh eyes
3. Look specifically for:
   - Edge cases and off-by-one errors
   - Race conditions and concurrency issues
   - Missing error handling at system boundaries
   - Security holes (injection, auth bypass, data exposure)
   - Logic errors that pass the happy path but fail on real data
4. Report findings in the standard format below
5. Be honest: if you find nothing, say "SOLO REVIEW — no P1/P2 findings."

To configure full council: add `@osanoai/multicli` as an MCP server in `~/.claude/settings.json`.

## Step 1 — Pack Context

Gather: the diff or plan, relevant files (not the whole repo), the specific question. Keep under 800KB total.

## Step 2 — Round 1: Fire in Parallel

Use `mcp__Multi-CLI__Ask-Gemini` and `mcp__Multi-CLI__Ask-Codex` simultaneously.

**Gemini R1 prompt template:**
```
You are doing an adversarial review. Your job is to find what Claude missed.
Focus on: large-scale consistency, architecture patterns, hidden dependencies,
things that look fine locally but break at scale.

Context: [brief description]
Question: [specific concern]

@[relevant files via @ syntax]

Format findings as [P1] CRITICAL / [P2] HIGH / [P3] MEDIUM / [P4] LOW.
Every finding needs: file, line, quoted code, specific fix.
Under 400 words.
```

**Codex R1 prompt template:**
```
Adversarial code review. Find what Claude missed.
Focus on: logic errors, edge cases, race conditions, security holes,
missing error handling.

[paste diff or describe files — Codex reads them directly]

Format: [P1]/[P2]/[P3]/[P4] + file:line + quoted code + fix.
Under 300 words.
```

## Step 3 — R1 Synthesis

After both respond:
1. Collect all P1 and P2 findings
2. Note which findings both models raised (highest confidence)
3. If **zero P1 findings** across both → skip to Step 5 (report). No R2 needed.
4. If **any P1 findings** → proceed to Step 4 (R2 convergence loop).

## Step 4 — Round 2: Convergence Loop (only if R1 has P1 findings)

**Goal:** Each model reacts to the other's findings. R2 is NOT a re-review of the code — it reviews R1 findings for false positives, missed context, and newly surfaced issues.

Fire both models again in parallel with their peer's R1 output:

**Gemini R2 prompt:**
```
Round 2 — Convergence Check.

You reviewed [context] in Round 1. Your peer reviewer (Codex) found these issues:

[Codex R1 findings — full text]

For each finding:
1. Do you agree or dispute? (one line each)
2. Does seeing their findings reveal anything NEW you missed in R1?

Only report genuinely new findings not in your R1 output.
If nothing new: say "R2 CLEAN — no new findings."
Format new findings as [P1]/[P2]/[P3]/[P4]. Under 200 words.
```

**Codex R2 prompt:**
```
Round 2 — Convergence Check.

You reviewed [context] in Round 1. Your peer reviewer (Gemini) found these issues:

[Gemini R1 findings — full text]

For each finding:
1. Agree or dispute? (one line each)
2. Anything NEW you missed in R1 after seeing their review?

Only report new findings not in your R1. If nothing new: "R2 CLEAN."
Format: [P1]/[P2]/[P3]/[P4] + file:line + fix. Under 200 words.
```

**Convergence condition:** If both R2 responses are "R2 CLEAN" (no new P1s), the loop is done. If either R2 has new P1s, record them — but do NOT fire a third round. Two rounds is the cap.

## Step 5 — Report

```
## Council Review

**Verdict:** [PASS / PASS WITH CONDITIONS / BLOCK]
**Mode:** [FULL / PARTIAL / SOLO]
**Rounds:** [R1 only / R1 + R2 converged / R1 + R2 new findings]

### Confirmed by both models
- [findings with 2x confidence — highest priority]

### Gemini only (R1)
- [findings]

### Codex only (R1)
- [findings]

### New in R2 (if any)
- [findings surfaced by convergence loop]

### Disputed
- [contradictions between models + my verdict on who's right]

### My synthesis
[1-3 sentences on what matters most and why]
```

## Latency

- R1 only: 2–3 minutes
- R1 + R2: 4–7 minutes
- Tell the user before firing: "Running council — takes a few minutes. R2 fires if P1s are found."

## Step 6 — Auto-Log Decision

After every council run (regardless of verdict), append to the project's decisions file.

**Only log when verdict is PASS WITH CONDITIONS or BLOCK, OR when the user confirmed a specific decision.**
Skip PASS verdicts with no action — don't pollute the log with noise.

First resolve the slug and path:
```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_SLUG=${SLUG:-$(basename "$PWD")}
_DECISIONS="${GSTACK_HOME:-$HOME/.gstack}/projects/$_SLUG/decisions.md"
mkdir -p "$(dirname "$_DECISIONS")"
```

Then append (replace placeholders with actual values from the review):
```bash
cat >> "$_DECISIONS" << 'ENTRY'

## <DATE>: <TOPIC>

**Verdict:** <PASS WITH CONDITIONS / BLOCK / PASS>
**Decision:** <what was decided — one sentence>
**Alternatives considered:** <what was rejected, why>
**Council:** Codex: <verdict> · Gemini: <verdict or "unavailable">
**Confidence:** <high / medium / low>     ← how strong was the agreement?
**Scope:** <project-wide / phase-only / file-cluster: list>     ← where this applies
**Expires:** <YYYY-MM-DD or "until superseded">     ← TTL — old decisions decay
**Supersedes:** <prior decision date or "n/a">     ← chain reversals
ENTRY
```

**Metadata rules:**
- **Confidence** = `high` if both models agreed and user accepted; `medium` if one dissent; `low` if user overruled or PARTIAL council
- **Scope** must specify the blast radius — file paths, service boundaries, or "project-wide"
- **Expires** defaults to 90 days for tactical decisions, 365+ for architectural; never "permanent"
- **Supersedes** when this decision reverses or replaces an earlier one — link by date

If the user amends the council verdict during discussion, note it: `**Vinamr:** <amendment>`

The constraint-pack hook (council-advisory.js) ranks injected decisions by recency × confidence — high-confidence recent decisions dominate; expired ones drop off automatically.

## What Council Is Not

Not a rubber stamp. If both models find nothing, say: "Council clean — no P1/P2 findings. R2 skipped." Don't invent issues.
