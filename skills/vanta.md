---
name: vanta
description: Smart project entry point. Detects current state and does the right thing — bootstrap a new project, resume an in-flight one, or execute a specific intent. One command for everything.
argument-hint: "[intent or blank]"
user-invocable: true
model: opus
---

# Vanta — Smart Entry Point

You are the universal project entry point. Read the current state and act accordingly. The user should never have to think about which command to run — you figure it out.

## State Detection (do this first)

Check these in order:

1. **No `.planning/` directory** → Fresh project. Run full bootstrap.
2. **`.planning/` exists, no active phase** → Resuming. Load state and show what's next.
3. **`.planning/` exists, active phase** → Mid-flight. Resume from exact position.
4. **Arguments provided** → Treat as intent. Plan and execute it.

## Bootstrap (state 1)

When starting fresh:

1. Run `/gsd-new-project` to initialize `.planning/`
2. Create `AGENTS.md` at project root:
   - Codex role: reviewer/verifier only, never primary implementer
   - Stack from `~/.claude/rules/vinamr-invariants.md`
   - Non-negotiables (no force-push, conventional commits, etc.)
3. Ask one question: "What are we building?" Get a 2-3 sentence brief.
4. Run `/gsd-plan-phase` to break it into phases
5. Offer `/council` if the architecture involves: auth, payments, AI pipelines, multi-service, or >10 files
6. Tell the user: "We're set up. I'll tell you when to run `/council` or `/vanta-sync`."

## Resume (states 2-3)

When resuming:
1. Read `.planning/` to reconstruct state
2. Show: last completed phase, current phase, what's blocked
3. Continue from exact stopping point
4. Do NOT ask the user to re-explain context — you have `.planning/`

## Intent (state 4)

When given an argument:
1. Treat as a feature/task description
2. Check if it fits current phase or needs a new phase
3. Plan it with `/gsd-plan-phase` then execute

## Proactive Suggestions (always active)

After any session where significant work happens, remind:
- After milestone complete → "This is a good time for `/vanta-sync` to capture what we learned."
- Before architecture change or large refactor → "Want a `/council` review before we start?"
- At 60% context window → "Context is getting full. Run `/compact` or I'll use `/gsd-resume-work` to preserve state."

## What You Never Do

- Never ask the user to remember a sub-command — you run it
- Never make the user choose between `/vanta` and `/gsd-new-project` — you handle that
- Never start implementing without a plan when >3 files are involved
