# Vanta v3.8.0 — Release Notes

Date: 2026-05-02
Branch: `master` at `347d603..` (after v3.8.0 commit lands)

This release closes the v3.7 sprint — the central executor, all open-loop
wiring, project-scoping, two-eyes enforcement, and the hygiene pass.

---

## What changed since v3.7.0

The v3.7.0 commit shipped rewriter, risk-classifier, safety-floor,
kill-switch, and peer-router as siblings. v3.7.1 → v3.7.6 promoted them
into a coherent executor layer with one decision authority and a stable
Decision shape that every hook reads.

### v3.7.1 — Prompt loop hard gate
- 12 rewriter rules, every rule carries `skill_route`
- Terse 4-line shadow injection contract
- `scripts/prompt-loop-smoke.sh` — 15-prompt hard gate
- taxonomy-rename ASK → `/council`
- Safety-floor product-decision → `/council` route surfaced

### v3.7.2 — Central executor
- `bin/vanta-executor.js` (NEW) — single `decide()` authority
- Composes kill-switch + safety-floor + rewriter + risk-classifier
- Canonical Decision shape: `{tier, decision, source, skill_route,
  intent, rule_id, rewritten, score, risk, floor, kill_switch, peer,
  budget_ms, why, confidence, context, decision_id, ts}`
- `policy/safety-floor.yaml`: NEW `prompt-bulk-delete` entry
- Hooks rewired: prompt-rewriter + council-advisory now call
  `executor.decide()` instead of reaching into helpers directly

### v3.7.3 — Critical safety fixes
- **Undo state-check**: `_undoFileWrite` verifies current SHA matches
  recorded `after_sha` before reverting; refuses with `--force` escape
- **`_undoFileDelete`**: refuses overwrite when path now exists
- **matchSymbol wiring**: council-advisory hook now extracts diff body
  from `tool_input` and passes to executor; sensitive symbols
  (`deleteCustomer(`, `TIER_PRICE = `, etc.) hit T3 ASK at write time
- **`bin/vanta-failure-escalation.js` (NEW)**: 3+ failure signals in
  10min → bump tier; 5+ → force T3
- **Semantic product-decision detector**: regex over framers + targets
  catches "should we add tiers?", "let's rename", etc. — no LLM call

### v3.7.4 — Wire open loops
- `Decision.inline_ready` (trust→mode signal — composite from
  trust-metrics; surfaced in shadow with `[Vanta INLINE]` marker)
- `Decision.effort` (huge: ≥800 lines forces T2; high: ≥200 lines or
  ≥5 files bumps 1)
- `Decision.uncertainty` (borderline rev=2..3 + blast=2..3 with no
  rule → bump 1; default 4/4 with no rule → confidence=medium)

### v3.7.5 — Per-project scoping + auto-execution gate
- `trust-metrics.compute({project, days, min_sample})`
- `readyForInline` requires min sample (default 50 actions)
- Two-eyes compound enforcement: 2+ high-risk signals → T3 + peer=both
- `setup.sh` policy versioning (`VANTA_FORCE_FLOOR_UPGRADE` env var)
- `setup.sh` bin list fixed: was missing `vanta-executor.js` and
  `vanta-failure-escalation.js` — fresh installs WERE NOT getting the
  executor

### v3.7.6 — Hygiene
- `docs/FAILURE-MODES.md` (NEW) — symptom → cause → fix index
- Manifest consistency tests: caught real drift (phase-gate.js was
  unregistered); now locked
- Contradiction-detection regression tests
- `setup.sh` idempotency tests

---

## Decision composition order

The executor composes signals in this order. Each step can short-circuit
or contribute to the final tier.

```
input: { prompt, file_path, command, diff, cwd, session_id, file_count }

1. kill-switch       → if off:        T0 + passthrough  [TERMINAL]
2. safety-floor      → if matched:    T3 + ask          [TERMINAL]
3. rewriter ASK rule → if matched:    T3 + ask          [TERMINAL]
3a. semantic detector → if matched:   T3 + ask          [TERMINAL]
3b. rewriter rule    → captures intent + skill_route + chain
4. risk-classifier   → produces base tier
4a. failure-escalation → bump (3+ failures) or force T3 (5+)
4b. effort signal    → bump 1 (high) or force min T2 (huge)
4c. uncertainty      → bump 1 if borderline + no rule
4d. two-eyes         → if 2+ signals fired together: force T3 + peer=both

5. compose: tier (after escalation) + decision (rewrite|ask|auto|passthrough)
6. inline_ready (project-scoped trust) attached as advisory
```

---

## Numbers

- **334/334 tests pass** (was 266 at v3.7.0 → +68 new tests across the sprint)
- **15/15 prompt-loop smoke** (the user-loop gate)
- **27 binaries** in `bin/`
- **12 hooks** in `hooks/` (all manifest-registered)
- **5 user-visible skills** (vanta-run, vanta-council, vanta-sync, vanta-patterns, using-vanta)
- **3 commands** (`/vanta`, `/vanta-sync`, `/council`) — same surface as v3.6

---

## Surface impact discipline check

Every commit in v3.7.x carried an explicit classification. Reviewing:

| Commit | Classification | Verified |
|---|---|---|
| v3.7.1 | INTERNAL MACHINERY | ✓ no new commands |
| v3.7.2 | INTERNAL MACHINERY | ✓ executor is a bin, not a skill |
| v3.7.3 | INTERNAL MACHINERY | ✓ undo/escalation/semantic — all bins |
| v3.7.4 | INTERNAL MACHINERY | ✓ Decision fields, no new surface |
| v3.7.5 | INTERNAL MACHINERY | ✓ trust scoping, no new commands |
| v3.7.6 | INTERNAL MACHINERY | ✓ doc + tests + manifest fix |

User surface unchanged. The three-command promise holds.

---

## Validation gates

Run before declaring v3.8.0 complete:

```bash
# 1. Test suite (must be 334+/334+ pass)
npm test

# 2. Prompt-loop smoke (must be 15/15)
bash scripts/prompt-loop-smoke.sh

# 3. Executor acceptance (must produce {tier:T3, decision:ask, floor:non-null})
node bin/vanta-executor.js --prompt "delete all users" --file users.ts

# 4. Manifest consistency (must pass — verifies hooks ↔ manifest sync)
npm test 2>&1 | grep "manifest.json"

# 5. setup.sh dry run on a clean state (idempotent — must preserve user edits)
VANTA_FORCE_FLOOR_UPGRADE=1 ./setup.sh
```

If any gate fails, do NOT tag v3.8.0. Investigate, fix, re-run.

---

## Known deferred work

These were on the original v3.7.x roadmap but pushed past v3.8.0:

- **Test file split** — `tests/canonical.test.js` is ~4500 lines. Split
  into 14 files is mechanical, not blocking, deferred indefinitely.
- **LLM rewriter latency budget enforcement** — `Decision.budget_ms` is
  wired but no LLM caller exists yet. Land when LLM rewriter ships.
- **Inline mode flip** — `inline_ready` is surfaced but the actual flip
  from shadow → inline replacement requires a wrapper command (Claude
  Code hook API can't replace prompts). Design discussion for v3.9+.
- **Project-tier memory** — global vinamr-invariants.md vs per-project
  CLAUDE.md scope. Punted to v3.9.
- **Subprocess hook tests** — have prompt-rewriter coverage; the other
  hooks (auto-sync, plan-watcher, code-index-watch) still rely on unit
  tests of their pure logic.
- **Version-bound resolver enforcement** — vanta-resolve version-stamps
  shards but doesn't refuse-on-stale-version. Land with v3.9 shard format
  changes.

---

## Council review

Adversarial review (Codex + Gemini) on the v3.7 → v3.8 series should be
the user's next action via `/council`. Hard-stop conditions:

- Unresolved P1 finding from either model
- Unresolved P2 finding both models agree on
- Real architectural bug (not just style)

If clean: tag v3.8.0 and run `/vanta-sync` to extract any session learnings.

---

## What to do next

1. Review this release-notes file
2. Run the validation gates above (all should pass)
3. Run `/council` for adversarial review (4–7 minutes)
4. If clean: `git tag v3.8.0 -m "v3.8.0 — central executor, open loops, hygiene"`
5. `git push origin v3.8.0`
6. Run `/vanta-sync` to capture session learnings into invariants

The v3.7 sprint is the harness becoming load-bearing. The user-loop
worked at 5/13 pre-v3.7.1. It works at 15/15 today.
