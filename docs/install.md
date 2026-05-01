# Install Guide

The supported installer is the repo's `setup.sh`. Run it from the repo root:

```bash
./setup.sh
```

That single command:

- Deploys the four flat skills (`vanta-run`, `vanta-council`, `vanta-sync`, `vanta-patterns`) to `~/.claude/skills/`
- Deploys all hooks listed in `hooks/manifest.json` (the single source of truth) to `~/.claude/hooks/`
- Deploys all shared bins (`vanta-resolve`, `vanta-jsonl`, runtime-state, etc.) to `~/.claude/bin/`
- Regenerates `hooks/hooks.json` from `manifest.json`
- Wires every hook into `~/.claude/settings.json` (purges any earlier Vanta entries first to avoid drift)
- Wires `using-vanta` as always-active context via `@`-import in `~/.claude/CLAUDE.md`
- Prepends `tool-observer.js` so other plugins' blocking hooks can't shadow telemetry (R10 P1)

## Prerequisites

- Claude Code CLI installed
- Node.js 18+
- `~/.claude/` directory exists (Claude Code creates it on first run)
- Optional: `@osanoai/multicli` MCP server for `/council` (full Gemini + Codex review). Without it, `/council` falls back to PARTIAL or SOLO mode (see `skills/council/SKILL.md`).

## Uninstall

```bash
./uninstall.sh
```

Reverses what `setup.sh` did using `manifest.json` as the authoritative file list. Preserves user data (`~/.vanta/`, `~/.claude/rules/vinamr-invariants.md`). Strips the `using-vanta` `@`-import from `~/.claude/CLAUDE.md`.

## Manual install

Not supported. Earlier versions of this guide documented a nested `skills/vanta/<name>/` layout and only three hooks — that layout is incorrect for current Claude Code (skills must be flat: `~/.claude/skills/<name>/SKILL.md`, one level only) and the hook list has grown. If you need to install on a system where `setup.sh` won't run, read `setup.sh` itself — it's a few hundred lines of bash that documents every step.

## Verify

- Open a new Claude Code session
- Navigate to a project directory without `.planning/`
- Claude should offer `/vanta` proactively
- Edit a file in an `auth/` directory — `council-advisory.js` should fire
- Run a test that fails — `test-failure-advisor.js` should inject a hard-stop advisory
