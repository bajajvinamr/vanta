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

**Step 3 — Score each candidate, then write (Tier 6 #16)**

Each distilled invariant gets routed through `vanta-extract-score` BEFORE landing in the global file. This prevents wrong / duplicate / project-state entries from polluting `vinamr-invariants.md` forever, with no review gate.

For every candidate (in order):

```bash
node ~/.claude/bin/vanta-extract-score.js '<candidate text>' --existing=$HOME/.claude/rules/vinamr-invariants.md
```

The output is a JSON object:
```json
{ "route": "auto|staging|update-in-place|discard",
  "score": 0.84,
  "reasons": [...],
  "dup": null }
```

Apply the route:

| `route` | What you do |
|---|---|
| `auto` (score ≥ 0.65) | Use the **Edit tool** to append under the appropriate `## Section` header in `~/.claude/rules/vinamr-invariants.md`, **prepended with an audit comment** (see below) |
| `staging` (0.40–0.65) | Use the **Edit tool** to append to `~/.claude/rules/vinamr-invariants.staging.md` (also with audit comment). Tell the user to review later via `vanta-extract-score list-staging` |
| `update-in-place` (near-dup ≥ 0.8) | Read the existing matched entry from `dup` field. Either skip (already covered) or use the **Edit tool** to refine the existing line — never append a 4th rephrasing |
| `discard` (< 0.40 or skill-doc reject) | Skip silently. Log to `~/.vanta/hook.log` if VANTA_DEBUG is set |

**Audit comment** — every auto/staging write MUST be prefixed with:
```
<!-- vanta-sync: session=<id> ts=<ISO> confidence=<score> -->
- <invariant text>
```

This lets `git blame` trace mistakes back to the originating session and confidence at write time. Use the auditPrefix() helper from the module:

```bash
node -e "console.log(require('vanta-extract-score').auditPrefix({ sessionId: '<sid>', confidence: 0.84 }))"
```

Or hard-code the format if calling from prose: `<!-- vanta-sync: session=<sid> ts=<iso> confidence=<n.nn> -->`.

If no appropriate section exists, add a new `## [Tool/Service Name]` header at the end of the file with the audit comment + invariant directly underneath.

**Do not suggest the edit. Make the edit.** Read the file, find the right section, score the candidate, write the change with audit comment.

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

**Step 7 — Invariant→Skill Promotion (write-a-skill pattern)**

After writing new invariants in Step 3, check whether any section has accumulated enough density to deserve a dedicated skill. Threshold:
- **≥4 distinct invariants in one `## Section`**
- All describing the **same tool / framework / library**
- Most written within the last **90 days** (recent + active surface)

If a section qualifies, propose promotion:

> `## PixiJS v8` has 5 invariants accumulated. Dense enough to promote to a dedicated skill (`pixijs-v8-patterns`). Promote? [y/n]
> 
> Trade-off: the section stays in invariants.md (other models read it via @import). The skill adds usage examples + decision tree + pitfalls. Claude pulls it via `Skill("<name>-patterns")` instead of scanning the 3000-line invariants file.

If yes, apply the **write-a-skill discipline** when generating the SKILL.md:

1. **Frontmatter** — required fields, terse:
   ```yaml
   ---
   name: <tool>-patterns
   description: <one sentence — what the skill is for, when Claude should invoke>
   argument-hint: "[optional context]"
   user-invocable: false   # internal — Claude invokes when working with this tool
   model: sonnet
   ---
   ```
2. **Progressive disclosure** — 4 sections, scaling with depth:
   - **TL;DR** (1-2 lines): what the skill captures, when it applies
   - **Invariants** (the accumulated facts, formatted as a table or list with `why-it-matters`)
   - **Usage patterns** (one concrete code example per invariant, drawn from project CLAUDE.md or session transcripts where the invariant was learned)
   - **Pitfalls / when this skill DOESN'T apply** (off-label edge cases)
3. **Bundled resources** — if the tool has migration scripts, config templates, or copy-paste snippets that recur, drop them in `~/.claude/skills/<name>-patterns/resources/`. Keep the SKILL.md itself short; resources are loaded on demand.
4. **Cross-link** the invariants file: leave the section in place but add a header note:
   ```
   ## PixiJS v8
   → Detailed patterns + examples: `Skill("pixijs-v8-patterns")`
   - <existing invariants...>
   ```
5. **Deploy flatly** — `~/.claude/skills/<name>-patterns/SKILL.md` (one level deep — flat-skill invariant). Never nest under namespaces.
6. **Append to vanta-sync confirm output** that a new skill was created so the user knows to restart Claude Code for skill discovery.

**Why this exists**: ad-hoc invariant accumulation works until a section grows past ~5 entries — at that point reading the section costs more context than reading a focused skill. Promotion is the moment to refactor knowledge into a structured surface. Without this step, dense sections keep accumulating noise; with it, they crystallize into reusable skills.

**Upstream provenance**: structural discipline (frontmatter, progressive disclosure, bundled resources) adapted from mattpocock/skills/write-a-skill (MIT) and anthropics/skills/skill-creator (Apache-2.0). Promotion-by-density threshold and the cross-link pattern are Vanta-original.

**Step 8 — Attribute Open Council Findings (Tier 6 #15)**

For every invariant added in Step 3, check whether it resolves an open council finding so model accuracy data accumulates automatically.

Open findings = entries in `~/.vanta/council-feedback.jsonl` whose `finding_hash` does NOT yet appear in `~/.vanta/council-feedback-resolved.jsonl`.

Match an invariant to a finding when ALL of:
- Same `slug` (current gstack slug)
- Finding `ts` within last **14 days**
- Topic match: invariant's section header (e.g. `Supabase / Deno Edge Functions`) overlaps the finding's `topic` field, OR the invariant text overlaps the `finding_excerpt` substring (case-insensitive, ≥3 word match)

For each match, attribute as `true-positive`:

```bash
node ~/.claude/bin/vanta-council-feedback.js attribute \
  --hash 'sha256:<hash>' \
  --outcome 'true-positive' \
  --evidence "invariant added $(date -u +%Y-%m-%d): <one-line invariant text>" >/dev/null 2>&1 || true
```

**Do not auto-attribute false-positives.** False-positive evidence requires negative confirmation (e.g., "we tried this and it didn't break") that auto-extraction can't reliably detect. Leave non-matched findings as `pending` — they age into `unverified` after 90d via the stats window, which is the correct signal.

If multiple invariants match the same finding, attribute once with the most specific match.

Report attribution count in Step 9: `Attributed: 2 council findings as true-positive`.

**Step 9 — Confirm**

Report back:
```
Vanta-Sync complete.

Added [N] invariants to ~/.claude/rules/vinamr-invariants.md:
- [list them with the section they went under]

Project CLAUDE.md updated: [yes/no — if yes, what was added]
Skill promoted: [yes/no — if yes, name + path]
Council findings attributed: [N true-positive / N skipped no-match]   # Tier 6 #15
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
