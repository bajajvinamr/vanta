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

#### Gray-area decision matrix (council R1 P2 fix)

The binary "engineering vs product" rule has fuzzy cases. Concrete table
for the most common gray areas — Vanta uses this to decide whether to
proceed silently, mention briefly, or stop and ask:

| Situation | Silent | Mention | ASK |
|---|---|---|---|
| Refactor while fixing a bug (same file, behavior-preserving) | ✓ | | |
| Refactor while fixing a bug (different files / +5 min effort) | | ✓ | |
| Refactor that changes an exported API signature | | | ✓ |
| Update tests for a rename Vanta is doing | ✓ | | |
| Update tests because the behavior changed | | ✓ | |
| Add a new test file because coverage is missing | | ✓ | |
| Bump a dev dependency to fix the build | ✓ | | |
| Bump a runtime dependency (e.g. axios, prisma) | | | ✓ |
| Add a new dependency (any) | | | ✓ |
| Delete a file Vanta concluded is dead | | | ✓ |
| Delete a comment / log statement Vanta concluded is dead | ✓ | | |
| Change error messages users see | | | ✓ |
| Change internal error codes | ✓ | | |
| Change a billing/plan/permission default | | | ✓ |
| Change a UI string (anything user reads) | | | ✓ |
| Change a CLI flag default | | | ✓ |
| Migrate a database column | | | ✓ |
| Add a feature flag (default off) | | ✓ | |
| Flip a feature flag default | | | ✓ |

The boundary rule, when in doubt: **does this change something the
user, the user's customers, the database, or the deploy will see
differently?** If yes — ASK. If no — proceed (silent or mention).

Time-cost rule: any "engineering choice" that adds **>5 minutes** to
the current task elapsed time, OR delays the ship date, OR breaks an
external API boundary — ASK.

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
| **Catch-all / Uncertain** (council R1 P1, both-flagged) | "this looks weird", "what is going on", "make it work like X did", "something feels off" — anything that doesn't match the 8 above with high confidence | **ASK user** | NEVER guess on low confidence. Frame 2-3 candidate routes with one-line tradeoffs; let the user pick or describe the goal differently. |

### Catch-all UX

If detected_intent confidence is below the high-confidence bar, route
to the catch-all bucket. Vanta says:

```
[Vanta] I'm not sure what you want here. Did you mean:
A) <best guess based on prompt>
B) <second-best guess>
C) Something else — tell me in your own words

(I'd rather ask than guess wrong on something that matters.)
```

Hard rule: any catch-all interaction emits a route-quality telemetry
entry with `detected_intent: "uncertain"`. Soak report (§v3.8.2) flags
top causes of catch-all so the rule table grows from real data, not
guesses.

### Acceptance — `scripts/vanta-router-smoke.sh`

A new smoke gate that tests at least **40 real prompts** (was 30,
expanded to cover catch-all + re-route + stop). Must pass **≥36/40**.
Critical prompts must pass **100%**:

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
this looks weird            -> catch-all ASK (never guess)
what is going on            -> catch-all ASK
make it work like X did     -> catch-all ASK
something feels off         -> catch-all ASK
not that, I meant test it   -> mid-flight re-route to /qa
no, do review instead       -> mid-flight re-route to /review
undo that                   -> conversational undo
revert that                 -> conversational undo
stop                        -> stop intent (cancel + report)
wait, don't                 -> stop intent
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

**During work — short ops (<30s)** — only speak if:
- asking the user
- escalating to council
- blocked
- found a major issue
- changing plan

**During work — long ops (≥30s, council R1 P2 fix)** — silence reads as
crash to a non-engineer founder. Heartbeat every 20–30s in plain English:

```
[Vanta] Still working — Codex is reviewing the diff (~2 min total).
[Vanta] Codex done. Now running Gemini for the architecture pass (~2 min).
[Vanta] Both reviewers replied. Synthesizing findings now.
```

Heartbeats name *what* and *how long*, never internal machinery. No
"R1 P2 budget consumed", no "T2 peer route active". Just "still
working — Codex is reviewing the diff."

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

## v3.9.3 — Action-Object Model + Conversational Undo + Mid-Flight Re-Route

> **Sequencing fix per council R1 (both-flagged P1):** the action-object
> model is a prerequisite for inline preview, not parallel to it. You
> cannot safely preview prompt mutations without a structured way to
> log the original intent, log what was changed, and reverse it. This
> section ships before any inline behavior — formerly numbered v3.9.4,
> moved up.

### Goal

Three conversational behaviors that all need the same backbone:

1. **Undo** — "undo that", "revert that", "go back"
2. **Mid-flight re-route** — "not that, I meant test it" (Codex R1 P1)
3. **Stop** — "stop", "wait, don't"

All three need to know *what just happened* and *how to reverse it*
before any inline mode can be safe.

### Build the action-object model first

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
  inverse?: object;          // operation to undo this action
  affected_files?: string[];
  original_prompt?: string;
  rewritten_prompt?: string;
  detected_intent?: string;  // for re-route reclassification
  current_route?: string;    // for re-route halt
  project: string;
  session: string;
  ts: string;
}
```

This is the structured backbone for everything that follows. Trust math,
inline replacement, two-eyes escalation, memory promotion — all of them
need to know what happened and how to reverse it.

### Conversational undo

Inputs (extends safety floor):

- "undo that"
- "revert that"
- "no that's wrong"
- "go back"

If ambiguous:

```
[Vanta] Undo what?
A) Prompt rewrite
B) File edit
C) Memory update
```

If unambiguous:

```
[Vanta] Reverted the last prompt rewrite. Continuing with your
original prompt.
```

### Mid-flight re-route (council R1 P1, Codex)

Critical UX gap the rewrite missed: the user routed wrong, realizes
mid-execution, says "no, I meant X". This is **not** an undo (the
prior action wasn't necessarily wrong); it's a reclassification. Vanta
must:

1. Halt the current executor on the in-flight action
2. Reverse any partial side-effects via the action-object inverse
3. Pipe the original context into the new route — no restart, no
   "type your question again"

Inputs:

- "not that"
- "no, I meant <X>"
- "wait, actually <X>"
- "different thing — <X>"
- "not <current route>, do <X> instead"

UX:

```
User:  /vanta review this
Vanta: [Vanta] Reviewing the diff…
       (council fires)
User:  no, I meant test it
Vanta: [Vanta] Got it — switching to QA. Halting review, no changes
       yet. Writing tests for the same diff.
```

If the in-flight route already wrote files or sent prompts, Vanta
states the cleanup explicitly:

```
[Vanta] Halting review. I had already started a Codex review call —
that's queued, no charge. Switching to /qa for the same diff.
```

### Stop intent (cleanly named, separate from undo)

Inputs:

- "stop"
- "wait, don't"
- "pause"

Effect: cancel the in-flight action immediately. Don't ask for
clarification, don't undo prior actions, just halt and report state.

### Hard rule

**No real inline replacement (`rewriter.inline = "auto"`) until
conversational undo + re-route + stop are all reliable for at least
14 days of real usage across ≥3 sessions.**

### Acceptance

- 10 synthetic undo prompts route to the correct kind 100% of the time
- 10 synthetic re-route prompts halt the current action AND switch to
  the new route AND preserve original context, 100% of the time
- 5 synthetic stop prompts halt cleanly with state reported
- Ambiguous undos always ASK — never silently pick
- Mid-flight re-route NEVER discards a paid API call without telling
  the user it happened (cost transparency — see §Operations)
- 5 real-session undos succeed end-to-end (action reversed, state
  consistent, telemetry logged)

---

## v3.9.4 — Selective Inline Preview

> **Now safe to ship** because v3.9.3 ships the action-object model
> and the three reversal intents first. Without those, preview would
> have been a tease that the user couldn't recover from.

### Goal

Test whether inline rewriting is actually desired, without committing
to replacement.

### Strong pushback against earlier roadmap (preserved)

The earlier roadmap version proposed real inline replacement gated on
metric thresholds. **That's the wrong gate.** A non-engineer user may
not notice when Vanta subtly changes intent. That is dangerous.

Selective preview only. **No replacement until v3.9.7 burn-in shows
users actually want it AND the absolute-gate failures (§v3.9.7) are
all zero.**

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
- Each preview emits a v3.9.3 action-object so it's reversible if the
  user's next message is "undo that"

### Config

`~/.vanta/config.json`:

```json
{
  "rewriter": {
    "inline": "preview"   // "off" | "preview" | "auto" — never "auto" until v3.9.7 burn-in passes
  }
}
```

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

### What counts as a "real session"

Council R1 P1 — averages hide catastrophes. Define "real" precisely:

A session counts if all of:
- ≥1 prompt routed through `/vanta` (not just session-start brief)
- ≥10 minutes of active interaction
- Some concrete outcome attempted (a fix, a ship, a review, a test
  write — not just exploration)

Synthetic sessions don't count. Sessions that crashed within 30
seconds don't count. Sessions where Vanta was disabled don't count.

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

### "Did I save you thinking today?" (council R1 P4 fix)

The fifth product-bar criterion is qualitative; needs an explicit
measurement mechanic. At the end of every session that counts as
"real" per the definition above:

```
[Vanta] Quick check before you go: did I save you thinking today?
A) Yes
B) No
C) Partially — I helped with X but missed Y
```

Logged to `~/.vanta/burn-in.jsonl` as `saved_thinking: yes|no|partial`.

If the answer is **"no" across 10 consecutive sessions** — roll back
the v3.9 release. The router and UX rewrite were not solving the
problem the user has.

If the answer is **"partially" with a specific miss** — the miss
becomes a P1 follow-up before any further v3.9.x ships.

### Success criteria — averages

- User manually remembers commands in **<20%** of sessions
- Routing accuracy **>85%**
- Product-decision asks caught **>95%**
- Unnecessary council calls **<20%**
- "Saved me thinking" answer = "yes" or "partially" in **≥7/10**
  sessions

### Success criteria — absolute hard gates (council R1 P1, both-flagged)

Averages let one catastrophic session hide. These are zero-tolerance:

- **Zero unasked destructive actions** across all burn-in sessions.
  An unasked `rm -rf`, `git reset --hard`, `DROP TABLE`, `git push
  --force`, deploy, package install, secret rotation, or migration
  fails the entire burn-in regardless of average metrics.
- **Zero confident wrong-routes that wrote files or sent prompts.**
  A confident wrong-route caught in preview before any side-effect
  is annoying but recoverable; a confident wrong-route that already
  edited code or sent a council call is a trust violation.
- **Zero unrecoverable Vanta crashes.** A crash that loses session
  state, leaves the action-log inconsistent, or requires manual
  intervention to recover fails the gate.
- **Zero irreversible bad memory promotions.** A global invariant
  that lands in `vinamr-invariants.md` (not staging) and turns out
  to be wrong fails the gate. (Reversible promotions to staging
  are recoverable; promotions to main aren't.)

A single failure on any of the absolute gates above is a hard-stop.
Don't ship v3.9. Don't average it away. Find the root cause, fix it,
restart the 10-session burn-in.

---

## Operations & Trust Boundaries (council R1 P1, both-flagged)

The prior rewrite missed this entirely. A non-engineer founder cares
about: what data leaves my machine, what does this cost, what happens
if it crashes, what happens offline. The roadmap can't pretend these
don't exist.

### Privacy — what data leaves the machine

| Surface | Stays local | Sent to API |
|---|---|---|
| Prompt text | Yes (action-log, route-quality telemetry) | Sent to Codex/Gemini ONLY when council fires (T2 peer or T3 full council) |
| Diff content | Yes (read by hooks for risk classification) | Sent to Codex/Gemini ONLY when council fires |
| File paths and basenames | Yes | Names go to Codex/Gemini when council fires; absolute paths stay local |
| Session ID | Yes | Never sent |
| Action-log entries | Yes (`~/.vanta/`) | Never sent |
| Trust metrics | Yes | Never sent |
| Memory invariants | Yes (`~/.claude/rules/`) | Sent to Gemini via `@import` (Gemini reads vinamr-invariants.md as context) |
| Codex agent rules | Yes (`~/.codex/AGENTS.md`) | Sent to Codex on every Codex invocation |

Rule: **anything written to `~/.vanta/` stays local**. Anything in
`~/.claude/rules/` or `~/.codex/AGENTS.md` is read by other model
clients via standard import paths — that's the propagation mechanism,
not a leak.

What v3.9.0 must add: when a prompt is about to fire a council call,
the user sees what content will be sent in advance (one-line summary,
not full diff), with an option to redact:

```
[Vanta] About to send to Codex + Gemini for review:
  - The diff for hooks/prompt-rewriter.js (87 lines)
  - The PR description
  - The most recent council finding for context
Cost estimate: ~$0.15. Continue? Y/N/redact
```

### Cost — council calls aren't free

Every council call costs real money on the Anthropic / OpenAI / Google
APIs. v3.9.0 must:

- Estimate cost before firing each council call (token count × model
  rate; use a small lookup table updated quarterly)
- Show the estimate in the heartbeat update for any call >$0.05
- Log actual cost back to `~/.vanta/cost.jsonl` after each call
- Surface daily and monthly cost rollups in `vanta-status` (CLI binary,
  not a slash command)

If estimated session cost exceeds **$5**, ASK before continuing:

```
[Vanta] This session has cost ~$4.80 in council calls. Continue with
the full council on this next risk check (~$0.30 more)?
A) Yes
B) Use single-model peer instead (~$0.10)
C) Self-review only (no API cost)
```

### Crash recovery — what survives

Vanta's state lives in append-only JSONL files (`~/.vanta/*.jsonl`).
A crash mid-action means:

- Action-log entry may not have been written → the action effectively
  didn't happen from Vanta's POV (idempotent: re-running the same
  prompt produces the same Decision)
- File edits are committed by Claude Code, not Vanta — they survive
  crashes regardless
- In-flight council calls are lost (the API call may complete on the
  remote side, but Vanta doesn't see the result; user sees the cost
  on next session start with a "we may have been charged for this" note)

Recovery path: at session start, Vanta scans `~/.vanta/sync-queue.jsonl`
for entries with `synced: false` AND no terminal status, surfaces them
to the user:

```
[Vanta] Last session ended unexpectedly. The council call on
hooks/prompt-rewriter.js may have completed remotely (~$0.18 charged).
The diff is unchanged — pick up where you left off?
A) Yes
B) Re-run the council
C) Skip / abandon
```

### Offline — what works without internet

| Feature | Online | Offline |
|---|---|---|
| `/vanta <intent>` routing | ✓ | ✓ (all routing is local rule + classifier) |
| Self-review / T0/T1 actions | ✓ | ✓ |
| Council R1+R2 | ✓ | ✗ — degraded to self-review with explicit message |
| Memory write (project + global) | ✓ | ✓ (local files only) |
| Trust metrics | ✓ | ✓ |
| Inline preview / replace | ✓ | ✓ (rules are local) |

Offline message UX:

```
[Vanta] Offline — I can't run a full council right now. I'll do my
own review pass and flag anything I'd want a second opinion on. Run
again with internet later if needed.
```

Vanta NEVER blocks waiting for internet. Degrade gracefully.

---

## Sequencing summary

```
v3.8.2  Internal explain + soak + route-quality telemetry        [hidden from user]
   │
v3.9.0  Universal /vanta router (incl. catch-all + cost preview) [the product]
   │
v3.9.1  Calm UX response discipline (incl. heartbeats)           [response shape]
   │
v3.9.2  Actionable session brief                                  [brief shape]
   │
v3.9.3  Action-object model + conversational undo + re-route     [reversibility backbone]
   │
v3.9.4  Selective inline preview (now safe)                       [preview only]
   │
v3.9.5  Two-eyes escalation UX                                    [escalation language]
   │
v3.9.6  Memory UX                                                 [learning surface]
   │
v3.9.7  Real-world burn-in (10 sessions, 3 projects, absolute gates) [proof]
```

Critical sequence point per council R1: **v3.9.3 ships before v3.9.4**.
The action-object model is the prerequisite for safe inline behavior,
not parallel to it. Any preview without the action-object backbone is
a tease the user can't recover from.

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
