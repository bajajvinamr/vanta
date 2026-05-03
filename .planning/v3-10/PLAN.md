# Vanta v3.10 — Closed-Loop Self-Improvement (v2)

**Status:** v2 — incorporates council R1+R2 findings (4 P1 + 8 P2 + 2 P3 resolved). Ready for implementation.
**Goal:** Close the EvolveR-style loop using existing v3.8.2/v3.9.0 telemetry, without crossing the prompt-injection boundary R7 P1 correctly drew.
**Surface Impact Discipline:** INTERNAL MACHINERY. No new commands. Three-command promise preserved.

## Council R1+R2 verdict (synthesized)

| ID | Finding | Severity | Status |
|---|---|---|---|
| C-1 | `decision_id` correlation gap (`vanta-action.js createAction` drops the field) | P1 both-confirmed | **FIX in commit 0** |
| C-2 | Reflexion injection vector (redaction strips secrets, not hostile prompt text) | P1 both-confirmed | **FIX — enum + allowlisted identifiers only** |
| C-3 | Auto-rehab mtime coupling (single shared file = false rehab cascade) | P1 single, R2-agreed | **FIX — per-rule content hash** |
| C-4 | Causal-window misattribution (no lineage = false attribution) | P2 R2-confirmed | **FIX — lineage required, else unscorable** |
| C-5 | Rehab immediately re-kills (historical evidence persists across rehab) | P2 R2-confirmed | **FIX — new scoring epoch on rehab** |
| C-6 | Stale quarantine cache across processes | P2 R2-confirmed | **FIX — drop process-local TTL, mtime/hash revalidate per read** |
| C-7 | Evidence gate not enforceable (no `origin` field on resolve) | P2 R2-confirmed | **FIX — add origin, default-deny** |
| C-8 | Dedup key collision at ms granularity | P2 R2-confirmed | **FIX — monotonic sequence + deterministic precedence** |
| C-9 | Soak report scaling / alarm fatigue | P2 R2-confirmed | **FIX — cap top-5 + soft-quarantine after 60d non-use** |
| C-10 | Path mismatch (`~/.vanta/repos/` vs project convention `~/.gstack/projects/`) | P2 NEW in R2 | **FIX — standardize on `~/.vanta/repos/<slug>/` for v3.9-aligned paths; project decisions live in `~/.gstack/projects/`** |
| C-11 | `readActions()` OOM (loads all bak siblings synchronously) | P2 NEW in R2 | **FIX — bound active file only; bak siblings opt-in via `--all-history` flag** |
| C-12 | Cross-machine sync divergence | P2 partial-agree | **FIX — explicitly exclude rule-effectiveness from gbrain-sync; document local-only invariant** |
| W-1 | Surface Impact CLI on `vanta-rule-tune.js` | P2 false-positive | **WITHDRAWN — builder CLI is allowed per CLAUDE.md** |
| C-13 | Bak rotation policy missing for new JSONL files | P3 confirmed | **FIX — last-5 daily backs, matching v3.8.2 pattern** |
| C-14 | R3 council gate language | P3 partial | **NOOP — plan already says "R3 if R2 introduces new code paths"** |

## Hard constraints (unchanged)

| Constraint | Implication |
|---|---|
| Three-command surface | No new user commands. All v3.10 is internal machinery. |
| Invariants file is `@import` context | Anything that auto-writes there is exploitable (R7 P1). Side-channel state only. |
| Cost-honesty | Self-improvement loop runs on existing telemetry. No new LLM calls in the hot path. |
| Cross-process durability | All state via append-only JSONL with dedup-on-read. Match v3.8.2 + v3.9.0 patterns. |
| Two-eyes for irreversibility | Quarantine yes (reversible). Rule deletion no. Auto-promotion to global invariants no. |
| Local-only by default | Derived state (rule-effectiveness, evidence) does NOT cross gbrain-sync boundary unless explicitly opted-in (v3.11+) |

## Commit 0 (PREREQUISITE) — backfill `decision_id` on VantaAction

**This is not v3.10 work proper — it's a v3.9.x prerequisite that the v3.10 plan exposed.** Per council C-1, Phase A scoring requires the rule→action lineage, which is currently severed at the schema layer.

Files:
- `bin/vanta-action.js` — add `decision_id: string|null` to VantaAction schema; accept in `createAction({ decision_id })`; forward-compat read (legacy entries → null)
- `hooks/prompt-rewriter.js` — currently only logs decision_id to legacy action-log; ALSO pass to any future v3.9.0 createAction calls. (Today the rewriter doesn't directly call createAction — that's via undo handlers — but the field must exist for downstream wiring.)
- `bin/vanta-intent-undo.js` / `vanta-intent-stop.js` / `vanta-intent-reroute.js` — when these create cancellation/rollback actions, propagate the original action's `decision_id`
- `bin/vanta-cancellation.js` — record `decision_id` on cancellation entries (already has `action_id`; add the decision side)
- Tests: schema migration, forward-compat read, lineage propagation through undo+stop+reroute

**Council gate:** R1 on commit 0 diff before merge. This is a schema change to a v3.9.0 ledger — must be reviewed.

## The unit of improvement: `RuleEffectiveness` (revised)

```ts
RuleEffectiveness {
  rule_id: string
  fires: int                        // total scorable rule fires (decision events with rule_id != null)
  unscorable: int                   // C-4: fires where outcome lacked lineage; reported but not scored
  proceeded: int                    // lineage-confirmed: no undo/stop/reroute/recall on action with same decision_id within 30min RECENT_WINDOW
  recalled: int
  undone: int
  rerouted: int
  success_rate: float               // proceeded / fires (excludes unscorable)
  ci_lower: float                   // Wilson lower bound 95%
  last_50_window_rate: float        // rolling
  status: 'active' | 'flagged' | 'quarantined'
  status_reason: string|null
  status_changed_at: iso8601
  status_seq: int                   // C-8: monotonic per-rule sequence; precedence on tie via highest seq
  rule_content_hash: string         // C-3: SHA-256 of the specific rule's regex+intent+route block parsed from vanta-rewriter.js
  scoring_epoch_start_ts: iso8601   // C-5: scoring window start; resets on rehabilitate
}
```

**Lineage requirement (C-4 fix):** A rule fire is `scorable` only if a downstream undo/stop/reroute/cancellation event carries the matching `decision_id`. Without lineage, the fire is `unscorable` — counted in `unscorable`, NOT counted in `fires` for success-rate calculation. This eliminates false attribution from task switches.

**Manual recall** is the one exception: it can match on `(rule_id, project, session)` proximity even without decision_id, because manual-recall is itself the user bypassing the rewriter — that's the signal we want.

## Three-phase loop (revised)

### Phase A — Score (`bin/vanta-rule-effectiveness.js`)

Pure compute, no side effects. Reads route-quality + actions (via `readActions({ limit })`, NOT bak siblings — see C-11) + manual-recalls + cancellations.

Algorithm:
1. For each route-quality entry with `rule_id != null` and `decision === 'rewrite'`:
   - Find downstream events with matching `decision_id` in actions/cancellations/manual-recalls
   - If lineage found: classify as proceeded/undone/rerouted/recalled by event kind
   - If no lineage in 30min: mark `unscorable`
2. Filter to entries newer than the rule's `scoring_epoch_start_ts` (C-5: rehab restart)
3. Compute `fires = proceeded + undone + rerouted + recalled` (excludes unscorable)
4. Compute Wilson CI lower bound at 95%
5. Append snapshot to `~/.vanta/rule-effectiveness.jsonl` with `status_seq = max(existing_seq) + 1`

Idempotent. Safe on cron, Stop hook, on-demand.

### Phase B — Surface

- Soak report "Rule Effectiveness" section: top-5 worst (capped, C-9), freshly-quarantined since last run, freshly-rehabbed
- Soak report "Invariant Evidence" section: top-5 most-cited + top-5 unused-30d (capped at 5 each, C-9)
- Session-start brief: 🚨 line if any rule was quarantined since previous session (rate-limited to 1 line)
- vanta-patterns weekly retrospective: trends + soft-quarantine candidates (60d unused invariants, C-9)

### Phase C — Act

Quarantine eligibility (ALL must hold, unchanged):
- `fires >= 50` (post-epoch)
- `ci_lower < 0.30`
- `last_50_window_rate < 0.30`

**Cache invalidation (C-6 fix):** `vanta-rewriter.js` reads rule-effectiveness.jsonl on every `decide()` call, comparing file `mtime` against last-read mtime. If unchanged, use cached parse. If changed, re-read. NO process-local TTL. This is correct under multi-tab/multi-session because filesystem mtime is the shared source of truth.

**Rehab mechanism (C-3 + C-5 fix):**
- Manual: `node bin/vanta-rule-tune.js rehabilitate <rule_id>` appends `{rule_id, status: 'active', status_reason: 'manual-rehab', status_seq: next, scoring_epoch_start_ts: now}` — historical fires excluded from future re-quarantine via epoch filter
- Auto: extract per-rule block hash from `vanta-rewriter.js` source. If `current_block_hash !== quarantined_block_hash`, the rule was edited → auto-rehab with new epoch. mtime check is OUT — content hash is in.

**Rule block extraction:** `vanta-rewriter.js` has rules in a JS array (one literal per rule). Parser walks the AST or uses a simpler regex-based extractor: `/{\s*id:\s*['"](\w+)['"][^}]+}/g`. Hash the matched block text. Implementation note: AST-based via `@babel/parser` is more robust but adds a dependency; v3.10 ships with regex extraction, v3.11 can revisit if rule shape changes.

## Per-invariant evidence (revised)

```
~/.vanta/invariant-evidence.jsonl
{ ts, invariant_hash, event: 'retrieved' | 'council_tp' | 'unused_30d', origin: 'user-prompt' | 'internal' | null }
```

**Origin field (C-7 fix):** `vanta-resolve.js` requires explicit `origin` parameter. Default-deny for evidence logging when origin is absent. Callers:
- vanta-run skill / cross-project recall command → `origin: 'user-prompt'`
- vanta-soak-report internal computation → `origin: 'internal'` (excluded from evidence count)
- session-start brief → `origin: 'internal'` (no inflation)
- ANY caller that doesn't set origin → no evidence write at all (log warning to vlog)

This makes self-citation inflation structurally impossible without explicit caller cooperation.

**Hash:** SHA-256 of trimmed invariant text (the `- one-liner` after audit comment). Stable across audit-comment edits, breaks on text edits.

**Soft-quarantine (C-9):** After 60 days with `event: 'unused_30d'` accumulated and zero `retrieved` events, mark in soak report as "candidate for soft-quarantine — not retrieved by vanta-resolve in 60d." Soft-quarantine = exclude from default top-K retrieval ranking unless query explicitly mentions tool/topic. Reversible (any retrieval restores). NOT deletion. Surface only.

## Reflexion as bounded additionalContext (HARDENED)

Council C-2 said redaction is insufficient. The fix is structural — never persist freeform text:

```
~/.vanta/repos/<slug>/recent-failures.jsonl
{
  ts: iso8601,
  kind: 'rollback_failed'|'test_fail'|'multi_reroute',
  ttl_until: iso8601,
  // C-2 fix: structured allowlisted fields ONLY. NO freeform context field.
  exit_code: int|null,             // for test_fail
  failed_path: string|null,        // canonicalized via fs.realpathSync; rejected if outside project root
  tool_name: string|null,          // enum: 'npm'|'pytest'|'jest'|'cargo'|'go'|'tsc'|'eslint'|null
  test_id: string|null,            // first 64 chars only, alphanumeric+slash+dash+colon allowed, all else stripped
  action_id: string|null,          // for rollback_failed
  reroute_count: int|null,         // for multi_reroute
  reroute_intents: string[]|null   // enum-validated against rewriter intent corpus
}
```

**Validation pipeline:** Every field is enum-checked or path-canonicalized before write. The hint surfacer composes the user-facing string from these fields client-side using a safe template:

```js
const HINTS = {
  rollback_failed: ({failed_path, action_id}) =>
    `Rolling back ${failed_path || 'a recent edit'} failed (action ${action_id?.slice(0,8) || 'unknown'}). Check pre-commit hooks before retrying.`,
  test_fail: ({tool_name, exit_code, test_id}) =>
    `Last session ${tool_name || 'a test'} failed${exit_code ? ` (exit ${exit_code})` : ''}${test_id ? ` in ${test_id}` : ''}. Run before edits here.`,
  multi_reroute: ({reroute_count, reroute_intents}) =>
    `Last session: ${reroute_count} re-routes between ${reroute_intents?.join('→') || 'intents'}. Confirm intent before acting.`,
};
```

The freeform text never enters the prompt. Even if a malicious test outputs hostile prompt-override text in stderr/stdout, that string is never persisted — only the test exit code and tool name are.

Surface rules unchanged: 24h TTL, project-scoped, capped at 3 hints per brief.

## Curriculum: missed-intent clustering (unchanged from v1)

Bag-of-words Jaccard cluster on `~/.vanta/missed-intents.jsonl`, last 30d, threshold 0.5. Surface clusters with ≥3 unique phrases as candidate-rule hints in vanta-patterns weekly retrospective. Manual gate. Centroid only, not raw phrases.

## What ships in v3.10 (5 + 1 commits)

| # | Files | Purpose | Council gate |
|---|---|---|---|
| **0** | `bin/vanta-action.js` schema, `bin/vanta-cancellation.js`, intent handlers, tests | C-1 prerequisite: `decision_id` on VantaAction lineage | **R1 on diff before merge** |
| 1 | `bin/vanta-rule-effectiveness.js` + tests | Pure-compute scorer with C-4 lineage requirement, Wilson CI, content-hash extraction (C-3) | None (read-only) |
| 2 | `bin/vanta-evidence-log.js` + `bin/vanta-resolve.js` (origin field, C-7) + `bin/vanta-council-feedback.js` mirror | Side-channel evidence with default-deny gate | None (additive log) |
| 3 | `bin/vanta-rule-tune.js` CLI + `bin/vanta-rewriter.js` quarantine load (mtime revalidate, C-6; epoch filter, C-5) | First runtime-behavior change | **R1+R2 on diff before merge** (upgraded from R1-only — first behavior change touching the rewriter is too consequential for single-round) |
| 4 | `hooks/auto-sync.js` recent-failures appender (structured fields only, C-2) + `bin/vanta-brief.js` surfacer | Reflexion-as-context with hardened schema | **R1 on diff** (hardened schema deserves second look) |
| 5 | `tools/vanta-soak-report.js` extensions (capped surfaces, C-9) + missed-intent clusters + skill doc updates | Surface layer | None (advisory) |

## What does NOT ship in v3.10 (consciously)

(unchanged from v1 + clarified)

- Auto-write to global invariants — R7 P1
- Auto-update of rewriter regex from extracted intents — silent drift
- Self-modifying prompt rules — no oracle
- Autonomous curriculum proposer — adversarial
- RL on rule weights — small-N, hard-debug
- **Cross-machine sync of rule-effectiveness/evidence — gbrain-sync `.gitignore` line + documented local-only invariant (C-12)**
- Embedding-based clustering — Jaccard sufficient for v3.10
- AST-based rule extraction — regex sufficient for v3.10

## Risk register (revised)

| Risk | Mitigation | Council ref |
|---|---|---|
| Rule starvation from over-quarantine | 50-fire min + Wilson CI + 30d auto-rehab via content-hash change | C-3 |
| Cold-start unfairness | Same | — |
| Reflexion injection vector | **Structured fields only, no freeform text persisted; client-side template composes hint** | C-2 |
| Evidence inflation via self-citation | **Origin field on resolve(), default-deny when absent** | C-7 |
| Council attribution false-positive | Existing v3.8.2 strict gate (Jaccard ≥0.25) | — |
| Missed-intent PII leak | Redaction at write + centroid-only surface | — |
| Rewriter cold-load reads stale quarantine | **mtime revalidate per decide() call, no process-local TTL** | C-6 |
| Concurrent rule-tune writes | **monotonic status_seq + dedup-on-read by max(seq)** | C-8 |
| auto-rehab races concurrent quarantine | **Same — append-only with seq tiebreaker** | C-8 |
| Lineage gap silently miscounts | **Lineage REQUIRED; otherwise unscorable, reported but not scored** | C-4 |
| Rehab immediately re-kills | **scoring_epoch_start_ts resets on rehab; pre-epoch fires excluded** | C-5 |
| Cross-machine sync flap | **rule-effectiveness.jsonl in `.gitignore`; gbrain-sync excludes; local-only invariant documented** | C-12 |
| Path mismatch | **Standardize on `~/.vanta/repos/<slug>/` (matches v3.9 safe-mode path); project decisions stay in `~/.gstack/projects/`** | C-10 |
| readActions() OOM | **Default to active file only; bak siblings opt-in via `--all-history`** | C-11 |
| Soak-report alarm fatigue | **Cap top-5 in every section** | C-9 |
| Bak rotation unbounded | **last-5 daily backs for each new JSONL, matches v3.8.2** | C-13 |

## Council protocol for v3.10 (revised)

1. ✅ Write PLAN.md v1
2. ✅ `/council` R1+R2 on plan
3. ✅ Synthesize council findings → PLAN.md v2 (this file)
4. **Commit 0 first** — `decision_id` schema migration with R1 council on diff
5. Implement commits 1-2 in parallel (read-only, low risk)
6. **`/council` R1+R2 on commit 3 diff** before merging (upgraded from R1-only — rewriter cold-load is the first behavior change)
7. Implement commit 4 with R1 on diff (hardened reflexion schema deserves second look)
8. Implement commit 5
9. **`/council` R1+R2 on full v3.10 diff** before tag; R3 if R2 surfaces structurally new code paths
10. Soak on master 7 days minimum before `v3.10.0` tag

## Files touched (revised)

**New files:**
- `bin/vanta-rule-effectiveness.js` (~350 lines after C-4 lineage check)
- `bin/vanta-evidence-log.js` (~150 lines)
- `bin/vanta-rule-tune.js` (~250 lines after C-3 + C-5 + C-6 fixes)
- `tests/v3-10-self-improving.test.js` (~700 lines after threading all fix verifications)

**Modified files:**
- `bin/vanta-action.js` (commit 0: +20 lines for decision_id schema)
- `bin/vanta-cancellation.js` (commit 0: +5 lines for decision_id propagation)
- `bin/vanta-intent-{stop,undo,reroute}.js` (commit 0: +5 lines each for lineage propagation)
- `bin/vanta-resolve.js` (+15 lines: origin field with default-deny gate)
- `bin/vanta-council-feedback.js` (+5 lines: mirror TP attribution to evidence stream)
- `bin/vanta-rewriter.js` (+30 lines: mtime-revalidating quarantine load + content-hash extractor)
- `bin/vanta-brief.js` (+30 lines: 🚨 line surface + recent-failures hint composer with safe templates)
- `hooks/auto-sync.js` (+30 lines: recent-failures appender with structured-field validation)
- `tools/vanta-soak-report.js` (+200 lines: three new sections, capped surfaces, soft-quarantine surfacer)
- `skills/vanta-sync/SKILL.md` (+1 step: rule-effectiveness review prompt)
- `skills/vanta-patterns/SKILL.md` (+3 sections)
- `.gitignore` (+1 line: `~/.vanta/rule-effectiveness.jsonl` is local-only)

## Open questions (resolved or carried forward)

| v1 question | Resolution |
|---|---|
| Wilson CI vs Bayesian | Wilson sufficient for v3.10 |
| Log query in retrieval-evidence | Resolved: NO query, only invariant_hash + ts + event + origin (C-7 default-deny) |
| Rotation policy | Last-5 daily backs (C-13) |
| Multi-reroute threshold | ≥2 in 10min — verified in tests not adversarial |

**Carried forward to v3.11+:**
- AST-based rule extraction (vs regex)
- Embedding-based missed-intent clustering (vs Jaccard)
- Cross-machine telemetry aggregation (if needed)
- Beta-Binomial credible intervals (vs Wilson)
