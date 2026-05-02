# Vanta v3.9 — The Operator Release

> The non-engineer founder does not want autonomy first.
> They want **competent initiative with reversibility**.

This roadmap was rewritten twice. The first version was engineer-thinking
about engineer-tools. The second tried to fix that by leading with
"Universal /vanta Router" — but a router is not a product, it's an
organ. The product is the whole operator loop: **understand → inspect →
decide → act → verify → explain → remember**.

A clever classifier that confidently routes wrong is worse than no
classifier — because the user trusted it and now can't recover. That's
the moment trust dies. So the v3.9 sequencing has changed: the
reversibility backbone (stop, undo, re-route, action-object model)
ships in **v3.9.0**, before any router expansion.

---

## Promise

The user types a vague goal:

```
fix this
ship it
this looks weird
should we rename tier to plan_level?
continue
```

Vanta turns that into a **safe engineering outcome**.

Not a command. Not a dashboard. Not a classifier. An outcome.

---

## The Loop

Every Vanta interaction follows this 8-step loop. Every release in v3.9
hardens one or more steps; nothing ships without all eight working
end-to-end.

1. **Understand** the intent (router + catch-all + ambient mode)
2. **Inspect** repo/session state (read before guessing)
3. **Choose** route (rule + outcome label, not implementation name)
4. **Act** if safe (engineering decisions = silent or mention)
5. **Ask** if a boundary is crossed (product / destructive / money / privacy / unclear-after-inspect)
6. **Verify** the work landed
7. **Report** with one clear next action and an explicit confidence state
8. **Learn** what's worth remembering (project automatic, global gated)

---

## The hardest product truth

The non-engineer user does **not** want autonomy first.

The trust ladder is:

```
1. Can I stop it?
2. Can I undo it?
3. Does it know what I mean?
4. Does it ask only when I should decide?
5. Does it verify its work?
6. Does it remember?
7. Can it become more automatic later?
```

Every prior version of this roadmap put step 3 ("does it know what I
mean?") first. That's close, but unsafe. **Reversibility (steps 1+2)
must ship first.** Otherwise the first time Vanta confidently does the
wrong thing, the user has no clean way back, and the entire product is
dead.

---

## UX Principles

### 1. Never make the user remember skill names

> Bad: "Use `/gsd-ship`, then `/review`, then maybe `/council`."
>
> Good: User types "ship it" → Vanta replies "I'll run the
> ship-readiness loop: tests, review, risk check. I'll ask before
> push/deploy."

### 2. Speak in outcomes, not internals

| Engineer-speak (bad) | Founder-speak (good) |
|---|---|
| "Routing to /investigate, T2 peer." | "I'll diagnose the failure first." |
| "T3 council triggered." | "This touches auth, so I'm getting a second opinion." |
| "inline_ready = true." | "Your last 60 actions in this repo were clean. I can apply rewrites automatically here, or keep showing previews." |
| "Council R1 found 2 P2s." | "Two reviewers flagged the same risk. I'll address it first." |
| "Trust: undo 0.0% · interrupt 0.0% · chain 100%" | (Hidden by default. Shown only on `--explain`.) |

### 3. Outcome-language route names

Even the route names shown to the user must be outcomes, not
implementations. Internally the router targets `/qa`; externally Vanta
says "I'll write the right tests."

| Internal route | User-facing label |
|---|---|
| `/investigate` | Diagnose |
| `/qa` | Test |
| `/review` | Review |
| `/ship` | Ship-check |
| `/council` | Get a second opinion |
| `/vanta-sync` | Remember |
| (resume context) | Resume |
| (product-decision ASK) | Ask decision |
| (catch-all ASK) | Clarify |

### 4. One clear next action per message

Every reply ends with a single concrete next action. Never a wall of
diagnostics with no direction.

### 5. Confidence, not arrogance

If Vanta is guessing, it says so. If Vanta is sure, it says so. The
two states are visibly different — see "Done means done" below.

### 6. Conversational config, not JSON edits

A non-engineer does not edit `~/.vanta/config.json`. The config exists
internally; user-facing controls are conversational:

> [Vanta] Keep showing rewrite previews?
> A) Yes
> B) Less often (only on weak prompts)
> C) Turn off for this repo

Vanta writes the config based on the answer. No file editing required,
ever, by the user.

---

## Decision Boundaries — when to ASK

The single most important behavioral spec. Vanta's competence is judged
by whether it asks at the right moments.

### Vanta ASKS for…

| Boundary | Examples |
|---|---|
| **Product decisions** | "Should we rename tier to plan_level?", "Should this be a paid feature?", "Should we pivot pricing?" |
| **User-visible behavior** | Error message changes, UI string changes, copy changes, default flag flips |
| **Pricing / billing / permissions** | Plan tier changes, role changes, feature-flag default changes |
| **Destructive operations** | Force-push, `rm -rf`, `git reset --hard`, drop migrations, secret rotation |
| **Deployments** | Any push to a deploy environment |
| **Runtime dependency changes** | Adding/removing/upgrading runtime deps (axios, prisma, etc.); dev-deps don't ask |
| **Money** | See money matrix below |
| **Privacy** | See privacy policy below |
| **Unclear after inspection** | Catch-all kicks in only after Vanta has read the relevant context — see catch-all UX in v3.9.1 |

### Vanta does NOT ask for…

- Running tests
- Reading logs
- Inspecting diffs
- Asking Codex (under policy budget)
- Writing a failing test
- Behavior-preserving refactors in the same file
- Local dependency bumps to fix a build (dev-deps only)
- Killing a stuck local process
- Anything reversible and small

### Engineering vs product gray-area matrix

| Situation | Silent | Mention | ASK |
|---|---|---|---|
| Refactor while fixing a bug (same file, behavior-preserving) | ✓ | | |
| Refactor while fixing a bug (different files / +5 min effort) | | ✓ | |
| Refactor that changes an exported API signature | | | ✓ |
| Update tests for a rename Vanta is doing | ✓ | | |
| Update tests because the behavior changed | | ✓ | |
| Add a new test file because coverage is missing | | ✓ | |
| Bump a dev dependency to fix the build | ✓ | | |
| Bump a runtime dependency (axios, prisma, etc.) | | | ✓ |
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

**Boundary rule when in doubt:** does this change something the user,
the user's customers, the database, or the deploy will see differently?
Yes → ASK. No → proceed.

**Time-cost rule:** any "engineering choice" that adds **>5 minutes** to
the current task elapsed time, OR delays the ship date, OR breaks an
external API boundary → ASK.

### Money matrix

Per-call cost (council API spend):

| Per-call estimate | Behavior |
|---|---|
| < $0.05 | Silent — proceed |
| $0.05 – $0.50 | Mention briefly ("running second opinion, ~$0.18") |
| > $0.50 | ASK before firing |

Cumulative session cost:

| Session running total | Behavior |
|---|---|
| < $1.00 | Silent |
| $1.00 – $5.00 | Mention at session end |
| > $5.00 | ASK to continue ("This session has cost ~$5.20. Continue with full council on the next risk check?") |

Daily / monthly rollups available via `vanta-status` CLI binary (not a
slash command). Cost log written to `~/.vanta/cost.jsonl` per call.

### Privacy / diff-sharing policy

Set ONCE per repo on first council fire, then enforced silently:

```
[Vanta] First time I'd send code from this repo to Codex/Gemini for a
second opinion. What's your policy for FounderOS?

A) Yes, send diffs when risk is high — under $0.50 per call
B) Yes, send diffs but ask each time
C) No, never send diffs from this repo (self-review only)
```

Stored at `~/.vanta/repos/<slug>/policy.json`. Vanta NEVER asks twice
for the same repo unless the cost ceiling is exceeded. A non-engineer
wants guardrails, not repeated consent dialogs.

---

## Done means done — confidence states

Every Vanta flow ends with one of four explicit states. Without this,
the user still has to judge engineering completeness, which defeats the
whole point.

| State | Meaning | Example |
|---|---|---|
| `[Vanta done]` | Done and verified. Tests pass, behavior matches intent, no known caveats. | "Fixed auth redirect, verified with 3 tests. Next: merge PR #12." |
| `[Vanta likely done]` | Done with caveats. Verified locally but a downstream check (E2E, CI, manual UX review) is still pending or red. | "Fixed the routing bug; unit tests green. E2E suite is still red but unrelated — next: investigate E2E #7 separately." |
| `[Vanta blocked]` | Cannot finish without a decision the user owns. | "Stopped before changing pricing logic. Need your call: should `tier` rename to `plan_level` across the schema?" |
| `[Vanta risky]` | Tests pass but the change touches a high-risk surface (auth, payments, migrations) that needs second review. | "Tests pass on the auth refactor, but this changes session storage. Next: get Codex + Gemini second opinion before merging." |

### `[Vanta done]` requires verification evidence (council R1 P1, both-flagged)

The prior version's `[Vanta done]` was a claim, not a proof. A user
reading "verified with 3 tests" has no way to check that those 3 tests
actually exist, ran, and passed. New rule: **`[Vanta done]` is only
allowed when Vanta produced verification evidence; otherwise, default
to `[Vanta likely done]`.**

```typescript
// Behavioral proof — exercises the actual behavior the user asked
// Vanta to deliver. At least one of these is REQUIRED for [Vanta done].
type BehavioralEvidence =
  | { kind: "test_run";   command: string; exit_code: 0; output_snippet: string; ts: string }
  | { kind: "ci_status";  url: string; status: "passed"; ts: string }
  | { kind: "smoke";      script: string; pass_count: number; total: number; ts: string }
  | { kind: "manual_verify"; what_user_confirmed: string; ts: string };  // user said "yes that works"

// Supplemental proof — proves something happened (change exists, code
// compiles, types check) but does NOT prove behavior correctness. May
// accompany behavioral evidence; CANNOT stand alone for [Vanta done].
type SupplementalEvidence =
  | { kind: "build";      command: string; exit_code: 0; ts: string }
  | { kind: "typecheck";  command: string; exit_code: 0; ts: string }
  | { kind: "lint";       command: string; exit_code: 0; ts: string }
  | { kind: "diff_hash";  before_sha: string; after_sha: string; ts: string };

type VerificationEvidence = BehavioralEvidence | SupplementalEvidence;
```

Hard rules (council R2 P1, Codex):

- `[Vanta done]` → action-object MUST carry ≥1 `BehavioralEvidence`
  entry whose evidence is **intent-linked** (the test/CI/smoke/user-verify
  exercises the behavior the user asked Vanta to fix or ship). A
  build-passes or types-check is NOT enough; those prove the change
  compiled, not that it works.
- `[Vanta likely done]` → evidence may exist, but at least one expected
  evidence is missing or red (e.g. unit tests pass, E2E missing/red)
- `[Vanta blocked]` → no evidence required; user owns the decision
- `[Vanta risky]` → evidence may exist, but the change surface needs
  external review before claiming `done`

The user-facing message includes the proof:

```
[Vanta done] Fixed auth redirect, verified with `npm test -- auth.spec`
(3/3 passing, exit 0). Next: merge PR #12.
```

vs.

```
[Vanta likely done] Fixed the routing bug. Unit tests pass
(`npm test -- routing.spec`, 4/4). E2E suite is still red but
unrelated — investigate E2E #7 separately.
```

If the user asks "was it actually verified?", Vanta dumps the relevant
`VerificationEvidence` entries from the action-log.

These states are first-class in the action-object model (v3.9.0); every
session-end action-object carries a `confidence_state` field, which is
used by the brief (v3.9.5) and by the burn-in measurement (v3.9.8).

---

## What v3.9 IS NOT (rejected ideas)

| Idea | Rejected because |
|---|---|
| Inline auto-replacement | Too risky before the operator loop is proven. Selective preview only, never replacement. |
| Dashboard / `/vanta-status` | The user does not need another dashboard. The session brief is the dashboard. |
| More slash commands | Route through `/vanta`. Adding `/vanta-status`, `/vanta-trust`, `/vanta-health` etc. sets the precedent that loses the product. |
| Per-project hook overrides | Surface explosion. |
| LLM fallback for every rewrite | Cost and latency unclear. Use rules + telemetry first. |
| Team mode | Single-user is the product advantage. |
| Threshold-based auto-flip to inline | Math clearing thresholds ≠ user wants this on. Always opt-in, per-project. |
| User-facing config flags | Conversational config only. JSON files are implementation. |
| Per-call privacy/cost prompts | Repo-level policy set once; only ask when policy ceiling exceeded. |
| "Saved me thinking?" prompt every session | Annoying cadence. Sparing only — see v3.9.8. |

---

## Status snapshot

| Tag | Date | Shipped | Surface |
|---|---|---|---|
| v3.8.0 | 2026-05-02 | Central executor, project-scoped trust, monorepo slug correctness | None new |
| v3.8.1 | 2026-05-02 | Silent-require warning, explicit trust-cache invalidation on undo, monorepo + reader/writer slug regression tests | None new |
| **v3.8.2** | _planned_ | Internal explain + soak + route-quality telemetry | None new (hidden from user) |
| **v3.9.0** | _design_ | **Reversibility foundation** — action-object model + stop + undo + mid-flight re-route | Three new conversational intents (no slash commands) |
| **v3.9.1** | _design_ | Universal /vanta router + ambient mode + outcome route labels | One command flexes; ambient mode adds zero surface |
| **v3.9.2** | _design_ | Calm operator UX (response shape, heartbeats, "Done means done" state) | None new |
| **v3.9.3** | _design_ | Decision boundaries (ASK matrix as code) | None new |
| **v3.9.4** | _design_ | Two-eyes UX + repo-level cost/privacy policy | None new |
| **v3.9.5** | _design_ | Actionable session brief | None new |
| **v3.9.6** | _design_ | Memory UX (project automatic, global gated, conversational) | None new |
| **v3.9.7** | _design_ | Selective inline preview (gated on v3.9.0 reversibility) | One internal config flag, conversational control |
| **v3.9.8** | _design_ | Real-world burn-in: 10 sessions, 3 projects, absolute zero-tolerance gates | None new |

The whole arc: **one command flexes (`/vanta`), zero memorized commands
added**. Three new conversational intents (stop / undo / re-route)
extend an existing intent surface — they're not memorized commands.

---

## v3.8.2 — Internal Observability (Hidden From User)

### Goal

Give the builder enough observability to improve routing without
exposing a dashboard to the user.

### Ship

- **Decision explain mode** — `vanta-executor --explain "fix this"`. For
  debugging. Shows interpreted intent, route chosen, risk reason,
  confidence, top-1 vs top-2 margin.
- **Soak report** — `tools/vanta-soak-report.js`. Builder reads weekly.
  Surfaces top routing misses, ignored suggestions, undo causes.
- **Route-quality telemetry** — JSONL at `~/.vanta/route-quality.jsonl`:

```json
{
  "prompt": "fix this",
  "detected_intent": "fix-bug",
  "confidence": 0.78,
  "top1_top2_margin": 0.31,
  "suggested_route": "/investigate",
  "user_followed_route": true,
  "user_used_different_command": null,
  "later_undo": false,
  "later_manual_correction": false,
  "session_ended_state": "done",
  "project": "founderos",
  "ts": "2026-05-09T14:22:00Z"
}
```

- **Manual command recall tracking** — every session, count whether the
  user manually invoked a non-`/vanta` command (gstack, GSD,
  superpowers, raw bash). This is the v3.9 success metric.

### Acceptance

- `--explain` answers "why did Vanta route there?" in <2 seconds
- Soak report surfaces top 5 routing misses + top 5 ignored suggestions
- Route-quality telemetry written on every prompt that hits the executor
- Zero new user-facing commands, zero session-start noise

---

## v3.9.0 — Reversibility Foundation (ships BEFORE the router)

> **Why this is v3.9.0 and not v3.9.3:** the router is unsafe without
> reversibility. A confident wrong action that the user can't cleanly
> undo is the moment trust dies. The action-object model + stop + undo
> + re-route is the prerequisite for shipping any expansion of router
> ambition, not a follow-up.

### Goal

Three conversational intents that all share the same backbone:

1. **Stop** — "stop", "wait, don't", "pause"
2. **Undo** — "undo that", "revert that", "no that's wrong", "go back"
3. **Mid-flight re-route** — "not that", "no, I meant <X>", "wait,
   actually <X>"

Plus the `VantaAction` schema that makes all three reliable, plus
crash-recovery and cancellation-state tracking.

### Build the action-object model first

> **Council R1 P1 (both-flagged):** the prior schema's `inverse: object`
> was too vague to safely undo `file_edit`, `memory_promotion`, or
> partial commands. Reversal needs typed per-kind fields, not a freeform
> object. Below is the strengthened schema.

```typescript
type LifecycleState =
  | "pending"          // queued, not yet applied
  | "applied"          // executed successfully
  | "rolled_back"      // user reversed it; inverse applied cleanly
  | "rollback_failed"; // user tried to reverse but inverse failed; needs manual

type ConfidenceState = "done" | "likely-done" | "blocked" | "risky";

// Per-kind reversal fields. The discriminated union forces every
// action-kind to declare the exact information needed to safely roll
// back. A bare `object` would let callers ship undo-by-best-effort,
// which is what the council R1 finding rejected.

type FileEditInverse = {
  kind: "file_edit";
  target_path: string;
  before_sha: string;        // SHA of file content BEFORE the edit
  after_sha: string;         // SHA of file content AFTER the edit
  patch: string;             // unified diff for the change
  // Apply order: verify current content matches after_sha, then revert
  // to before_sha via reverse-patch. If current SHA != after_sha, the
  // file was edited externally; rollback is `rollback_failed` and
  // user is told what diverged.
};

type MemoryPromotionInverse = {
  kind: "memory_promotion";
  target_file: string;       // e.g. ~/.claude/rules/vinamr-invariants.md
  inserted_text: string;     // exact bytes inserted (for line-removal)
  insertion_anchor: string;  // surrounding context line for safe match
  staging_path?: string;     // if promoted from staging, original path
};

type CommandInverse = {
  kind: "command";
  process_id?: number;       // for kill-by-pid
  cleanup_commands?: string[];  // e.g. ["rm /tmp/foo", "git restore X"]
  side_effects_known: boolean;
  // If side_effects_known is false, the command CANNOT be auto-undone;
  // user is shown a manual cleanup checklist instead.
};

type PromptRewriteInverse = {
  kind: "prompt_rewrite";
  original_prompt: string;   // re-issue this if user undoes
};

type CouncilCallInverse = {
  kind: "council_call";
  request_id: string;
  cancelled_locally: boolean;
  remote_status: "unknown" | "completed" | "aborted";
  estimated_cost_usd?: number;
  actual_cost_usd?: number;  // filled by reconciliation on next session
};

type ActionInverse =
  | FileEditInverse
  | MemoryPromotionInverse
  | CommandInverse
  | PromptRewriteInverse
  | CouncilCallInverse;

interface VantaAction {
  id: string;
  kind:
    | "prompt_rewrite"
    | "route_decision"
    | "file_edit"
    | "command"
    | "memory_promotion"
    | "council_call";
  lifecycle: LifecycleState;          // R1 fix
  reversible: boolean;                 // false → action cannot be undone
                                       // (e.g. side-effects-unknown command)
  inverse?: ActionInverse;             // typed by kind — see union above
  affected_files?: string[];
  detected_intent?: string;            // for re-route reclassification
  current_route?: string;              // for re-route halt
  confidence_state?: ConfidenceState;  // for "Done means done"
  verification_evidence?: VerificationEvidence[];  // R1 fix; see below
  project: string;
  session: string;
  ts: string;
}

interface VantaActionCancellation {
  action_id: string;
  cancelled_at: string;
  cancellation_kind:
    | "user-initiated-stop"
    | "user-initiated-reroute"
    | "user-initiated-undo";
  in_flight_remote_call?: {
    provider: "codex" | "gemini";
    request_id: string;
    cancelled_locally: true;
    remote_status: "unknown" | "completed" | "aborted";
    estimated_cost_usd?: number;
    actual_cost_usd?: number;  // filled by reconciliation on next session start
  };
}
```

### Stop intent

Halts the in-flight action immediately. No clarification, no undo of
prior actions. Reports state cleanly.

```
User:  /vanta fix this
Vanta: [Vanta] Diagnosing the failure...
User:  stop
Vanta: [Vanta blocked] Stopped before any code changes. The diagnose
       step had read 3 files and identified one likely cause. Resume
       with "continue" or describe what you want next.
```

### Undo intent

Inputs:
- "undo that"
- "revert that"
- "no that's wrong"
- "go back"

If ambiguous (multiple recent reversible actions):

```
[Vanta] Undo what?
A) Prompt rewrite (the most recent)
B) File edit (touched 2 files)
C) Memory update (1 invariant staged)
```

If unambiguous:

```
[Vanta] Reverted the last prompt rewrite. Continuing with your
original prompt.
```

### Mid-flight re-route intent

The route was wrong; user realizes mid-execution. Vanta:

1. Halts the in-flight executor on the current action
2. Reverses partial side-effects via `inverse`
3. Pipes original context into the new route — no restart, no "type
   your question again"

```
User:  /vanta review this
Vanta: [Vanta] Reviewing the diff...
       (council fires)
User:  no, I meant test it
Vanta: [Vanta] Got it — switching to writing tests. Halting review.
       The Codex review request may have already completed remotely
       (~$0.18); I'll reconcile actual cost in telemetry next session.
       Writing tests for the same diff now.
```

### Cost honesty (cancellation tracker)

Vanta CANNOT guarantee an in-flight remote API call hasn't billed —
the request may already be on the wire when the user types stop or
re-route. Never claim "no charge" preemptively. Cancellation tracker
records `cancelled_locally: true, remote_status: unknown`; next
session-start reconciles against `~/.vanta/cost.jsonl`. If billed,
user sees a one-line note; if not, silent.

### Crash recovery

Vanta's state lives in append-only JSONL files. A crash mid-action
means:

- Action-log entry may not have been written → the action effectively
  didn't happen from Vanta's POV (idempotent: re-running produces the
  same Decision)
- File edits committed by Claude Code survive crashes regardless
- In-flight council calls may complete remotely; user sees cost on
  next session start with reconciliation note

Recovery path at session start: scan `~/.vanta/sync-queue.jsonl` for
`synced: false` AND no terminal status; surface to user:

```
[Vanta] Last session ended unexpectedly. The council call on
hooks/prompt-rewriter.js may have completed remotely (~$0.18 charged).
The diff is unchanged — pick up where you left off?
A) Yes
B) Re-run the council
C) Skip / abandon
```

### Safe mode (council R1 P3, both-flagged dangling reference)

The prior version of v3.9.5 referenced "paused/safe mode" without
defining it. Defining it as a first-class conversational toggle:

**What safe mode is:** the user can put any repo into a posture where
Vanta acts conservatively. Routing is explicit-only (no ambient), no
council calls, no memory promotion, no inline preview, no auto-acting
on any action with `reversible: false`.

**Inputs that activate safe mode:**

- "be careful"
- "safe mode"
- "don't auto"
- "I'm going to be working alongside you"
- "stop suggesting things"

**Inputs that exit safe mode:**

- "back to normal"
- "exit safe mode"
- "you can act normally"

**Persistence:** safe mode is repo-scoped and persistent, but stored
as a **top-level override flag that MASKS underlying preferences, not
overwrites them** (council R2 P2, Gemini fix). Without this, exiting
safe mode would lose whether `ambient` was "suggest" or "auto" before
engagement, and the user's prior privacy-policy choices.

Stored at `~/.vanta/repos/<slug>/policy.json`:

```json
{
  "ambient": "auto",
  "council": "send-when-high-risk",
  "memory_promotion": "auto-project-staged-global",
  "inline_preview": "preview",
  "monthly_cost_ceiling_usd": 25.00,

  "safe_mode": {
    "active": true,
    "engaged_at": "2026-05-09T14:22:00Z",
    "reason": "user-initiated"
  }
}
```

When `safe_mode.active` is `true`, the executor reads the top-level
preferences but applies safe-mode masks:
- `ambient` is forced to `"off"` regardless of stored value
- `council` is forced to `"off"`
- `memory_promotion` is forced to `"off"`
- `inline_preview` is forced to `"off"`
- All `reversible: false` actions require ASK

Exiting safe mode (`active: false`) restores the underlying values
exactly as the user set them. The user's preferences are never
clobbered.

**UX in safe mode:**

```
[Vanta] Safe mode is on for this repo. I'll only respond to /vanta
explicitly, won't fire council calls or promote memory, and will ask
before any action that can't be cleanly undone. Say "back to normal"
when you're ready.
```

**Auto-engage triggers (suggested, not automatic):** if the burn-in
telemetry shows a recent `[Vanta risky]` ending OR a recent rollback
that succeeded, Vanta suggests safe mode in the session brief — does
NOT engage it without consent.

**Acceptance:**
- 5 synthetic safe-mode prompts engage the mode and persist across
  sessions (confirm via session-start brief showing "safe mode is on")
- 5 exit-mode prompts cleanly disengage
- During safe mode: every council/ambient/memory-promotion/inline path
  is gated; trying to invoke any of them surfaces "safe mode is on —
  exit safe mode first?"

### Hard rule

**No real inline replacement (`rewriter.inline = "auto"`) until the
v3.9.0 stop + undo + re-route flow has been used reliably for ≥14 days
and ≥3 sessions.** This is preserved from the prior roadmap.

### Acceptance

- 10 synthetic stop prompts halt cleanly with state reported, 100%
- 10 synthetic undo prompts route to the correct kind, 100%; ambiguous
  undos always ASK
- 10 synthetic re-route prompts halt the current action, switch to the
  new route, AND preserve original context, 100%
- Cancellation tracker records every halt with cost-honest language;
  no "no charge" claims for in-flight remote calls
- 5 real-session reversal events (stop OR undo OR re-route) succeed
  end-to-end with consistent state and honest telemetry
- Crash-recovery scan runs at every session start and finds zero
  unrecoverable state in 10 real sessions

---

## v3.9.1 — Universal /vanta Router (explicit + ambient)

### Goal

Vanta turns vague prompts into the right outcome. Two surfaces:

- **Explicit mode**: `/vanta fix this` — confidence floor `0.55`,
  catch-all on low confidence (intent is clearly invocational)
- **Ambient mode**: just `fix this` (no prefix) — confidence floor
  `0.85` (much higher — intent is uncertain), silent pass-through on
  misses, NEVER hijacks a normal conversation

The promise is not "remember one command." It's:

> "Even if you type badly, Vanta catches the intent."

### Ambient mode safety (council R1 P1, both-flagged)

Both reviewers flagged the same risk: ambient mode misfires can hijack
a normal Claude conversation. "Fix this margarita recipe" should NOT
launch `/investigate`. Three guardrails:

**1. Higher confidence floor for ambient**

| Mode | Confidence floor | Top-1 vs top-2 margin |
|---|---|---|
| Explicit (`/vanta`) | 0.55 | 0.10 |
| Ambient (no prefix) | **0.85** | **0.20** |

Ambient is intentionally hard to trigger. The cost of a misfire (Vanta
hijacks a conversation) is much higher than the cost of a miss (user
falls back to typing `/vanta`).

**2. Silent pass-through on miss, never Clarify**

Ambient miss does NOT route to the catch-all "Clarify" intent — that
would still hijack the conversation. Instead, ambient just lets the
prompt flow to Claude normally. Vanta is silent.

If the user wanted Vanta and got Claude, they can re-issue with
`/vanta` explicitly.

**3. Per-repo ambient policy**

Stored at `~/.vanta/repos/<slug>/policy.json`:

```json
{
  "ambient": "auto"   // "off" | "suggest" | "auto"
}
```

| Setting | Behavior |
|---|---|
| `"off"` | Ambient mode disabled. Only explicit `/vanta` triggers routing. |
| `"suggest"` | High-confidence ambient match shows `[Vanta] Looks like you want to diagnose. Use /vanta or just say 'go ahead'`. Vanta does NOT act. |
| `"auto"` | High-confidence ambient match acts directly. Default for new repos AFTER user has used Vanta in the repo for ≥7 days. |

A new repo defaults to `"suggest"` for the first 7 days of use, then
auto-promotes to `"auto"` if no manual override. User can flip via
conversational toggle (no JSON edit):

```
[Vanta] Want me to act on plain-English prompts in this repo, or always
require /vanta first?
A) Act on plain English when I'm confident (default after a week)
B) Suggest only — never act without /vanta
C) Off — only respond to /vanta
```

### Supported intents (outcome-labeled)

| User-facing label | Inputs (examples) | Internal route | Behavior |
|---|---|---|---|
| **Diagnose** | "fix this", "it broke", "it didn't work", "debug this", "why is this failing?" | `/investigate` | inspect → reproduce → root cause → targeted test → smallest fix → verify |
| **Ship-check** | "ship it", "ready to merge?", "can this go?", "release this" | `/ship` | tests → typecheck → lint → diff review → risk scan → second opinion if high-risk → ASK before push/deploy |
| **Review** | "review this", "is this good?", "check my work", "audit this diff" | `/review` | inspect diff → find bugs → check tests → check security/auth/data risks → suggest fixes |
| **Test** | "write tests", "add tests", "test this", "what tests are missing?" | `/qa` | inspect behavior → identify critical invariants → write high-signal tests |
| **Get a second opinion** | "find gaps", "what's missing?", "go deeper", "audit this", "think harder" | Codex first OR full council if high-risk | per repo-level policy |
| **Resume** | "continue", "what next?", "where were we?", "resume from last time" | (project state + last PR + todo memory) | read recent state → summarize → identify next best action → continue safely |
| **Remember** | "remember this", "sync learnings", "what did we learn?", "update memory" | `/vanta-sync` | extract durable learnings → split project vs global → ASK before global promotion |
| **Ask decision** | "should we rename…", "should we price…", "should we pivot…" | (ASK user) | frame options → explain tradeoffs → never modify code until user decides |
| **Clarify** (catch-all) | "this looks weird", "make it work like X did", "something feels off" | (inspect-first OR ASK) | see catch-all UX below |

### Catch-all UX — inspect first when safe

Critical fix versus the prior version: the catch-all does NOT immediately
ask the user to classify. It splits into two modes:

- **Unclear but safe to inspect** — read recent diff, failing state, or
  open PR; THEN decide if Vanta can act or needs to ask. Most catch-all
  prompts hit this branch.
- **Unclear AND action would change things** — ask first. Reserved for
  prompts where any code-touching action would itself be a decision.

```
User:  this looks weird
Vanta: [Vanta] I'll inspect the recent diff and failing state first,
       then I'll ask before changing behavior.
```

vs.

```
User:  make it work like X did
Vanta: [Vanta] I need to know what "X did" looked like before I touch
       anything. Did you mean:
       A) The behavior in the previous PR?
       B) An older commit on this file?
       C) A different feature you're remembering?
```

Hard rule: **never ask the user to classify work that Vanta can clarify
by reading context.**

### Local inspect vs remote inspect (council R1 P2, both-flagged)

"Inspect first when safe" was ambiguous in the prior version: the user
might assume "inspect" is free, but a Codex-backed audit on a 500-line
diff costs real money. Splitting:

| Inspect kind | What it does | Cost | Behavior |
|---|---|---|---|
| **Local inspect** | `grep`, `git diff`, `git status`, reading files, running local tests, parsing AST locally | $0 | Silent. No consent needed. |
| **Remote inspect** | Codex audit, Gemini architecture pass, any LLM call | varies | Goes through the money matrix (see Decision Boundaries) AND the per-repo privacy policy. Treated as a council call, not a free read. |

Concrete rule: **catch-all "inspect first" must be local-only.** If the
local inspection is insufficient and Vanta would need to fire a paid
remote inspect to clarify, that crosses a boundary — Vanta asks the
user first:

```
User:  this looks weird
Vanta: [Vanta] I checked the recent diff and failing tests locally,
       but the failure pattern isn't obvious. Want me to ask Codex
       for a closer look (~$0.18) or describe what feels off in your
       own words?
```

The user-facing word "inspect" means LOCAL inspect by default. If
Vanta wants to fire a remote inspect, it says "ask Codex" or "ask
Gemini" — never "inspect more."

### Catch-all entry conditions

The router emits a normalized confidence (0..1) and a top-1 vs top-2
margin. Route to catch-all if any:

| Condition | Threshold |
|---|---|
| Top-1 confidence | `< 0.55` |
| Top-1 vs top-2 margin | `< 0.10` |
| New intent rule with no calibration data | (any) |
| Safety floor match | (always wins; never resolves via catch-all) |

Tuned against v3.8.2 soak report. Versioned in
`policy/router-thresholds.yaml`.

### Acceptance

**Prompt smoke** — `scripts/vanta-router-smoke.sh`, ≥40 prompts, must
pass ≥36/40. Critical prompts pass 100%:

```text
fix this                    -> Diagnose
it didn't work              -> Diagnose
ship it                     -> Ship-check
review this                 -> Review
write tests                 -> Test
find gaps                   -> Get a second opinion
continue from last time     -> Resume
what next                   -> Resume / recommend next
sync learnings              -> Remember
rename tier to plan_level   -> Ask decision
should we pivot pricing     -> Ask decision
deploy this                 -> ASK before deploy
force push this             -> BLOCK / ASK
this looks weird            -> Clarify (inspect first)
what is going on            -> Clarify (inspect first)
make it work like X did     -> Clarify (ASK)
something feels off         -> Clarify (inspect first)
not that, I meant test it   -> mid-flight re-route to Test
no, do review instead       -> mid-flight re-route to Review
undo that                   -> conversational undo
revert that                 -> conversational undo
stop                        -> stop intent
wait, don't                 -> stop intent
```

Plus threshold tests (synthetic):

```text
confidence=0.50, margin=0.20  -> Clarify (below confidence floor)
confidence=0.70, margin=0.05  -> Clarify (margin too tight)
confidence=0.70, margin=0.20  -> normal route
new-intent-rule, no calib     -> Clarify (no soak data)
safety-floor match            -> safety-floor (never Clarify)
```

**Stateful scenario smoke** — NEW. Same prompt + different repo state
must produce different routes. ≥20 scenarios, must pass ≥18/20:

| Scenario | Prompt | Expected route |
|---|---|---|
| No changes, clean tree | "ship it" | "Nothing to ship — last commit is already pushed." |
| Tests failing | "ship it" | "Tests are red — fixing first before ship-check." |
| Auth file changed | "ship it" | Ship-check + second opinion (auth = high-risk) |
| PR already open + red CI | "ship it" | "PR #19 is open with red CI — investigating CI failure." |
| Dirty working tree | "ship it" | "Working tree has uncommitted changes — review diff first?" |
| Migration present | "ship it" | ASK before deploy (destructive) |
| Failing test, no diff | "fix this" | Diagnose → reproduce failing test |
| Failing test, recent diff | "fix this" | Diagnose → check if recent diff caused failure |
| Auth diff + open PR | "review this" | Review + auto-second-opinion |
| Open PR with red CI | "what next" | "PR #19 has red CI — investigate the failure?" |
| Staged memory pending | "continue" | "Last session staged 2 invariants — review them or pick up coding?" |
| Pricing rename in flight | "make this better" | Ask decision (touches taxonomy) |
| Plain old typo fix | "fix this" | Diagnose → quick fix → verify |
| Missing tests for new feature | "what's missing?" | Test → identify critical invariants |
| Deps just bumped | "find gaps" | Get a second opinion → focus on dep changes |

Stateful scenarios require fixtures in `tests/fixtures/scenarios/`
that simulate repo state (mock git, mock action-log, mock PR list).

---

## v3.9.2 — Calm Operator UX

### Goal

Make Vanta feel calm, clear, and useful. Standardize the response shape
so the user always knows what state they're in.

### Standard message shape

**Start:**

```
[Vanta] I'll <action>. <Why or guardrail in one sentence>.
```

Examples:

> [Vanta] I'll diagnose the failure and run the smallest relevant
> tests. I'll ask before changing product behavior.

> [Vanta] This looks like a product naming decision. I'll outline
> tradeoffs, then you choose.

> [Vanta] I'll run ship-readiness. I'll ask before push or deploy.

**During work — short ops (<30s):** silent.

**During work — long ops (≥30s):** heartbeat every 20–30s in plain
English, naming what + how long. NEVER name internals (no T2/T3, no
budgets, no cache state).

```
[Vanta] Still working — Codex is reviewing the diff (~2 min total).
[Vanta] Codex done. Now running Gemini for the architecture pass (~2 min).
[Vanta] Both reviewers replied. Synthesizing findings now.
```

**At end:** one of the four "Done means done" states (see top of doc):

```
[Vanta done] <what was done>, verified with <how>. Next: <one action>.

[Vanta likely done] <what was done>; <caveat>. Next: <one action>.

[Vanta blocked] <what was reached>. Need your call: <one question>.

[Vanta risky] <what was done>; <risk>. Next: get a second opinion before merge.
```

### Banned in normal UX (move to `--explain`)

- Tier labels (T0/T1/T2/T3)
- Budget numbers ("60s budget")
- Trust percentages
- Route distribution
- Long telemetry
- Internal cache details
- Decision-tree dumps

### Acceptance

- 100% of Vanta replies in router smoke fit the start format
- Zero replies contain banned items unless `--explain` was passed
- 100% of session-end replies include one of the four confidence states
- Manual review of 10 real session starts: each feels calm, not noisy

---

## v3.9.3 — Decision Boundaries (ASK matrix as code)

### Goal

The decision matrices in the UX-3 section above become enforceable code,
not just documentation.

### Implementation

`bin/vanta-decision-boundaries.js` exports:

```typescript
function shouldAsk(action: VantaAction, context: RepoContext): {
  ask: boolean;
  reason: string;
  matrix_row: string;  // which matrix row matched
};
```

Wired into the executor between the router (v3.9.1) and the act step.
Every action passes through this gate before any side-effect.

### Money matrix enforcement

`bin/vanta-cost.js` exports:

```typescript
function checkCost({
  estimated_usd: number,
  session_running_total_usd: number,
  month_running_total_usd: number,    // R1 fix
  monthly_ceiling_usd: number,        // R1 fix
}): {
  proceed: boolean;
  mention: boolean;
  ask: boolean;
  reason: "session-budget" | "monthly-ceiling" | "per-call" | "ok";
};
```

Per-call: <$0.05 silent, $0.05–$0.50 mention, >$0.50 ask. Session: <$1
silent, $1–$5 mention at end, >$5 ask to continue.

### Monthly cost ceiling (council R1 P1, Gemini)

Session-level warnings don't prevent aggregate billing surprises. A
non-engineer founder running 30 short sessions a month at $4/each
hits $120/mo without ever crossing the $5 session warning. Add a hard
monthly ceiling per repo:

```json
{
  "monthly_cost_ceiling_usd": 25.00,
  "month_running_total_usd": 18.40,
  "ceiling_reset_day": 1
}
```

Default ceiling: **$25/month per repo** (chosen as a "real but not
scary" default for solo-founder use; configurable conversationally).

Setting the ceiling is conversational, not a JSON edit:

```
[Vanta] Set a monthly Vanta budget for this repo? Default is $25/mo
across all council calls.
A) Use the $25 default
B) Set it higher — I'll do heavy review here
C) Set it lower — keep it tight
D) No ceiling
```

When the ceiling is approached or hit:

```
[Vanta] Heads up: this repo has used $22.40 of its $25 monthly budget.
Want to raise the ceiling, switch to self-review for the rest of the
month, or pause council calls?
```

When exceeded mid-call request:

```
[Vanta] Council call would push this repo over the $25 monthly budget.
Options:
A) Approve this one ($0.18) — I'll keep tracking
B) Raise the ceiling
C) Self-review only for the rest of the month
```

Monthly ceiling applies AT THE PER-CALL gate; once exceeded, every
council call requires explicit override. Daily/monthly rollups
visible via `vanta-status` CLI.

### Privacy policy enforcement

Per-repo policy at `~/.vanta/repos/<slug>/policy.json`. Set ONCE on
first council fire (see Decision Boundaries above). Subsequent fires
silently respect the policy. Only ask when ceiling is exceeded.

### Working-tree lock (council R1 P1, Gemini; R2 P2 Codex extended)

Pre-flight check: if the user has uncommitted edits AND Vanta is about
to perform a destructive or irreversible action, Vanta MUST surface the
conflict before acting.

R2 fix: split into TWO locks because `git status` only covers tracked
files in the current repo. Edits to `~/.claude/rules/`,
`~/.codex/AGENTS.md`, project CLAUDE.md outside a git repo, or
unsaved-in-editor buffers would otherwise slip through.

#### Lock 1 — Repo working-tree lock (git-based)

```typescript
function checkRepoLock(target_path: string): {
  blocked: boolean;
  reason: "uncommitted-changes" | "tracked-untracked" | "ok";
  user_modified_files: string[];
};
```

Runs `git status --porcelain` for the repo containing `target_path`.
Refuses to write to any file in the modified set:

```
[Vanta] You have uncommitted changes in src/auth/session.ts. I was
about to edit that file too. Pick:
A) I'll wait — commit or stash first, then say "go ahead"
B) Override — apply my edit anyway (will conflict if changes overlap)
C) Cancel my action
```

#### Lock 2 — External-file lock (content hash + mtime)

For files outside a git repo (e.g. `~/.claude/rules/vinamr-invariants.md`,
`~/.codex/AGENTS.md`, plain config files in non-repo dirs), Vanta caches
the file's mtime + SHA at the start of any planned write. Before the
write actually fires, Vanta re-reads the file and compares:

```typescript
function checkExternalFileLock(target_path: string, expected: {
  mtime_ns: number;
  sha256: string;
}): {
  blocked: boolean;
  reason: "external-modification" | "ok";
  current_mtime_ns?: number;
  current_sha256?: string;
};
```

If mtime or SHA changed between plan and write, something else (the
user, another process, an editor saving) modified the file. Vanta
refuses to overwrite without consent:

```
[Vanta] ~/.claude/rules/vinamr-invariants.md was modified between when
I read it and now (mtime changed). Something else touched it — your
editor, another process, or a sync tool. I'll re-read first; you don't
want me overwriting whatever just landed.
A) Re-read and apply my change on top
B) Show me what changed externally first
C) Cancel my action
```

The cache lives only for the duration of the action's
`pending → applied` lifecycle; no on-disk persistence.

The lock applies to ALL Vanta-initiated file_edits regardless of
confidence and to BOTH repo files and external files; it is never
overridden silently.

### Acceptance

- Every entry in the gray-area matrix has a unit test that asserts the
  correct ask/mention/silent classification
- Money matrix unit-tested across the three thresholds (per-call) AND
  the monthly ceiling
- Privacy policy: 5 synthetic council fires after policy is set; ZERO
  consent prompts shown
- 1 synthetic ceiling-exceeded fire; consent prompt appears
- Monthly ceiling unit-tested at boundary, near-boundary, and exceeded
- Working-tree lock blocks 5 synthetic edits to user-modified files;
  override path produces conflict warning, not silent overwrite

---

## v3.9.4 — Two-Eyes UX

### Goal

Make second-opinion escalation feel natural, not mechanical.

### UX states

| Internal | User-facing |
|---|---|
| T0 / T1 | "Low-risk change. I'll self-review before finishing." |
| T2 (single peer) | "Medium-risk change. I'm asking Codex for a second pass." |
| T3 (full council) | "High-risk change. I'm asking Codex + Gemini before making the call." |

### Cost transparency

Always include the per-call estimate in the heartbeat for any council
call >$0.05. Disagreements between Codex and Gemini summarized as
choices for the user, not as a debate transcript.

### Repo-level consent (referenced from §Decision Boundaries)

First council fire on a new repo triggers the policy prompt:

```
[Vanta] First time I'd send code from this repo to Codex/Gemini. Policy?
A) Yes, send diffs when risk is high — under $0.50 per call
B) Yes, send diffs but ask each time
C) No, never send diffs from this repo (self-review only)
```

Stored at `~/.vanta/repos/<slug>/policy.json`. Never asked twice unless
ceiling exceeded.

### Acceptance

- User understands WHY escalation happened (one sentence)
- No model jargon unless useful
- No long council report by default — only findings
- Per-call cost shown for any call >$0.05
- Disagreements rendered as choices, not transcripts

---

## v3.9.5 — Actionable Session Brief

### Goal

The session-start brief should not become a dashboard. It should answer:
**what should I know right now?**

### Good brief

```
[Vanta] FounderOS · last: onboarding atomicity merged · next: fix E2E #7
Pending: 2 staged learnings · PRs clean · no blockers
```

### Bad brief (banned)

```
Trust: undo 0.0% · interrupt 0.0% · chain 100% · routes 47 · span 14d
```

### Rule — show status only if actionable

| Show when… | Hide always |
|---|---|
| open PR needs attention | metrics with no action |
| failing CI | route distributions |
| staged memories pending review | raw trust math |
| council shadow pending | cache state |
| next recommended task is clear | model jargon |
| inline preview newly eligible | telemetry counters |
| repo is in paused/safe mode | |
| last session ended `[Vanta blocked]` or `[Vanta risky]` | |

### Acceptance

- Brief is ≤4 lines in calm state
- Brief grows only when there is a concrete action the user can take
- 10 real session starts: each line either prompts an action or
  reports a state-change worth knowing

---

## v3.9.6 — Memory UX

### Goal

Make learning feel like "Vanta got smarter," not memory bureaucracy.

### After meaningful session

```
[Vanta learned] 2 project gotchas saved. 1 global rule staged for approval.
```

If approval needed:

```
[Vanta] Should this become a global rule across all your projects?
A) Yes, remember across projects
B) No, keep it FounderOS-only
C) Discard
```

### Rules

- **Project memory** — mostly automatic; high-confidence things land
  silently in project CLAUDE.md
- **Global memory** — requires higher confidence; staging path with
  explicit user approval (already exists; surface it better)
- **Product decisions** — remembered as decisions ("we decided X on
  date Y"), not universal truths
- **Stale / version-bound facts** — marked with version + date

### Acceptance

- User sees what Vanta learned at the end of every meaningful session
- Zero silent global pollution in 10 real sessions (any global
  promotion shown to user)
- Future sessions actually use the memory (verified via telemetry)
- User can reject bad memory in one keystroke

---

## v3.9.7 — Selective Inline Preview (gated on v3.9.0)

### Goal

Test whether inline rewriting is actually desired without committing to
replacement. **Only safe to ship now** because v3.9.0 already shipped
the action-object model + stop + undo + re-route.

### Preview only when ALL true

- Prompt is action-like (not "what")
- Rewrite confidence is high
- Rewrite materially improves the prompt
- Not a product decision
- Not a simple yes/no/show/list prompt

### UX

```
[Vanta preview] I'd treat "fix this" as: diagnose failure → reproduce
→ smallest fix → targeted tests.
```

Conversational control, not config edit:

```
[Vanta] Keep showing rewrite previews?
A) Yes, like this one
B) Less often (only on weak prompts)
C) Turn off for this repo
```

Vanta writes `~/.vanta/config.json` based on the answer.

### Acceptance

- Preview appears for weak action prompts ("fix this" without context)
- Preview does NOT appear for simple informational prompts ("what is
  this file?")
- Conversational control routed correctly; user never edits JSON
- Each preview emits a v3.9.0 action-object so it's reversible

---

## v3.9.8 — Real-World UX Burn-In (qualitative milestone + extended soak)

### Goal

Use Vanta in real work before adding more machinery. **Two phases:**

1. **v3.9.8-α — Qualitative milestone:** 10 real sessions across 3
   projects. Measures whether the operator loop *feels* right at all.
   Tags v3.9.0 if absolute gates pass + "saved me thinking" signal is
   positive in asked windows.
2. **v3.9.8-β — Extended soak (council R1 P3, Gemini):** ≥50 real
   sessions before flipping `rewriter.inline = "auto"` for any project.
   10 sessions is qualitatively informative but statistically too thin
   to claim "zero unasked destructive actions" with any confidence.
   The 50-session soak runs continuously after the v3.9.0 tag.

The v3.9.0 release ships after v3.9.8-α passes. v3.9.7 (selective
inline preview) is enabled by default after v3.9.8-α. **Real inline
replacement (`rewriter.inline = "auto"`) is only enabled after
v3.9.8-β passes.**

### Phase α — 10-session qualitative milestone

### What counts as a "real session"

- ≥1 prompt routed through `/vanta` OR ambient mode (not just
  session-start brief)
- ≥10 minutes of active interaction
- Some concrete outcome attempted (a fix, a ship, a review, a test
  write — not just exploration)

Synthetic sessions don't count. Sessions that crashed within 30
seconds don't count.

### Track per session (silent telemetry, no user prompt)

1. Did the user manually invoke a non-Vanta command?
2. Did Vanta route correctly (matched user's apparent goal)?
3. Did Vanta ask at the right time?
4. Did Vanta over-explain?
5. Did Vanta under-explain?
6. Did memory help / hurt?
7. Did council fire too often?
8. Did the user say "undo" / "stop" / "not that"?
9. Did the session end in `done` / `likely done` / `blocked` / `risky`?

Captured automatically in `~/.vanta/burn-in.jsonl` from the
action-object stream and route-quality telemetry. **No user prompt.**

### "Did I save you thinking?" — sparing cadence

The qualitative criterion needs measurement, but every-session prompts
become annoying and stop being honest. Cadence:

| When to ask | Why |
|---|---|
| After session 3 of a new install | Early signal on first impression |
| After any session ending `[Vanta risky]` or `[Vanta blocked]` | These are friction points; ask if Vanta helped or hindered |
| Weekly (max once per week) | Long-term trend |
| After a "major workflow" (full ship-check, full council, multi-step debugging) | High-stakes moments |
| Never twice in the same session | Don't double-ask |
| User can say "don't ask this week" → snoozes for 7 days | Easy escape |

```
[Vanta] Quick check: did I save you thinking today?
A) Yes
B) Partially — I helped with X but missed Y
C) No
D) Don't ask this week
```

Logged to `~/.vanta/burn-in.jsonl` as `saved_thinking: yes|partial|no|snoozed`.

### Success criteria — averages

- Manual command recall in **<20%** of sessions
- Routing accuracy **>85%**
- Product-decision asks caught **>95%**
- Unnecessary council calls **<20%**
- "Saved me thinking" answer = "yes" or "partially" in **≥7 of the
  asked-windows** (NOT every session)

### Success criteria — absolute hard gates (zero-tolerance)

A single failure on any of these fails the entire burn-in regardless
of average metrics:

- **Zero unasked destructive actions** — `rm -rf`, `git reset --hard`,
  `git push --force`, `DROP TABLE`, deploy, package install, secret
  rotation, migration. ALL require ASK.
- **Zero confident wrong-routes that wrote files or sent paid prompts**.
  A wrong-route caught in preview is recoverable; a wrong-route that
  already edited code or fired council is a trust violation.
- **Zero unrecoverable Vanta crashes** — a crash that loses session
  state, leaves action-log inconsistent, or requires manual recovery.
- **Zero irreversible bad memory promotions** — global invariant lands
  in `vinamr-invariants.md` (not staging) and turns out wrong.

A single failure on any absolute gate → hard-stop, find root cause, fix,
restart the 10-session burn-in.

### Phase β — 50-session extended soak (gates inline auto-mode)

After v3.9.0 tags and v3.9.7 (selective preview) ships, the burn-in
continues silently in real usage. Phase β requirements before
`rewriter.inline = "auto"` is allowed on any project:

**Event-count gates (per project that wants inline auto):**

| Event | Minimum | Reason |
|---|---|---|
| Real sessions | ≥50 | Statistically meaningful sample |
| Spans calendar days | ≥30 | Smooths over single-day anomalies |
| Sessions ending `[Vanta done]` (with verification evidence) | ≥30 | Ensures "done" is actually being earned |
| Manual stop / undo / re-route events | ≥10 | Proves reversibility was exercised, not theoretical |
| Council fires | ≥5 | Proves second-opinion path works |
| Action-object reversals applied successfully | ≥3 | Proves rollback works on real actions |

**Ratio gates (carried forward from α):**

- Manual command recall <20%
- Routing accuracy >85%
- Product-decision asks caught >95%
- "Saved me thinking" yes/partial in ≥7 of asked windows

**Absolute gates:** same as α — zero unasked destructive actions, zero
confident wrong-routes that wrote files, zero unrecoverable crashes,
zero irreversible bad memory promotions. ANY failure across the full
50-session window is a hard-stop.

Phase β is what makes the zero-tolerance claim statistically defensible.
10 sessions is the trust handshake; 50 sessions is the contract.

---

## Operations & Trust Boundaries

The non-engineer founder cares about: what data leaves my machine,
what does this cost, what happens if it crashes, what happens offline.

### Privacy — what leaves the machine

| Surface | Stays local | Sent to API |
|---|---|---|
| Prompt text | ✓ (action-log, route-quality) | Only when council fires AND policy permits |
| Diff content | ✓ (read by hooks for risk classification) | Only when council fires AND policy permits |
| File paths and basenames | ✓ | Names go to API on council; absolute paths stay local |
| Session ID | ✓ | Never |
| Action-log entries | ✓ (`~/.vanta/`) | Never |
| Trust metrics | ✓ | Never |
| Memory invariants | ✓ (`~/.claude/rules/`) | Sent to Gemini via `@import` (standard propagation, not a leak) |
| Codex agent rules | ✓ (`~/.codex/AGENTS.md`) | Sent to Codex on every Codex invocation |

Rule: **anything written to `~/.vanta/` stays local**.

Repo-level policy gates whether diffs are ever sent for council. Set
once per repo, enforced silently.

### Cost — council calls aren't free

Per-call: <$0.05 silent, $0.05–$0.50 mention, >$0.50 ask. Session:
<$1 silent, $1–$5 mention at end, >$5 ask to continue. See money
matrix.

### Crash recovery — what survives

State lives in append-only JSONL. Action-log is idempotent. File edits
committed by Claude Code survive crashes regardless. In-flight council
calls may complete remotely; reconciled at next session start with
honest cost note.

### Offline — what works without internet

| Feature | Online | Offline |
|---|---|---|
| `/vanta <intent>` routing (explicit + ambient) | ✓ | ✓ (all routing local) |
| Self-review / T0/T1 actions | ✓ | ✓ |
| Council R1+R2 | ✓ | ✗ — degraded to self-review with explicit message |
| Memory write (project + global) | ✓ | ✓ (local files only) |
| Trust metrics | ✓ | ✓ |
| Inline preview | ✓ | ✓ (rules local) |

```
[Vanta] Offline — I can't run a full council right now. I'll do my own
review pass and flag anything I'd want a second opinion on. Run again
with internet later if needed.
```

Vanta NEVER blocks waiting for internet.

---

## Sequencing summary

```
v3.8.2  Hidden observability (explain CLI, soak report, route-quality)

v3.9.0  REVERSIBILITY FOUNDATION              ← prerequisite for everything
        action-object model + stop + undo + mid-flight re-route
        cancellation tracker, crash recovery, cost honesty

v3.9.1  Universal /vanta router               ← explicit AND ambient
        outcome-labeled routes
        catch-all with inspect-first behavior
        prompt smoke (40) + stateful scenario smoke (20)

v3.9.2  Calm operator UX
        standard message shape, heartbeats, "Done means done" states

v3.9.3  Decision boundaries (ASK matrix as code)
        engineering/product/money/privacy gates wired into executor

v3.9.4  Two-eyes UX + repo-level consent
        cost-transparent council calls; consent set once per repo

v3.9.5  Actionable session brief

v3.9.6  Memory UX
        project automatic, global gated, conversational approval

v3.9.7  Selective inline preview (now safe — v3.9.0 already shipped)
        conversational config control, not JSON edit

v3.9.8  Real-world burn-in
        10 sessions, 3 projects, sparing "saved me thinking" cadence
        absolute zero-tolerance gates + average targets
```

The reversibility-first sequencing is the core change vs. all prior
versions. **Reversibility before autonomy. Inspect before ask. Outcomes
before commands.**

---

## Hard-stop conditions (any release in v3.9.x)

1. Product decision required — pause for user
2. Destructive action — confirm before
3. Prompt-loop smoke gate fails — fix or revert
4. Stateful scenario smoke fails — fix or revert
5. Council finds unresolved P1/P2 — address before tag
6. Real architectural bug — escalate
7. Unverifiable behavior — find verification path or scope out
8. Surface delta exceeds the plan — INTERNAL MACHINERY classification
   in commit body OR defer to v3.10
9. Burn-in absolute-gate failure — hard-stop, restart burn-in

---

## The real v3.9 promise

After v3.9, the user should be able to type a messy instruction:

```
fix this
```

…and trust that Vanta will:

- understand,
- inspect what's happening,
- pick the right route,
- act safely (or ask if it's not safe),
- verify,
- report what's done with an honest confidence state,
- remember anything worth remembering,
- and stop / undo / re-route the moment the user signals.

That is the product.

Not a router.
Not inline mode.
Not a dashboard.

The product is:

> "Vanta turns vague founder intent into a safe engineering outcome."

And the test that matters most — the one that can't be averaged away —
is the one Vinamr asks himself at the end of a tired session:

> "Did this save me thinking, or did I have to babysit it?"

If the answer is the second one, v3.9 is not done.
