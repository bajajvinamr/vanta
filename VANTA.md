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

## How Vanta Relates to the Three Underlying Frameworks

Three separate frameworks are installed simultaneously. Vanta wraps two of them.

| Framework | Source | Installed at | Role |
|---|---|---|---|
| **garrytan/gstack** | https://github.com/garrytan/gstack | `~/.claude/skills/gstack/` | Specialist personas: /ship, /qa, /review, /investigate, /office-hours |
| **gsd-build/get-shit-done** | https://github.com/gsd-build/get-shit-done | `~/.claude/skills/gsd-*/` + hooks | Workflow + context engineering: .planning/, phase discipline, learnings extraction |
| **obra/superpowers** | https://github.com/obra/superpowers | `~/.claude/plugins/cache/.../superpowers/` | TDD-first: /brainstorm, /write-plan, /execute-plan |

Vanta's three commands call into GSD for orchestration:

| Vanta | Calls underneath |
|---|---|
| `/vanta` bootstrap | GSD: `/gsd-new-project`, `/gsd-plan-phase` |
| `/vanta` resume | GSD: reads `.planning/` directly |
| `/vanta-sync` | GSD: `/gsd-extract_learnings` → updates invariants file |
| `/council` | Multi-CLI MCP: `mcp__Multi-CLI__Ask-Gemini` + `mcp__Multi-CLI__Ask-Codex` |

**gstack specialists are NOT called by Vanta** — you invoke them directly:
- Use `/ship` when ready to deploy, `/qa` for browser testing, `/review` before merge
- Use `/office-hours` when product direction needs resetting
- Use `/health` for code quality audit, `/cso` for security

Vanta is the 3 commands you need 90% of the time. The other 80% of both frameworks' skills are still available directly.

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

## v3.5 — Operator Tools + Trust/Resilience Layer

In addition to the three commands, Vanta ships read-only operator bins under
`~/.claude/bin/`:

| Tool | Purpose |
|---|---|
| `vanta-status` | Single-screen health: shards / queues / hook errors / stuck locks / council readiness / per-model accuracy / suggestions. `--json` for scripts, `--quiet` for prompts. |
| `vanta-prune` | Archive dormant project shards (reversible via `--restore <slug>`). Two-signal classifier — won't archive a quiet shard if the project tree was touched recently. |
| `vanta-resolve --analyze` | Query-log diagnostics: top topics, zero-result ratio, foreign-bleed events, top-1 score p50/p90, source mix, index gaps (topics returning nothing ≥50% of attempts). |
| `vanta-council-health` (Tier 6 #17) | Pre-flight readiness for `/council`: Multi-CLI MCP registration, Gemini trust config, Codex config presence, last-council recency. Static config inspection only — no network. |
| `vanta-council-feedback` (Tier 6 #15) | Two-stage council quality tracking. `record` appends each P1/P2 finding at council time; `attribute` marks outcomes (true-positive / false-positive / unverified) at sync time; `stats --days 90` rolls up per-model × priority accuracy. The `consensus_strategy` field tracks `two-different-models` (default) vs `n-of-same-model` (stochastic — never used, present for future analysis). |
| `vanta-extract-score` (Tier 6 #16) | Confidence scoring + routing for invariant candidates. `auto` ≥ 0.65 → `vinamr-invariants.md`, `staging` 0.40–0.65 → `vinamr-invariants.staging.md` for review, `update-in-place` for near-dups (Jaccard ≥ 0.8), `discard` otherwise. Every auto/staging write gets an audit comment with session id, timestamp, and confidence so `git blame` traces mistakes back to source. |

All five are read-only on a local filesystem (council-feedback and
extract-score have explicit append CLIs). None network. Safe anywhere.

### Tier 6 — Trust + Resilience Layer

The four Tier 6 items address the failure mode where Vanta's outputs drift
silently over time:

- **#14 — Cross-source contradiction detection.** `vanta-resolve` flags binary-opposition pairs (e.g., ES256 vs HS256) when each half lands in a separate retrieved entry. Council-advisory surfaces the warning ABOVE the constraint pack so the LLM sees the disagreement before reading either half. Conservative — comparisons (both halves in one entry) don't trip; pairs need ≥ 0.7 confidence.
- **#15 — Council quality feedback.** Two-stage data flow records P1/P2 findings at council time and attributes outcomes when matching invariants land in `vanta-sync`. Per-model × priority accuracy rolls up in `vanta-status` and via `vanta-council-feedback stats`.
- **#16 — Auto-extraction safeguards.** Three-stage pipeline gates writes to `vinamr-invariants.md`. Skill-doc phrases hard-reject; PII / project state routes to discard via low-density scoring; near-duplicates route to `update-in-place` instead of accumulating rephrasings. Audit comments make every entry traceable.
- **#17 — Robust Multi-CLI degradation.** Pre-flight ping protocol + cascading model fallback chain prevent silent degradation when Gemini hits capacity-exhausted or trust-workspace failures. Mandatory `model_health` block in council reports surfaces what was actually consulted.

## Storage Assumptions

`~/.vanta/` and `~/.gstack/` must live on a local filesystem (HFS+, APFS, ext4,
btrfs, ZFS). Two reasons:

1. **`O_EXCL` is not reliable on NFS.** The shard lockfile relies on
   `open(O_EXCL)` to grant exclusive access. NFSv3 silently grants the lock
   to multiple writers; concurrent indexer fires clobber each other's writes.
2. **Atomic rename across mount boundaries fails with EXDEV.** The indexer's
   `tmp + rename` pattern requires same-filesystem operation. If your home
   dir is on NFS but `/tmp` is local, writes are lost.

For cross-machine state, sync a snapshot (rsync, S3) instead of sharing the
live tree.

## Setup

See `docs/install.md` for step-by-step install.

Skill files: `skills/`
Hooks: `hooks/`
Gstack reference: `gstack/`
