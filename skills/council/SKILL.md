---
name: council
description: Adversarial multi-model review. Fires Gemini and Codex in parallel, synthesizes findings. Use before high-stakes decisions — architecture changes, security-sensitive code, large refactors, anything you'd lose sleep over.
argument-hint: "[what to review — blank uses current diff/plan]"
user-invocable: true
model: opus
---

# Council — Multi-Model Adversarial Review

Fire Gemini and Codex in parallel on the same problem. Each has different training data and different blind spots. Synthesize into a single verdict.

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

- **Both available** → Full council mode (Steps 1–4 below)
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

## Step 2 — Fire in Parallel

Use `mcp__Multi-CLI__Ask-Gemini` and `mcp__Multi-CLI__Ask-Codex` simultaneously.

**Gemini prompt template:**
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

**Codex prompt template:**
```
Adversarial code review. Find what Claude missed.
Focus on: logic errors, edge cases, race conditions, security holes,
missing error handling.

[paste diff or describe files — Codex reads them directly]

Format: [P1]/[P2]/[P3]/[P4] + file:line + quoted code + fix.
Under 300 words.
```

## Step 3 — Synthesize

After both respond:
1. Findings both agree on → highest confidence, address first
2. Findings only one raised → still important, flag clearly
3. Contradictions → explain why they differ, give your verdict
4. Final verdict: PASS / PASS WITH CONDITIONS / BLOCK

## Step 4 — Report

```
## Council Review

**Verdict:** [PASS / PASS WITH CONDITIONS / BLOCK]
**Mode:** [FULL / PARTIAL / SOLO]

### Both flagged
- [findings with 2x confidence]

### Gemini only
- [findings]

### Codex only
- [findings]

### My synthesis
[1-3 sentences on what matters most and why]
```

## Latency

Full council takes 2-5 minutes. Tell the user before firing: "Running council — takes a few minutes."

## What Council Is Not

Not a rubber stamp. If both models find nothing, say: "Council clean — no P1/P2 findings." Don't invent issues.
