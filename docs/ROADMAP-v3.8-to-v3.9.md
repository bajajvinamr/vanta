# Vanta v3.9 Roadmap — The Router Release

> Vanta is not a developer tool for people who already know what to run.
> Vanta is a senior-engineer operating layer for a non-engineer founder.

This roadmap was rewritten from a UX-first perspective. The prior version
optimized for surface-impact discipline; that mattered for v3.7→v3.8
sprint hygiene, but it accidentally smuggled in engineer-thinking
about a product whose user is not an engineer. This version starts from
the user, not the architecture.

## North Star

The user should be able to type any of:

- "it broke"
- "fix this"
- "ship it"
- "is this good?"
- "continue"
- "what should I do next?"
- "make this better"
- "find issues"
- "don't mess this up"

…and Vanta should understand the intent, choose the correct workflow,
call the right tools/models, and explain only what matters.

The goal is not more commands. The goal is **less thinking about
commands**.

## UX Principles (the spec — every release tests against these)

### 1. Never make the user remember skill names

> Bad: "Use `/gsd-ship`, then `/review`, then maybe `/council`."
>
> Good: User types "ship it" → Vanta replies "I'll run the
> ship-readiness loop: tests, review, risk check. I'll ask before
> push/deploy."

The user should not care whether the underlying route is gstack, GSD,
superpowers, Codex, Gemini, `/review`, `/qa`, `/council`, or
`/vanta-sync`. **Vanta chooses.**

### 2. Speak in outcomes, not system internals

| Engineer-speak (bad) | Founder-speak (good) |
|---|---|
| "T2 peer route selected with 60s budget." | "This touches auth, so I'm getting a second opinion before changing it." |
| "inline_ready = true." | "Your last 60 Vanta actions in this repo were clean. I can start applying rewritten prompts automatically here, but you can keep preview mode." |
| "Council R1 found 2 P2s." | "Two reviewers flagged the same risk. I'll address it before continuing." |
| "Trust: undo 0.0% · interrupt 0.0% · chain 100%" | (Hidden by default. Shown only on `--explain`.) |

### 3. Ask only when the user owns the decision

| Vanta should NOT ask | Vanta SHOULD ask |
|---|---|
| Should I run tests? | Should this be a paid feature? |
| Should I inspect the logs? | Should we rename this concept? |
| Should I look at the diff? | Should this behavior change for users? |
| Should I ask Codex? | Should I deploy? |
| Should I write a failing test? | Should I run a destructive migration? |
| | Should I force-push? |
| | Should this be product A or product B? |

Engineering choices are Vanta's job. Product/strategy/destructive choices
are the user's.

### 4. One clear next action per message

The user should never read a wall of diagnostics and wonder what to do.

> Bad: 7 bullets of telemetry.
>
> Good: "Next: I recommend fixing the failing E2E suite before more
> feature work."

### 5. Confidence, not arrogance

If Vanta is guessing, it should say so:

> "I'm not sure if this is a bug or product decision. I'll inspect
> first, then ask before changing behavior."

Not:

> "Proceeding."

---

## What v3.9 IS NOT (rejected ideas, council-confirmed)

| Idea | Rejected because |
|---|---|
| Inline auto-replacement | Too risky before router quality is proven. A non-engineer user may not notice when Vanta subtly changes intent. **Selective preview only**, never replacement, until conversational undo is rock-solid. |
| Dashboard / `/vanta-status` | The user does not need another dashboard. The session brief is the dashboard. |
| More slash commands | Route through `/vanta`. Period. Adding `/vanta-status`, `/vanta-trust`, `/vanta-health` etc. sets the precedent that loses the product. |
| Per-project hook overrides | Surface explosion — every project would have its own rule set. |
| LLM fallback for every rewrite | Cost and latency unclear. Use rules + telemetry first. |
| Team mode | Single-user is the product advantage. |
| Threshold-based auto-flip to inline | Math clearing thresholds ≠ user wants this on. Always opt-in, per-project, with conversational undo proven. |

---

## Status snapshot

| Tag | Date | Shipped | Surface |
|---|---|---|---|
| v3.8.0 | 2026-05-02 | Central executor, project-scoped trust, monorepo slug correctness, council R1+R2+R3 fixes | None new |
| v3.8.1 | 2026-05-02 | Silent-require warning, explicit trust-cache invalidation on undo, monorepo + reader/writer slug regression tests | None new |
| **v3.8.2** | _planned_ | Internal explain + soak + route-quality telemetry. **Hidden from user.** | None new |
| **v3.9.0** | _design_ | **The router**: `/vanta <anything>` | One command flexes; all others routed |
| **v3.9.1** | _design_ | Calm UX response discipline | None new |
| **v3.9.2** | _design_ | Actionable session brief | None new |
| **v3.9.3** | _design_ | Selective inline preview | One config flag, default "preview" |
| **v3.9.4** | _design_ | Conversational undo foundation | "undo that" / "revert that" routed |
| **v3.9.5** | _design_ | Two-eyes escalation UX | None new |
| **v3.9.6** | _design_ | Memory UX | None new |
| **v3.9.7** | _design_ | Real-world burn-in (10 sessions) | None new |

The whole arc: **one command added (`/vanta` flexes), one config flag**.
Every other "feature" is routing or response discipline.

---

## v3.8.2 — Internal Observability (Hidden From User)

### Goal

Give the builder enough observability to improve routing without
exposing a dashboard to the user.

### Ship

**1. Decision explain mode** — `vanta-executor --explain "fix this"`.
For debugging, not normal UX. Shows interpreted intent, route chosen,
risk reason, whether second opinion is needed, whether user confirmation
is needed.

**2. Soak report** — `tools/vanta-soak-report.js`. Builder reads it
weekly to answer:
- Which prompts failed to route?
- Which routes were ignored?
- Which suggestions did the user override?
- Which prompts caused "undo that"?
- Which routes were overused?
- Which risky work skipped second review?

**3. Route-quality telemetry** — schema:

```json
{
  "prompt": "fix this",
  "detected_intent": "fix-bug",
  "suggested_route": "/investigate",
  "user_followed_route": true,
  "user_ignored_route": false,
  "user_used_different_command": null,
  "later_undo": false,
  "later_manual_correction": false,
  "project": "founderos",
  "ts": "2026-05-09T14:22:00Z"
}
```

This is the data that feeds v3.9.0's router-quality smoke test.
Without it, we are guessing whether the router actually helps.

### Acceptance

- `--explain` answers "why did Vanta route there?" in <2 seconds
- Soak report surfaces top 5 routing misses + top 5 ignored suggestions
- Route-quality telemetry written to `~/.vanta/route-quality.jsonl`
  on every prompt that hits the executor
- **Zero new user-facing commands. Zero added session-start noise.**

---

## v3.9.0 — Universal `/vanta` Router

### Goal

The user should only need one command:

```text
/vanta <what I want>
```

Vanta routes the rest. This is the product.

### UX shape

```
User: /vanta fix this
Vanta: [Vanta] I'll investigate the failure, reproduce it, fix the
       smallest root cause, and run targeted tests.

User: /vanta ship it
Vanta: [Vanta] I'll run ship-readiness: tests, typecheck, diff review,
       risk scan. I'll ask before push/deploy.

User: /vanta should we rename tier to plan_level?
Vanta: [Vanta] This is a product/taxonomy decision. I'll outline
       tradeoffs, but you decide before I change code.
```

### Supported intents

| Intent | Inputs (examples) | Routes to | Behavior |
|---|---|---|---|
| **Fix / debug** | "fix this", "it broke", "it didn't work", "debug this", "why is this failing?" | `/investigate` | inspect → reproduce → root cause → targeted test → smallest fix → verify |
| **Ship** | "ship it", "ready to merge?", "can this go?", "release this" | `/ship` or ship-readiness workflow | tests → typecheck → lint → diff review → risk scan → council if high-risk → ASK before push/deploy |
| **Review** | "review this", "is this good?", "check my work", "audit this diff" | `/review` | inspect diff → find bugs → check tests → check security/auth/data risks → suggest fixes |
| **QA / tests** | "write tests", "add tests", "test this", "what tests are missing?" | `/qa` | inspect behavior → identify critical invariants → write high-signal tests → avoid shallow coverage chasing |
| **Gaps / audit** | "find gaps", "what's missing?", "go deeper", "audit this", "think harder" | Codex first OR `/council` if high-risk | Codex for code audit; Gemini for architecture/product breadth; full council for auth/security/architecture/product-risk |
| **Continue** | "continue", "what next?", "where were we?", "resume from last time" | project state + last PR + todo memory | read recent state → summarize last work → identify next best action → continue safely |
| **Sync / learn** | "remember this", "sync learnings", "what did we learn?", "update memory" | `/vanta-sync` | extract durable learnings → split project-specific vs global → ASK before promoting questionable memory |
| **Product decision** | "should we rename…", "should we price…", "should we pivot…", "should this feature…", "change onboarding copy…" | **ASK user** | frame options → explain tradeoffs → do not modify code until user decides |

### Acceptance — `scripts/vanta-router-smoke.sh`

A new smoke gate that tests at least **30 real prompts**. Must pass
**≥27/30**. Critical prompts must pass **100%**:

```text
fix this                    -> investigate
it didn't work              -> investigate
ship it                     -> ship-readiness
review this                 -> review
write tests                 -> qa
find gaps                   -> audit/council
continue from last time     -> resume
what next                   -> resume / recommend next
sync learnings              -> vanta-sync
rename tier to plan_level   -> product decision ASK
should we pivot pricing     -> product decision ASK
deploy this                 -> ASK before deploy
force push this             -> BLOCK / ASK
```

### Product metric (matters more than tests)

After v3.9.0 ships, track in route-quality telemetry:

> **How many sessions required the user to manually remember a
> non-Vanta command?**

Targets:
- <20% after 1 week
- <10% after 1 month

This is the v3.9 success metric. Not inline mode. Not trust math. Not
test count.

---

## v3.9.1 — UX Response Discipline

### Goal

Make Vanta feel calm, clear, and useful.

### Default response format

**At the start:**

```
[Vanta] I'll <action>. <Why or guardrail in one sentence>.
```

Examples:

> [Vanta] I'll investigate the failure and run the smallest relevant
> tests. I'll ask before changing product behavior.

> [Vanta] This looks like a product naming decision. I'll outline
> tradeoffs, then you choose.

> [Vanta] I'll run ship-readiness. I'll ask before push or deploy.

**During work** — only speak if:
- asking the user
- escalating to council
- blocked
- found a major issue
- changing plan

**At end:**

```
[Vanta done] <what was done>, verified with <how>. Next: <one action>.
```

### Banned in normal UX (move to `--explain`)

- Raw tier labels (T0/T1/T2/T3) unless useful
- Budget numbers (e.g. "60s budget")
- Trust percentages
- Route distribution
- Long telemetry
- Internal cache details
- Huge decision trees

### Acceptance

- 100% of Vanta replies in router-smoke fit the start format
- Zero replies contain the banned items unless `--explain` was passed
- Manual review: 10 real session starts feel "calm" not "noisy"

---

## v3.9.2 — Actionable Session Brief

### Goal

The session-start brief should not become a dashboard. It should answer:
**what should I know right now?**

### Good brief

```
[Vanta] FounderOS · last: onboarding atomicity merged · next: fix E2E #7
Pending: 2 staged learnings · PRs clean · no blockers
```

### Bad brief

```
Trust: undo 0.0% · interrupt 0.0% · chain 100% · routes 47 · span 14d · inline yes
```

### Rule

**Show status only if actionable.**

| Show when… | Hide always |
|---|---|
| open PR needs attention | metrics with no action |
| failing CI | route distributions |
| staged memories pending review | raw trust math |
| council shadow pending | cache state |
| next recommended task is clear | model jargon |
| inline preview eligible (first time) | telemetry counters |
| repo is in paused/safe mode | |

### Acceptance

- Brief is ≤4 lines in calm state
- Brief grows only when there is a concrete action the user can take
- 10 real session starts: each line either prompts an action or
  reports a state-change worth knowing

---

## v3.9.3 — Selective Inline Preview

### Goal

Test whether inline rewriting is actually desired, without committing
to replacement.

### Strong pushback against earlier roadmap

The prior version proposed real inline replacement gated on metric
thresholds. **That's the wrong gate.** A non-engineer user may not
notice when Vanta subtly changes intent. That is dangerous.

Selective preview only. **No replacement until v3.9.4 ships
conversational undo and v3.9.7 burn-in shows users actually want it.**

### Preview only when ALL true

- Prompt is action-like ("fix", "ship", "review", etc. — not "what")
- Rewrite confidence is high
- Rewrite materially improves the prompt (not cosmetic)
- Not a product decision
- Not a simple yes/no/show/list prompt

### UX

```
[Vanta preview] I would treat "fix this" as: investigate failure →
reproduce → smallest fix → targeted tests.
```

Do not show this on every prompt.

### Acceptance

- Preview appears for weak action prompts (e.g. "fix this" without context)
- Preview does NOT appear for simple informational prompts ("what is this file?")
- User can say "use that style" or "don't rewrite this" → both routed correctly
- Preview outcomes logged to route-quality telemetry

### Config

`~/.vanta/config.json`:

```json
{
  "rewriter": {
    "inline": "preview"   // "off" | "preview" | "auto" — never "auto" until §3.9.4 ships
  }
}
```

---

## v3.9.4 — Conversational Undo Foundation

### Goal

Before any real inline replacement or deeper auto-execution, "undo
that" must be safe.

### Build the action-object model

Every reversible Vanta action logs:

```typescript
interface VantaAction {
  id: string;
  kind:
    | "prompt_rewrite"
    | "route_decision"
    | "file_edit"
    | "command"
    | "memory_promotion";
  reversible: boolean;
  inverse?: object;  // operation to undo this action
  affected_files?: string[];
  original_prompt?: string;
  rewritten_prompt?: string;
  project: string;
  session: string;
  ts: string;
}
```

This is the structured backbone for everything that follows. Trust math,
inline replacement, two-eyes escalation, memory promotion — all of them
need to know what happened and how to reverse it.

### Conversational undo

Inputs that trigger undo intent (extends safety floor):

- "undo that"
- "revert that"
- "no that's wrong"
- "go back"
- "stop, that's not what I meant"

If ambiguous:

```
[Vanta] Undo what: the prompt rewrite, the file edit, or the memory update?
A) Prompt rewrite
B) File edit
C) Memory update
```

If unambiguous:

```
[Vanta] Reverted the last prompt rewrite. Continuing with your
original prompt.
```

### Hard rule

**No real inline replacement (`rewriter.inline = "auto"`) until
conversational undo is reliable for at least 14 days of real usage
across ≥3 sessions.**

### Acceptance

- 10 synthetic undo prompts route to the correct kind 100% of the time
- Ambiguous undos always ASK — never silently pick
- 5 real-session undos succeed end-to-end (action reversed, state
  consistent, telemetry logged)

---

## v3.9.5 — Two-Eyes UX

### Goal

Make second-opinion escalation feel natural, not mechanical.

### Bad UX

> T3 council triggered.

### Good UX

> [Vanta] This touches auth and review gates, so I'm getting a second
> opinion before changing it.

### UX states

| State | Internal | User-facing |
|---|---|---|
| Self-check | T0/T1 | "Low-risk change. I'll self-review before finishing." |
| One peer | T2 | "Medium-risk change. I'm asking Codex for a second pass." |
| Full council | T3 | "High-risk change. I'm asking Codex + Gemini before making the call." |

### Acceptance

- User understands WHY escalation happened (one sentence)
- No model jargon unless useful
- No long council report by default — only findings
- Disagreements between Codex and Gemini summarized as choices, not
  as a debate transcript

---

## v3.9.6 — Memory UX

### Goal

Make learning feel like "Vanta got smarter," not like memory bureaucracy.

### After meaningful session

```
[Vanta learned] 2 project gotchas saved, 1 global rule staged for approval.
```

If approval needed:

```
[Vanta] Should this become a global rule across all your projects?
A) Yes, remember across projects
B) No, keep it FounderOS-only
C) Discard
```

### Rules

- **Project memory** — mostly automatic; high confidence things land
  silently in project CLAUDE.md
- **Global memory** — requires higher confidence; staging path with
  explicit user approval (already exists; surface it better)
- **Product decisions** — remembered as decisions ("we decided X
  on date Y"), not as universal truths
- **Stale / version-bound facts** — marked with version + date so
  future-Claude knows when to re-verify

### Acceptance

- User sees what Vanta learned at the end of every meaningful session
- No silent global pollution (≥1 global rule promoted in 10 sessions
  without surfacing)
- Future sessions actually use the memory (verified via telemetry:
  invariant matches the situation, behavior reflects it)
- User can reject bad memory in one keystroke

---

## v3.9.7 — Real-World UX Burn-In

### Goal

Use Vanta in real work before adding more machinery.

**Run Vanta across at least 10 real sessions** spanning at least 3
projects (vanta itself, founderos, little-wins or pi-perception).

### Track per session

1. Did the user need to remember another command?
2. Did Vanta route correctly?
3. Did Vanta ask at the right time?
4. Did Vanta over-explain?
5. Did Vanta under-explain?
6. Did memory help?
7. Did memory hurt?
8. Did council fire too often?
9. Did the user say "undo" / "stop"?
10. Did the session end closer to ship?

Capture in `~/.vanta/burn-in.jsonl`. Inspect after every session.

### Success criteria

Vanta v3.9 ships when:

- User manually remembers commands in **<20%** of sessions
- Routing accuracy **>85%**
- Product-decision asks caught **>95%**
- Unnecessary council calls **<20%**
- User says **"this saved me thinking"** at least once

That last one matters. The first four are the engineering bar; the
fifth is the product bar.

---

## Sequencing summary

```
v3.8.2  Internal explain + soak + route-quality telemetry        [hidden from user]
   │
v3.9.0  Universal /vanta router                                   [the product]
   │
v3.9.1  Calm UX response discipline                               [response shape]
   │
v3.9.2  Actionable session brief                                  [brief shape]
   │
v3.9.3  Selective inline preview                                  [preview only, never replace]
   │
v3.9.4  Conversational undo foundation                            [action-object model + intent]
   │
v3.9.5  Two-eyes escalation UX                                    [escalation language]
   │
v3.9.6  Memory UX                                                 [learning surface]
   │
v3.9.7  Real-world burn-in (10 sessions, 3 projects)              [proof]
```

---

## The real v3.9 promise

After v3.9, the user should be able to type:

```
/vanta fix this
```

…and trust that Vanta knows whether that means:

- investigate,
- write tests,
- ask Codex,
- call council,
- check memory,
- continue prior plan,
- or stop and ask for a product decision.

**That is the product.**

Not inline mode.
Not trust math.
Not metrics.
Not dashboards.

The product is:

> "I don't know the right engineering workflow. Vanta does."
