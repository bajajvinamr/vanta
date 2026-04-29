# Vanta — Personal AI Development Protocol

Vanta is a three-command harness built on top of [Superpowers/gstack](https://github.com/obra/superpowers) that reduces the full AI dev workflow to three decisions: start, learn, review. You never have to remember when to run meta-commands — Claude does that for you.

## The Three Commands

### `/vanta` — Smart Entry Point

Run at the start of any new session in an unfamiliar repo, or to kick off a new project.

**What it does:**
- Detects current state: fresh project, in-flight, or resuming
- If no `.planning/` directory → bootstraps a full project setup via `/gsd-new-project`
- If `.planning/` exists → reconstructs state and shows exactly where to continue
- If you pass an argument → treats it as intent and plans/executes it

**Claude auto-suggests this when:** Session starts in a repo with no `.planning/` directory.

---

### `/vanta-sync` — Learning Extraction

Run after every shipped milestone, merged PR, or significant fix.

**What it does:**
- Scans the current session for discovered production gotchas
- Distills learnings into invariants (specific, durable facts about tools/environments)
- Appends to `~/.claude/rules/vinamr-invariants.md` (auto-loaded by Gemini via GEMINI.md `@import`)
- Propagates relevant findings to `~/.codex/AGENTS.md` for Codex sessions
- Updates project `CLAUDE.md` with project-specific gotchas

**Claude auto-suggests this when:** User says "done", "shipped", "merged", "that's working", or `/gsd-ship` runs.

---

### `/council` — Multi-Model Adversarial Review

Run before any high-stakes decision. Takes 2-5 minutes. Fires Gemini and Codex in parallel, synthesizes findings.

**What it does:**
- Sends diff/plan/question to both `mcp__Multi-CLI__Ask-Gemini` and `mcp__Multi-CLI__Ask-Codex`
- Gemini: large-scale consistency, hidden dependencies, architecture patterns
- Codex: logic errors, edge cases, race conditions, security holes
- Synthesizes into: both-flagged (high confidence) / only-one-flagged / contradictions
- Returns verdict: PASS / PASS WITH CONDITIONS / BLOCK

**Claude auto-suggests this when:**
- Architecture decision touching >2 services or >10 files
- Auth, payments, data privacy, or security-sensitive code
- Hard-to-reverse refactor
- Before any PR touching shared infrastructure

**Auto-hook:** `~/.claude/hooks/council-advisory.js` fires as a PreToolUse advisory when editing auth/payment/migration/security paths.

---

## How Vanta Relates to Gstack

Vanta is a **thin wrapper on top of Superpowers/gstack**. It doesn't replace gstack — it makes it approachable.

| Vanta | Calls underneath |
|---|---|
| `/vanta` bootstrap | `/gsd-new-project`, `/gsd-plan-phase` |
| `/vanta` resume | Reads `.planning/` directly |
| `/vanta-sync` | `/gsd-extract_learnings`, updates invariants file |
| `/council` | `mcp__Multi-CLI__Ask-Gemini`, `mcp__Multi-CLI__Ask-Codex` |

The full gstack skill library (85 skills) is still available via the Superpowers plugin — see `~/.claude/plugins/cache/claude-plugins-official/superpowers/`. Vanta just gives you the three commands you need 90% of the time.

---

## The Hook Layer

Five PostToolUse and one PreToolUse hook run automatically:

| Hook | Trigger | Effect |
|---|---|---|
| `council-advisory.js` | PreToolUse Write/Edit on auth/payment/migration paths | Advisory: suggest /council for non-trivial changes |
| `test-failure-advisor.js` | PostToolUse Bash after test/build commands | Hard-stop: blocks continuation until tests pass |
| `stack-file-nudge.js` | PostToolUse Write/Edit on config files | Targeted reminder: what to run after package.json, schema.prisma, tsconfig, etc. |
| `gsd-read-injection-scanner.js` | PostToolUse Read | Flags prompt injection in file content |
| `gsd-context-monitor.js` | PostToolUse all major tools | Watches context window usage |
| `gsd-phase-boundary.sh` | PostToolUse Write/Edit | GSD phase transition checks |

---

## The Memory Layer

Auto-memory at `~/.claude/projects/-Users-vinamr/memory/`:
- `MEMORY.md` — index loaded at every session start
- `feedback_vanta_proactive.md` — tells Claude when to suggest Vanta commands
- Project and user memories persist cross-session

Invariants at `~/.claude/rules/vinamr-invariants.md`:
- 20+ production gotchas (Supabase CORS, PixiJS v8 async init, BullMQ dedup, etc.)
- Auto-loaded by Gemini via `@import` in `~/.gemini/GEMINI.md`
- Referenced by Codex via `project_doc_fallback_filenames = ["CLAUDE.md"]`

---

## The Vanta Protocol in CLAUDE.md

The `## Vanta Protocol` section in `~/.claude/CLAUDE.md` encodes the proactive trigger rules so every Claude session starts with them active — no prompting needed.

---

## What Vanta Does NOT Do

- Does not replace `/ship`, `/qa`, `/review`, `/investigate` — these gstack skills are still available directly
- Does not run `/council` automatically (advisory only, not a block) — you confirm
- Does not store memories during a session — that's `/vanta-sync`'s job

---

## Setup

See `docs/install.md` for step-by-step install.

Skill files: `skills/`
Hooks: `hooks/`
Gstack reference: `gstack/`
