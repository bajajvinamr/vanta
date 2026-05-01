# Vanta

> "I shipped six features last week. Three of them were re-discovering things I already knew."
>
> — me, before I built this

Claude Code is fast. Fast without memory is fast in circles. **Vanta is the harness around Claude Code that fixes that.** It runs in the background of every session and does three things:

1. **Reads your context before you type.** Phase, decisions, stale PRs, last skill run, expiring decisions — surfaced in a 4-line brief at session start. You configured nothing.
2. **Routes natural language to the right skill.** Say "ship this" or "what do I know about JWT" — Vanta picks the right tool across [gstack](https://github.com/garrytan/gstack), [GSD](https://github.com/obra/superpowers), and [Superpowers](https://github.com/obra/superpowers). 33 routes today, more whenever a miss hits twice.
3. **Remembers across sessions.** Every council verdict, every learning, every gotcha lands in plain Markdown your next session reads automatically. No vector DB. No SaaS. Just files your future self (and Claude) can grep.

I'm Vinamr. I build solo across three companies and the bottleneck was never code — it was the same lessons getting re-learned every Monday. Vanta is what I built so Friday's learning shows up in Monday's session without me typing anything.

Free. MIT. No accounts. No API keys. **27 binaries, 11 hooks, 5 skills, 266 tests, 0 dependencies.** Plain Node + bash on top of Claude Code's existing skill system.

**Who this is for:**
- **Solo founders and technical operators** running 3+ projects in parallel
- **Power users of Claude Code** who already use [gstack](https://github.com/garrytan/gstack), [GSD](https://github.com/obra/superpowers), or [Superpowers](https://github.com/obra/superpowers)
- **Anyone tired** of pasting "remember when we decided X" into every new session

---

## Quick start

1. Install Vanta (30 seconds — see below)
2. Open Claude Code in any project
3. Type **"what's next"** — Vanta reads `.planning/`, `decisions.md`, open PRs, picks up where you left off
4. Ship something
5. Type **"we're done"** — Vanta extracts what you learned and writes it to your invariants file
6. Open Claude Code tomorrow. The learning is already in context.

---

## Install — 30 seconds

```bash
git clone https://github.com/bajajvinamr/vanta ~/Projects/vanta
cd ~/Projects/vanta && ./setup.sh
```

That's it. `setup.sh` deploys 5 skills, registers 11 hooks, and loads `using-vanta` as always-active session context via `CLAUDE.md`. No config. No env vars. No server.

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Node 18+, Python 3 (one smoke test).
**Recommended:** [gstack](https://github.com/garrytan/gstack) and [GSD](https://github.com/obra/superpowers). Vanta degrades gracefully without them but most useful with both.

See [`docs/install.md`](docs/install.md) for manual setup, conflict resolution, and uninstall.

---

## See it work

Every session opens with this:

```
[Vanta] Active: pi-perception · Phase 3/4: Calibration · Last: /ship 18h ago
Decisions: ES256 JWT chosen (3d ago) · 12-dim algo kept (1w ago)
Stale: PR #52 open 4d — /review or /ship?
Routes: ship this · review this · debug this · write tests · what's next
```

You typed nothing. Vanta read `.planning/`, `~/.gstack/projects/<slug>/timeline.jsonl`, `decisions.md`, and your open PRs.

Now you talk to it like a person:

```
You:    something's broken
Claude: [routes to /investigate, opens debug session]
        [traces, fixes, writes a regression test]

You:    ship this
Claude: [routes to /ship, opens PR]

You:    that worked
Claude: [routes to /vanta-sync — extracts the learning]
        Added: "Edge function cold-start is ~5min.
                Keep-warm cron at 4min interval prevents P99 spikes."
        → ~/.claude/rules/vinamr-invariants.md (Supabase section)
        Gemini and Codex pick this up next session via @import.
```

Three commands you never typed: `/investigate`, `/ship`, `/vanta-sync`. Vanta saw the signals — *broken*, *ship this*, *that worked* — and ran them.

That is not a copilot. That is a chief of staff for your Claude Code sessions.

---

## Three commands

The user-visible surface is intentionally small. Vanta promises three commands. Everything else is internal machinery.

| Command | When Claude suggests it | What it does |
|---|---|---|
| `/vanta` | New project, no `.planning/`, or "start fresh" | Bootstraps or resumes. Detects state, chains the right tools, surfaces stale signals (open PRs, expiring decisions, unsynced sessions). |
| `/vanta-sync` | After "done", "shipped", "merged", "that worked" | Extracts learnings → writes invariants → propagates to Gemini + Codex via `@import` |
| `/council` | Before arch decisions, auth/payments/security, hard-to-reverse refactors | Gemini + Codex in parallel, R2 convergence loop, verdict + scored decisions log |

You never decide when to run these. Claude watches for the signals and triggers them.

---

## How Vanta works under the hood

Vanta sits between you and Claude Code as four layers.

### Layer 1: Routing

A 33-route intent table maps natural-language phrases to the right skill across three frameworks.

| Say this | Goes to |
|---|---|
| "ship this" / "open pr" / "merge this" | gstack `/ship` |
| "qa" / "test the site" / "smoke test" | gstack `/qa` |
| "review" / "check my diff" | gstack `/review` |
| "debug" / "something's broken" / "error" | GSD `/gsd-debug` |
| "write tests" / "add tests" | GSD `/gsd-add-tests` |
| "investigate" / "trace this" | gstack `/investigate` |
| "brainstorm" / "i have an idea" | Superpowers `/brainstorming` |
| "plan this" / "new phase" | GSD `/gsd-plan-phase` |
| "deploy to prod" / "go live" | gstack `/land-and-deploy` |
| "security audit" | gstack `/cso` |
| "office hours" / "strategy session" | gstack `/office-hours` |
| "retro" / "what did we learn" | gstack `/retro` → `/vanta-sync` |
| "what's next" / "where was I" | GSD reads `.planning/` |
| "am I done" / "verify this" | GSD `/gsd-verify-work` |
| **"what do I know about X"** | **Vanta cross-project recall** |
| **"rename tier to plan_level"** | **`/council` — taxonomy is product authority** |
| + compound chains | "resume and ship" → `/review` → `/qa` → `/ship` |

On miss: appended to `~/.vanta/missed-intents.jsonl` and surfaced as a hint. Misses that hit twice become new routes.

### Layer 2: Anticipatory memory (constraint-pack hook)

When Claude is about to write to `auth/`, `payment/`, `migration/`, or any security-sensitive path, the `council-advisory.js` PreToolUse hook fires *before* the edit lands. It queries `vanta-resolve.js` — a single ranked index over decisions, invariants, project gotchas, recent episodes, and pending shadow reviews — and injects the constraint pack:

```
📌 PRIOR DECISIONS — what /council already decided about this topic
⚠️  INVARIANTS — relevant gotchas from vinamr-invariants.md
🔒 PROJECT GOTCHAS — what this repo's CLAUDE.md says
🧠 RECENT EPISODES — what we decided in the last few sessions
🌑 PENDING SHADOW REVIEW — plans flagged but not council-reviewed
⚠️  CONTRADICTIONS — binary opposition pairs (ES256/HS256, Pixi v7/v8) detected across sources
```

Claude doesn't have to remember to check. The constraint pack is in-context at the moment of decision. Past learnings shape present action automatically.

All five sources flow through one canonical query layer (`bin/vanta-resolve.js`, ~1000 lines, 17+ tests) — single ranking, single expiry/supersession filter, single dedup, single contradiction detector.

### Layer 3: Auto-memory

Every session end fires a Stop hook. If the session crossed any decision marker (*root cause*, *shipped*, *fixed it*, *merged*), the hook appends to:

- `~/.vanta/sync-queue.jsonl` — pending learning to extract
- `~/.vanta/episodes.jsonl` — time-aware decision log

The next `/vanta` session catches up automatically. Two indexes, two access patterns:

- **Invariants** indexed by tool (*"what's the gotcha with PixiJS"*)
- **Episodes** indexed by topic + time (*"what did we decide about JWT last week"*)

Both surface in cross-project recall. No vector DB. No SaaS. The corpus is small but signal-dense — this is what a 2nd brain actually feels like.

### Layer 4: Self-governance (`/vanta-patterns`)

Vanta logs everything: route hits, route misses, decisions, episodes, sync events. `/vanta-patterns` turns telemetry into a weekly health report:

- Top routes invoked
- Top missed phrases (≥2 hits = new route candidate)
- Repeat topics (≥2 sessions = invariant candidate)
- Sync coverage %
- Outcome distribution (resolved / blocked / decided / in-progress)
- Per-model finding accuracy (Gemini vs Codex over the last 30 days)

If the report flags ≥2 issues, it offers to run `/council` *on the report itself*. Vanta uses its own adversarial review process to redesign itself based on observed failures. Confirmed missed phrases become routes automatically.

---

## Cross-project recall

Type **"what do I know about Supabase"** — Vanta searches:

- `~/.claude/rules/vinamr-invariants.md` — global tool gotchas
- `~/.claude/projects/-Users-vinamr/memory/*.md` — auto-saved project context
- `~/.gstack/projects/*/decisions.md` — every council verdict
- `~/Projects/*/CLAUDE.md` — project-specific gotchas

200ms grep. No vectors. No SaaS. Smaller corpus, denser signal.

Example: ask *"what do I know about PixiJS"* and you get the v8 init pattern, the Lottie sprite-sheet trick, and the exact project where it matters. All in one block.

---

## Adversarial council

Before anything hard to reverse, `/council` fires Gemini and Codex in parallel:

```
R1: Both models review independently
   → if any P1 findings: fire R2
R2: Each model reacts to the other's findings
   → convergence: no new P1s → done
   → cap: 2 rounds max

Verdict: PASS / PASS WITH CONDITIONS / BLOCK
→ logged to ~/.gstack/projects/<slug>/decisions.md
   with metadata: confidence · scope · expires · supersedes
→ surfaces in next session brief
→ stale decisions decay (90d tactical, 365d architectural)
```

When a model is degraded (Gemini exit-55 in headless, Codex arg-parse failure on optional params), `vanta-council-health` runs a pre-flight check, falls back through a cascading model chain (gpt-5.4 → 5.3-codex → 5.2; gemini-3.1-pro → 3-pro → 2.5-pro), and emits a `model_health` block in the report. **Silent degradation is the bug Vanta will not let you ship over.**

---

## Shadow Council (pre-emptive governance)

When you write a plan to `.planning/*.md` that mentions auth, payments, migrations, or security keywords, `plan-watcher.js` fires *immediately* and writes a flag to `~/.gstack/projects/<slug>/.shadow_pending.md`.

Then on the very first code edit to that area, `council-advisory.js` reads the flag and surfaces:

```
🌑 PENDING SHADOW REVIEW (plan flagged but not council-reviewed):
- 2026-04-30-auth-rewrite.md · auth, session · flagged 2026-04-29T22:36Z
  → Run /council before implementing.
```

Plan-watcher fires when the plan is written; surfacing fires when implementation starts. You can't accidentally implement a sensitive plan that hasn't been adversarially reviewed.

---

## Prompt loop (v3.7+)

Weak prompts get rewritten in shadow mode before Claude sees them.

| You type | Vanta surfaces |
|---|---|
| `fix this` | `[Vanta] /investigate · fix-bug` + 3 numbered investigation steps |
| `ship it` | `[Vanta] /ship · ship` + 3 numbered ship steps |
| `it didn't work` | `[Vanta] /investigate · diagnose-recent` + 3 numbered triage steps |
| `find gaps` | `[Vanta] /codex · audit-gaps` |
| `what's next` | `[Vanta] continue-state · resume` |
| `rename tier to plan_level` | `[Vanta] /council recommended · T3 ASK · taxonomy = product authority` |
| `should we pivot pricing?` | `[Vanta] /council recommended · T3 ASK · safety-floor:prompt-pivot-decision` |

Routing decisions log to `~/.vanta/action-log.jsonl` with stable per-entry ids. Trust metrics (undo-within-2m, manual-interrupt, chain-success, silent-regret) compute downstream `ready_for_inline` — once shadow mode earns trust, future versions can flip to inline rewriting.

The hard gate: `bash scripts/prompt-loop-smoke.sh` — 15 prompts, ≥13 must produce sensible behavior. v3.7.1 ships at 15/15.

---

## Hooks (fire automatically)

| Hook | Trigger | What |
|---|---|---|
| `prompt-rewriter.js` | UserPromptSubmit | Shadow rewrite + skill route surface; passthrough on lookups, ASK on product-decision floor |
| `council-advisory.js` | PreToolUse: Write/Edit on auth/payment/migration paths | Constraint-pack injector + contradiction warnings + shadow-pending surface |
| `git-guardrails.js` | PreToolUse: Bash | Two-tier: HARD BLOCK on force-push to main, `--no-verify`, `rm -rf /`, `DROP/TRUNCATE`; ADVISORY on force-push feature, `reset --hard`, `clean -f` |
| `plan-watcher.js` | PostToolUse: Write/Edit on `.planning/*.md` | Shadow Council flag on sensitive plans |
| `test-failure-advisor.js` | PostToolUse: Bash with test failures | Hard-stop. Don't ship over broken tests. |
| `stack-file-nudge.js` | PostToolUse: Write/Edit on config files | Follow-up actions for config changes |
| `code-index-watch.js` | PostToolUse: Write/Edit/NotebookEdit | Incremental refresh of per-project knowledge shards |
| `auto-sync.js` | Stop: session end | Sync-queue + episodic memory; deduped by `session_id` across rotated `.bak.<ts>` siblings |

Plus four observability/scaffolding hooks (`tool-observer.js`, `prompt-context.js`, `phase-gate.js`, `session-start`) that never block and never inject.

---

## Architecture

```
~/.claude/skills/
  vanta-run/        ← /vanta: state detection, 33-route table, recall, bootstrap
  vanta-council/    ← /council: R1+R2 adversarial loop, decisions.md w/ metadata
  vanta-sync/       ← /vanta-sync: invariant extraction, scoped queue clearing
  vanta-patterns/   ← /vanta-patterns: weekly self-governance retrospective
  using-vanta/      ← always-active session context (loaded via @import)

~/.claude/bin/   (27 binaries, all plain Node)
  vanta-resolve.js           canonical knowledge query layer (~1000 lines)
  vanta-rewriter.js          shadow prompt rewrite + 12 rules + skill routes
  vanta-risk-classifier.js   3-axis hybrid: reversibility × blast × authority → T0–T3
  vanta-safety-floor.js      deterministic always-ask layer (prompt + cmd + file + symbol)
  vanta-kill-switch.js       3-scope: session > repo > global, bidirectional markers
  vanta-action-log.js        append-only JSONL ledger, .bak.<ts> rotation, stable ids
  vanta-trust-metrics.js     undo / interrupt / regret → composite ready_for_inline
  vanta-undo.js              per-kind reversers: file / git / memory / autonomy
  vanta-autonomy.js          earned levels L0–L3 with promotion + cooldown
  vanta-memory-promote.js    one-at-a-time, section-included fingerprint
  vanta-confidence-decay.js  half-lives by source class (90d / 180d / 365d)
  vanta-council-health.js    pre-flight readiness + cascading model fallback
  vanta-council-feedback.js  per-model finding accuracy tracker
  vanta-extract-score.js     3-stage gating: hard-reject → score → near-dup update
  vanta-peer-router.js       stack-aware peer routing (codex / gemini / both)
  vanta-status.js            single-screen health dashboard
  vanta-prune.js             reversible archival of dormant project shards
  vanta-projects.js          single source of truth for slug canon + keywords
  + 9 more scaffolding/util binaries

~/.claude/hooks/   (11 hooks)
  See "Hooks" table above.

~/.vanta/
  sync-queue.jsonl     ← pending learning extraction
  episodes.jsonl       ← time-aware decision log
  routing-events.jsonl ← every successful route match
  missed-intents.jsonl ← every routing miss (becomes new routes)
  action-log.jsonl     ← every rewriter / risk / autonomy decision
  query-log.jsonl      ← every resolve() call (shape-only)
  hook.log             ← hook errors and warnings (rotated at 1000 lines)
  vanta-health.md      ← weekly retrospective output
  knowledge/           ← per-project shards (one .jsonl + .cursor.json + .lock per slug)
    .archive/          ← vanta-prune destination (reversible)
```

Everything is plain Markdown and Node. No packages. No runtime. No network calls. Fails gracefully when gstack or GSD aren't installed — degrades to whatever frameworks are present.

---

## Surface impact discipline

**Vanta promises three commands.** Every change is classified before it lands.

- **INTERNAL MACHINERY** — does NOT add user-visible commands or skills. May add: bins under `~/.claude/bin/`, hooks under `~/.claude/hooks/`, sections inside the existing 5 skills, pure code in `bin/*.js`, tests, docs, invariants. **No surface budget impact.**
- **NEW USER SURFACE** — adds: a new top-level skill (`Skill("vanta-foo")`), a new slash command, a new prompt the user must memorize. **Must justify against the three-command promise.** The bar is high — most additions should be internal machinery.

Every commit body names the classification explicitly. Reviewers (council, code-reviewer agents) MUST flag surface-creep — silent expansion is the failure mode this rule exists to prevent.

---

## Storage assumptions

`~/.vanta/` and `~/.gstack/` MUST live on a local filesystem.

1. **`O_EXCL` is not reliable on NFS.** Shard lockfiles need POSIX-on-local-disk semantics. NFSv3 silently grants the same lock to multiple writers; concurrent indexer fires would clobber each other's writes.
2. **Atomic rename across NFS mount boundaries can fail with EXDEV.** The indexer writes via `tmp + rename` — different filesystems break that.

If you need cross-machine state, snapshot to S3/Dropbox nightly. Don't share the live tree.

---

## What Vanta is not

- **Not an agent framework.** Routing + memory on top of Claude Code's existing skill system.
- **Not a vector database.** Cross-project semantic search is deferred behind an evidence gate (>5 failed local retrievals or >10 active projects). Local grep handles everything below that.
- **Not opinionated about your stack.** Works with any project.
- **Not a replacement for gstack or GSD.** It's the harness that decides when to call them.

---

## Version history

| Version | Score | What changed |
|---|---|---|
| v1 | 6/10 | 3 commands, prose suggestions, no routing |
| v2 | 7.5/10 | 13 routes, session brief, compound chains, direct invocations |
| v3 | 9.4/10 | 25 routes, Stop hook auto-memory, decisions.md, staleness detection, codemap at bootstrap |
| v3.1 | 9.6/10 | 33 routes incl. cross-project recall, scoped sync-queue, smarter Stop hook, routing precedence |
| v3.2 | 9.8/10 | Constraint-pack hook, episodic memory, `/vanta-patterns` self-governance, decision metadata |
| v3.3 | 9.9/10 | `vanta-resolve.js` canonical knowledge index, Shadow Council via `plan-watcher.js`, Stop hook dedup |
| v3.4 | 9.95/10 | Per-project shards (eliminates O(N) write race), 3-layer pattern architecture, `vanta-status` + `vanta-prune`, synonym pre-expansion, query-log + `--analyze` |
| v3.5 | 9.97/10 | Tier 6: `vanta-council-health` pre-flight + cascading fallback, `vanta-council-feedback` per-model accuracy, cross-source contradiction detector, `vanta-extract-score` 3-stage gating, `git-guardrails.js` two-tier policy, 52+ tests |
| v3.6 | 9.98/10 | Always-on observability (`tool-observer.js`, `prompt-context.js`), 3-axis risk classifier, safety-floor + kill-switch, action-log JSONL ledger with stable ids and `.bak.<ts>` rotation, trust-metrics composite |
| v3.7.1 | 9.99/10 | **Prompt loop hard gate.** 12 rewriter rules with `skill_route`, terse 4-line shadow injection, 15-prompt smoke gate at 15/15, taxonomy-rename → `/council` ASK, safety-floor product-decision → `/council` surface |

See [`docs/EXPLAINER.md`](docs/EXPLAINER.md) for the full design rationale.

---

MIT. Free forever. Built solo because I needed it to work.

**Want to extend Vanta?** Most additions go in `bin/` (knowledge layer) or `hooks/` (event layer). The three user-facing commands are intentionally a hard cap — see [Surface impact discipline](#surface-impact-discipline) above.

---

> *"The bottleneck was never code."*
