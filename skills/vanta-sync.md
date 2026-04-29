---
name: vanta-sync
description: End-of-milestone learning extraction. Pulls what was learned this session, distills into permanent invariants, updates global config. Run after every shipped milestone. Takes 5 minutes, makes every future project smarter.
argument-hint: ""
user-invocable: true
model: sonnet
---

# Vanta-Sync — Learning Extraction Loop

Every milestone teaches something. This skill captures it permanently so the next project starts smarter.

## When to Run (suggest this proactively)

Suggest `/vanta-sync` — without being asked — after:
- A milestone is shipped (`/gsd-ship` was just run)
- A major PR is merged
- A significant bug was fixed (especially one that took >1 hour)
- The session involved discovering a production gotcha
- The user says "done", "shipped", "that's working", "merged"

## Process

**Step 1 — Extract from session**

Run `/gsd-extract_learnings` if in a GSD project. Otherwise, scan the current session for:
- Commands that failed before working (what was the fix?)
- Errors that appeared (what caused them?)
- Workarounds applied (why were they needed?)
- Configuration that was non-obvious
- "Oh I didn't know that" moments

**Step 2 — Distill to invariants**

For each learning, ask: "Is this a discovered truth about a tool, library, or deployment environment that will still be true in 6 months?" 

If yes → it's an invariant. Format:
```
## [Tool/Service Name]
- [One-line specific fact]. [Why it matters / what breaks if ignored].
```

Reject:
- Things that are already documented (link to docs instead)
- Project-specific state (goes in project CLAUDE.md, not global)
- Things that change with version upgrades

**Step 3 — Update global invariants**

Append new invariants to `~/.claude/rules/vinamr-invariants.md`. 
- Never overwrite existing entries
- Check for duplicates before adding
- Group under existing section headers if possible, create new section if needed

**Step 4 — Propagate**

The `~/.gemini/GEMINI.md` already `@imports` the invariants file — Gemini picks this up automatically on next session.

For Codex: if invariant is Codex-relevant (build tooling, package management, API behavior), add a short note to `~/.codex/AGENTS.md` under the relevant section.

**Step 5 — Update project CLAUDE.md**

If the learning is project-specific (a particular API's behavior in this codebase, a deployment gotcha for this infra), add it to the project's `CLAUDE.md` under a `## Gotchas` section.

**Step 6 — Confirm**

Report back:
```
Vanta-Sync complete.

Added [N] invariants to ~/.claude/rules/vinamr-invariants.md:
- [list them]

Project CLAUDE.md updated: [yes/no]
Gemini picks this up automatically on next session.
```

## What Good Invariants Look Like

Good:
- "Supabase edge functions: CORS headers required on every response branch, including error paths."
- "PixiJS v8: Application.init() is async. v7 sync pattern silently produces empty canvas."

Bad:
- "Check the docs before using a new API" (too generic)
- "The auth token in this project expires after 1 hour" (project-specific state)
