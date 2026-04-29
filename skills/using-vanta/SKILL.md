---
name: using-vanta
description: Vanta session protocol — when and how to invoke /vanta, /vanta-sync, and /council proactively. Loaded at every session start. Vinamr focuses on building; Claude manages when to run meta-commands.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

# Vanta — Session Protocol

Vanta has three commands. **You manage when to run them. Never make Vinamr remember.**

## The Three Commands

| Command | How to invoke | When |
|---|---|---|
| `/vanta` | `Skill("vanta:vanta")` | New project / no `.planning/` / "start", "new project", "fresh" |
| `/vanta-sync` | `Skill("vanta:vanta-sync")` | After "done", "shipped", "merged", "that's working" / after `/gsd-ship` |
| `/council` | `Skill("vanta:council")` | Before arch decisions, auth/payments/security, hard-to-reverse refactor |

## Proactive Trigger Rules

**Suggest /vanta when:**
- Session opens in a project directory with no `.planning/` directory
- User says "starting a new project", "new feature from scratch", "fresh start"
- No project context is loaded and the user is about to build something

**Suggest /vanta-sync immediately after:**
- User says "done", "shipped", "merged", "that's working", "this is working now"
- `/gsd-ship` completed
- A significant bug was fixed (especially >1 hour of work)
- A major PR merged
- One mention is enough — do not nag

**Suggest /council before:**
- Architecture change touching >2 services or >10 files
- Writing to `auth/`, `payment/`, `migration/`, `middleware/` paths
- A refactor that is hard to reverse
- Any PR touching shared infrastructure

## Rule

After any session with substantial work, offer `/vanta-sync`. Do not wait to be asked.

## Dependency Detection

Skills detect what's installed at runtime and adapt:
- **GSD installed** (`~/.claude/skills/gsd-new-project/` exists) → use `/gsd-new-project`, `/gsd-plan-phase`, `/gsd-extract_learnings`
- **GSD absent** → fall back to superpowers `/brainstorm` + `/write-plan` for planning
- **gstack installed** (`~/.claude/skills/gstack/` exists) → offer `/ship`, `/qa`, `/review`, `/investigate` suggestions
- **gstack absent** → describe the action without invoking the skill by name
- **Multi-CLI configured** (`mcp__Multi-CLI__Ask-Gemini` in tool list) → full council mode
- **Multi-CLI absent** → solo adversarial review with explicit degradation notice
