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
| `auto` (score ≥ 0.65) | **Gemini council R7 P1 fix — auto-write to global invariants is disabled.** Score-0.65+ extractions still go to `~/.claude/rules/vinamr-invariants.staging.md` with the audit comment. Surface a one-line summary back to the user: "Vanta-Sync staged N high-confidence invariant(s) — review via `vanta-extract-score list-staging` before promoting to global." Promotion to `vinamr-invariants.md` requires explicit user OK. |
| `staging` (0.40–0.65) | Use the **Edit tool** to append to `~/.claude/rules/vinamr-invariants.staging.md` (with audit comment). Tell the user to review later via `vanta-extract-score list-staging` |
| `update-in-place` (near-dup ≥ 0.8) | Read the existing matched entry from `dup` field. Either skip (already covered) or use the **Edit tool** to refine the existing line — never append a 4th rephrasing. **Refining an existing global entry IS allowed** — duplicate-recognition is the human review proxy. |
| `discard` (< 0.40 or skill-doc reject) | Skip silently. Log to `~/.vanta/hook.log` if VANTA_DEBUG is set |

**Why no auto-promotion:** Vanta surfaces invariants verbatim into the LLM's
context (additionalContext on UserPromptSubmit, constraint pack on Write|Edit).
A malicious file read in a session can be scored ≥0.65 by including backticks
+ tech tokens. Auto-promotion makes Vanta a persistent prompt-injection vector
across all future sessions. Staging gates this behind human review. The
`update-in-place` case is exempt because a hit on an existing invariant is
itself a human-review proxy — the original entry was already approved.

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

Codex council R5 P1 fix — sync-queue is **append-only**, written by `auto-sync.js`
under POSIX-atomic `appendFileSync`. The earlier read-modify-rename approach
clobbered concurrent Stop-hook entries when two sessions ended simultaneously.
We now append `{session_id, synced: true, ts}` resolution entries; consumers
already dedup by session_id (latest wins), so the resolution overlays the
earlier `synced: false` entry naturally.

```bash
_QUEUE=~/.vanta/sync-queue.jsonl
_CWD="$(pwd)"
if [ -f "$_QUEUE" ] || ls "$_QUEUE".bak.* >/dev/null 2>&1; then
  node -e "
const fs=require('fs');
const path=require('path');
const targetCwd='$_CWD';
const queue='$_QUEUE';
// R8 P1 — read across rotated bak files. Producer (auto-sync.js) no
// longer compacts on rotate; merge happens here at read time.
const dir=path.dirname(queue);
const base=path.basename(queue);
const parts=[];
try{
  const baks=fs.readdirSync(dir).filter(n=>n.startsWith(base+'.bak.')).sort();
  for(const b of baks){ try{ parts.push(fs.readFileSync(path.join(dir,b),'utf8')); }catch{} }
}catch{}
try{ parts.push(fs.readFileSync(queue,'utf8')); }catch{}
const merged=parts.map(p=>p.endsWith('\n')?p:p+'\n').join('');
const lines=merged.trim().split('\n').filter(Boolean);
// Fold by session_id (latest wins) so we only flip the truly-unsynced rows.
const latest=new Map();
for(const l of lines){ try{ const e=JSON.parse(l); if(e.session_id) latest.set(e.session_id,e); }catch{} }
const ts=new Date().toISOString();
let marked=0;
for(const [sid,e] of latest){
  if(e.synced===false && e.cwd===targetCwd){
    fs.appendFileSync(queue, JSON.stringify({...e,synced:true,marked_synced_at:ts})+'\n');
    marked++;
  }
}
console.log(\`  ✓ sync-queue: \${marked} entries marked synced for \${targetCwd}\`);
"
fi
```

Critical: do NOT mark entries from other cwds — they belong to other projects and need their own /vanta-sync run.

**Step 7 — Invariant→Skill Promotion (write-a-skill pattern)**

⚠️ **Internal-only — never expose to the user.** Promoted skills are
`user-invocable: false`. Claude pulls them via `Skill()` when working in the
relevant tool's domain. The user never types the skill name; Vanta's
three-command promise (`/vanta`, `/vanta-sync`, `/council`) is preserved. If
you find yourself telling the user to "run `Skill("pixijs-v8-patterns")"`,
stop — that's a Surface Impact Discipline violation.

After writing new invariants in Step 3, check whether any section has accumulated enough density to deserve a dedicated skill. Threshold:
- **≥4 distinct invariants in one `## Section`**
- All describing the **same tool / framework / library**
- Most written within the last **90 days** (recent + active surface)

If a section qualifies, propose promotion (frame it as internal infrastructure, not a new feature):

> `## PixiJS v8` has 5 invariants accumulated — dense enough that scanning
> the section costs more context than loading a focused internal-routing skill.
> Promote to internal `pixijs-v8-patterns` skill? [y/n]
> 
> Trade-off: the section stays in invariants.md (other models read it via @import).
> The skill is `user-invocable: false` — Claude routes to it automatically when
> working on PixiJS, the user never sees it. No new surface for the user.

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

For every invariant added in Step 3, run the deterministic match-open helper to find open findings (raised, not yet attributed) that the new invariant likely resolves:

```bash
node ~/.claude/bin/vanta-council-feedback.js match-open \
  --slug "$_SLUG" \
  --invariant '<invariant text>' \
  --json
```

The helper applies these criteria internally (no need to re-implement):
- Same `slug`
- Finding `ts` within last **14 days** (override via `--days N`)
- Lexical overlap classified into two strengths:
  - `strong`: word-set Jaccard ≥ 0.25 — auto-attribute candidate
  - `weak`: Jaccard 0.10–0.25 + topic substring match — **surface for human review only, do NOT auto-attribute**
- Already-resolved findings excluded automatically

**Why two strengths**: topic-substring alone (e.g., a generic invariant containing "auth") matches every auth-topic finding. Auto-TP'ing on that signal silently corrupts the accuracy dataset that Tier 6 #15 depends on — defeating the entire feedback loop.

Output (when matches found):
```json
[
  { "hash": "sha256:...", "topic": "auth", "model": "codex",
    "priority": "P1", "similarity": 0.42, "strength": "strong", "topicHit": true, ... }
]
```

**Only auto-attribute when `strength === 'strong'`.** For the top STRONG match (if any), attribute as `true-positive`:

```bash
node ~/.claude/bin/vanta-council-feedback.js attribute \
  --hash '<top.hash>' \
  --outcome true-positive \
  --evidence "invariant added $(date -u +%Y-%m-%d): <one-line invariant text>" >/dev/null 2>&1 || true
```

**Do not auto-attribute false-positives.** False-positive evidence requires negative confirmation (e.g., "we tried this and it didn't break") that auto-extraction can't reliably detect. Leave non-matched findings as `pending` — they age into `unverified` after 90d via the stats window, which is the correct signal.

Skip silently if `match-open` returns `[]` — no overlap found is a clean "nothing to attribute".

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
