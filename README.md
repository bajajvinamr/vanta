# Vanta

**AI development lifecycle harness for Claude Code.** One command that knows where you are, routes to the right tool, remembers what you learned, and flags what needs attention — without you managing any of it.

Built on [gstack](https://github.com/garrytan/gstack), [Get Shit Done](https://github.com/obra/superpowers), and [Superpowers](https://github.com/obra/superpowers). Vanta is the glue layer on top.

---

## What it looks like

Every session opens with this:

```
[Vanta] Active: pi-perception · Phase 3/4: Calibration · Last: /ship 18h ago
Decisions: ES256 JWT chosen (3d ago) · 12-dim algo kept (1w ago)
Stale: PR #52 open 4d — /review or /ship?
Next: write tests for calibration failures
Routes: ship this · review this · debug this · write tests · checkpoint · what's next · retro
```

You didn't configure anything. Vanta reads `.planning/`, `timeline.jsonl`, `decisions.md`, and open PRs. It knows your context before you type a word.

---

## Three commands

| Command | When Claude suggests it | What it does |
|---|---|---|
| `/vanta` | Session in a repo, new project, or "start fresh" | Bootstraps or resumes. Detects state, chains the right tools. |
| `/vanta-sync` | After "done", "shipped", "merged" | Extracts learnings → writes invariants → propagates to Gemini + Codex |
| `/council` | Before arch decisions, auth/payments/security, hard refactors | Gemini + Codex in parallel, R2 convergence loop, verdict + decisions.md log |

**You never decide when to run these.** Claude watches for the signals and triggers them.

---

## 25-route intent router

Type a phrase. Vanta routes to the right tool across three frameworks — no slash commands to memorize.

| Say this | Goes to |
|---|---|
| "ship this" / "open pr" / "merge this" | gstack `/ship` |
| "qa" / "test the site" / "smoke test" | gstack `/qa` |
| "review" / "check my diff" | gstack `/review` or GSD `/code-review` (collision rule) |
| "debug" / "something's broken" / "error" | GSD `/gsd-debug` |
| "write tests" / "add tests" / "test this" | GSD `/gsd-add-tests` |
| "investigate" / "trace this" / "what's causing" | gstack `/investigate` |
| "brainstorm" / "i have an idea" / "help me think" | Superpowers `/brainstorming` |
| "plan this" / "new phase" / "break this down" | GSD `/gsd-plan-phase` |
| "refactor" / "clean this up" / "simplify" | gstack `/review` |
| "deploy to prod" / "go live" / "land this" | gstack `/land-and-deploy` |
| "security audit" / "check security" | gstack `/cso` |
| "office hours" / "strategy session" / "think with me" | gstack `/office-hours` |
| "retro" / "what did we learn" | gstack `/retro` → vanta-sync |
| "health check" / "update deps" | gstack `/health` |
| "what's next" / "next step" | GSD reads `.planning/` |
| "am I done" / "verify this" | GSD `/gsd-verify-work` |
| "restore context" / "where was I" | gstack `/context-restore` |
| "execute phase" / "let's build it" | GSD `/gsd-execute-phase` |
| "follow tdd" / "test first" | Superpowers `/tdd-workflow` |
| **"what do I know about X" / "have we solved X before"** | **vanta cross-project recall** (rg over invariants + memory + decisions) |
| + compound chains | "resume and ship" → /review → /qa → /ship |

On miss: logs to `~/.vanta/missed-intents.jsonl` and surfaces a hint. Miss patterns become new routes.

---

## Cross-project recall

Type **"what do I know about Supabase"** or **"have we solved this with PixiJS before"** — Vanta searches across:

- `~/.claude/rules/vinamr-invariants.md` — global tool gotchas (the things that burned you)
- `~/.claude/projects/-Users-vinamr/memory/*.md` — project context auto-saved across sessions
- `~/.gstack/projects/*/decisions.md` — every council verdict and trade-off you made
- `~/Projects/*/CLAUDE.md` — project-specific gotchas

200ms grep. No vectors. No SaaS. The corpus is small but signal-dense — this is what a 2nd brain actually feels like.

Example: ask "what do I know about PixiJS" and you get back the v8 init pattern, the Lottie sprite-sheet trick, and the exact project where it matters. All in one block.

---

## Auto-memory pipeline

**The problem:** Claude forgets between sessions. You forget to run `/vanta-sync`. Learnings disappear.

**The fix:** A Stop hook that fires when any session ends — and writes two streams.

```
Session ends
  → auto-sync.js reads transcript
  → if >5 tool calls OR decision marker present (root cause / fixed it / shipped / merged…)
    → appends to ~/.vanta/sync-queue.jsonl  (pending learning extraction)
    → if decision marker: appends episode to ~/.vanta/episodes.jsonl
        { ts, slug, branch, topics: ["jwt","auth"], decision: "...", outcome: "resolved" }

Next /vanta session
  → detects unsynced sessions, surfaces queue depth
  → "What did we discuss about X last week" → searches episodes by topic + time
```

Two indexes, two access patterns:
- **invariants** index by tool ("what's the gotcha with PixiJS")
- **episodes** index by topic + time ("what did we decide about JWT last week")

Both surface in `/recall`. No vector DB. No SaaS.

---

## Anticipatory memory (constraint-pack hook)

The moment Claude starts to write `auth/`, `payment/`, `migration/`, or any security-sensitive path, the `council-advisory.js` hook fires *before* the edit lands and injects:

```
📌 PRIOR DECISIONS — what /council already decided about this topic
⚠️  INVARIANTS — relevant gotchas from vinamr-invariants.md
🔒 PROJECT GOTCHAS — what this repo's CLAUDE.md says about this topic
🧠 RECENT EPISODES — what we decided about this in the last few sessions
🌑 PENDING SHADOW REVIEW — plans flagged but not yet council-reviewed
```

Claude doesn't have to remember to check. The constraint pack is in-context at the moment of decision. Past learnings shape present action automatically.

All five sources flow through one canonical query layer (`bin/vanta-resolve.js`) — single ranking, single expiry/supersession filter, single dedup. Replaces five separate greps with one ranked, scored, metadata-aware index.

---

## Shadow Council (pre-emptive governance)

When you write a plan to `.planning/*.md` that mentions auth, payments, migrations, or security keywords, `plan-watcher.js` fires *immediately* and writes a flag to `~/.gstack/projects/<slug>/.shadow_pending.md`.

Then on the very first code edit to that area, `council-advisory.js` reads the flag and surfaces:

```
🌑 PENDING SHADOW REVIEW (plan flagged but not council-reviewed):
- 2026-04-30-auth-rewrite.md · auth, session · flagged 2026-04-29T22:36Z
  → Run /council before implementing.
```

The plan-watcher fires when the plan is written; the surfacing fires when implementation starts. You can't accidentally implement a sensitive plan that hasn't been adversarially reviewed — Vanta surfaces the gap at exactly the moment it would matter.

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
→ auto-logged to ~/.gstack/projects/<slug>/decisions.md
   with metadata: confidence · scope · expires · supersedes
→ surfaces in session brief next time
→ stale decisions decay automatically (90d tactical, 365d architectural)
```

Council findings become institutional memory with TTLs. Old decisions fade out. Reversals chain via `supersedes:` so you can trace why a position changed.

---

## Self-governance (`/vanta-patterns`)

Vanta logs everything: route hits, route misses, decisions, episodes, sync events. `/vanta-patterns` turns that telemetry into a weekly health report:

- Top routes invoked
- Top missed phrases (≥2 hits = candidate for new route)
- Repeat topics (≥2 sessions = candidate for an invariant)
- Sync coverage %
- Outcome distribution (resolved / blocked / decided / in-progress)

If the report flags ≥2 issues, it offers to run `/council` *on the report itself* — Vanta uses its own adversarial review process to redesign itself based on observed failures. Confirmed missed phrases become new routes automatically.

---

## Hooks (fire automatically)

| Hook | Trigger | What |
|---|---|---|
| `council-advisory.js` | PreToolUse: Write/Edit to auth/payment/migration paths | **Constraint-pack injector** — queries `vanta-resolve.js` for ranked decisions, invariants, gotchas, episodes, and pending shadow reviews. Surfaces ⚠️ contradiction warnings (Tier 6 #14) when binary-opposition pairs land in separate retrieved entries. |
| `git-guardrails.js` | PreToolUse: Bash | Two-tier policy on destructive git/sql/rm: HARD BLOCK on force-push to main, `--no-verify`, `rm -rf /`, `DROP/TRUNCATE`; ADVISORY on force-push feature, `reset --hard`, `clean -f`, relative `rm -rf` |
| `plan-watcher.js` | PostToolUse: Write/Edit to `.planning/*.md` | **Shadow Council flag** — detects sensitive topics in plans, writes pending-review flag for council-advisory to surface at code time |
| `test-failure-advisor.js` | PostToolUse: Bash with test failures | Hard-stop — don't ship over broken tests |
| `stack-file-nudge.js` | PostToolUse: Write/Edit to config files | Follow-up actions for config changes |
| `code-index-watch.js` | PostToolUse: Write/Edit/NotebookEdit | Incremental refresh of per-project knowledge shards |
| `auto-sync.js` | Stop: session end | Queue session + write episodic memory; dedupes by session_id |

---

## Install

```bash
git clone https://github.com/bajajvinamr/vanta ~/Projects/vanta
cd ~/Projects/vanta && ./setup.sh
```

**What setup does:**
1. Deploys four skills to `~/.claude/skills/`: `vanta-run`, `vanta-council`, `vanta-sync`, `vanta-patterns`
2. Copies hooks to `~/.claude/hooks/`
3. Registers Stop hook in `~/.claude/settings.json`
4. Loads `using-vanta` as always-active context via `CLAUDE.md`

Requires: Claude Code. Recommended: [gstack](https://github.com/garrytan/gstack) + [GSD](https://github.com/obra/superpowers) for full routing coverage.

See `docs/install.md` for manual setup and dependency notes.

---

## Architecture

```
~/.claude/skills/
  vanta-run/        ← /vanta: state detection, 33-route table, /recall, bootstrap
  vanta-council/    ← /council: R1+R2 adversarial loop, decisions.md w/ metadata
  vanta-sync/       ← /vanta-sync: invariant extraction, scoped queue clearing
  vanta-patterns/   ← /vanta-patterns: weekly self-governance retrospective

~/.claude/bin/
  vanta-projects.js          ← single source of truth for project keywords + slug canon
  vanta-resolve.js           ← canonical knowledge query layer (one ranked index over 6 sources)
                               + cross-source contradiction detector (Tier 6 #14)
  vanta-index-code.js        ← code-knowledge indexer (per-project shards, lockfile, atomic write)
  vanta-status.js            ← single-screen health: shards/queues/hooks/council/accuracy
  vanta-prune.js             ← archive dormant project shards (reversible)
  vanta-log.js               ← shared hook logger (~/.vanta/hook.log)
  vanta-brief.js             ← session-start brief generator
  vanta-council-health.js    ← (Tier 6 #17) pre-flight readiness for /council
  vanta-council-feedback.js  ← (Tier 6 #15) per-model finding accuracy tracker
  vanta-extract-score.js     ← (Tier 6 #16) confidence scoring + auto/staging/discard router

~/.claude/hooks/
  auto-sync.js              ← Stop hook: sync-queue + episodic memory (deduped by session_id)
  council-advisory.js       ← PreToolUse: constraint-pack via vanta-resolve + contradiction warnings
  git-guardrails.js         ← PreToolUse:Bash hard-block + advisory tier (destructive git/sql/rm)
  plan-watcher.js           ← PostToolUse: Shadow Council flag on sensitive plans
  test-failure-advisor.js   ← PostToolUse: hard-stop on broken tests
  stack-file-nudge.js       ← PostToolUse: config-file follow-ups
  code-index-watch.js       ← PostToolUse: incremental shard refresh on file edits

~/.vanta/
  sync-queue.jsonl       ← pending learning extraction
  episodes.jsonl         ← time-aware decision log
  routing-events.jsonl   ← every successful route match
  missed-intents.jsonl   ← every routing miss (becomes new routes)
  query-log.jsonl        ← v3.4: every resolve() call (shape-only, used by --analyze)
  hook.log               ← v3.4: hook errors and warnings (rotated at 1000 lines)
  vanta-health.md        ← weekly retrospective output
  knowledge/             ← v3.4: per-project shards (one .jsonl + .cursor.json per slug)
    little-wins.jsonl
    little-wins.cursor.json
    pi-perception.jsonl
    pi-perception.cursor.json
    .archive/            ← vanta-prune destination (reversible)

~/Projects/vanta/
  skills/           ← Source of truth (deploys to ~/.claude/skills/)
  hooks/            ← Source of truth (deploys to ~/.claude/hooks/)
  skills/using-vanta/SKILL.md  ← Always-active session context (loaded via @)
```

Everything is plain markdown. No packages. No runtime. No network calls. Fails gracefully when gstack or GSD aren't installed — degrades to the available frameworks.

---

## Storage assumptions

`~/.vanta/` and `~/.gstack/` MUST live on a local filesystem. Two reasons:

1. **`O_EXCL` is not reliable on NFS.** The shard lockfile (`<slug>.lock`)
   relies on `open(O_EXCL)` to grant exclusive access. NFSv3 silently grants
   the same lock to multiple writers — concurrent indexer fires would clobber
   each other's writes. NFSv4 with delegations is better but still not
   guaranteed. Vanta's lock semantics are POSIX-on-local-disk only.

2. **Atomic rename across NFS mount boundaries can fail with EXDEV.** The
   indexer writes via `tmp + rename`; if the temp file lands on one filesystem
   and the target on another, rename returns EXDEV and the write is lost.

If you genuinely need cross-machine state, sync a snapshot (e.g., via a
nightly rsync to S3 / Dropbox), don't share the live tree. The cost of
sharing is silent corruption; the cost of snapshotting is a few seconds.

## What Vanta is not

- Not an agent framework. It's routing + memory on top of Claude Code's existing skill system.
- Not opinionated about your stack. Works with any project.
- Not supermemory or a vector database. Cross-project semantic search is deferred to an evidence gate (>5 failed local retrievals or >10 active projects). Local grep handles it below that threshold.
- Not a replacement for gstack or GSD. It's the harness that decides when to call them.

---

## Version history

| Version | Score | What changed |
|---|---|---|
| v1 | 6/10 | 3 commands, prose suggestions, no routing |
| v2 | 7.5/10 | 13 routes, session brief, compound chains, direct invocations |
| v3 | 9.4/10 | 25 routes, Stop hook auto-memory, decisions.md, staleness detection, codemap at bootstrap |
| v3.1 | 9.6/10 | 33 routes incl. cross-project recall, scoped sync-queue, smarter Stop hook (decision markers), routing precedence rules |
| v3.2 | 9.8/10 | Constraint-pack hook (anticipatory memory at write-time), episodic memory (`episodes.jsonl`), `/vanta-patterns` self-governance loop, decision metadata (confidence/scope/expires/supersedes), Gemini trust fix |
| v3.3 | 9.9/10 | `bin/vanta-resolve.js` canonical knowledge index (replaces 5 separate greps with one ranked query, expiry+supersession-aware), Shadow Council via `plan-watcher.js` (pre-emptive governance at plan-write time), Stop hook dedup by session_id, decision-extractor strips markdown, install bug fixed (all 4 hooks now register, not just Stop) |
| v3.4 | 9.95/10 | **Per-project shards** (`~/.vanta/knowledge/<slug>.jsonl`) eliminate the O(N) write race on the global jsonl — each project gets its own shard, cursor, and O_EXCL lockfile with PID-aware steal. **3-layer pattern architecture**: BASELINE (universal) + PROJECT_SPECIFIC (curated table) + CLAUDE.md `## Sensitive Patterns` (user-defined). **Alias-shard fold-on-read** so `bajajvinamr-vanta.jsonl` and `vanta.jsonl` merge under the canonical slug at query time. **`vanta-status`** for single-screen health (shards, queues, hook errors, stuck locks, suggestions). **`vanta-prune`** for reversible archival of dormant projects. **Synonym pre-expansion** widens recall (`--topic JWT` matches `bearer token`, `access token`, etc.). **Query-log + `--analyze`** for shape-only observability of resolver calls (top topics, zero-result ratio, foreign-bleed counts, score percentiles). **Hook logging** via `~/.vanta/hook.log` — broken hooks no longer rot invisibly. **17+ tests** lock canonProject + pathRank + lock semantics. |
| v3.5 | 9.97/10 | **Tier 6 — trust + resilience layer.** **#17** `vanta-council-health` pre-flight + cascading model fallback chain (gpt-5.4→5.3-codex→5.2; gemini-3.1-pro→3-pro→2.5-pro) + mandatory `model_health` block in council reports — silent degradation no longer goes unnoticed. **#15** `vanta-council-feedback` two-stage logging: record P1/P2 findings at council time, attribute outcomes at sync time, surface per-model accuracy in `vanta-status`. **#14** Cross-source contradiction detector in `vanta-resolve` flags binary-opposition pairs (ES256/HS256, v7/v8 in PixiJS, etc.) when they land in separate retrieved entries — surfaces ⚠️ above the constraint pack so the LLM sees the disagreement before reading either half. **#16** `vanta-extract-score` three-stage gating pipeline: skill-doc hard-reject, length/marker/framing/backtick scoring, near-dup → update-in-place, audit comments traceable via `git blame`. **Plus** integrations from external skill audit: `git-guardrails.js` PreToolUse:Bash two-tier policy (HARD BLOCK + ADVISORY), Low-Confidence Intent Mode in `vanta-run`, write-a-skill discipline in `vanta-sync`'s invariant→skill promotion. **52+ tests** across canonProject, pathRank, lock, synonym, git-guardrails, council-health, council-feedback, contradiction-detector, extract-score modules. |
