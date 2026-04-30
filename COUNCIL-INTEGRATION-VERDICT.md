# Council Verdict — Tier-1 Skill Integration

**Mode:** PARTIAL → recovered to FULL on retry. Codex (gpt-5.4) full review;
Gemini-3.1-pro hit capacity (capacity-exhausted twice), recovered via fallback
to gemini-2.5-pro for the second voice.

**Rounds:** R1 only. Both models converged on 3 of 4 verdicts; the one
disagreement (Grill Me) resolves cleanly when interpreted: Codex saw it as
"redundant skill"; Gemini saw it as "porting the logic, not the skill" —
the Gemini framing is consistent with Vanta's "minimal user surface" promise.

## Final per-candidate decisions

| # | Skill | Verdict | Lands in |
|---|---|---|---|
| 1 | Write-a-Skill | **PORT (logic)** | `skills/vanta-sync/SKILL.md` Step 5 — invariant→skill promotion patterns when N invariants accumulate in the same section |
| 2 | Grill Me | **PORT (logic)** | `skills/vanta/SKILL.md` — internal "Low-Confidence Intent Mode" embedded in Bootstrap step. Fires only when intent is ambiguous, never user-visible as a separate skill |
| 3 | Stochastic Multi-Agent | **SKIP** | — |
| 4 | Git Guardrails | **PORT (consolidated)** | `hooks/git-guardrails.js` — single PreToolUse:Bash hook with consolidated regex table |

## Confirmed P1 findings (from both models)

### [P1] Stochastic ≠ council (Codex)
N-of-same-model consensus shares training-data blind spots. /council uses
TWO DIFFERENT MODELS deliberately to break this. Stochastic adds confident
agreement on shared errors. Never equate stochastic runs to council verdicts.
**Action:** No code change — kill the candidate. Documented in this file as
a permanent guidance.

### [P1] Hook composition behavior undocumented (Gemini)
Multiple PreToolUse:Bash hooks firing on the same command have no
documented ordering or short-circuit semantic in Claude Code. Adding
`git-guardrails.js` alongside any future bash hook risks: race condition
on the same regex match, non-deterministic ordering, or one hook's
non-zero exit not blocking subsequent hooks.
**Action:** Before porting Git Guardrails, verify Claude Code's hook runner
behavior empirically + document as an invariant in `vinamr-invariants.md`.
The ported hook should be self-contained (one regex table) so the
ordering question never arises within Vanta's surface.

### [P1] Stale forks drift from upstream (Gemini)
Porting Mattpocock's git-guardrails creates an unmaintained fork. Upstream
security fixes will be missed.
**Action:** Every ported file gets a header comment citing the upstream
repo + commit SHA + date of port. Add a quarterly check (vanta-status
suggestion?) for upstream drift.

## Confirmed P2 findings

### [P2] "Grill Me" vs "brainstorm" trigger overlap (Gemini)
Risk: user says "help me think through X" and routing is ambiguous between
brainstorm (generative) and grill-mode (reductive).
**Resolution:** the ported grill-mode is INTERNAL (only fires when vanta-run
detects ambiguous intent), not user-triggerable. Brainstorm remains the
user-facing entry. Disambiguation is structural — no overlap surface.

### [P2] Surface promise erosion (Gemini)
Vanta's "three commands" promise needs explicit guardianship. Without it,
internal-machinery additions accumulate until they become user surface.
**Action:** Add a "Surface Impact" classification to project CLAUDE.md.
Every change is either INTERNAL MACHINERY (no new user surface) or NEW
USER SURFACE (must justify against the three-command promise).

### [P2] Routing collisions if INSTALLed (Codex)
We are PORTING all three retained candidates as internal logic — no new
SKILL.md trigger files added. The collision surface stays at exactly the
three Vanta skills. **No action needed** — design avoided the risk.

## Build order (executing now)

1. **Git Guardrails** (`hooks/git-guardrails.js`) — zero deps, highest leverage
2. **Hook composition invariant** — empirical check + invariants.md entry
3. **Grill Me logic** in `skills/vanta/SKILL.md` — internal Low-Confidence Intent Mode
4. **Write-a-Skill patterns** in `skills/vanta-sync/SKILL.md` — invariant→skill promotion
5. **Surface Impact section** in `CLAUDE.md`
6. **Resume Tier 6 build** per DESIGN-T6.md order: #17 → #15 → #14 → #16

## Cross-set assessment (Gemini)

> "The proposed PORT/SKIP verdicts create a coherent set that reinforces
> Vanta's core philosophy. Guardrails and Grill Me harden the existing
> command surface without expanding it, while rejecting a feature that
> undermines /council. This batch deepens Vanta's robustness and precision,
> rather than fragmenting its purpose."

Codex was harsher ("not a coherent set") but only because Codex framed Grill
Me as a SKIP. With the PORT-as-internal-logic interpretation, the set IS
coherent — three additions that all harden existing surface without expanding
it, plus one rejection that protects the core /council differentiation.

## Verdict: PASS — proceed with PORT × 3 + SKIP × 1.
