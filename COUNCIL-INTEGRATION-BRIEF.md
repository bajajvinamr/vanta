# Council Brief — Vanta + 4 External Skill Integrations

## Context

Vanta is a personal AI dev lifecycle harness for Claude Code (~/Projects/vanta). It composes three frameworks (gstack, GSD, superpowers) into three commands (`/vanta`, `/vanta-sync`, `/council`) plus 6 hooks. Architecture in `README.md` and `VANTA.md` at repo root. Recent v3.4 work documented at end of `README.md` version table. CLAUDE.md captures gotchas and constraints.

Core philosophy of Vanta:
- **Minimal user surface** — three commands cover the full lifecycle. User never invokes meta-commands like `/recall`, `/index`, etc. directly.
- **Self-contained** — no external runtime deps; everything is plain JS bins, markdown skills, and shell hooks.
- **Graceful degradation** — works when gstack/GSD/Multi-CLI are absent.
- **Probabilistic routing** — SKILL.md routing is LLM-interpreted, so collision rules must be explicit.

## The Question

Four candidate external skills surfaced as potentially valuable. We must decide for each: **PORT** (steal patterns into vanta's own files), **INSTALL** (use as-is, side-by-side), or **SKIP**.

For PORT, the change lands inside `~/Projects/vanta/`. For INSTALL, the user adds an external skill outside Vanta and we accept routing collisions/duplication.

## The Four Candidates

### 1. Write-a-Skill / Skill Creator (Anthropic + Mattpocock)
- Repos: github.com/anthropics/skills/tree/main/skills/skill-creator, github.com/mattpocock/skills/tree/main/write-a-skill
- Purpose: Authoring tool — drafts and iterates SKILL.md files with proper structure, progressive disclosure, bundled resources.
- Possible integration: Could back vanta-sync's invariant-promotion path (when extracted invariants accumulate, promote to skills). Or: could be the "meta-skill" embedded in `/vanta` bootstrap to scaffold project-specific skills.
- Vanta has 4 hand-authored skills already (vanta-run, vanta-council, vanta-sync, vanta-patterns).

### 2. Grill Me (Mattpocock)
- Repo: github.com/mattpocock/skills/tree/main/grill-me
- Purpose: Forces relentless one-question-at-a-time clarifying until decision tree fully resolved.
- Possible integration: Embed inside `Skill("vanta-run")` Bootstrap step (currently asks 1-2 questions then proposes approaches). Vanta's protocol explicitly says "ambiguous intent → one clarifying question, don't guess" — Grill Me enforces this harder.

### 3. Stochastic Multi-Agent Consensus (hungv47/meta-skills)
- Repo: github.com/hungv47/meta-skills
- Purpose: Spawns N sub-agents on the same problem, aggregates findings.
- Possible integration: COMPLEMENTARY to `/council` — different consensus model. /council = 2 different models (Codex+Gemini); Stochastic = N copies of same model. Tier 6 #15 (council quality feedback, design at `DESIGN-T6.md`) wants per-strategy accuracy data.
- Risk: Adds latency + cost; agent fan-out can hit rate limits.

### 4. Git Guardrails for Claude Code (Mattpocock)
- Repo: github.com/mattpocock/skills/tree/main/git-guardrails-claude-code
- Purpose: PreToolUse hooks that block dangerous git commands (push --force, reset --hard, clean -f, branch -D).
- Possible integration: PORT into `hooks/git-guardrails.js`. Same hook protocol as existing `council-advisory.js`. Vanta's CLAUDE.md already states these guardrails as text rules ("never force-push main, never --no-verify"); this enforces them at tool level.
- The user's `~/.claude/CLAUDE.md` "Guardrails (non-negotiable)" section lists exactly the same patterns.

## What Council Should Evaluate

For each candidate, give a PORT/INSTALL/SKIP verdict with one-line rationale.

Then evaluate as a SET:

**Q1**: Does adding all 4 violate Vanta's "minimal user surface, three commands" promise? Or do they compose silently as background machinery?

**Q2**: For Grill Me + Write-a-Skill — are these orthogonal, or do they overlap with what `Skill("brainstorming")` (superpowers) and `Skill("writing-plans")` (superpowers) already cover? `~/.claude/plugins/cache/claude-plugins-official/superpowers/` has these.

**Q3**: For Stochastic Multi-Agent Consensus — does running N-of-same-model consensus risk **bias amplification**? Same training data → same blind spots → falsely-high confidence in shared errors. /council deliberately uses TWO DIFFERENT MODELS to break this.

**Q4**: For Git Guardrails — would porting create a maintenance burden vs installing? The Mattpocock skill receives upstream updates; a fork doesn't.

**Q5**: Build order if any are PORT — which derisks the others?

**Q6**: Hidden integration risks — for each candidate that lands as PORT or INSTALL:
  - Routing collisions with existing `/vanta` / `/council` triggers?
  - Hook-event duplication (multiple PreToolUse Bash hooks firing for same command)?
  - Skill-discovery one-level-deep gotcha (~/.claude/rules/vinamr-invariants.md documents this)?
  - License compatibility (Vanta is MIT)?

## Output Format

```
## Verdict per candidate
1. Write-a-Skill: PORT | INSTALL | SKIP — <one-line rationale>
2. Grill Me:     PORT | INSTALL | SKIP — <one-line rationale>
3. Stochastic:   PORT | INSTALL | SKIP — <one-line rationale>
4. Git Guardrails: PORT | INSTALL | SKIP — <one-line rationale>

## P1 risks (must address)
[P1] <finding> — <fix>

## P2 risks (should address)
[P2] <finding> — <fix>

## Build order (if any PORT)
1. <first> because <reason>
2. ...

## Cross-set assessment
<2-3 sentences: do these integrate as a coherent set, or do they fragment Vanta?>
```

Under 500 words total. Be opinionated. Honesty > diplomacy.
