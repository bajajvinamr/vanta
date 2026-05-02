# Vanta v3.8 → v3.9 Roadmap

Detailed plan covering everything that lands between the v3.8.0 cut and
the v3.9.0 minor. Captures: what shipped, what's queued in the v3.8.x
patch lane, and what's scoped for v3.9 proper. Internal-machinery
discipline applies — no new commands or skills unless explicitly justified
against the three-command surface promise.

## Status snapshot

| Tag | Date | What it shipped | Scope |
|---|---|---|---|
| v3.8.0 | 2026-05-02 | Central executor, R1+R2+R3 council fixes, project-scoped trust, monorepo slug correctness via slugFromCwd, trust cache (TTL 15s, bounded 64) | Sprint cap |
| v3.8.1 | 2026-05-02 | Silent require warning, explicit trust-cache invalidation on undo, monorepo + reader/writer slug regression tests | Hardening |
| v3.8.2 | _planned_ | (see §1) | Soak / observability fixes only |
| v3.8.3 | _planned, conditional_ | (see §1) | Bug-fix-only |
| v3.9.0 | _design phase_ | (see §2) | First user-visible surface change since v3.6 |

## §1 — v3.8.x patch lane

The patch lane is for items the council surfaced or real usage will surface
that don't change behavior the user ever sees. Boring, mechanical,
regression-test-first. **Anything that adds a command, hook, skill, or
prompt the user must remember belongs in v3.9, not v3.8.x.**

### v3.8.2 — soak + observability (target: 1 week)

Goal: surface what's actually happening inside the central executor in
real sessions. Today every Decision is logged but the aggregate signal
is hard to read. Two consumers need it: the user (debugging "why did
Vanta route there?") and v3.9 design (calibrating the inline-flip
threshold against real data).

| Item | What | Why | Risk |
|---|---|---|---|
| 1 | `vanta-executor --explain <prompt>` CLI flag | Print the full Decision tree (which step short-circuited, all signals, escalations applied, final tier+route) for one prompt without writing to action-log | Today the only way to see the decision path is to read source. Operator debugging is high friction. | Low — CLI-only, no behavior change |
| 2 | `tools/vanta-soak-report.js` | Pull last N days of action-log; emit a markdown summary: route distribution, tier distribution, escalation rate, undo rate per route, average latency budget consumed. Matches gstack's `/health` output style. | We need to see whether the v3.7→v3.8 trust scoping is actually pulling `inline_ready` toward `true` for any project. Currently no view. | Low — read-only; no writes outside `/tmp` |
| 3 | Setup.sh deploy of `bin/vanta-projects.js` parity check | Verify `~/.claude/bin/vanta-projects.js` has `slugFromCwd` exported; warn if the deployed copy lags behind the repo HEAD | Surfaced during v3.8.0 sync — the deployed binary lacked v3.7.x helpers. Quietly degraded the council-feedback CLI. | Low — setup.sh check at re-install only |
| 4 | Stale-cache invalidation on file-write reverts (in-process) | When `vanta-undo._undoFileWrite()` succeeds, also invalidate the cached _interruptRate result for the project (separate from the trust-metrics cache, which v3.8.1 already covers) | The action-log row gets `synced: true` but the in-memory cached metrics for that project may carry the un-reverted state for up to 15s | Low — same pattern as v3.8.1 trust invalidation |

### v3.8.3 — bug-fix-only release valve (target: as needed)

Reserved for whatever the soak in v3.8.2 surfaces. Triggers:

- Council finds a P1/P2 in v3.8.2 that wasn't a regression of an older
  bug (i.e. genuinely new surface)
- A real user session hits a routing miss whose fix is mechanical
- A test starts flaking and the fix is a 1-line tightening

If nothing surfaces in 2 weeks, skip v3.8.3 and roll into v3.9.0.

## §2 — v3.9.0 — first user-visible surface change

This is the first minor since v3.6 to ship a new user-facing capability.
Every prior release through v3.8.x was internal machinery. **The v3.9
scope expands the user-visible surface — every item must justify itself
against the three-command surface promise.**

The four-month soak of v3.6→v3.8 made one thing clear: **the user-visible
surface is currently complete.** Anything new must clear a higher bar than
"would be nice to have." The v3.9 scope is therefore narrow.

### v3.9 candidate scope (3 items, ranked by EV)

#### v3.9-A — `inline_ready` mode flip (preview-only first)

**Surface impact: medium.** The trust-metrics signal `inline_ready` has
been computed since v3.7.4 but never acted on. v3.9 makes it the gate
for flipping prompt-rewriter from shadow mode (today: injects context
alongside the user's prompt) to inline mode (replaces the prompt).

**Council R1 forced a scope cut:** the original plan claimed
`vanta-undo --inline-flip` as the rollback path, but that command does
not exist and adding it would create a 4th top-level surface (both
Codex and Gemini flagged this as P1, both-confirmed). The revised plan
splits v3.9-A into two phases gated by reversibility, not calendar:

**v3.9-A.1 — Inline preview (always, no trust gate):** the rewriter
keeps shadow-injecting context BUT also injects a visible block at the
top of every prompt that says "if I had inline mode for this project,
the prompt would have become: <rewritten>". Read-only. The user's
original prompt continues unchanged. This earns its keep by surfacing
what inline mode would have done so trust calibration is visible
without committing to replacement.

**v3.9-A.2 — Real inline replacement:** ships ONLY after a working
rollback path is built and tested. Two acceptable rollback designs:

- **Conversational revert.** "revert that", "undo", "no that's wrong"
  match an existing safety-floor entry; the prompt-rewriter looks at
  the most recent action-log entry with `kind=rewriter-inline` and
  re-issues the original prompt. Routes through the existing `/vanta`
  intent table, no new command.
- **Action-log-backed audit trail.** Every inline rewrite stores
  `{ original, rewritten, decision_id, ts }` in the action-log with a
  new `kind: rewriter-inline-replace`. The user can read it with the
  existing `vanta-status` binary or trigger replay through `/vanta`.

Implementation: A.1 = 1 day. A.2 = 4-5 days INCLUDING rollback path
+ tests + 14d shadow-metrics soak before the flag flips for any
project. **No `--inline-flip` flag, no new top-level command, no new
CLI subcommand the user has to memorize.**

Hysteresis (council R1 P2 — both-flagged): inline_ready computed once
per session-start, latched for the session. A mid-session undo drops
trust in the metrics ledger but does NOT flip inline off mid-session
(prevents oscillation that destroys UX predictability). Demotion
requires two consecutive sessions where trust drops below threshold.

Trust gaming counter (Gemini R1 P2): chain-success today only counts
absence-of-undo. v3.9-A.2 adds a "manual-correction" detector — if the
user edits the same file the rewriter just touched within the next
2 prompts, count that as a soft-undo signal. Imperfect but raises the
bar above "user didn't notice the rewrite was wrong."

Council questions still open:
- Cross-project trust pollution: project-scoped trust was the
  v3.7.5→v3.8.0 fix; v3.9-A.2 is the consumer that exercises it.
  Required canary before flag flip — see §3.
- Default rollout: explicit per-project opt-in, never auto-flip.
  Earned trust ≠ user wants this on. Surface eligibility via the
  session-start brief (already a Vanta surface), not a sidecar
  status command.

What does NOT change:
- The three-command surface (`/vanta`, `/vanta-sync`, `/council`) is
  unchanged. Even the eligibility surface lives inside the existing
  session-start brief, not a 4th command.

**Surface delta: zero new commands. One config flag in
`~/.vanta/config.json` (`rewriter.inline: "off" | "preview" | "auto"`,
default `"preview"` after A.1, never `"auto"` until A.2 ships).**

#### v3.9-B — Status surface enrichment (NOT a new command)

**Surface impact: zero — moved to internal brief.** The original draft
proposed `/vanta-status` as a 4th top-level command. Council R1 (both
models) rejected this outright: a `vanta-status` binary already exists,
the session-start brief already carries status, and adding a memorized
slash command for it sets precedent for `/vanta-health`, `/vanta-trust`,
`/vanta-undo` — exactly the surface explosion the three-command promise
prevents.

Replacement scope: **enrich the session-start brief** (which already
injects on every session) to include the same aggregate the operator
needs:

```
[Vanta] master · vanta · last sync 2h ago · 47 auto · 0 undo
Trust:   undo 0.0% · interrupt 0.0% · chain 100% (4/4) · span 14d · inline_ready YES
Routes:  /investigate 12 · /ship 8 · /review 6 · /council 3
Pending: 0 unsynced · 0 council shadows · 1 PR (#19, 2d open)
Eligibility: this project earned inline preview (v3.9-A.1). Set rewriter.inline = "auto" once you've used preview for 1+ session.
```

The brief already has 4 lines of budget; v3.9-B adds 2-3 more lines
when the trust thresholds are clearing — gated by signal, not always.
The CLI binary `vanta-status` stays as the operator's escape hatch for
deeper drilldown.

Implementation: 1-2 days. Modified `using-vanta` skill brief generator,
no new code surface. **Surface delta: zero new commands; the existing
brief grows from 4 lines to ~6-7 lines under specific signal conditions.**

Rejection rule for future surface debates (added per council): "No new
slash wrapper for an existing bin unless the same outcome cannot fit
inside `/vanta`, `/vanta <verb>`, or the session-start brief."

#### v3.9-C — `/vanta`-as-router intent expansion

**Surface impact: zero.** The `/vanta` command currently bootstraps or
resumes. v3.9-C extends the same command (no new surface) to handle
intent strings: `/vanta ship`, `/vanta review`, `/vanta debug`. Each
delegates to the existing skill via `Skill()` rather than the user
remembering which gstack/superpowers skill maps to their intent.

This is the inverse of v3.9-B: it preserves the three-command promise
by routing more verbs through the same command surface. The argument
parser inside `/vanta` already discriminates — extending the verb table
is mechanical.

Implementation: 1 day. Modified `vanta-run` skill, new test cases for
the intent table. **Surface delta: zero new commands; expanded verbs
inside an existing command.**

### Items explicitly NOT in v3.9 scope

- **Inline-flip rollout to all users:** v3.9-A ships the mechanism;
  rollout is a per-user `inline_ready` calculation, not a release event.
- **LLM-backed rewriter rules:** the rule path is the only path today.
  LLM fallback was scoped for v3.7.4 and remains deferred. EV unclear
  vs the cost of an extra Anthropic call on every prompt.
- **Cross-session memory in vanta-undo:** undo currently looks at the
  current session's action-log only. Cross-session would require
  reconciling against `synced` markers and is its own design problem.
- **`/vanta-canary` or staged rollout:** would require a notion of
  cohorts that doesn't exist. Defer.
- **Multi-user / team-mode Vanta:** scope creep. Vanta is single-user
  by design.

## §3 — Sequencing, gates, and named prerequisites

Council R1 forced two changes here:
1. **v3.9-A.2 explicitly depends on v3.8.2** (Codex R1 P1). Calibrating
   `inline_ready` against real per-project trust data is impossible
   without the soak report shipped in v3.8.2.
2. **The 14-day soak cannot gate on a feature that only ships in
   v3.9.0** (Gemini R1 P3 — circular dependency). The fix: shadow-metrics
   for inline mode begin during v3.8.2, BEFORE A.2 code lands. By the
   time A.2 ships, calibration data already exists; only the user-facing
   flag flip is gated by an additional 14-day window.

```
v3.8.0  ✓ tagged 2026-05-02
   │
   ├── v3.8.1  ✓ tagged 2026-05-02 (hardening)
   │
   ├── v3.8.2  soak + observability + inline shadow-metrics
   │      named outputs:
   │        - vanta-executor --explain CLI
   │        - tools/vanta-soak-report.js
   │        - bin parity check in setup.sh
   │        - SHADOW telemetry: every prompt that WOULD have flipped
   │          inline (had A.2 shipped) writes a counterfactual entry
   │          to action-log with kind=`inline-shadow`. No behavior
   │          change visible to user.
   │      gates:
   │        - 350+/350+ tests, 15/15 smoke
   │        - 7 days of real usage by Vinamr
   │        - shadow telemetry confirms project-scoped trust resolves
   │      ship trigger: explain CLI + soak report both used in 1+ real session
   │
   ├── v3.8.3  bug-fix valve (conditional)
   │      ship trigger: real bug found in v3.8.2 soak; otherwise skip
   │
   ▼
v3.9.0  ── SHIP CRITERIA (covers A.1 + B + C only, NOT A.2) ──
   prereqs to tag v3.9.0:
   - v3.8.2 has been live for ≥14 calendar days (shadow telemetry
     in production; informs A.2 calibration but doesn't gate the tag)
   - council R1+R2 reviewed A.1 + B + C implementations
   - 350+/350+ tests, 15/15 smoke gate
   - no surface delta beyond §2 (zero new commands; brief grows under
     signal; one config flag for A.1 preview)

   sequencing within v3.9.0:
   - v3.9-A.1 (preview-only) lands first — no trust gate, lowest risk
   - v3.9-C lands second (zero new surface, mechanical verb table)
   - v3.9-B lands third (brief enrichment, no new commands)
   - tag v3.9.0 here. A.2 does NOT block this tag.

v3.9-A.2  ── ENABLEMENT CRITERIA (post-tag, gated separately) ──
   v3.9-A.2 is a runtime-flag flip, not a release. The code that
   reads the flag may ship inside v3.9.0 (gated default-off and
   functionally inert until enabled) or in a v3.9.x patch — that's
   an implementation detail. What matters is that the flag never
   defaults to "auto" until ALL enablement criteria pass:

   prereqs to flip default `rewriter.inline = "auto"` for any project:
   - shadow telemetry from v3.8.2 shows ≥1 project would have
     triggered inline_ready under real workload
   - 14 calendar days of shadow telemetry on a project before that
     project's flag is eligible to flip (per-project soak, not global)
   - council R1+R2 reviewed the A.2 implementation
   - rollback path (conversational "revert that" routed through the
     existing safety floor + /vanta verb expansion, OR action-log
     replay) is IMPLEMENTED AND TESTED against §3.5 canaries
   - explicit operator opt-in recorded in `~/.vanta/config.json` for
     each project (per §5 qualitative leading indicator)

§3.5 — Required canary scenarios before v3.9-A.2 flag flip:

| Canary | What it tests | Pass criterion |
|---|---|---|
| Threshold-edge project | Project at exactly the inline_ready boundary (50 actions, 14d, undo just under 2%) — flips on | Inline activates; one synthetic undo flips trust to 2%+; latched session stays inline; next session demoted |
| Oscillation | Two consecutive sessions with trust just under threshold | Inline stays OFF for both (latched-out demotion); only re-enters after 2 consecutive sessions clear |
| Monorepo slug split | Same workspace cwd queried from `packages/api` and `apps/web` | Both subdirs collapse to one slug; trust accrues to the workspace root, not per subdir |
| Cross-project noisy session | Heavy undo in project-A; project-B starts session same day | project-B's inline_ready unaffected (project-scoped trust holds) |
| Failed inline rollback | Conversational "revert that" within 2 prompts of an inline rewrite | Original prompt re-issued; chain-success counter NOT incremented for the broken rewrite; trust drops |
| Stale-cache demotion within one process | Undo lands; same-session decide() called within 1s | invalidateTrustCache fires; next decide() reads fresh trust; latching may keep inline ON for the session but the metric is correct |
| Manual-correction detection | User edits the same file rewriter touched within 2 prompts | Soft-undo signal recorded; chain-success NOT counted for that rewrite |
```

## §4 — Hard-stop conditions for v3.9.0

Same as v3.8.0, plus one new:

1. **Product decision required** — pause for the user.
2. **Destructive action** — confirm before.
3. **Prompt-loop smoke gate fails** — fix or revert.
4. **Council finds unresolved P1/P2** — address before tag.
5. **Real architectural bug** — escalate.
6. **Unverifiable behavior** — find a verification path or scope out.
7. **NEW: Surface delta exceeds the v3.9-A+B+C plan** — silent
   surface creep is the failure mode v3.6→v3.8 invariants exist to
   prevent. Any commit that adds capability beyond this roadmap must
   either (a) be classified as INTERNAL MACHINERY in the commit body
   with justification, or (b) be deferred to v3.10 with a rationale.

## §5 — What good v3.9.0 looks like

Quantitative bars (from telemetry):
- The three-command surface (`/vanta`, `/vanta-sync`, `/council`) still
  fits on one CLAUDE.md line.
- Every user-visible behavior change is announced in the session-start
  brief — no silent state transitions.
- 14+ days of shadow-metric soak (started during v3.8.2) prove that
  `inline_ready` correctly identifies trust-earned projects and
  correctly excludes brand-new ones.
- All §3.5 canary scenarios pass.
- Council ran R1+R2 (R3 only if R2 changed core risk logic) and found
  no unresolved P1/P2.
- Vinamr used Vanta for at least 3 real sessions before v3.9.0 design
  closed; routing misses, council false-positives, and memory hits/misses
  were all logged.

Qualitative bar (from operator behavior, per Gemini R1 P3):
- The metric clearing thresholds is necessary but not sufficient.
  Vinamr should have at minimum one moment of "shadow felt too
  slow / I want this on" BEFORE flipping `rewriter.inline = "auto"`
  on a project. If the trust math says yes but the operator doesn't
  want inline replacement, the math is misaligned with the actual UX.
- Equivalent leading indicator: explicit operator opt-in to A.2 mode
  for at least one project, recorded in `~/.vanta/config.json` with
  a timestamp. If no project crosses this bar within 30 days of
  v3.9.0, treat that as data — A.2 is solving a problem the operator
  doesn't have, and v3.10 should reconsider.

## §6 — Rejected ideas (with reasons)

| Idea | Rejected because |
|---|---|
| Multi-user Vanta | Single-user is a feature, not a limitation. |
| LLM-backed rewriter | EV unclear; rule path is fast and predictable. |
| Plugin marketplace | `/plugin install` is broken (known invariant); manual deploy is the install path. |
| Skill auto-discovery from `~/.claude/agents/` | Conflicts with one-level-deep scanner invariant. |
| Per-project hook overrides | Surface explosion — every project would have its own rule set. |
| Vanta-as-MCP-server | The hooks ARE the integration; MCP would duplicate state. |
| `/vanta-status` as a 4th top-level command | (Council R1 both-flagged.) `vanta-status` binary already exists; the session-start brief already carries status; adding a memorized slash command sets precedent for `/vanta-health`, `/vanta-trust`, `/vanta-undo`. The same outcome fits inside the existing brief or `/vanta <verb>`. |
| `vanta-undo --inline-flip` flag | (Council R1 both-flagged P1.) Adds a new CLI flag the user must memorize for a recovery path that should be conversational. Inline rollback routes through "revert that" / "undo" prompts via the existing safety floor, OR through `/vanta` verb expansion — never as a flag. |
| Auto-flip default for `rewriter.inline = "auto"` once trust thresholds clear | Trust thresholds clearing means the math is happy, not that the user wants inline replacement on. v3.9-A.2 always requires explicit operator opt-in per project. If the operator never opts in, that is data — the feature is solving a problem they don't have. |
| Inline mid-session demotion (immediate flip-off when undo lands) | (Council R1 both-flagged P2.) Causes oscillation that destroys UX predictability. Hysteresis: latch inline for the session; require two consecutive failing sessions to demote. |
| Status-in-brief AND sidecar `/vanta-status` AND config flag | (Codex R1 P2.) Compound surface. Pick one containment path: enriched brief is the chosen path. |

## §7 — Provenance + cross-references

- v3.8.0 sprint thread: commits 10743c7 (R1) → a8675cf (R2) → 3b88d9c (R3)
- v3.8.1 hardening: commit 5be0f5b (merge 364b1f6)
- Council-found P1/P2 history: see `docs/FAILURE-MODES.md`
- Surface impact discipline: `CLAUDE.md` § "Surface Impact Discipline"
- Three-command promise: `~/Projects/vanta/skills/using-vanta/SKILL.md`
- Trust threshold: `bin/vanta-trust-metrics.js` `readyForInline()`
