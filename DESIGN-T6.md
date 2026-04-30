# Tier 6 Design — Trust + Resilience Layer

Tier 6 is the layer where Vanta stops trusting itself implicitly. Tiers 2–5
made the resolver fast, scoped, and observable. Tier 6 makes it *honest*:
when sources disagree, when council was wrong, when extraction was noisy,
when remote models go down — surface and degrade gracefully instead of
emitting confident-sounding falsehood.

Four bounded changes. Each ships independently. Each maps to one current
silent-failure mode.

---

## #14 — Cross-source contradiction detection

### Problem

Resolver returns ranked results from 5 sources. They can disagree silently.
Example: an invariant says "ES256 asymmetric for pi-perception JWTs" but a
year-old decision says "HS256 chosen". Both inject into council-advisory's
CONSTRAINT PACK. The LLM reads contradictory facts as equally weighted truth.

Real impact: pi-perception had this exact bug last quarter. Fixed in invariants
but old decisions.md kept saying HS256.

### Design

```ts
// new in vanta-resolve.js
type ContradictionSignal = {
  pair: [Result, Result];          // the two conflicting entries
  type: 'binary' | 'numeric' | 'keyword';
  confidence: number;               // 0..1 heuristic
  hint: string;                     // human-readable summary
};

function detectContradictions(results: Result[]): ContradictionSignal[];
```

**Detection heuristics** (conservative — false positives are noise, but
false negatives are the actual bug we ship):

1. **Binary opposition keywords** — pairs that frequently flip in this
   codebase:
   ```
   ES256 ⇄ HS256
   sync ⇄ async (in PixiJS context)
   v7 ⇄ v8 (in PixiJS context)
   include ⇄ exclude
   should ⇄ must not
   "use X" ⇄ "don't use X" / "avoid X"
   ```
   When two results land in the same query and one mentions one half, the
   other mentions the other half, flag it.

2. **Same-section contradiction** — two invariants in the same `## Section`
   that both contain "must" or "always" but mention different concrete values
   for the same variable.

3. **Date-aware**: if invariant (newer) says X and decision (older) says ¬X,
   the invariant wins implicitly via score weight. We still surface the
   flag — the older decision should be deprecated, not just outscored.

### Output integration

- `resolve()` adds `contradictions: ContradictionSignal[]` to the return.
- `council-advisory.js` adds a new section to CONSTRAINT PACK when
  `contradictions.length > 0`:
  ```
  ⚠️ CONTRADICTION DETECTED — resolve before implementing:
    - invariant says "ES256 asymmetric required"
    - decision (2025-08-12) says "HS256 chosen"
    Newer source likely correct; consider /council to deprecate old decision.
  ```

### Test surface

- Seed two contradictory invariants → detector flags exactly one
  ContradictionSignal
- Seed an invariant + a SUPERSEDED decision → detector does NOT flag (the
  supersession filter already handled it)

### Risk

False positives. Mitigated by: only flag when both members of a known binary
pair are present + confidence ≥ 0.7. Underclaim is safe; overclaim adds noise
to every Write|Edit hook.

---

## #15 — Council quality feedback

### Problem

`/council` produces verdicts. We never measure whether they were right.
Bad councils — false-positive P1s that wasted hours, false-negative misses
that caused incidents — drift forever. Each model's blind spots are
unobservable.

### Design

Two new artifacts:

**`~/.vanta/council-feedback.jsonl`** — one line per council finding:
```json
{
  "ts": "2026-04-30T08:00:00Z",
  "council_run": "2026-04-30T07:55:00Z",
  "model": "codex" | "gemini" | "synthesis",
  "round": 1 | 2,
  "priority": "P1" | "P2" | "P3" | "P4",
  "topic": "auth",
  "slug": "pi-perception",
  "finding_hash": "sha256:...",       // for dedup
  "finding_excerpt": "...",
  "verdict": "raised",
  "outcome": null,                    // filled later by sync-feedback
  "outcome_ts": null
}
```

**`~/.vanta/council-feedback-resolved.jsonl`** — appended by `vanta-sync`:
```json
{
  "council_run": "2026-04-30T07:55:00Z",
  "finding_hash": "sha256:...",
  "outcome": "true-positive" | "false-positive" | "unverified",
  "evidence": "fix landed at <commit>" | "never reproduced after 30d" | ...
}
```

### Linking heuristic (the hard part)

Council finding → outcome is fuzzy. Use:
- Same project slug + same topic + within 14 days = candidate match
- If a `vanta-sync` extraction in that window adds an invariant covering the
  same regex/keywords → likely **true-positive** (the council found something
  that became a durable invariant)
- If the topic appears in `episodes.jsonl` with `outcome: "resolved"` and the
  finding's regex matches the decision text → **true-positive**
- If 30 days pass with no related extraction or episode → **unverified**
  (don't claim either way)
- Explicit user override via `vanta-council-feedback <hash> <true|false>`

### Reporting

`vanta-resolve --council-stats` (or extend `--analyze`):
```
=== council quality (90d) ===
total findings: 47   tp: 18   fp: 6   unverified: 23
Codex P1 accuracy:   12/14 (86%)
Gemini P1 accuracy:   8/11 (73%)
Disputed (one model raised, other didn't):
  - 9 findings, 7 turned out tp → keep firing both models
```

### Risk

Heuristic linking can mis-attribute. Mitigation: never use stats to silence a
model. Stats are advisory only — both models always fire on /council.

---

## #16 — Auto-extraction safeguards

### Problem

`vanta-sync` extracts invariants from session transcripts. If extraction is
wrong, the polluted invariant lands in `~/.claude/rules/vinamr-invariants.md`
and influences every future Claude/Gemini/Codex session. Once. Forever. No
review gate.

Concrete failure modes seen:
- Skill documentation paragraphs misclassified as invariants (Tier 5 had to
  add SKILL_DOC_PHRASES rejection list)
- Project-specific facts (LW's `child_name` PII) leaking into the global file
- Duplicate invariants when extraction re-fires for the same topic

### Design

**Three-stage write pipeline:**

```
session transcript
  ↓ extract candidate invariants (existing)
  ↓ score each candidate (NEW)
       confidence_score = 0..1 based on:
         - decision-marker proximity (closer = higher)
         - distinct technical keywords (more = higher)
         - length (10-300 chars sweet spot)
         - dup-similarity vs existing invariants (lower if novel)
  ↓ route by score:
     ≥ 0.8  → ~/.claude/rules/vinamr-invariants.md  (auto-commit, with audit comment)
     0.5–0.8 → ~/.claude/rules/vinamr-invariants.staging.md  (user reviews)
     < 0.5  → discard with debug log line in hook.log
```

**Audit comment** — every auto-extracted invariant gets prefixed with:
```html
<!-- vanta-sync: session=<id> ts=<iso> confidence=0.87 -->
- ES256 asymmetric JWTs for pi-perception edge functions...
```
Lets the user `git blame` mistakes back to the originating session and the
extractor's confidence at the time.

**Diff-aware writes**:
```ts
function findExistingMatch(candidate: string, file: string): { line: number, similarity: number } | null;
```
If similarity ≥ 0.8 to an existing invariant in the same section, propose
"update in place" instead of "append". Prevents the same invariant getting
rephrased and added 3 times.

**`vanta-sync --commit-staging`** — manual review command:
```
=== staging invariants (3 pending) ===
[1] confidence=0.62  section=PixiJS v8
    - When you call await app.init(), texture loading must happen after...
    Action: [a]ccept / [r]eject / [e]dit / [s]kip
```

### Risk

User never reviews staging file → invariants pile up there silently. Mitigation:
status command surfaces staging line count; `vanta-status` already has the
QUEUES section, add a `staging` row.

---

## #17 — Robust Multi-CLI degradation

### Problem

Council currently relies on Multi-CLI MCP. Failure modes seen:
- Gemini exits 55 (trust workspace) → handled
- Gemini capacity-exhausted (server overload) → council silently downgrades to
  Codex-only PARTIAL, no retry
- Codex breaks on `approvalPolicy`/`sandbox` args → documented but no guard
- Network hang (>2min) on Multi-CLI call → user sees nothing, command appears stuck
- Both fail → "neither available" message but no concrete fallback action

### Design

**Three layers of resilience:**

1. **Pre-flight ping** — before R1, fire a 5-token sanity prompt at each model
   with a 10s timeout. If either fails the ping:
   - Mark unavailable for this run
   - Skip its R1 fire — don't burn 60s on a model that won't respond
   - Emit explicit reason: `Codex: trust workspace not set` / `Gemini: 503`

2. **Per-call timeout wrapper** — every Multi-CLI invocation gets wrapped:
   ```ts
   async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
     return Promise.race([
       p,
       new Promise<never>((_, reject) =>
         setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
       ),
     ]);
   }
   ```
   R1 timeout = 90s. R2 timeout = 60s (smaller prompt). On hit, mark
   unavailable + emit user-visible warning.

3. **Retry policy** — 1 retry with 5s backoff ONLY on transient errors:
   - `capacity-exhausted` (Gemini)
   - HTTP 502 / 503 / 504
   - `timeout`
   NOT on:
   - auth errors (won't help)
   - argument errors (broken prompt)
   - 4xx other than rate limit

4. **Cascading fallback**:
   ```
   both alive             → FULL council (existing path)
   one alive              → PARTIAL (existing) — explicit "running solo R2"
                            note: model reacts to its OWN R1 findings
   neither alive          → SOLO ADVERSARIAL (Skill("solo-review"))
                            with explicit "Multi-CLI both unavailable" banner
   ```

### Output structure (extend existing)

```json
{
  "verdict": "PASS",
  "mode": "FULL" | "PARTIAL" | "SOLO",
  "rounds": "R1" | "R1+R2" | "R1+R2-converged",
  "model_health": {
    "gemini": { "available": true, "ping_ms": 230, "r1_ms": 45000, "r2_ms": null },
    "codex":  { "available": false, "reason": "capacity-exhausted (1 retry exhausted)" }
  },
  ...
}
```

### Risk

Pre-flight ping adds ~10s latency on every council run. Acceptable —
council is already 2-7min. Ping cost is in the noise. Mitigation: cache
"available" verdict for 5min within a session to avoid re-pinging on
back-to-back councils.

---

## Build order (after council convergence)

The 4 items are independent. Recommended order by dependency:

1. **#17 first** — robust degradation. Everything else assumes council can
   actually run; this hardens the foundation.
2. **#15 second** — feedback infra. Cheap to build (just append-only logs).
   The aggregation half waits for real data.
3. **#14 third** — needs no infra; pure resolver-side function.
4. **#16 last** — touches user-facing extraction; benefits from #15 feedback
   data to tune confidence thresholds.

Each is one commit. Tests required for #14 (pure function, easy) and #17
(timeout/retry wrapper, mockable). #15 and #16 get integration smoke tests.

---

## What this design does NOT include

- **No vector DB or embedding lookups.** Contradiction detection stays
  regex/heuristic. The corpus is small enough that semantic similarity is
  premature optimization.
- **No telemetry to external services.** All feedback stays local in
  `~/.vanta/`. The council-feedback log can be inspected; nothing is
  shipped anywhere.
- **No automatic verdict overrides.** Council quality stats are observational
  only. We never silence a model based on past accuracy — that would
  introduce a bias loop.
