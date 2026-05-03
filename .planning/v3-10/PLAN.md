# Vanta v3.10 — Closed-Loop Self-Improvement

**Status:** DRAFT — pending council R1+R2
**Goal:** Close the EvolveR-style loop that v3.8.2 telemetry + v3.9.0 reversibility infrastructure made possible, without crossing the prompt-injection boundary R7 P1 correctly drew.
**Surface Impact Discipline:** INTERNAL MACHINERY. No new commands. Three-command promise preserved.

## Context

Research consensus in 2026 (EvolveR ICLR-26, Voyager, Reflexion variants) converges on **memory + scoring + retrieval** as the bottleneck — not the LLM itself. Vanta already has the durable trajectory store, semantic dedup (vanta-extract-score), retrieval (vanta-resolve), and adversarial critique (council). What's missing is **per-unit effectiveness scoring** — the load-bearing detail in EvolveR that everyone else skips.

v3.10 closes that gap with three primitives: rule effectiveness, invariant evidence, and bounded reflexion-as-context.

## Hard constraints (these decide the design space)

| Constraint | Implication |
|---|---|
| Three-command surface | No new user commands. All v3.10 is internal machinery. |
| Invariants file is `@import` context | Anything that auto-writes there is exploitable (R7 P1). Side-channel state only. |
| Cost-honesty | Self-improvement loop runs on existing telemetry. No new LLM calls in the hot path. |
| Cross-process durability | All state via append-only JSONL with dedup-on-read. Match v3.8.2 + v3.9.0 patterns. |
| Two-eyes for irreversibility | Quarantine yes (reversible). Rule deletion no. Auto-promotion to global invariants no. |

## The unit of improvement: `RuleEffectiveness`

Smallest atom with a clean cause→effect chain in existing logs:

```
rule (in vanta-rewriter.js)
  → decision (decision_id in route-quality.jsonl)
  → action (action_id in actions.jsonl, decision_id linkage)
  → outcome (lifecycle terminal state + nearby undo/stop/reroute/manual-recall events)
```

Computable purely from v3.8.2 + v3.9.0 telemetry. **No new instrumentation needed for the rule layer.**

```ts
RuleEffectiveness {
  rule_id: string
  fires: int                  // total decision events with this rule_id
  proceeded: int              // no undo/stop/reroute/recall within 5 prompts
  recalled: int               // user manually invoked /skill after rule fired
  undone: int                 // explicit undo intent on derived action
  rerouted: int               // explicit reroute intent
  success_rate: float         // proceeded / fires
  ci_lower: float             // Wilson lower bound at 95%
  last_50_window_rate: float  // rolling so old behavior doesn't dominate
  status: 'active' | 'flagged' | 'quarantined'
  status_reason: string|null
  status_changed_at: iso8601
}
```

## Three-phase loop (Score → Surface → Act)

### Phase A — Score (`bin/vanta-rule-effectiveness.js`, pure compute)

- Reads route-quality + actions + manual-recalls + cancellations
- Joins on decision_id (already threaded through v3.8.2)
- Writes snapshot to `~/.vanta/rule-effectiveness.jsonl` (append-only, dedup by `(rule_id, snapshot_ts)` on read)
- Idempotent; safe to run on cron, on Stop hook, or on demand

Decision-id correlation algorithm:
1. For each rule fire (route-quality entry with `rule_id != null` and `decision !== 'ask'`), find downstream events within next 5 user-prompt windows (read by ts ordering on actions.jsonl + manual-recalls.jsonl)
2. Negative signals: undo on action with `decision_id` match (within 30min default RECENT_WINDOW), stop on the action, reroute halt of the action, manual-recall in next 5 prompts
3. Default to `proceeded=true` if no negative signal found in window

### Phase B — Surface (no behavior change, advisory only)

- Soak report adds "Rule Effectiveness" section: top 5 worst rules + freshly-quarantined since last run
- Session-start brief surfaces a 🚨 line if any rule was quarantined in the last session (capped at 1 line, alongside existing 🛟 crash-recovery + 🌑 shadow-pending lines)
- vanta-patterns weekly retrospective lists trends

### Phase C — Act (the actual policy update, gated by thresholds)

Quarantine eligibility (ALL must hold):
- `fires >= 50`
- `ci_lower < 0.30` (Wilson 95% lower bound, NOT point estimate)
- `last_50_window_rate < 0.30` (rolling — don't quarantine on stale history if recent behavior is fine)

Mechanism:
- Rewriter loads rule-effectiveness.jsonl at executor init with 60s TTL cache (matches v3.8.0 trust-metrics pattern)
- Skips `status === 'quarantined'` rules during candidate generation
- Logs the skip with reason so soak-report can surface "rule X would have fired but is quarantined"

**Reversibility:**
- `node bin/vanta-rule-tune.js rehabilitate <rule_id>` flips status back to active
- Auto-rehabilitate after 30d if no replacement rule has been written in vanta-rewriter.js source (detected by file mtime > status_changed_at)

**Why these thresholds?** Wilson lower bound (not point estimate) prevents 0/3 cold-start nuking. 50-fire minimum prevents stochastic flake. 30-day auto-rehab prevents permanent corpus erosion. These are the same auditable-threshold patterns Vanta uses elsewhere (50 council fires before topic-stats kick in, 14d window for council attribution).

## Per-invariant evidence (parallel track, simpler)

Invariants are semantic so direct rule-style scoring doesn't apply. v3.10 tracks **retrieval and citation** in a side file — invariants.md stays human-edited:

```
~/.vanta/invariant-evidence.jsonl
{ ts, invariant_hash, event: 'retrieved' | 'council_tp' | 'unused_30d' }
```

Sources of evidence events:
- `vanta-resolve.js` — appends one log line per top-K hit (modest 1-line addition; only logs when query came from a USER prompt context, not internal machinery — guards against self-citation inflation)
- `vanta-council-feedback.js` — already logs true-positive attribution; mirror to evidence stream
- Periodic batch (in soak-report run): mark `unused_30d` for invariants with no `retrieved` events in last 30 days

Soak report surfaces "most cited" and "never cited in 30d" lists.

**No auto-pruning.** Surface only. Pruning crosses the boundary — humans decide.

**Invariant hash:** SHA-256 of trimmed invariant text (the `- one-liner` after the audit comment). Stable across edits to the audit comment, breaks on text edits — which is the right behavior because evidence for an old phrasing shouldn't carry over to a refined one.

## Reflexion as bounded additionalContext

When v3.10 sees a clear failure signal, log a redacted hint into a project-scoped, TTL-bounded file. Surface ONLY in next session's brief, ONLY for the same project, ONLY for 24h:

```
~/.vanta/repos/<slug>/recent-failures.jsonl
{ ts, kind: 'rollback_failed'|'test_fail'|'multi_reroute', context: <redacted>, ttl_until: <ts+24h> }
```

Failure signals (already collected, no new instrumentation):
1. `lifecycle: rollback_failed` on a VantaAction → kind=rollback_failed
2. `test-failure-advisor.js` post-Bash hard-stop → kind=test_fail
3. ≥2 reroutes within 10 minutes for the same project → kind=multi_reroute

Surfacing example (composed by vanta-brief.js, one line max):
```
[Vanta hint] Last session, rolling back the auth-middleware edit failed. The pre-commit hook caught a missing import. Worth running `npm run lint` before edits here.
```

Rules:
- One line, project-scoped, 24h TTL
- NEVER writes to global invariants
- Redaction layer shared with v3.8.2 (`vanta-route-quality.redactSecrets`)
- Capped at 3 hints in the brief; oldest expire first
- Cleared from disk by soak-report-run garbage collector when ttl_until passes

This is Reflexion-as-prompt-context — the variant that production agents converge on because weight updates aren't viable in deployed systems.

## Curriculum: missed-intent clustering (manual gate, surface-only)

Cheapest possible primitive: bag-of-words Jaccard cluster on `~/.vanta/missed-intents.jsonl`. Surface clusters with ≥3 unique phrases in vanta-patterns weekly retrospective as "candidate new rule" — human writes the rule.

```
Cluster algorithm (cheap, deterministic):
1. Read missed-intents.jsonl, last 30d window
2. Tokenize each phrase to lowercase word-set, strip stopwords
3. Jaccard-cluster greedily at threshold 0.5 (small N, O(n²) is fine)
4. For each cluster with ≥3 distinct phrases, emit centroid + count + sample (1 phrase)
```

Surface only. No autonomous rule generation in v3.10. The autonomous version (agent proposes rule patches) is adversarial — agent could probe phrasings to expand its own corpus — and is explicitly out of scope.

## What ships in v3.10 (5 commits, each <300 lines)

| # | Files | Purpose | Council gate? |
|---|---|---|---|
| 1 | `bin/vanta-rule-effectiveness.js` + `tests/v3-10-self-improving.test.js` | Pure-compute scorer. Wilson CI, threshold logic. | None (read-only) |
| 2 | `bin/vanta-evidence-log.js` + `bin/vanta-resolve.js` patch + `bin/vanta-council-feedback.js` patch | Side-channel evidence stream | None (additive log) |
| 3 | `bin/vanta-rule-tune.js` CLI + `bin/vanta-rewriter.js` quarantine load | **First runtime-behavior change** | **R1 council on diff before merge** |
| 4 | `hooks/auto-sync.js` recent-failures appender + `bin/vanta-brief.js` surfacer | Reflexion-as-context pipeline | None (project-scoped, TTL-bounded) |
| 5 | `tools/vanta-soak-report.js` extensions + missed-intent clusters + skill doc updates (vanta-sync, vanta-patterns) | Surface layer | None (advisory) |

## What does NOT ship in v3.10 (consciously deferred or rejected)

- Auto-write to global invariants — R7 P1 still holds, exploitable as prompt-injection vector
- Auto-update of rewriter regex patterns from extracted intents — silent drift risk
- Self-modifying prompt rules — feedback loop with no oracle
- Autonomous curriculum (agent proposes phrasings to test) — adversarial expansion path
- RL on rule weights — small-N, hard-to-debug, no audit trail
- Cross-project knowledge transfer — privacy boundary violation
- Embedding-based clustering for missed intents — adds dependency for marginal benefit; v3.10 ships with Jaccard, v3.11 can revisit if quality is poor

## Risk register (with mitigations)

| Risk | Mitigation |
|---|---|
| Rule starvation from over-quarantine | 50-fire minimum + Wilson CI lower-bound; surface in every soak report; auto-rehabilitate at 30d |
| Cold-start unfairness | Same — minimum N gate before eligibility |
| Reflexion hint becomes injection vector | 24h TTL, project-scoped, redacted, bounded length, capped at 3 hints |
| Evidence inflation via self-citation | Only count retrievals from user-prompt context, not internal machinery (guarded by caller field on resolve() entries) |
| Council attribution false-positive | Use existing v3.8.2 strict-only gate (Jaccard ≥0.25) |
| Missed-intent clusters leak PII | Redaction at write; surface centroid only, not raw phrases |
| Rewriter cold-load reads stale quarantine | 60s TTL cache (matches v3.8.0 trust-metrics pattern); explicit invalidate on rule-tune CLI write |
| Concurrent rule-tune writes from multiple sessions | Append-only JSONL pattern + dedup-on-read by `(rule_id, status_changed_at)` — last write wins on tie via `>=` (v3.9.0 fix) |
| auto-rehab races a fresh quarantine | Read-modify-write would race; use append-only pattern: rehab is a new `status: active, status_changed_at: now` entry; dedup-on-read uses latest by status_changed_at |

## Council protocol for v3.10

Hard-required:

1. ✅ Write PLAN.md (this file)
2. **`/council` R1+R2 on the plan — both rounds before any code**
3. R3 if R2 introduces new code paths (per v3.7→v3.8 retro pattern)
4. Hard-stop on any unresolved both-confirmed P2 finding
5. Implement commits 1-2 (read-only, low risk) in parallel
6. **`/council` R1 minimum on commit-3 diff** before merging (first runtime-behavior change)
7. Implement commits 4-5
8. **`/council` R1+R2 on full v3.10 diff** before tag
9. Soak on master for 7 days minimum before `v3.10.0` tag

## Why this is more conservative than EvolveR

EvolveR runs on QA benchmarks and updates policy via RL. It's safe in that environment because:
- Inputs are bounded (fixed dataset)
- Reward is computable (right answer / wrong answer)
- Drift is observable (benchmark scores)

Vanta runs on a real machine reading real files. Inputs are unbounded; reward is implicit (undo signals); drift is invisible (a slowly-broken rewriter could persist for weeks before a human notices). Hard thresholds + auditable transitions + reversible quarantine substitute for RL's failure modes that are observable in benchmark settings but invisible in production.

## What v3.10 gives us

After ship:
- Rules that don't actually help get quarantined automatically (with reversibility)
- Most-cited invariants get visible signal (so retired rules get pruned by humans)
- Yesterday's rollback failures inform tomorrow's session (24h, project-scoped)
- Missed-intent gaps surface as candidate rules for human authoring
- Soak report is now an actionable retrospective, not just observation

What v3.10 does NOT give us: a fully autonomous agent that rewrites its own rules. That's not v3.11 either. Vanta's design opinion: the boundary where the agent edits its own context permanently is exactly where humans should keep the pen.

## Files touched (preview for council)

**New files:**
- `bin/vanta-rule-effectiveness.js` (~300 lines)
- `bin/vanta-evidence-log.js` (~150 lines)
- `bin/vanta-rule-tune.js` (~200 lines)
- `tests/v3-10-self-improving.test.js` (~600 lines)
- `.planning/v3-10/PLAN.md` (this file)

**Modified files:**
- `bin/vanta-resolve.js` (+5 lines: log retrieval to evidence stream)
- `bin/vanta-council-feedback.js` (+5 lines: mirror TP attribution to evidence stream)
- `bin/vanta-rewriter.js` (+15 lines: load + skip quarantined rules with TTL cache)
- `bin/vanta-brief.js` (+30 lines: surface 🚨 freshly-quarantined + recent-failures hints)
- `hooks/auto-sync.js` (+20 lines: recent-failures appender on Stop)
- `tools/vanta-soak-report.js` (+150 lines: three new sections)
- `skills/vanta-sync/SKILL.md` (+1 step: rule effectiveness review prompt)
- `skills/vanta-patterns/SKILL.md` (+3 sections: rule effectiveness, invariant evidence, missed-intent clusters)

## Open questions for council

1. **Wilson CI vs Bayesian credible interval?** Wilson is simpler and well-understood. Beta-Binomial credible interval would let us encode a prior on each rule's expected success rate. Probably overkill for v3.10 — Wilson is fine.
2. **Should retrieval-evidence log entries include the QUERY?** Privacy concern. Default proposal: log only invariant_hash + ts + event, not the query phrase.
3. **What's the right rollover for rule-effectiveness.jsonl?** Append-only grows unboundedly. Snapshot daily? Compact monthly? Match the existing route-quality bak rotation pattern (last 5 daily backs).
4. **Multi-reroute threshold** (≥2 in 10min): is this tight enough to avoid flagging legitimate exploration? Sensitivity test in commit 1 tests.
