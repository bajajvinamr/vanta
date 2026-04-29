# What We've Been Doing Wrong

Honest post-mortem of the AI dev setup refactor. These are habit failures, not tool failures.

---

## 1. No /council Before Building the Setup Itself

We refactored the entire AI development harness across 3 sessions. `/council` was built *during* the refactor — not run *before* it. The thing that should gate high-stakes work was absent for the highest-stakes work we've done.

**Fix:** `/council` is now a PreToolUse advisory hook. The behavioral memory tells Claude to suggest it proactively.

---

## 2. Security Key Unrotated for 2+ Sessions

`@21st-dev/magic` API key is plaintext at `~/.claude.json:829`. This was flagged as CRITICAL 2 sessions ago. Still not rotated. This is a habit failure — not a tooling gap.

**Fix:** You need to visit 21st.dev and regenerate the key. No hook can force this.

---

## 3. Wrong Install Command Suggested

We suggested `/install spyrae/gemini-plugin-cc`. The command doesn't exist in Claude Code. The correct command is `/plugin install <name>` after registering the marketplace. This is a research failure — we should have verified the Claude Code CLI reference before suggesting it.

**Fix:** gemini-plugin-cc added to `extraKnownMarketplaces`. Install via `/plugin install gemini-plugin@gemini-plugin`.

---

## 4. Multi-CLI Confusion

We listed "Remove Multi-CLI from Claude Code" as a pending infrastructure task. Multi-CLI (`@osanoai/multicli`) IS the backbone of `/council` — removing it would have silently broken adversarial review. We didn't map the dependency before suggesting removal.

**Fix:** Multi-CLI stays. It's load-bearing.

---

## 5. test-failure-advisor False Positive Risk

The pattern `/\bfailed\b/` catches generic error messages like "failed to load", "connection failed", "build failed (but recovered)". The ratio logic (`passCount > failCount * 2`) mitigates this but doesn't eliminate it.

**Fix:** Run a few sessions and monitor for false positives. If they appear, tighten the patterns to test-runner-specific formats.

---

## 6. drizzle.config.js Advisory Typo

`stack-file-nudge.js` key is `'drizzle.config.js'` but the advisory message says "drizzle.config.ts changed". The `.js` file gets the `.ts` message. Cosmetic but wrong — will confuse.

**Fix applied:** Corrected to "drizzle.config.js changed".

---

## 7. No /vanta-sync After Sessions

We built significant infrastructure (3 skills, 2 hooks, memory system, hook wiring) across 2 sessions and extracted zero learnings back into invariants. The entire point of `/vanta-sync` is preventing this.

**Invariants we should have captured:**
- Claude Code hooks receive JSON on stdin, must output to stdout; timeout exits are silent
- PreToolUse hooks inject `additionalContext` but cannot easily share state between invocations
- The `additionalContext` mechanism works for advisory injection without blocking
- `~/.claude.json` and `~/.claude/settings.json` are different files — json is state, settings is config

**Fix:** Run `/vanta-sync` now.

---

## 8. Codex Memories Disabled for 2 Sessions, Unnecessarily

We flagged `~/.codex/memories/` for security audit before re-enabling. The directory was EMPTY. A single `ls` would have confirmed this and unblocked Codex memory in under 60 seconds. We spent 2 sessions with Codex running memoryless because we didn't do the 30-second check.

**Fix applied:** Codex memories re-enabled.

---

## 9. GSD Phase Hooks Without GSD Phase Usage

The hooks `gsd-prompt-guard.js`, `gsd-workflow-guard.js`, `gsd-phase-boundary.sh` enforce GSD's phase system (PLAN → BUILD → SHIP). But we're not actually using GSD phases in our workflow — we're using `/vanta` as the entry point. These hooks may be firing and silently blocking or nagging without any actual phase being set.

**Fix:** When starting a project, run `/vanta` (which calls `/gsd-new-project`) to initialize the phase. Don't bypass this.

---

## 10. sessions.json Populated But Never Read

The statusline (`gsd-statusline.js`) shows GSD state. We set up the status line but never verified it's actually displaying. If it's showing nothing, we're flying blind on GSD phase.

**Fix:** Start a new session with `/vanta` and confirm the statusline updates.

---

## Pattern: We Build Safety Nets After the Incident

The sequence was: build something risky → discover it could go wrong → add the hook/check. The correct order is: design the safety net first, then build. `/council` was supposed to prevent this — but we built `/council` without using `/council`. This is the meta-failure.

The PreToolUse council advisory hook breaks this pattern going forward.
