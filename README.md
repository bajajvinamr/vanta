# Vanta

Personal AI development protocol. Three commands that cover the full lifecycle.

Built on top of [Superpowers/gstack](https://github.com/obra/superpowers) — wraps what you need 90% of the time so you never have to remember which meta-command to run.

## Commands

| Command | When | What |
|---|---|---|
| `/vanta` | New project / resuming | Bootstrap or resume via gstack |
| `/vanta-sync` | After shipping | Extract learnings → invariants |
| `/council` | Before high-stakes changes | Gemini + Codex adversarial review |

## Structure

```
skills/          Three Vanta SKILL.md files
hooks/           council-advisory.js, test-failure-advisor.js, stack-file-nudge.js
gstack/          Reference: what gstack is, how Vanta builds on it
docs/            Install guide
VANTA.md         Full protocol documentation
WRONGS.md        Honest audit — what we've been doing wrong
```

## Install

See `docs/install.md`.

## Gstack Skills

The full Superpowers skill library is at `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/`.
See `gstack/README.md` for the full map.
