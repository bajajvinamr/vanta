# Vanta v3.12 — Auto-Stage on Stop Hook

**Status:** Approved (operator-directed; v3.11 council fixes shipped immediately prior).
**Goal:** /vanta-sync becomes automatic. Stop hook auto-stages mid-quality candidates so backlog never accumulates and learnings are never lost. /vanta-sync remains as the manual high-quality interactive option.
**Surface Impact Discipline:** INTERNAL MACHINERY. Three-command surface preserved (/vanta, /vanta-sync, /council).

---

## Why now

After v3.11 shipped, sync-queue still required manual /vanta-sync invocation to clear. Live install showed 7+ unsynced sessions accumulating because the user had to remember to run it. The whole reason v3.11 lowered the cost (no more 1M-context wall) was to make running it cheap — the natural next step is to make it automatic too.

The v3.11 fix made this trivial to add: `vanta-sync-extract` is a pure CLI bin (~80ms typical), `vanta-extract-score` is pure scoring (~2ms per candidate). Wiring both into the existing Stop hook costs <200ms inside the existing 9.5s budget.

## Hard constraints (carried unchanged)

| Constraint | Implication |
|---|---|
| Three-command surface | NO new commands. /vanta-sync still works manually for higher-quality interactive flow. |
| `~/.claude/rules/vinamr-invariants.md` is `@import` context | NEVER auto-promote to global. Staging only (R7 P1). |
| Cost-honesty | ZERO LLM calls in Stop hook. Pure scoring + atomic appendFileSync. |
| Stop hook 9.5s budget | Auto-stage step must finish in <500ms typical, <2s worst case. |
| Local-only by default | Auto-stage writes to `~/.claude/rules/vinamr-invariants.staging.md` — same path as manual /vanta-sync, same review flow. |
| Audit comment required | Every auto-staged entry carries `<!-- vanta-sync: session=... ts=... confidence=... auto=true -->` so reviewer can distinguish auto from manual. |

## Quality vs quantity tradeoff (operator-decided)

| | Auto-stage (v3.12) | Manual /vanta-sync |
|---|---|---|
| Source | Direct from extract bin | LLM distillation pass |
| Quality | Mid (raw episode/git text) | High (LLM-distilled) |
| Cadence | Every meaningful session, automatic | On user invocation |
| Staging volume | Higher (more entries) | Lower (curated) |
| Lost-learnings risk | Zero (always captured) | Real if user forgets |
| Review effort | Higher per entry | Lower per entry |

**Decision:** ship auto-stage as the safety floor. Manual /vanta-sync remains for the curated polish pass. User can ignore the manual path entirely if they accept the auto-staging quality.

## What ships (4 commits)

### Commit 1 — `bin/vanta-extract-score.js` `auditPrefix({ auto })` extension

Tiny change. ~5 LOC. `auditPrefix()` accepts an optional `auto: boolean` param; when present, appends `auto=true|false` to the audit comment. Backward-compat: absent param produces v3.10/v3.11 audit format unchanged.

### Commit 2 — `hooks/auto-sync.js` auto-stage step

After existing episode/failure/sync-queue writes, run:
1. Resolve slug via `slugFromCwd(cwd)` (already done earlier in hook)
2. Lazy-require `vanta-sync-extract`, `vanta-extract-score`, `vanta-sync-consume`
3. Run extract — limit max=10 to keep it cheap
4. Read `existing` from `vinamr-invariants.md` and `staging` from `vinamr-invariants.staging.md`
5. For each candidate:
   - Run `routeCandidate(text, { existing, staging })`
   - If route is `staging` (0.40–0.65) → write to staging with audit prefix
   - If route is `auto` (≥0.65) → also write to staging (R7 P1: NEVER auto-promote to global)
   - If route is `update-in-place`, `staging-duplicate`, or `discard` → skip
6. After staging write succeeds, `consume.mark()` for that source-ref
7. Wrap entire step in try/catch — never break the Stop hook

Single-shot session-id (already in scope from earlier in the hook) is reused for the audit prefix `session=` field.

### Commit 3 — `bin/vanta-statusline.js` 📥N segment

New statusline segment: `📥N` shows count of auto-staged candidates pending review. Distinct from `⚡N` (sync-queue backlog) and `❗` (hook errors).

Implementation:
- Read `~/.claude/rules/vinamr-invariants.staging.md`
- Count audit blocks with `auto=true` (regex match)
- Display as `📥N` between `⚡N` and `❗` if N > 0

Statusline budget: <30ms hot path. One additional `fs.readFileSync` of the staging file (typically <100KB, capped read).

### Commit 4 — `tests/v3-12-auto-stage.test.js` (~280 lines, 7 tests)

| # | Test |
|---|---|
| 1 | Stop hook with synthetic session writes auto-staged entries to staging file (score≥0.40) |
| 2 | Audit prefix includes `auto=true` field |
| 3 | Score<0.40 candidates do NOT auto-stage (discard route) |
| 4 | Candidate matching existing global → `update-in-place` route → does NOT stage |
| 5 | Candidate matching existing staging → `staging-duplicate` route → does NOT stage |
| 6 | Consume ledger marked atomically per auto-staged candidate |
| 7 | Auto-stage failure (e.g. extract bin missing) does NOT crash the Stop hook |

Plus 2 statusline tests:
| # | Test |
|---|---|
| 8 | `📥N` segment renders when staging has `auto=true` blocks |
| 9 | `📥N` absent when staging has only manually-distilled entries |

## What does NOT ship in v3.12 (consciously)

| Item | Reason |
|---|---|
| LLM distillation in Stop hook | Cost-honesty + 9.5s budget. Stop hook is bin-only. |
| Auto-promote to global | R7 P1 hard constraint. Staging review remains the human gate. |
| Scheduled re-extraction (cron/daemon) | Speculative; not needed if Stop hook handles every session. |
| Cross-machine staging sync | Local-only by design (matches v3.10 invariants). |
| Session-start reminder for accumulated 📥N | v3.13 candidate; let the statusline carry the signal first. |
| Away-mode (8-hour autonomous Codex/Claude) | Carried from v3.11 PLAN.md → still v3.12.x or later. Different scope. |

## Risk register

| Risk | Mitigation |
|---|---|
| Staging file fills with mid-quality auto-extracted noise | Threshold ≥0.40 already filters. `staging-duplicate` route prevents re-staging same fix. User reviews via existing `vanta-extract-score list-staging`. |
| Stop hook latency creeps past 9.5s | Cap extract to max=10. Lazy-require modules. Wrap in try/catch with timer-bounded section. |
| Auto-staged audit prefix accidentally promoted to global | Promotion is human-gated; promotion script must read `auto=true` and refuse OR require explicit confirm. (v3.13 — not in v3.12 scope; current promotion path is manual edit.) |
| Backward-compat: old audit prefix consumers expect 3-field format | v3.10 audit consumers tolerate trailing fields (we set them via key=value pairs). Verified in pre-commit. |
| LLM still proactively suggests /vanta-sync after backlog cleared | Update `using-vanta/SKILL.md` to suppress suggestion when 📥N>0 = auto-stage handled it. Defer to v3.12.1 polish. |

## Council protocol for v3.12

Single-round R1 sufficient because:
- Pure additive change (no v3.11 behavior modified)
- Auto-stage is gated by existing scorer threshold (no new logic)
- Audit prefix change is one optional field, backward-compat
- Most surface area is reused v3.11 bins

R2 only if R1 surfaces NEW code paths or schema changes (matches v3.10/v3.11 protocol). PARTIAL council acceptable.

## Files touched

**New:**
- `.planning/v3-12/PLAN.md` (this file)
- `tests/v3-12-auto-stage.test.js` (~280 lines, 9 tests)

**Modified:**
- `bin/vanta-extract-score.js` (~+5 lines for auto field in auditPrefix)
- `hooks/auto-sync.js` (~+45 lines for auto-stage step)
- `bin/vanta-statusline.js` (~+25 lines for 📥N segment)

**NOT modified:**
- `bin/vanta-sync-extract.js` (used as-is)
- `bin/vanta-sync-consume.js` (used as-is)
- `skills/vanta-sync/SKILL.md` (manual /vanta-sync flow unchanged)

## Done definition

- [ ] All 9 v3.12 tests pass
- [ ] No regression in v3.10 + v3.11 (272/272 still pass)
- [ ] Stop hook benchmark: auto-stage step adds <500ms typical (verified on live ~/.vanta with ~100 sessions in episodes.jsonl)
- [ ] Council R1 clean (or R1+R2 converged)
- [ ] Live verification: simulated session with high-signal episode → entry appears in staging with `auto=true` audit prefix
- [ ] Statusline 📥N renders when auto-staged entries pending; clears when staging file emptied/promoted
