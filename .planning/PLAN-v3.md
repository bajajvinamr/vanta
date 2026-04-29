# Vanta v3 — Path to 9.9

## Where We Are

| Version | Score | What it is |
|---|---|---|
| v1 | 6/10 | 3 commands, 0 routes, prose suggestions |
| v2 | 7.5/10 | 13 routes, session brief, compound chains, direct invocations |
| v3 target | **9.9** | Auto-memory, 25+ routes, cross-project intelligence, proactive surfacing |

## Council Verdict (2026-04-30)

PARTIAL council (Gemini trust directory blocked, Codex only, 2 rounds).

**BLOCK on Phase 1 as originally written.** Root cause: false build-vs-buy premise + wrong problem at current scale.

- [P1] Stop hook is 30-60 lines Node (same pattern as council-advisory.js) — not "2 hours + brittle Bash"
- [P1] Solo dev with ~5 projects has no retrieval problem — defer supermemory to evidence gate
- [P2] Original plan had a watchdog contradiction: context-save in watchdog AND "supermemory solves compaction"
- Phase 1 replaced: **in-house Stop hook → sync-queue.jsonl**. Supermemory deferred to Phase 6 with evidence gate.

## The Ceiling Problem

SKILL.md tops out at ~8.5. Here is why:

- SKILL.md only runs when invoked — it cannot fire on session end, PostToolUse, or on a schedule
- It cannot persist routing outcomes across sessions without a hook writing to a file
- It cannot auto-sync learnings without a Stop hook or manual trigger

**Getting to 9.9 requires 2 hooks. Not for routing — for memory persistence.**

Routing stays SKILL.md-only. These hooks write to files. They do not change user-facing UX.

---

## Gap Analysis (7.5 → 9.9)

| Gap | Cost | Root cause |
|---|---|---|
| Memory is manual (vanta-sync must be invoked) | −1.0 | No Stop hook |
| Routing coverage ~40% (13/30 common actions) | −0.5 | Routing table too small; no miss-logging |
| No decision persistence (council output disappears) | −0.3 | No auto-log after /council |
| No cross-project knowledge (each project siloed) | −0.4 | No project registry; no codemap integration |
| Proactive surfacing is reactive, not proactive | −0.2 | No staleness detection; no pattern recognition |
| Routing is probabilistic — occasional misfires | −0.1 | No calibration loop |

Total gap: 2.5 points. All = 10.0. Target 9.9 = leave ~0.1 for probabilistic routing ceiling.

---

## Success SLOs (replaces "9.9/10 score")

| Metric | v2 (now) | v3 target |
|---|---|---|
| Route precision | ~13/30 known intents | ≥20/30 (20 canned smoke test) |
| Session-brief accuracy | N/A | Correct project/phase on ≥9/10 sessions |
| Sessions auto-saved | 0% | ≥60% of sessions with >5 tool calls |
| False-positive /council nudges | ~2/week | ≤1/week |
| Decision retrieval hit | 0% | ≥70% — "what did we decide about X" returns answer |

---

## Phase 1 — Auto-Memory via Stop Hook (~40 min)
**Score impact: 7.5 → 8.5 (+1.0) — highest leverage**

Build an in-house Stop hook. Same pattern as council-advisory.js. 30-50 lines Node.

### What it does

- Claude Code fires Stop hooks when a session ends
- Hook reads stdin JSON: `{ session_id, transcript_path, cwd, hook_event_name }`
- Counts tool calls in the transcript (proxy for meaningful session)
- If >5 tool calls: appends entry to `~/.vanta/sync-queue.jsonl`
- Vanta-run checks the queue at session start → offers to flush via vanta-sync

### Queue entry format

```json
{ "ts": "2026-04-30T12:00:00Z", "cwd": "/Users/vinamr/Projects/pi-perception", "session_id": "...", "tool_calls": 23, "synced": false }
```

### Session-start queue check (in vanta-run)

Bash block at top of state 2-3 (Resume):
```bash
_QUEUE=~/.vanta/sync-queue.jsonl
if [ -f "$_QUEUE" ]; then
  _UNSYNCED=$(grep -c '"synced":false' "$_QUEUE" 2>/dev/null || echo 0)
  [ "$_UNSYNCED" -gt 0 ] && echo "UNSYNCED_SESSIONS: $_UNSYNCED"
fi
```

If UNSYNCED_SESSIONS > 0, emit: "You have N sessions with unsaved learnings. Run /vanta-sync to capture them?"

### Why not supermemory (deferred to Phase 6)

Supermemory costs $19/mo and solves cross-project semantic search. At ~5 active projects, `rg` over local files is sufficient. Defer to evidence gate: if >5 failed local retrievals in 2 weeks OR >10 active projects, revisit.

### Files changed

| File | Change |
|---|---|
| `~/Projects/vanta/hooks/auto-sync.js` | Create — Stop hook source of truth |
| `~/.claude/hooks/auto-sync.js` | Deploy — copy of above |
| `~/.claude/settings.json` | Add Stop hook registration |
| `~/.claude/skills/vanta-run/SKILL.md` | Add sync-queue check at session start |
| `~/Projects/vanta/skills/vanta/SKILL.md` | Mirror |

---

## Phase 2 — Routing Expansion + Calibration (~2 hours)
**Score impact: 8.5 → 9.0 (+0.5)**

### Expand routing table from 13 → 25 routes

| Trigger keywords | Framework | Invocation |
|---|---|---|
| "refactor", "clean this up", "simplify" | gstack | `Skill("gstack")` context "run /review then refactor" |
| "document this", "write docs" | gstack | `Skill("gstack")` context "run /document-release" |
| "update deps", "bump packages" | gstack | `Skill("gstack")` context "run /health" |
| "open a PR", "create PR" | gstack | `Skill("gstack")` context "run /ship" |
| "review the PR", "look at this PR" | gstack | `Skill("gstack")` context "run /review" |
| "deploy to prod", "go live" | gstack | `Skill("gstack")` context "run /land-and-deploy" |
| "what should I do next", "what's next" | GSD | reads `.planning/` state, emits next step |
| "am I done", "is this complete" | GSD | `Skill("gsd-verifier")` |
| "save context", "checkpoint" | gstack | `Skill("gstack")` context "run /checkpoint" |
| "restore context", "where was I" | gstack | `Skill("gstack")` context "run /context-restore" |
| "retro", "what did we learn" | gstack + vanta | chains `Skill("gstack")` /retro → `Skill("vanta-sync")` |

### Routing miss logging

When no route matches, append to `~/.vanta/missed-intents.jsonl`:
```json
{ "ts": "...", "phrase": "make this faster", "fallthrough": "generic-intent" }
```

Surface monthly: top 5 missed intents → propose new routes.

### Files changed

| File | Change |
|---|---|
| `~/.claude/skills/vanta-run/SKILL.md` | +12 routes + miss logging |
| `~/Projects/vanta/skills/vanta/SKILL.md` | Mirror |

---

## Phase 3 — Decision & Context Persistence (~1.5 hours)
**Score impact: 9.0 → 9.3 (+0.3)**

### 3a. Auto-log council decisions

After `/council` completes, vanta-council auto-appends to `~/.gstack/projects/<slug>/decisions.md`:
```markdown
## 2026-04-30: Auth middleware refactor

**Decision:** JWT expiry extended to 7 days
**Alternatives considered:** Session tokens (rejected — stateful), refresh tokens (future)
**Codex:** PASS · **Gemini:** PASS with caveat (log rotation)
**Vinamr:** Accepted both, went with 7-day with audit log
```

### 3b. Session-start brief v2

Extend using-vanta session-start brief:
```
[Vanta] Active: pi-perception · Phase 2/4: Scanner · Last: /ship 18h ago
Decisions: JWT→7d (2d ago) · Scanner algo kept (1w ago)
Next: write tests for 12-dim calibration
Routes: ship this · review this · debug this · write tests · checkpoint
```

### Files changed

| File | Change |
|---|---|
| `~/.claude/skills/vanta-council/SKILL.md` | +decisions.md auto-log |
| `~/Projects/vanta/skills/council/SKILL.md` | Mirror |
| `~/Projects/vanta/skills/using-vanta/SKILL.md` | +decisions in brief |

---

## Phase 4 — codemap at Bootstrap (~1.5 hours)
**Score impact: 9.3 → 9.7 (+0.4)**

codemap (`/codemap`) builds `docs/CODEMAP/INDEX.json`: structured symbol/import/export graph. O(1) lookups instead of re-reading 200 files.

### At Bootstrap (state 1)

After gsd-new-project:
```
IF source files exist AND docs/CODEMAP/ does not exist:
  invoke Skill("codemap") to build initial index
  emit: "Codebase indexed. Use 'what does X do' to query without re-reading files."
```

### At Resume (states 2-3)

```
IF codemap exists AND recent commits since INDEX.json generated_at:
  suggest: "Codebase changed since last index. /codemap to refresh?"
```

### Files changed

| File | Change |
|---|---|
| `~/.claude/skills/vanta-run/SKILL.md` | +codemap at Bootstrap + refresh suggestion |
| `~/Projects/vanta/skills/vanta/SKILL.md` | Mirror |

---

## Phase 5 — Proactive Staleness + Pattern Intelligence (~1 hour)
**Score impact: 9.7 → 9.9 (+0.2)**

### 5a. Staleness detection in session-start brief

```bash
# Run at session start (silently)
git log --oneline -5          # last commit date
gh pr list --state open       # open PRs + age
~/.vanta/sync-queue.jsonl     # unsynced sessions
~/.vanta/missed-intents.jsonl # routing failures in last 7 days
```

Surface IF stale:
- "PR #47 open 5 days — /review or /ship?"
- "3 routing misses this week on 'optimize this' — add a route?"

### 5b. Pattern-based pre-flight

In vanta-run, before compound chains:
- Check routing-log.jsonl for prior failures on this chain
- If "resume and ship" failed 2+ times recently: "This chain failed twice last week. /council before proceeding?"

### Files changed

| File | Change |
|---|---|
| `~/Projects/vanta/skills/using-vanta/SKILL.md` | +staleness detection |

---

## Phase 6 — Semantic Recall (evidence gate) (~2 hours + $19/mo)

**Defer until:** >5 failed local retrievals in 2 weeks OR >10 active projects.

If the evidence gate triggers, revisit supermemory install. At that point the problem is real and the $19/mo buys genuine value.

---

## Implementation Order

1. **Phase 1 — Stop hook** (40 min) — local auto-memory, no dependencies
2. **Phase 3 — Decision persistence** (1.5h) — council auto-log, session brief v2
3. **Phase 2 — Routing expansion** (2h) — 25+ routes + miss logging
4. **Phase 4 — codemap at bootstrap** (1.5h) — only if repos are getting large
5. **Phase 5 — Staleness + patterns** (1h) — reads data phases 1-4 produce

Total: ~6.5 hours across sessions.

---

## What 9.9 Feels Like

**8:00am — New session on pi-perception**
```
[Vanta] Active: pi-perception · Phase 3/4: Calibration · Last: /ship 18h ago
Decisions: 12-dim kept (3d ago) · ES256 JWT (1w ago)
Unsynced: 2 sessions from yesterday — /vanta-sync to save?
Stale: PR #52 open 4 days — /review or /ship?
Routes: ship this · review this · debug this · write tests · checkpoint
```

**5:00pm — Session ends**
Stop hook fires. Appends to sync-queue. Next morning Vanta offers to flush. You didn't do anything.

**Next week — New project**
You ask "what do I know about Supabase JWT?" → rg over vinamr-invariants.md returns the answer in 200ms. No supermemory needed.
