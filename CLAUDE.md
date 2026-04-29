# Vanta Plugin

Lifecycle harness for Claude Code. Composes three frameworks into three commands.

## Underlying Frameworks

- **garrytan/gstack** (`~/.claude/skills/gstack/`) — specialist personas: /ship, /qa, /review, /investigate, /office-hours, /health, /cso
- **gsd-build/get-shit-done** (`~/.claude/skills/gsd-*/`) — workflow + context: .planning/, phase discipline, /gsd-new-project, /gsd-extract_learnings
- **obra/superpowers** (plugin) — TDD-first: /brainstorm, /write-plan, /execute-plan

## Commands

- `/vanta` — smart entry: bootstrap new project or resume in-flight one
- `/vanta-sync` — learning extraction after milestones → updates vinamr-invariants.md
- `/council` — adversarial review via Gemini + Codex in parallel (Multi-CLI MCP)

## Hooks

Three hooks fire automatically:
- `council-advisory.js` — PreToolUse advisory on auth/payment/migration/security file edits
- `test-failure-advisor.js` — PostToolUse hard-stop on failing tests/build
- `stack-file-nudge.js` — PostToolUse follow-up actions on config file changes

---
@./skills/using-vanta/SKILL.md
