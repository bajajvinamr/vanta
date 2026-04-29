# Gstack (Superpowers) — Reference

Vanta is built on top of **Superpowers** (the gstack plugin by Jesse Vincent / obra).

## Source

- **GitHub:** https://github.com/obra/superpowers (the plugin that powers gstack skills)
- **Installed at:** `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/`
- **Plugin ID:** `superpowers@claude-plugins-official`

## Skills Available via Superpowers

These are the underlying gstack skills. Vanta wraps the three most-used ones; the rest are available directly.

| Skill | What it does |
|---|---|
| `brainstorming` | Turn ideas into fully-formed designs via dialogue |
| `writing-plans` | Create detailed implementation plans |
| `executing-plans` | Drive subagents through plan tasks |
| `dispatching-parallel-agents` | Launch independent agents in parallel |
| `subagent-driven-development` | Multi-agent feature development |
| `test-driven-development` | TDD: red → green → refactor workflow |
| `systematic-debugging` | Root-cause debugging protocol |
| `finishing-a-development-branch` | Branch cleanup and PR readiness |
| `receiving-code-review` | How to process and apply code review |
| `requesting-code-review` | How to run a good code review |
| `using-git-worktrees` | Parallel work via git worktrees |
| `verification-before-completion` | Pre-ship verification checklist |
| `using-superpowers` | Meta: how to use skills themselves |
| `writing-skills` | How to create new skills |

## Commands Available (superpowers plugin)

From `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/commands/`:
- `brainstorm.md` → `/brainstorm`
- `write-plan.md` → `/write-plan`
- `execute-plan.md` → `/execute-plan`

## How to View Gstack Files

```bash
# Skills
ls ~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/

# Read a specific skill
cat ~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/brainstorming/SKILL.md

# Full plugin structure
ls ~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/
```

## How Vanta Builds on This

```
Superpowers (gstack)           Vanta wrapper
─────────────────────          ─────────────────────────────────
/gsd-new-project           →   /vanta (bootstrap path)
/gsd-plan-phase            →   /vanta (bootstrap path)
/gsd-extract_learnings     →   /vanta-sync (step 1)
mcp__Multi-CLI__Ask-Gemini →   /council (step 2)
mcp__Multi-CLI__Ask-Codex  →   /council (step 2)
```

Vanta doesn't replace gstack — it's the 20% that covers 80% of sessions.
The other 80% of gstack skills are still available. Use them directly when needed.

## Upgrade

```bash
# Check current version
cat ~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/package.json | grep version

# Upgrade via Claude Code
# /plugin update superpowers@claude-plugins-official
```
