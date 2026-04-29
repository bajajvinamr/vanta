<!-- /autoplan restore point: /Users/vinamr/.gstack/projects/bajajvinamr-vanta/master-autoplan-restore-20260430-014158.md -->
# Vanta v2 — Make It a Real 2nd Brain

## Problem Statement

Vanta v1 is a thin routing layer, not a 2nd brain. Three commands exist
(`/vanta`, `/vanta-sync`, `/council`) but they only integrate the three
underlying frameworks (gstack, GSD, superpowers) at entry and exit points.
The 80% middle — daily development work — is unrouted.

Current state: 6/10 as a 2nd brain.
- GSD: 3 of 85 skills wired
- gstack: 60+ skills mentioned in prose, zero invoked
- superpowers: 2 of 14 wired (bootstrap only)

Target: 8.5/10. Every common developer action routes to the right tool
automatically. User types what they want; Vanta picks the framework.

## What We Are NOT Building

- A new framework. Vanta composes existing frameworks.
- A CLI or package. Vanta is Claude Code SKILL.md files.
- Routing for all 85+ GSD skills. High-frequency only.
- Any UI, dashboard, or web surface.

## What We ARE Building

### 1. Session-Start Project Brief (highest value, ~30 min)

**File:** `~/.claude/skills/using-vanta/SKILL.md` (extend existing)

When vanta loads at session start, auto-detect active project context:

```
IF .planning/ exists:
  - Read .planning/PHASE.md or current phase file
  - Show: last completed phase | current phase | blocking item | suggested next command
  - 3 lines max. No prompt, no user action needed.

IF ~/.gstack/projects/<slug>/timeline.jsonl exists:
  - Read last 3 entries
  - Surface: last skill run | time | outcome

IF memory/MEMORY.md has active project entry:
  - Pull project name + last known status
```

Output at session start (injected into additionalContext):
```
[Vanta] Active: <project> · Phase <N>/M: <phase-name> · Last: <skill> <time-ago>
Next: <suggested command>
```

**Why:** A 2nd brain knows where you left off. Currently the user re-explains context every session.

### 2. Mid-Session Lifecycle Routing (highest leverage, ~2 hours)

**File:** `~/.claude/skills/vanta-run/SKILL.md` (extend Intent section)

When user types something that maps to a known action, Vanta invokes the right skill:

| User says | Framework | Skill invoked |
|---|---|---|
| "ship this", "open a PR", "deploy" | gstack | `Skill("gstack")` → `/ship` |
| "QA this", "test the site", "does it work" | gstack | `Skill("gstack")` → `/qa` |
| "review this", "check my diff" | gstack | `Skill("gstack")` → `/review` |
| "debug this", "something's broken" | GSD | `Skill("gsd-debug")` |
| "write tests", "add test coverage" | GSD | `Skill("gsd-add-tests")` |
| "do a code review" | GSD | `Skill("gsd-code-review")` |
| "investigate this bug" | gstack | `Skill("gstack")` → `/investigate` |
| "brainstorm", "I have an idea" | superpowers | `Skill("brainstorming")` |
| "plan this feature" | GSD | `Skill("gsd-plan-phase")` |
| "checkpoint", "save progress" | gstack | `Skill("gstack")` → `/checkpoint` |

Implementation: extend the `## Intent (state 4)` section in `vanta-run/SKILL.md` to match
against intent keywords BEFORE falling through to generic planning. If matched, invoke
directly. If ambiguous, show the matched option and confirm.

**Why:** Right now, user has to know `/gstack`, `/gsd-debug`, `/brainstorming` etc. exist.
With routing, they just type what they want.

### 3. gstack Direct Invocation Fix (~20 min)

**File:** `~/.claude/skills/vanta-run/SKILL.md`

Replace all prose suggestions of gstack commands with actual `Skill("gstack")` calls.

Current (broken):
```
- Before merging → `/ship` (runs tests, opens PR)
- Browser testing needed → `/qa`
```

Fixed:
```
- Before merging → invoke `Skill("gstack")` with context "run /ship"
- Browser testing needed → invoke `Skill("gstack")` with context "run /qa"
```

**Why:** A suggestion that the user has to manually type is not automation.

### 4. Context Window Watchdog (~30 min)

**File:** `~/.claude/skills/using-vanta/SKILL.md`

Add explicit context-management behavior:

```
AT 60% CONTEXT:
  - Proactively say: "Context at 60%. Run /compact now, or I'll lose track of this session."
  - If GSD phase active: "Or run /gsd-save-context to checkpoint the phase."
  - Do not wait for the user to notice.

AT 80% CONTEXT:
  - Hard stop on new large features.
  - Offer: "Save state and start fresh with /clear, or compact with /compact <hint>."
```

Detection mechanism: The skill can't directly read token count, but it can trigger this
reminder after ~15 tool calls in a session, or when the user asks for a large new task
and the conversation has been going for a while.

**Why:** Every session that hits 93% context (like this one) loses work. One proactive
prompt saves 30 minutes of re-explaining.

### 5. Proactive council Triggers (existing behavior, make explicit)

**File:** `~/.claude/skills/vanta-run/SKILL.md` and `~/.claude/skills/using-vanta/SKILL.md`

Currently the `using-vanta` SKILL.md says "suggest /council before arch changes" but
never actually fires the trigger during a session.

Make it explicit: if the user is about to touch any of these paths, automatically say
"This touches [auth/payment/security/migration]. Want `/council` before we write code?"
and await confirmation.

Pattern matching:
```
paths: auth/, payments/, migrations/, middleware/, CORS, JWT, session, crypto
actions: "add", "change", "refactor", "delete" (not "read" or "review")
```

### 6. Compound Action Chain — "Resume and Ship" (~30 min)

**File:** `~/.claude/skills/vanta-run/SKILL.md`

Add a "Compound Intents" subsection to Intent Routing. When user says a multi-step phrase,
Vanta reads project state, summarizes in 2 lines, proposes the chain, executes on confirmation:

| User says | Vanta does |
|---|---|
| "resume and ship", "get this ready to ship" | reads .planning/ → review → QA → ship |
| "pick up where I left off and debug" | loads context → `/investigate` |
| "resume and plan next phase" | loads context → `/gsd-plan-phase` |

Response format on match:
```
[Vanta] vanta is at Phase 3/5: API endpoints. Last: /review 2d ago.
Chain: /review → /qa → /ship. Proceed? [y/n]
```

**Why:** Single-step routing makes Vanta a shortcut. Compound routing makes it a 2nd brain.
The magic moment: user types one phrase after days away and Vanta picks up exactly where they left off.

## Files Modified

| File | Change type | Notes |
|---|---|---|
| `~/Projects/vanta/skills/using-vanta/SKILL.md` | Extended (+2,186 bytes → 4,619 total) | Canonical. Loaded via CLAUDE.md `@./skills/using-vanta/`. Session brief + route vocab + watchdog + council-planning trigger |
| `~/.claude/skills/vanta-run/SKILL.md` | Extended (+4,077 bytes → 6,249 total) | Deployed skill. gstack direct invocations + intent routing + collision rules + compound action chain |
| `~/Projects/vanta/skills/vanta/SKILL.md` | Mirrored | Repo copy of vanta-run. Identical to above. |

3 files modified. No new files. `~/.claude/skills/using-vanta/` does NOT exist — nothing deployed there.

## Smoke-Test Table (run before and after edits)

| User phrase | Expected skill invoked | Framework |
|---|---|---|
| "ship this" | `Skill("gstack")` context "run /ship" | gstack |
| "open a PR" | `Skill("gstack")` context "run /ship" | gstack |
| "QA this" | `Skill("gstack")` context "run /qa" | gstack |
| "review this" (no prior gstack) | `Skill("gstack")` context "run /review" | gstack |
| "review this" (gstack already fired) | `Skill("gsd-code-review")` | GSD |
| "debug this" | `Skill("gsd-debug")` | GSD |
| "write tests" | `Skill("gsd-add-tests")` | GSD |
| "brainstorm" | `Skill("brainstorming")` | superpowers |
| "resume and ship" | reads .planning/ → chain /review → /qa → /ship | gstack |
| "let's go for lunch" | routing miss → shows phrase list | fallthrough |

## NOT In Scope

- Routing all 85 GSD skills (too much surface area, low-frequency skills stay manual)
- New hook files (existing hooks are sufficient)
- Plugin install mechanism (already documented as broken, not worth fixing)
- Onboarding docs or README updates (VANTA.md already exists)
- vanta-council changes (it works well, score 7/10)
- vanta-sync changes (it works well, score 8/10)

## Success Criteria

| Metric | Current | Target |
|---|---|---|
| gstack skills invocable via Vanta | 0 | 8+ |
| GSD skills invocable via Vanta | 3 | 10+ |
| Session-start context load | 0 lines | 3-line brief |
| User has to remember sub-commands | yes | no |
| 2nd brain score | 6/10 | 8.5/10 |

## Risks

1. **Over-routing ambiguous intent** — matching "ship" to `/ship` when user means "ship
   conceptually" in a conversation. Mitigation: always confirm before invoking a skill
   from intent matching if the match is not 90%+ confident.

2. **gstack preamble spam** — gstack's SKILL.md has a 100-line preamble (update checks,
   telemetry, session setup) that fires on every invocation. Multiple Vanta routes that
   call gstack will each trigger this preamble. Mitigation: note this in vanta-run and
   suggest running `/gstack-upgrade` once per session to settle state.

3. **Skill scanner still flat** — all new routing assumes flat `~/.claude/skills/<name>/`
   structure. Do not add any nested skill dirs. Invariant already documented.

4. **session-start hook character limit** — the using-vanta SKILL.md is injected by a
   bash hook into `additionalContext`. If the SKILL.md grows beyond ~8KB, the hook may
   truncate it. Keep additions to the session-start brief section concise.

## Implementation Order

1. gstack direct invocation fix (20 min, highest leverage per line written)
2. Mid-session lifecycle routing intent matcher (2 hours, core feature)
3. Session-start project brief (30 min, highest user-visible value)
4. Context window watchdog (30 min, prevents future pain)
5. Proactive council triggers (20 min, completes the safety net)

Total: ~4 hours of work.

---

## /autoplan Review Results (Phase 1 CEO + Phase 3 Eng)

### Phase 1 — CEO Review

**Premise gate:** Passed. User confirmed SKILL.md-only approach.
**User Challenge:** Both models recommended hooks-first mechanism. User direction stands (SKILL.md only).

**CEO Consensus:**
- Routing ≠ 2nd brain (discoverability vs. context continuity) — flagged, accepted
- gstack preamble spam mitigation inadequate — needs fix in implementation
- Platform risk (Claude Code absorbs routing layer in 6 months) — accepted

**Auto-decided:** Item 3 (gstack direct invocation fix) unambiguously correct. Execute first.

---

### Phase 3 — Engineering Review

**CRITICAL (fix before writing any code):**

1. **Wrong file path in plan** — `~/.claude/skills/using-vanta/SKILL.md` does NOT exist. The file is at `~/Projects/vanta/skills/using-vanta/SKILL.md` (2,433 bytes), loaded via session-start hook injection. Items 1, 4, 5 must target the repo file, not create a phantom duplicate. Update the Files Modified table.

2. **Context watchdog is unimplementable in SKILL.md** — SKILL.md has no access to tool call counts or token counts. "After ~15 tool calls" is not actionable for a language model following instructions. Reframe as: "when you notice the conversation has had many tool calls or is running long, proactively mention /compact" — passive guidance, not active trigger.

**HIGH:**

3. **Intent routing has no cross-framework disambiguation** — "review this" matches both gstack `/review` AND `gsd-code-review`. "investigate" maps to gstack, "debug" maps to GSD. No tie-breaking rule defined. Fix: when both GSD and gstack match, prefer GSD if gstack already fired this session (preamble spam), always confirm on cross-framework collision.

4. **Session brief has no staleness/conflict rules** — `.planning/`, `timeline.jsonl`, `MEMORY.md` can contradict each other. Fix: PHASE.md is authoritative; ignore timeline entries >7 days; cap to 5 files from `.planning/`, newest by mtime.

5. **Proactive council trigger duplicates `council-advisory.js`** — hook already fires on auth/payment/migration file writes. SKILL.md trigger should scope to *planning* actions only (before any file write), not duplicate the hook's coverage.

**MEDIUM:**

6. **Zero test strategy** — Add a manual smoke-test table: 10 user phrases × expected skill invocation. Run before and after edit to catch regressions.

7. **Session-start injection byte limit** — Current `using-vanta/SKILL.md` is 2,433 bytes. Hook may truncate if it grows. Add byte-count assertion to setup.sh (hard limit: keep under 6KB).

---

### Corrected Files Modified Table

| File | Change type | Notes |
|---|---|---|
| `~/Projects/vanta/skills/using-vanta/SKILL.md` | Extend (+40 lines) | Canonical. Loaded via session-start hook. NOT `~/.claude/skills/using-vanta/` |
| `~/.claude/skills/vanta-run/SKILL.md` | Extend (+60 lines) | Intent routing + gstack invocation fix |
| `~/Projects/vanta/skills/vanta-run/SKILL.md` | Mirror | Sync repo copy |

3 files (corrected from 4). `~/.claude/skills/using-vanta/` does not exist — do not create it.

---

### Eng Consensus Table

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               FAIL    FAIL   CONFIRMED (file path wrong, watchdog inert)
  2. Test coverage sufficient?         NO      NO     CONFIRMED (zero tests, needs smoke table)
  3. Performance risks addressed?      PARTIAL PARTIAL CONFIRMED (brief unbounded reads)
  4. Security threats covered?         N/A     N/A    N/A
  5. Error paths handled?              NO      NO     CONFIRMED (brief conflict/staleness)
  6. Deployment risk manageable?       NO      NO     CONFIRMED (critical path error in files table)
═══════════════════════════════════════════════════════════════
```

**Phase 3 complete.** Codex: 5 concerns (1 P1, 3 P2, 1 P3). Claude subagent: 7 concerns (2 critical, 2 high, 3 medium). Consensus: 5/6 confirmed (all negative). No new P1s beyond what CEO found.

Phase 3.5 (DX) and Phase 4 (Final Gate) pending — run after `/compact`.

---

## /autoplan Review Results (Phase 3.5 — DX Review)

### DX Dual-Voice Scorecard

| Dimension | Claude | Codex | Consensus | Gap |
|---|---|---|---|---|
| Usable | 4→7 | 6 | 6/10 | No feedback when route fires; ambiguous miss path |
| Credible | 5→6 | 4 | **4/10** | Probabilistic routing, unresolved cross-framework collisions |
| Findable | 3→5 | 3 | **3/10** | No discoverability — user can't discover what phrases work |
| Useful | 6→8 | 7 | 7/10 | Routing table covers right actions for solo dev |
| Valuable | 5→8 | 6 | 6/10 | Preamble spam + confirmation loop eats time savings |
| Accessible | 7→8 | 5 | 6/10 | Degraded paths not defined for each action when gstack absent |
| Desirable | 6→8 | 6 | 6/10 | Magic possible; currently noisy with competing prompts |
| **Overall** | **5.1/10** | **5.3/10** | **5.4/10** | Below 7/10 "good DX" bar |

**TTHW:** Competitive (2–5 min). Exact blessed phrases hit Champion; near-misses have no recovery UX.

---

### DX P1 Findings (fix before shipping)

1. **Phantom file in plan body** — Engineering correction in appended section is right, but sections 1–5 still say `~/.claude/skills/using-vanta/SKILL.md`. Every implementation item that references Items 1, 4, 5 must be updated to `~/Projects/vanta/skills/using-vanta/SKILL.md` before anyone implements. The fix is documented; the plan text is not corrected.

2. **Routing trust not defensible** — "review this" resolves to gstack `/review` OR `gsd-code-review` depending on session state, with no deterministic rule in the plan. Vinamr will learn the route misfires ~20% of the time → trust collapses. Fix: add one explicit precedence rule to the Intent Routing section: "if gstack already fired this session, prefer GSD for review/debug to avoid preamble spam; always confirm cross-framework on first collision."

### DX P2 Findings (high)

3. **Hidden routing vocabulary** — The 10-phrase table exists in SKILL.md but nowhere in the user-facing output. User can't ask "what can Vanta route?" Fix: session-start brief appends "Route-able: ship this · review this · debug this · write tests · checkpoint" (5 examples). On a routing miss, reply with "Routing miss — phrases I understand: …"

4. **No confirmation feedback loop** — Plan says "confirm before invoking" but no format specified. If every routing confirmation is verbose, it defeats the automation. Fix: single-line format: "→ Routing to /ship via gstack. Proceed? [y/n]"

5. **Missing magical moment** — The plan routes single utterances to single skills. The magical moment it doesn't create: "resume and get this ready to ship" → reads project state, explains current phase, chains review → QA → ship with one confirmation. Would make the 2nd brain metaphor real.

---

### DX Consensus Table

```
DX DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Usable — routing ergonomics?       6/10    6/10   PARTIAL (miss path undefined)
  2. Credible — probabilistic trust?    5/10    4/10   CONFIRMED FAIL (collision rules missing)
  3. Findable — discoverability?        3/10    3/10   CONFIRMED FAIL (vocabulary hidden)
  4. Useful — right actions covered?    8/10    7/10   PASS (good table)
  5. Valuable — time savings?           7/10    6/10   PARTIAL (preamble spam risk)
  6. Accessible — degraded paths?       6/10    5/10   PARTIAL (fallbacks undefined per-action)
  7. Desirable — feels magical?         7/10    6/10   PARTIAL (single-step only)
═══════════════════════════════════════════════════════════════
```

**Phase 3.5 complete.** Claude: 5.1/10 target score. Codex: 5.3/10. Consensus: 2 CONFIRMED FAIL dimensions (Credible, Findable), 4 PARTIAL, 1 PASS. DX overall: 5.4/10. Needs 2 fixes before implementation begins.

Phase 4 (Final Gate) pending.
