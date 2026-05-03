# Vanta v3.11 — Transcript-Free /vanta-sync (v2)

**Status:** v2 — incorporates council R1+R2 findings (2 P1 + 4 P2 + 2 P3 resolved). Ready for implementation.
**Goal:** /vanta-sync runs on standard 200K context. Stop re-scanning the conversation transcript at sync time; harvest the structured telemetry the v3.10 hooks already write during the session.
**Surface Impact Discipline:** INTERNAL MACHINERY. /vanta-sync command unchanged. No new user-visible commands.

---

## Council R1+R2 verdict (synthesized)

| ID | Finding | Severity | Status |
|---|---|---|---|
| C-1 | Global watermark causes cross-project starvation (sync project A advances global ts → project B loses pre-A events) | P1 both-confirmed | **FIX — replace with per-slug source-ref ledger** |
| C-2 | LLM cannot locate transcript path for fallback (skill has no transcript_path on stdin) | P1 Gemini single | **FIX — extract bin discovers + emits transcript_path** |
| C-3 | Pre-score cross-source dedup absent (same fix from episodes+git+decisions = 3-4 staged dups) | P2 both-confirmed | **FIX — pre-score dedup with source-priority + staging-aware** |
| C-4 | LLM-interpolated `<slug>` violates v3.10 slugFromCwd invariant (collapses to basename(PWD)) | P2 Gemini single | **FIX — compute slug internally; remove --project CLI** |
| C-5 | Non-atomic mark-done (extract succeeds + mark-done crashes → reprocess) | P2 Codex single | **FIX — source-ref ledger replaces watermark; atomic per-ref consume** |
| C-6 | Git commit BODY as candidate pollutes scoring (this repo's bodies are dense council prose) | P2 Codex single | **FIX — subject as candidate, body as evidence; strip trailers** |
| C-7 | Soak §10 marked OPTIONAL → silent breakage; Council R1-only underestimates runtime impact | P3 both-confirmed | **FIX — §10 mandatory; council R1+R2 mandatory** |
| C-8 | `git log` in extract bin doesn't pass `--cwd`; breaks in monorepo subdirs | P3 R2-new (Gemini) | **FIX — `git -C "$cwd" log` form** |

## Why now (unchanged)

User hit `Extra usage is required for 1M context` twice in this v3.10 sprint when invoking /vanta-sync. The 1M-context tier is a per-account billing flip; users without it cannot run /vanta-sync after a long session — exactly when learning extraction matters most. This is a regression in reach, not a regression in capability.

Root cause: `skills/vanta-sync/SKILL.md` Step 1 re-scans the full conversation transcript. The v3.10 hooks already capture every signal a learning-extraction pass needs (`~/.vanta/episodes.jsonl`, `~/.vanta/recent-failures.jsonl`, `~/.gstack/projects/<slug>/decisions.md`, git log, `.planning/<phase>/RETRO.md`).

## Hard constraints (carried from v3.10, unchanged)

| Constraint | Implication |
|---|---|
| Three-command surface | /vanta-sync semantics, ergonomics, and prompts to user are unchanged. v3.11 is a Step 1 implementation swap. |
| Invariants file is `@import` context | No auto-write. Staging-with-audit-comment + manual promotion remains the v3.10 contract. |
| Cost-honesty | Extraction must run on standard 200K context. No new LLM calls in the hot path. |
| Two-eyes for irreversibility | No change. Manual review remains required to promote staging → global. |
| Local-only by default | Source-ref ledger stays local; v3.11 does not cross the gbrain-sync boundary. |
| Forward-compat | Old sessions with no episodes (pre-v3.10) must still work — fall back to transcript scan, gated and budgeted. |

## The unit of state: `SyncConsumedRef` (replaces watermark)

```ts
SyncConsumedRef {
  slug: string                  // canonical slug from slugFromCwd
  source: 'episode'|'failure'|'git'|'retro'|'decision'|'transcript'
  ref: string                   // source-specific id: session_id|hash|filepath:line|date
  ts: string                    // ISO of the source event (NOT consume time)
  consumed_at: string           // ISO of when this ref was staged
  candidate_hash: string        // SHA-256(normalized candidate text)
}
```

**Storage:** `~/.vanta/sync-consumed.jsonl` (append-only, dedup-on-read by `(slug, source, ref)`).

**Why this replaces the global watermark:**
- Per-slug isolation by construction — no cross-project starvation (C-1)
- Idempotent — crash between stage+consume → next run replays only the un-consumed refs (C-5)
- Cross-source dedup — candidate_hash collision across sources skipped before scoring (C-3)
- 7d default lookback derived from `max(ts) per slug` OR `now()-7d` if empty
- Bounded — entries older than 30d trimmed lazily on next read; never grows unbounded

**Atomicity contract:** consume ledger appended ONLY after `vanta-extract-score` write succeeds. POSIX appendFileSync < 4096B per entry → atomic per write. Matches v3.10 sync-queue / actions append-only pattern.

## What ships (4 commits + mandatory R1+R2 council before merge)

### Commit 1 — `bin/vanta-sync-extract.js` (new, ~320 lines)

Pure-extract bin. Reads structured telemetry, emits candidate learnings + transcript-path hint. Zero LLM calls.

**Inputs (CLI):**
- `--cwd <path>` — REQUIRED. Slug computed internally via `slugFromCwd()` from this. **No `--project` arg** (C-4).
- `--max <N>` — cap candidates per source (default 20)
- `--all-history` — opt-in; ignore consume ledger and emit everything in last 7d. For debugging only.

**Slug computation (C-4):**
```js
const projects = require('vanta-projects');  // shared resolver
const slug = projects.slugFromCwd(cwd);
if (!slug) { /* ambiguous basename — exit 0 with warning */ }
```

Realpath canonicalization happens inside slugFromCwd. Matches `auto-sync.js` exactly (writer/reader slug agreement, per v3.7→v3.8 invariant).

**Sources scanned (in order, all optional, all degrade-quietly):**

1. **episodes.jsonl** — `entry.ts >= lookback && entry.project === slug && (slug, 'episode', entry.session_id) NOT IN consumed`. Read across `.bak.*` siblings AND live file (C-3 R8 P1 invariant from v3.10).
2. **recent-failures.jsonl** — same pattern. Emit only `outcome: 'resolved'` (the resolution is the learning).
3. **git log** — `git -C "$cwd" log --since="$lookback" --pretty=format:'%H|%s|%b' --no-merges` (C-8). Filter to `feat:|fix:|refactor:|perf:` commit subjects. **Use commit subject as candidate text; body as evidence only** (C-6). Strip review/findings/trailer blocks (`Co-Authored-By:`, `Constraint:`, `Rejected:`, `[P1]`/`[P2]` markers, `## Round` headers) before evidence storage.
4. **`.planning/*/RETRO.md`** — any RETRO file with `mtime >= lookback`. Parse `## Lessons` / `## Invariants` / `## Gotchas` sections.
5. **`~/.gstack/projects/<slug>/decisions.md`** — entries with `## YYYY-MM-DD` headers `>= lookback`. Decision body is candidate.

**Cross-source pre-score dedup (C-3):**
```js
const SOURCE_PRIORITY = {
  decision: 0,   // human-curated, highest signal
  retro:    1,
  episode:  2,
  failure:  3,
  git:      4,   // most prone to noise from council prose
  transcript: 5, // fallback — lowest priority
};

function normalizeCandidate(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// In emit loop: maintain Map<candidate_hash, {source, priority}>
// If hash collides AND new priority >= existing priority → skip (already covered by higher source)
```

**Output schema (JSONL on stdout):**
```json
{ "type": "candidate", "source": "episode|failure|git|retro|decision",
  "ref": "session_id|hash|filepath:date",
  "ts": "<ISO>", "candidate_hash": "<sha256-prefix-16>",
  "candidate": "<≤200 chars>", "evidence": "<≤500 chars>" }
```

**PLUS** transcript-path hint (C-2):
```json
{ "type": "transcript_hint", "path": "/Users/.../transcript.jsonl",
  "session_id": "<id>", "discovered_via": "sync-queue.jsonl" }
```

Discovery: read `~/.vanta/sync-queue.jsonl` + `.bak.*`, filter to `entry.cwd === cwd OR projects.slugFromCwd(entry.cwd) === slug`, take latest unsynced. Emit at most ONE hint per run.

**Lookback computation:**
```js
const consumed = readConsumed();              // dedup-on-read
const slugMax = max(consumed.filter(c => c.slug === slug).map(c => c.ts));
const lookback = slugMax || isoMinusDays(7);  // 7-day floor for first-run
```

**Required behaviors:**
- 100MB cap on each JSONL source; tail-read latest 8MB if file exceeds (matches v3.10 `_readJsonlMerged`).
- Bak-sibling discovery for episodes/failures/sync-queue (matches v3.10 R8 P1).
- All errors swallowed silently with `vlog().warn` — sync must never block on a missing file.
- Zero git invocation if `.git` is absent (Vanta itself is non-git in some test environments).
- Composite cache key (mtime+size) for any in-memory caching, per v3.10 C-6/C-8.

### Commit 2 — refactor `skills/vanta-sync/SKILL.md` Step 1 + Step 9

**New Step 1 (telemetry-first, transcript-fallback gated):**

```
Step 1 — Harvest structured telemetry

Run: node ~/.claude/bin/vanta-sync-extract.js --cwd "$PWD"
(or repo-local: ~/Projects/vanta/bin/vanta-sync-extract.js)

Output is JSONL. Two record types:
  - {"type": "candidate", ...} — input to Step 2 (distillation)
  - {"type": "transcript_hint", "path": "..."} — fallback target

Process all "candidate" records. These are the input to Step 2.

If extract emits ZERO candidate records AND the session was non-trivial:
  1. Look for the transcript_hint record (one per run, may be absent)
  2. If present: tail -c 204800 "$path" → scan last 200KB for fix/decision markers
  3. If absent: skip transcript fallback, proceed with whatever Step 1 produced
  4. Cap at 5 candidates from transcript fallback. Note "TRANSCRIPT_FALLBACK" in source.

200KB ≈ 50K tokens (4:1 byte:token for English+code mixed). Safe within 200K context budget.
```

**New Step 3 (cross-source dedup against staging too — C-3 staging-aware):**

```
For every candidate, run `vanta-extract-score --existing=$HOME/.claude/rules/vinamr-invariants.md
                                              --staging=$HOME/.claude/rules/vinamr-invariants.staging.md`
```

Requires Commit 4: extend extract-score to accept `--staging`. Behavior: candidate matched against BOTH files via the same near-dup check; if staging hit, skip silently (already pending review).

**Step 9 (Confirm) — append source-ref consume:**

After staging is written for each candidate, append to `~/.vanta/sync-consumed.jsonl`:
```bash
node -e 'require("vanta-sync-consume").mark({ slug, source, ref, ts, candidate_hash })'
```

Atomic append. Crash before this line → next run replays the candidate (correct idempotency).

### Commit 3 — `bin/vanta-sync-consume.js` (new, ~80 lines)

Tiny module exposing:
- `read({ slug })` → returns Set of `(source, ref)` for current slug, with auto-trim of entries older than 30d
- `mark({ slug, source, ref, ts, candidate_hash })` → atomic appendFileSync < 4096B
- `lookback({ slug })` → `max(ts) || now() - 7d`

`~/.vanta/sync-consumed.jsonl` is local-only. Add to gbrain-sync exclusion list (mirrors v3.10 rule-effectiveness exclusion).

### Commit 4 — extend `bin/vanta-extract-score.js` for staging dedup

Add `--staging <path>` flag. When provided, candidate is checked against both files via existing `routeCandidate({existing, staging})` — return `route: 'staging-duplicate'` if hit, no write. Soak metric counts these.

~30 LOC change, no schema migration.

### Commit 5 — tests

`tests/v3-11-sync-extract.test.js` (~520 lines, 22 tests):

| # | Test | Council finding |
|---|---|---|
| 1 | Extracts candidates from synthetic episodes.jsonl (3 entries, 2 within window) | baseline |
| 2 | Skips entries from other slugs (slugFromCwd-based filter) | C-4 |
| 3 | Reads bak siblings AND live file, dedupes by session_id | v3.10 R8 P1 |
| 4 | Failure source: emits only `outcome: 'resolved'` | baseline |
| 5 | Git source: candidate=subject, evidence=body, body trailers stripped | C-6 |
| 6 | Git source: uses `git -C "$cwd"` form (succeeds in monorepo subdir) | C-8 |
| 7 | RETRO.md source: parses Lessons/Invariants/Gotchas sections | baseline |
| 8 | decisions.md source: emits per-date entries within window | baseline |
| 9 | Cross-source dedup: same hash from git + episode → only higher-priority emitted | C-3 |
| 10 | Cross-source dedup: source priority order respected (decision > episode > git) | C-3 |
| 11 | Lookback derived from `max(ts) per slug` in consume ledger | C-1, C-5 |
| 12 | Lookback default = now()-7d when consume ledger empty for slug | baseline |
| 13 | Per-slug isolation: project A consume entries do NOT advance project B's lookback | C-1 |
| 14 | Idempotent: extract+stage+crash before consume → second run replays the candidate | C-5 |
| 15 | Idempotent: extract+stage+consume → second run skips the candidate | C-5 |
| 16 | Slug ambiguous (basename collision) → exit 0 with warning, no candidates | C-4 |
| 17 | Slug computed via slugFromCwd; symlinked cwd → same slug as canonical | v3.7→v3.8 |
| 18 | Transcript hint emitted when sync-queue.jsonl has unsynced entry for slug | C-2 |
| 19 | Transcript hint absent when sync-queue empty or all entries synced | C-2 |
| 20 | --all-history bypasses consume ledger | baseline |
| 21 | Bounded read: 100MB cap respected; 8MB tail when over | v3.10 |
| 22 | Consume ledger auto-trims entries older than 30d on read | bounded |

`tests/v3-11-sync-consume.test.js` (~150 lines, 8 tests):

| # | Test |
|---|---|
| 1 | mark() appends entry atomically (< 4096B) |
| 2 | mark() is idempotent on (slug, source, ref) — second mark detected via dedup-on-read |
| 3 | read() dedups across `.bak.*` siblings + live file |
| 4 | read() trims entries older than 30d |
| 5 | lookback() returns max(ts) for slug when ledger has entries |
| 6 | lookback() returns now()-7d when ledger empty for slug |
| 7 | lookback() does NOT advance based on other slugs' entries |
| 8 | malformed JSON line silently skipped (no crash) |

`tests/v3-11-extract-score-staging.test.js` (~80 lines, 4 tests):

| # | Test | Council finding |
|---|---|---|
| 1 | --staging flag accepted; candidate matched against staging returns 'staging-duplicate' | C-3 |
| 2 | --staging flag absent → existing behavior unchanged (backward-compat) | baseline |
| 3 | Candidate hits global → returns 'discard' even if staging absent (existing logic) | baseline |
| 4 | Candidate hits both staging AND global → 'staging-duplicate' wins (read order) | C-3 |

All tests use `VANTA_DIR_OVERRIDE` (matches v3.10 Codex R4 P3). No tests pollute `~/.vanta`.

## What does NOT ship in v3.11 (consciously)

| Item | Reason |
|---|---|
| Embedding-based candidate dedup | Wilson + Jaccard already in vanta-extract-score; v3.11 doesn't change the scoring layer, just the input pipeline + sibling dedup |
| Cross-machine consume ledger sync | Carried forward. Local-only by design (each machine syncs its own observed sessions). |
| Full transcript removal | Forward-compat fallback retained; removing it would break legacy installs. |
| New surface (`/vanta-recall`, etc.) | Hard constraint — three-command surface holds |
| Auto-promotion of episode candidates | Staging-with-audit + manual promote remains. v3.10 R7 P1 still applies |
| Codex `/goal`-style long-horizon mode | Different architecture; conflicts with three-command surface (out of scope) |

## Risk register (revised post-council)

| Risk | Mitigation |
|---|---|
| Episodes.jsonl entries are too coarse to produce good invariants | Score-route via existing vanta-extract-score → most go to staging or discard. Bad candidates filtered, not promoted. Staging-aware dedup (C-3) prevents same fix appearing 4 times. |
| Consume ledger drift across machines (gbrain-sync user) | Local-only by design. Each machine's consumed entries do not propagate. Documented in commit 3. |
| Transcript-fallback path becomes silent default if extract is buggy | **Telemetry: every fallback invocation logged to `~/.vanta/sync-extract-events.jsonl` with `source: 'transcript_fallback'`. Soak report §10 surfaces fallback rate. >20% fallback rate = real-extract bug, alarm.** Made mandatory per C-7. |
| Old `~/.vanta/sync-queue.jsonl` consumers break | Sync-queue unchanged. v3.11 only ADDS new readers (transcript_path discovery + consume ledger); old `mark synced` step in vanta-sync Step 6 unchanged. |
| Forward-compat: pre-v3.10 sessions have no episodes | Fallback to transcript scan covers exactly this case. Fallback budgeted to 200KB → fits standard 200K context. |
| Slug ambiguous (e.g., `cwd=$HOME` or `desktop`) | slugFromCwd returns null → extract bin exits 0 with warning, no candidates. Caller (vanta-sync) handles "0 candidates" gracefully. |
| LLM still tries to read transcript directly out of habit | SKILL.md Step 1 prose explicitly says "use the transcript_hint, do not look for transcript yourself". Behavioral discipline; not enforceable mechanically. |

## Council protocol for v3.11 (revised per C-7)

**R1 + R2 mandatory** before merge (was R1-only in v1; council itself argued this was insufficient).

Both Codex (`gpt-5.4`) and Gemini (`gemini-3.1-pro-preview`), powerful tier. PARTIAL council acceptable if Gemini trust-directory blocks (matches v3.10 fallback).

R3 only if R2 introduces a NEW code path or schema change (matches v3.10 protocol).

The pre-implementation R1+R2 on PLAN.md v1 → v2 has already happened (this document is the v2 output). Post-implementation council fires on the full diff before merge.

## Files touched (revised)

**New:**
- `bin/vanta-sync-extract.js` (~320 lines)
- `bin/vanta-sync-consume.js` (~80 lines)
- `tests/v3-11-sync-extract.test.js` (~520 lines, 22 tests)
- `tests/v3-11-sync-consume.test.js` (~150 lines, 8 tests)
- `tests/v3-11-extract-score-staging.test.js` (~80 lines, 4 tests)

**Modified:**
- `skills/vanta-sync/SKILL.md` (~+40 lines for Step 1 rewrite + Step 3 staging flag + Step 9 consume mark)
- `bin/vanta-extract-score.js` (~+30 lines for `--staging` flag)
- `tools/vanta-soak-report.js` (~+60 lines for §10 fallback rate + extract success rate; **MANDATORY per C-7**)
- `setup.sh` (deploy list: add 2 new bins)

**NOT modified:**
- `hooks/auto-sync.js` — already does the right thing (writes episodes.jsonl)
- `bin/vanta-rewriter.js` — runtime unchanged
- `bin/vanta-action.js` / `vanta-cancellation.js` — orthogonal
- Any v3.10 quarantine/effectiveness machinery — orthogonal

## Done definition (revised per C-7)

- [ ] All 34 tests pass (22 + 8 + 4)
- [ ] Council R1+R2 clean (or R1+R2 converged with all P1/P2 resolved)
- [ ] /vanta-sync executes end-to-end in a synthetic 250K-token transcript with `claude-opus-4-7` (no `[1m]` suffix) without context-wall error
- [ ] Per-slug isolation verified: synthetic two-project run shows independent lookbacks
- [ ] Idempotency verified: simulated crash between stage and consume → second run replays exactly the un-consumed candidates
- [ ] Forward-compat: legacy session with no episodes still produces ≥1 candidate via transcript fallback
- [ ] No regression in v3.10 test suite (337/337 still pass)
- [ ] **Soak report §10 deployed and operational** — surfaces (a) fraction of /vanta-sync runs on standard 200K context (target ≥95%), (b) transcript_fallback rate (target <20%), (c) extract-bin success rate (target ≥99%)

## Open questions (resolved)

| v1 question | Resolution |
|---|---|
| Per-project watermark vs global | **Per-slug source-ref ledger**, replaces watermark entirely (C-1, C-5) |
| Two projects in same session | Each invocation isolated by slug; no shared mutable state to clobber |
| Pending un-synced sessions surface | UNSYNCED_SESSIONS line in vanta-run resume — unchanged |
| Verifying v3.11 worked | Soak §10 mandatory (C-7); ≥95% standard-context completion target |

**Carried forward to v3.12+:**
- AST-based candidate extraction (vs regex from auto-sync.js)
- Embedding-based candidate dedup (vs SHA-256 normalized hash)
- Cross-machine consume ledger aggregation (if gbrain-sync users surface need)
- **Away-mode / sleep-mode (v3.12 candidate):** user provides roadmap → Vanta orchestrates Claude Code or Codex for N hours autonomously while user is away. Wraps existing autonomous engines (Codex `/goal`, gstack `/autopilot`, OMC `ralph`) rather than reinventing the loop. Surface fits inside `/vanta away <hours> --roadmap <file>` (extends entry-point command, no new top-level surface). Must address: budget caps (token + wall-clock), safety gates (no push/deploy/destructive ops without checkpoint), checkpoint/resume across crashes, observability dashboard for the wake-up review, action ledger for everything done in absentia. Entirely separate phase from v3.11; explicit non-scope here.
