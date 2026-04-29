---
name: council
description: Adversarial multi-model review. Fires Gemini (1M context) and Codex (GPT-5.4) in parallel, synthesizes findings. Use before high-stakes decisions — architecture changes, security-sensitive code, large refactors, anything you'd lose sleep over.
argument-hint: "[what to review — blank uses current diff/plan]"
user-invocable: true
model: opus
---

# Council — Multi-Model Adversarial Review

Fire Gemini and Codex in parallel on the same problem. Each has different training data and different blind spots. Synthesize into a single verdict.

## When to Run (suggest this proactively)

Suggest `/council` — don't wait for the user to ask — when you see:
- Architecture decision involving >2 services or >10 files
- Auth, payments, data privacy, or security-sensitive code
- A refactor where the wrong move is hard to reverse
- After implementing something you're not confident about
- Before any PR that touches shared infrastructure

## Process

**Step 1 — Pack context**

Gather: the diff or plan, relevant files (not the whole repo), the specific question. Keep under 800KB total.

**Step 2 — Fire in parallel**

Use `mcp__Multi-CLI__Ask-Gemini` and `mcp__Multi-CLI__Ask-Codex` simultaneously.

Gemini prompt template:
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

Codex prompt template:
```
Adversarial code review. Find what Claude missed.
Focus on: logic errors, edge cases, race conditions, security holes, 
missing error handling.

[paste diff or describe files — Codex reads them directly]

Format: [P1]/[P2]/[P3]/[P4] + file:line + quoted code + fix.
Under 300 words.
```

**Step 3 — Synthesize**

After both respond:
1. List findings both agree on → highest confidence, address first
2. Findings only one raised → still important, flag clearly
3. Contradictions → explain why they differ, give your verdict
4. Final verdict: PASS / PASS WITH CONDITIONS / BLOCK

**Step 4 — Report**

```
## Council Review

**Verdict:** [PASS / PASS WITH CONDITIONS / BLOCK]

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

This takes 2-5 minutes. Tell the user before firing: "Running council — this takes a few minutes."

## What Council Is Not

Not a rubber stamp. If both models find nothing, say so clearly: "Council clean — no P1/P2 findings." Don't invent issues to seem thorough.
