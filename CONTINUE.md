# Vanta P0/P1 Security Fixes

**Started:** 2026-06-10  
**Sprint:** P0 audit findings from deep audit (2026-06-08)

## P0 — Fix before next tag

- [x] P0.1 — Test suite: wire all 14 files + fix _resolve() path order so stubs hit
- [x] P0.2 — Safety-floor: fail-closed (hardcoded MINIMAL_FLOOR on any load failure; removed env override)
- [x] P0.3 — Kill-switch: warn when module unavailable (no silent skip)
- [x] P0.4 — Shell injection: execFileSync + SHA validation in vanta-regret-detector.js

## P1 — Fix in same session

- [x] P1.1 — tool-observer slug: path.basename → slugFromCwd (fixes interrupt-rate gate always-zero)
- [x] P1.2 — manualUpgrade gate: L0→L1 only (not any level)

## Verify

- [x] `node --test --test-concurrency=1 tests/canonical.test.js` → 347 pass, 0 fail
- [x] `node --test tests/*.test.js` → 729 pass, 0 fail (all 14 files)
- [ ] `/council` before committing safety-floor + kill-switch changes (safety-critical)

## Files changed

vanta-executor.js, vanta-safety-floor.js, vanta-regret-detector.js, hooks/tool-observer.js, bin/vanta-autonomy.js, package.json

## Next after verifying

- `/council` on the safety-floor + kill-switch changes
- `/vanta-sync` to capture learnings → tag v3.13

---

## Prior state (v3.3 ship note)

Resumed your "use codex and gemini to the fullest" directive. 4 commits pushed:
`7f4ec32` v3.2 · `8da5f0d` v3.3 T1 (install bug fix) · `7708f7f` v3.3 T2 (vanta-resolve + Shadow Council) · `6d5f83b` v3.3 polish
