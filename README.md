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
```

Claude doesn't have to remember to check. The constraint pack is in-context at the moment of decision. Past learnings shape present action automatically.

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
| `council-advisory.js` | PreToolUse: Write/Edit to auth/payment/migration paths | **Constraint-pack injector** — surfaces prior decisions, invariants, and project gotchas as `additionalContext` *before* the edit |
| `test-failure-advisor.js` | PostToolUse: Bash with test failures | Hard-stop — don't ship over broken tests |
| `stack-file-nudge.js` | PostToolUse: Write/Edit to config files | Follow-up actions for config changes |
| `auto-sync.js` | Stop: session end | Queue session + write episodic memory (topics, decision, outcome) |

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

~/.claude/hooks/
  auto-sync.js              ← Stop hook: sync-queue + episodic memory
  council-advisory.js       ← PreToolUse: constraint-pack injection
  test-failure-advisor.js   ← PostToolUse: hard-stop on broken tests
  stack-file-nudge.js       ← PostToolUse: config-file follow-ups

~/.vanta/
  sync-queue.jsonl     ← pending learning extraction
  episodes.jsonl       ← time-aware decision log
  routing-events.jsonl ← every successful route match
  missed-intents.jsonl ← every routing miss (becomes new routes)
  vanta-health.md      ← weekly retrospective output

~/Projects/vanta/
  skills/           ← Source of truth (deploys to ~/.claude/skills/)
  hooks/            ← Source of truth (deploys to ~/.claude/hooks/)
  skills/using-vanta/SKILL.md  ← Always-active session context (loaded via @)
```

Everything is plain markdown. No packages. No runtime. No network calls. Fails gracefully when gstack or GSD aren't installed — degrades to the available frameworks.

---

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
