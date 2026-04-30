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

Hooks fire automatically:
- `council-advisory.js` — PreToolUse advisory on auth/payment/migration/security file edits
- `git-guardrails.js` — PreToolUse:Bash hard-block + advisory tier for destructive git/sql/rm commands
- `test-failure-advisor.js` — PostToolUse hard-stop on failing tests/build
- `stack-file-nudge.js` — PostToolUse follow-up actions on config file changes
- `code-index-watch.js` — PostToolUse incremental refresh of per-project knowledge shards
- `plan-watcher.js` — PostToolUse Shadow Council flag on sensitive plan writes
- `auto-sync.js` — Stop hook: sync-queue + episodic memory dedup

## Surface Impact Discipline

**Vanta promises three commands. Every change must be classified before it lands.**

- **INTERNAL MACHINERY** — does NOT add user-visible commands or skills. May add: bins under `~/.claude/bin/`, hooks under `~/.claude/hooks/`, sections inside the existing 4 skills (vanta-run, vanta-council, vanta-sync, vanta-patterns), pure code in `bin/*.js`, tests, docs, invariants. **No surface budget impact.**
- **NEW USER SURFACE** — adds: a new top-level skill (`Skill("vanta-foo")`), a new slash command, a new prompt the user must memorize, a new mandatory step in an existing flow that wasn't there before. **Must justify against the three-command promise.** The bar is high — most additions should be internal machinery.

When opening a PR or commit that adds capability, name the classification explicitly in the commit body. Reviewers (council, code-reviewer agents) MUST flag surface-creep — silent expansion is the failure mode this rule exists to prevent.

## Gotchas

- **Skills must be flat**: Claude Code scanner reads `~/.claude/skills/<name>/SKILL.md` — one level only. All vanta skills are deployed as `vanta-run`, `vanta-council`, `vanta-sync` (not nested under `vanta/`). Never restructure to a namespace prefix.
- **`Skill()` calls use plain names**: `Skill("vanta-council")` not `Skill("vanta:council")` — colon format only works for officially installed plugins, which vanta is not (deployed directly to `~/.claude/skills/`).
- **`/plugin install vanta@vanta` does not work** — `known_marketplaces.json` is read at startup only. Manual deployment to `~/.claude/skills/` is the only reliable install path for this repo.
- **Repo dir names ≠ deployed skill names**: `skills/vanta/` deploys as `vanta-run`, `skills/council/` as `vanta-council`. The deployed directory name is the invocation key — the `name:` frontmatter field is display-only.
- **`using-vanta` is context, not a skill**: Loaded via CLAUDE.md `@./skills/using-vanta/SKILL.md` notation (always-active session context). It is NOT deployed to `~/.claude/skills/using-vanta/` and cannot be invoked via `Skill()`. Editing `~/Projects/vanta/skills/using-vanta/SKILL.md` is the only correct path.
- **Gemini council requires trust**: Gemini CLI exits 55 in headless mode without `GEMINI_CLI_TRUST_WORKSPACE=true`. When Gemini fails, proceed as PARTIAL COUNCIL (Codex only) — run R2 with Codex reacting to its own R1 findings for false-positive check.
- **Codex optional params break**: `approvalPolicy`/`sandbox` in `Ask-Codex` cause exit 2 arg-parse failure. Always omit optional params unless explicitly needed.
- **sync-queue consumers must clear**: The Stop hook writes `synced: false`. vanta-sync must mark `synced: true` after processing or alerts repeat every session indefinitely.

---
@./skills/using-vanta/SKILL.md
