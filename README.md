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

**The fix:** A Stop hook that fires when any session ends.

```
Session ends
  → auto-sync.js reads transcript
  → if >5 tool calls (meaningful session)
  → appends to ~/.vanta/sync-queue.jsonl

Next /vanta session
  → detects unsynced sessions
  → "You have 2 sessions with unsaved learnings. /vanta-sync now?"
  → you say yes → invariants written → Gemini picks up automatically
```

No manual tracking. The session brief always shows the queue depth.

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
→ surfaces in session brief next time
```

Council findings become institutional memory. You won't relitigate the same decisions.

---

## Hooks (fire automatically)

| Hook | Trigger | What |
|---|---|---|
| `council-advisory.js` | PreToolUse: Write/Edit to auth/payment/migration paths | Advisory — "run /council before this?" |
| `test-failure-advisor.js` | PostToolUse: Bash with test failures | Hard-stop — don't ship over broken tests |
| `stack-file-nudge.js` | PostToolUse: Write/Edit to config files | Follow-up actions for config changes |
| `auto-sync.js` | Stop: session end | Queue session for learning extraction |

---

## Install

```bash
git clone https://github.com/bajajvinamr/vanta ~/Projects/vanta
cd ~/Projects/vanta && ./setup.sh
```

**What setup does:**
1. Deploys three skills to `~/.claude/skills/`: `vanta-run`, `vanta-council`, `vanta-sync`
2. Copies hooks to `~/.claude/hooks/`
3. Registers Stop hook in `~/.claude/settings.json`
4. Loads `using-vanta` as always-active context via `CLAUDE.md`

Requires: Claude Code. Recommended: [gstack](https://github.com/garrytan/gstack) + [GSD](https://github.com/obra/superpowers) for full routing coverage.

See `docs/install.md` for manual setup and dependency notes.

---

## Architecture

```
~/.claude/skills/
  vanta-run/        ← /vanta: state detection, 25-route table, bootstrap, codemap
  vanta-council/    ← /council: R1+R2 adversarial loop, decisions.md auto-log
  vanta-sync/       ← /vanta-sync: invariant extraction, multi-model propagation

~/.claude/hooks/
  auto-sync.js      ← Stop hook: queues sessions > 5 tool calls
  council-advisory.js
  test-failure-advisor.js
  stack-file-nudge.js

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
