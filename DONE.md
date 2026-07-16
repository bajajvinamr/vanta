# DONE.md — Definition of Done (vanta)

Nothing ships (to `~/.claude/` or as a tagged release) unless the gate below is green.

## 1. Local gate (automated)

```bash
./verify.sh
```

Must print `RESULT: PASS` and exit 0. What it runs:

| Check | Command | Blocking |
|---|---|---|
| Tests | `node --test tests/*.test.js` (729 tests) | Yes |

No build step — vanta is plain JS with no compilation.

## 2. Deploy (install to ~/.claude)

After the gate passes:

```bash
./setup.sh
```

Installs skills, hooks, and bin scripts to `~/.claude/`.

## Known gate state (as of 2026-07-17)

Live run: **729 pass, 0 fail.** The former "permanent 2-fail" was a test-isolation
bug — `recentFailures()` read the real `~/.vanta` instead of honoring
`VANTA_DIR_OVERRIDE`, so the test failed on any machine with live telemetry.
Fixed in `bin/vanta-brief.js` (canonical `_vantaDir()` seam). The gate is green
or you do not ship — no normalized failure count.

## Known environmental failure modes

- `node --test` requires Node 18+. The `--test` built-in runner was added in Node 18.
- Tests that check filesystem paths (e.g., `~/.gstack/`) may skip when the path
  doesn't exist — that is expected behavior, not a failure.
