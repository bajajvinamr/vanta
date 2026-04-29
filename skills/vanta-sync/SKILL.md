---
name: vanta-sync
description: End-of-milestone learning extraction. Pulls what was learned this session, distills into permanent invariants, writes directly to vinamr-invariants.md using the Edit tool. Run after every shipped milestone.
argument-hint: ""
user-invocable: true
model: sonnet
---

# Vanta-Sync — Learning Extraction Loop

Every milestone teaches something. Capture it permanently so the next project starts smarter.

## When to Run (suggest proactively)

Suggest without being asked after:
- Milestone shipped (`/gsd-ship` ran or equivalent)
- Major PR merged
- Significant bug fixed (especially >1 hour)
- Session involved discovering a production gotcha
- User says "done", "shipped", "that's working", "merged"

## Process

**Step 1 — Extract from session**

Check dependency:

- **GSD available** (`~/.claude/skills/gsd-extract_learnings/` exists):
  Run `/gsd-extract_learnings` to pull structured learnings from `.planning/`

- **GSD absent — manual extraction:**
  Scan the current session for:
  - Commands that failed before working (what was the fix?)
  - Errors that appeared (root cause?)
  - Workarounds applied (why needed?)
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
- Things already documented (link to docs instead)
- Project-specific state (goes in project CLAUDE.md)
- Things that change with version upgrades

**Step 3 — Write directly to global invariants**

Read `~/.claude/rules/vinamr-invariants.md` first. Then use the **Edit tool** to append new invariants under the appropriate section header. Do not overwrite existing entries. If no appropriate section exists, add a new `## [Tool/Service Name]` header at the end of the file.

Example of what a correct Edit looks like — appending under an existing section:
```
old_string: "## Prisma\n\n- `prisma migrate deploy`..."
new_string: "## Prisma\n\n- `prisma migrate deploy`...\n- [new invariant here]."
```

Or appending a new section at the end:
```
old_string: "[last line of file]"
new_string: "[last line of file]\n\n## [New Tool]\n\n- [invariant]."
```

**Do not suggest the edit. Make the edit.** The invariants file is `~/.claude/rules/vinamr-invariants.md`. Read it, find the right section, write the change.

**Step 4 — Propagate to other models**

`~/.gemini/GEMINI.md` already `@imports` the invariants file — Gemini picks this up automatically.

For Codex: if the invariant is relevant to build tooling, package management, or API behavior, use the **Edit tool** to append a short note to `~/.codex/AGENTS.md` under the relevant section.

**Step 5 — Update project CLAUDE.md (mandatory)**

For EVERY learning extracted in Step 1, explicitly ask: "Is this specific to this project's stack, config, or codebase (not a general tool fact)?"

If yes → use the **Edit tool** to append to `./CLAUDE.md` under `## Gotchas` (create section if absent). Do not skip this. Do not ask — just write it.

Format:
```
## Gotchas

- [one-line fact specific to this project]. [what breaks if ignored].
```

If no learnings are project-specific: note "Project CLAUDE.md: no project-specific learnings this session." Do not leave this step unaddressed.

**Step 6 — Mark synced sessions (scoped to current project)**

Only mark entries for the CURRENT project (cwd) — never touch other projects' unsynced entries.
Uses atomic write (tmp + rename) so a concurrent Stop hook `appendFileSync` can't be silently overwritten:

```bash
_QUEUE=~/.vanta/sync-queue.jsonl
_CWD="$(pwd)"
if [ -f "$_QUEUE" ]; then
  node -e "
const fs=require('fs');
const targetCwd='$_CWD';
const queue='$_QUEUE';
// Re-read at the moment of write to minimize the race window.
const lines=fs.readFileSync(queue,'utf8').trim().split('\n').filter(Boolean);
let marked=0;
const updated=lines.map(l=>{
  try{
    const e=JSON.parse(l);
    if(e.synced===false && e.cwd===targetCwd){ e.synced=true; marked++; }
    return JSON.stringify(e);
  }catch{return l;}
});
const tmp=queue+'.tmp';
fs.writeFileSync(tmp,updated.join('\n')+'\n');
fs.renameSync(tmp,queue);
console.log(\`  ✓ sync-queue: \${marked} entries marked synced for \${targetCwd}\`);
"
fi
```

Critical: do NOT mark entries from other cwds — they belong to other projects and need their own /vanta-sync run.

**Step 7 — Confirm**

Report back:
```
Vanta-Sync complete.

Added [N] invariants to ~/.claude/rules/vinamr-invariants.md:
- [list them with the section they went under]

Project CLAUDE.md updated: [yes/no — if yes, what was added]
Gemini picks this up automatically next session.
```

## What Good Invariants Look Like

Good:
- "Supabase edge functions: CORS headers required on every response branch, including error paths."
- "PixiJS v8: Application.init() is async. v7 sync pattern silently produces empty canvas."
- "Claude Code hooks: PreToolUse hooks inject additionalContext but cannot share state between invocations."

Bad:
- "Check the docs before using a new API" (too generic)
- "The auth token in this project expires after 1 hour" (project-specific state)
