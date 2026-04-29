# Install Guide

## Prerequisites

- Claude Code CLI installed
- `~/.claude/` directory exists
- Multi-CLI MCP: `@osanoai/multicli` (for `/council`)

## Step 1 — Install Superpowers Plugin

In Claude Code:
```
/plugin install superpowers@claude-plugins-official
```

## Step 2 — Copy Skills

```bash
mkdir -p ~/.claude/skills/vanta
cp -r skills/vanta ~/.claude/skills/vanta/vanta
cp -r skills/vanta-sync ~/.claude/skills/vanta/vanta-sync
cp -r skills/council ~/.claude/skills/vanta/council

# Skills must be directories with SKILL.md inside
# Verify:
ls ~/.claude/skills/vanta/
```

Note: Skills in Claude Code must be directories named after the command, with a `SKILL.md` inside. The `/vanta` command loads from `~/.claude/skills/vanta/vanta/SKILL.md`.

## Step 3 — Install Hooks

```bash
cp hooks/council-advisory.js ~/.claude/hooks/
cp hooks/test-failure-advisor.js ~/.claude/hooks/
cp hooks/stack-file-nudge.js ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.js
```

## Step 4 — Wire Hooks in settings.json

Add to `~/.claude/settings.json` under `hooks`:

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/council-advisory.js", "timeout": 5 }]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/test-failure-advisor.js", "timeout": 8 }]
    },
    {
      "matcher": "Write|Edit",
      "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/stack-file-nudge.js", "timeout": 5 }]
    }
  ]
}
```

## Step 5 — Add Vanta Protocol to CLAUDE.md

Add the `## Vanta Protocol` section from `VANTA.md` to your `~/.claude/CLAUDE.md`.

## Step 6 — Add gemini-plugin Marketplace (optional)

In `~/.claude/settings.json` `extraKnownMarketplaces`:
```json
"gemini-plugin": {
  "source": { "source": "github", "repo": "spyrae/gemini-plugin-cc" }
}
```

Then install:
```
/plugin install gemini-plugin@gemini-plugin
```

## Step 7 — Enable Codex Memories

In `~/.codex/config.toml`:
```toml
[memories]
generate_memories = true
use_memories = true
disable_on_external_context = true
```

## Verify

- Open a new Claude Code session
- Navigate to a project directory without `.planning/`
- Claude should offer `/vanta` proactively
- Edit a file in an `auth/` directory — `council-advisory.js` should fire
- Run a test that fails — `test-failure-advisor.js` should inject a hard-stop advisory
