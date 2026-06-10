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

Hooks fire automatically. Single source of truth: `hooks/manifest.json` —
`setup.sh`, `hooks/hooks.json`, and the syntax-check test all read from it.

**Always-on layer (v3.6, fires on every prompt + every tool call):**
- `session-start` — SessionStart: injects 4-line project brief into the first response
- `prompt-context.js` — UserPromptSubmit: classifies prompt + injects 3-line factual brief, on-cooldown
- `tool-observer.js` — Pre+PostToolUse on Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Agent|Task: shape-only telemetry to `~/.vanta/interactions.jsonl`. Never blocks, never injects.

**Targeted hooks:**
- `council-advisory.js` — PreToolUse:Write|Edit advisory on auth/payment/migration/security file edits
- `git-guardrails.js` — PreToolUse:Bash hard-block + advisory tier for destructive git/sql/rm commands
- `test-failure-advisor.js` — PostToolUse:Bash hard-stop on failing tests/build
- `stack-file-nudge.js` — PostToolUse:Write|Edit follow-up actions on config file changes
- `code-index-watch.js` — PostToolUse:Write|Edit|NotebookEdit incremental refresh of per-project knowledge shards
- `plan-watcher.js` — PostToolUse:Write|Edit Shadow Council flag on sensitive plan writes
- `auto-sync.js` — Stop: sync-queue (append-only, deduped by session_id on read) + episodic memory

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
- **`slugFromCwd()` is the only canonical cwd→slug resolver** (`bin/vanta-projects.js`). Every consumer (executor, hooks, future planners) must delegate to it. Re-implementing `basename + canonProject` in caller code fragments project-scoped trust per subdir because monorepo basenames don't equal the workspace root, and `canonProject(full_path)` falls through to a lowercased path. Both `bin/vanta-executor.js _canonProjectFromCwd()` and `hooks/prompt-rewriter.js` route through `slugFromCwd()` — keep them in sync. Verified via R3 council, v3.8.0.
- **Council convergence cap is R2 protocol but R3+ pays off when R1 fixes are partial**. The v3.7→v3.8 sprint ran R1+R2+R3, each surfacing new P2s the prior round missed. Hard-stop on any unresolved both-confirmed P2 finding before tagging a release — single-model P3/P4 findings can be deferred to the next minor with notes in the tag annotation.
- **Stop-hook auto-stage writes need a lockfile**: `~/.claude/rules/vinamr-invariants.staging.md.lock` via O_EXCL + PID-aware steal serializes concurrent Stop-hook auto-stage runs. `appendFileSync` is per-call atomic but the read-modify-write flow (read staging → routeCandidate → append if not dup) has a TOCTOU window. Without the lock, two sessions ending within 100ms duplicate-stage. Pattern from `bin/vanta-index-code.js:212`. v3.12 council R1 P1 fix.
- **consume-ledger marks on every evaluation, not on success**: `consume.mark()` must fire for every routed candidate — including discard/update-in-place/staging-duplicate — not only stage/auto. Otherwise sub-threshold and dup candidates re-extract every Stop hook forever, gradually exhausting the 2s auto-stage budget as backlog grows. v3.12 council R2 P1 fix (Gemini).
- **Auto-stage section header emits once per (source, run)**: tracking via `headersWritten` Set. Repeating `## Auto-staged (<source>)\n<!-- audit -->\n- entry` per candidate breaks `bin/vanta-extract-score.js:259` `split(/\n(?=<!-- vanta-sync:)/g)` parser — produces phantom header-only blocks → wrong list-staging counts. v3.12 council R1 P2 fix.
- **`auditPrefix({ auto })` is the canonical extension primitive**: appending key=value fields inside the `<!-- vanta-sync: ... -->` HTML comment is forward-compat across v3.10/11/12 because consumers anchor on `<!--` and `-->`, not positional fields. Adding new audit fields here is safe; restructuring the comment shape is not.

---
@./skills/using-vanta/SKILL.md
