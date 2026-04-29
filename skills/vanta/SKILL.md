---
name: vanta
description: Smart project entry point. Detects current state and does the right thing — bootstrap a new project, resume an in-flight one, or execute a specific intent. One command for everything.
argument-hint: "[intent or blank]"
user-invocable: true
model: opus
---

# Vanta — Smart Entry Point

You are the universal project entry point. Read the current state and act accordingly.

## Dependency Detection (run first, silently)

Check what's available — this shapes every path below:

```
GSD_AVAILABLE   = ~/.claude/skills/gsd-new-project/ exists
GSTACK_AVAILABLE = ~/.claude/skills/gstack/ exists
SP_AVAILABLE    = brainstorm skill is invocable
```

## State Detection

Check in order:

1. **No `.planning/` directory** → Fresh project. Run Bootstrap.
2. **`.planning/` exists, no active phase** → Resuming. Load state and show what's next.
3. **`.planning/` exists, active phase** → Mid-flight. Resume from exact position.
4. **Arguments provided** → Intent mode. Plan and execute it.

## Bootstrap (state 1)

When starting fresh:

**If GSD is available:**
1. Run `/gsd-new-project` to initialize `.planning/`
2. Run `/gsd-plan-phase` to break the project into phases

**If GSD is absent, superpowers available:**
1. Use `Skill("brainstorming")` to design the project
2. Then `Skill("writing-plans")` to produce the implementation plan

**If neither — native planning:**
1. Ask: "What are we building?" (2-3 sentence brief)
2. Propose 2-3 approaches with tradeoffs
3. Write a `.planning/plan.md` directly

**Always after planning (regardless of path):**
1. Create `AGENTS.md` at project root:
   - Codex role: reviewer/verifier only, never primary implementer
   - Stack from `~/.claude/rules/vinamr-invariants.md`
   - Non-negotiables (no force-push, conventional commits, confirm before destructive ops)
2. If architecture involves auth, payments, AI pipelines, multi-service, or >10 files → offer `/council`
3. Tell the user: "Set up. I'll tell you when to run `/council` or `/vanta-sync`."

## Resume (states 2–3)

When resuming:
1. Read `.planning/` to reconstruct state
2. Show: last completed phase / current phase / what's blocked
3. Continue from exact stopping point — do NOT ask the user to re-explain context

## Intent (state 4)

When given an argument:
1. Treat as a feature/task description
2. Check if it fits current phase or needs a new phase
3. Plan with GSD (`/gsd-plan-phase`) if available, else describe the steps inline
4. Execute

## Proactive Suggestions (always active)

After significant work in a session:
- Milestone complete → "This is a good time for `/vanta-sync` to capture what we learned."
- Before arch change or large refactor → "Want a `/council` review before we start?"
- At 60% context window → "Context getting full. Run `/compact` or I'll use `/gsd-resume-work` to preserve state."

**If gstack is available**, additionally suggest:
- Before merging → `/ship` (runs tests, opens PR)
- Browser testing needed → `/qa`
- Pre-merge review → `/review`

## What You Never Do

- Never ask the user to remember a sub-command — you run it or suggest it
- Never start implementing >3 files without a plan
- Never call a skill that might not be installed without checking first
