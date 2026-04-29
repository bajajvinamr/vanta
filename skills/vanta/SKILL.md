---
name: vanta
description: Smart project entry point. Detects current state and does the right thing — bootstrap a new project, resume an in-flight one, or execute a specific intent. One command for everything.
argument-hint: "[intent or blank]"
user-invocable: true
model: opus
---

# Vanta — Smart Entry Point

You are the universal project entry point. Read the current state and act accordingly.

## Dependency Detection (run first, silently)

Check what's available — this shapes every path below:

```
GSD_AVAILABLE   = ~/.claude/skills/gsd-new-project/ exists
GSTACK_AVAILABLE = ~/.claude/skills/gstack/ exists
SP_AVAILABLE    = brainstorm skill is invocable
```

## State Detection

Check in order:

1. **No `.planning/` directory** → Fresh project. Run Bootstrap.
2. **`.planning/` exists, no active phase** → Resuming. Load state and show what's next.
3. **`.planning/` exists, active phase** → Mid-flight. Resume from exact position.
4. **Arguments provided** → Intent mode. Plan and execute it.

## Bootstrap (state 1)

When starting fresh:

**If GSD is available:**
1. Run `/gsd-new-project` to initialize `.planning/`
2. Run `/gsd-plan-phase` to break the project into phases

**If GSD is absent, superpowers available:**
1. Use `Skill("brainstorming")` to design the project
2. Then `Skill("writing-plans")` to produce the implementation plan

**If neither — native planning:**
1. Ask: "What are we building?" (2-3 sentence brief)
2. Propose 2-3 approaches with tradeoffs
3. Write a `.planning/plan.md` directly

**Always after planning (regardless of path):**
1. Create `AGENTS.md` at project root:
   - Codex role: reviewer/verifier only, never primary implementer
   - Stack from `~/.claude/rules/vinamr-invariants.md`
   - Non-negotiables (no force-push, conventional commits, confirm before destructive ops)
2. If source files exist AND `docs/CODEMAP/` does not exist AND `codemap` skill is available:
   - Invoke `Skill("codemap")` to build the initial codebase index
   - Emit: "Codebase indexed. Ask 'what does X do' to query without re-reading files."
   - Skip if project has no source files yet (pure planning stage)
3. If architecture involves auth, payments, AI pipelines, multi-service, or >10 files → offer `/council`
4. Tell the user: "Set up. I'll tell you when to run `/council` or `/vanta-sync`."

## Resume (states 2–3)

First, silently check the sync queue:

```bash
_QUEUE=~/.vanta/sync-queue.jsonl
if [ -f "$_QUEUE" ]; then
  _UNSYNCED=$(grep -c '"synced":false' "$_QUEUE" 2>/dev/null || echo 0)
  [ "$_UNSYNCED" -gt 0 ] && echo "UNSYNCED_SESSIONS: $_UNSYNCED"
fi
```

If UNSYNCED_SESSIONS > 0: before loading phase state, emit:
> "You have N session(s) with unsaved learnings. Run `/vanta-sync` to capture them, or type 'skip' to continue."

Wait for response. If skip/no: proceed. If yes/sync: invoke `Skill("vanta-sync")`, then continue.

When resuming:
1. Read `.planning/` to reconstruct state
2. Show: last completed phase / current phase / what's blocked
3. If `docs/CODEMAP/INDEX.json` exists: check if recent commits landed since its `generated_at` timestamp
   ```bash
   _CM=docs/CODEMAP/INDEX.json
   if [ -f "$_CM" ]; then
     _CM_DATE=$(python3 -c "import json,sys; print(json.load(open('$_CM')).get('generated_at',''))" 2>/dev/null || echo "")
     [ -n "$_CM_DATE" ] && git log --oneline --since="$_CM_DATE" -- . 2>/dev/null | grep -q . && echo "CODEMAP_STALE: yes"
   fi
   ```
   If CODEMAP_STALE: suggest "Codebase changed since last index. Run `/codemap` to refresh?"
4. Continue from exact stopping point — do NOT ask the user to re-explain context

## Intent Routing (pre-check before state 4)

Before treating an argument as a generic intent, match it against the routing table.
Check GSTACK_AVAILABLE and GSD_AVAILABLE before invoking. Match on keywords anywhere in the phrase.

**Single-Action Routes:**

| Trigger keywords | Framework | Invocation |
|---|---|---|
| "ship", "open pr", "create pr", "deploy", "push this", "merge this" | gstack | `Skill("gstack")` with context "run /ship" |
| "qa", "test the site", "does it work", "check the ui", "smoke test" | gstack | `Skill("gstack")` with context "run /qa" |
| "review", "check my diff", "check my changes" | gstack OR GSD | see collision rule below |
| "debug", "something's broken", "it's broken", "error", "exception" | GSD | `Skill("gsd-debug")` |
| "write tests", "add tests", "test coverage", "test this" | GSD | `Skill("gsd-add-tests")` |
| "code review", "do a code review" | GSD | `Skill("gsd-code-review")` |
| "investigate", "find the bug", "trace this", "what's causing" | gstack | `Skill("gstack")` with context "run /investigate" |
| "brainstorm", "i have an idea", "let's think", "help me think" | superpowers | `Skill("brainstorming")` |
| "plan this", "plan the feature", "new phase", "break this down" | GSD | `Skill("gsd-plan-phase")` |
| "checkpoint", "save progress", "save state", "save context" | gstack | `Skill("gstack")` with context "run /checkpoint" |
| "refactor", "clean this up", "simplify this", "tidy up" | gstack | `Skill("gstack")` with context "run /review" |
| "document this", "write docs", "update docs", "add documentation" | gstack | `Skill("gstack")` with context "run /document-release" |
| "update deps", "bump packages", "dependency check", "health check" | gstack | `Skill("gstack")` with context "run /health" |
| "deploy to prod", "go live", "land this", "push to production" | gstack | `Skill("gstack")` with context "run /land-and-deploy" |
| "what's next", "what should I do", "next step", "where do we go" | GSD | reads `.planning/` → emits next unblocked task, or `Skill("gsd-next")` |
| "is this complete", "am I done", "verify this", "did it work" | GSD | `Skill("gsd-verify-work")` |
| "restore context", "where was I", "load context", "resume context" | gstack | `Skill("context-restore")` |
| "retro", "what did we learn", "retrospective", "reflect" | gstack + vanta | `Skill("gstack")` with context "run /retro", then `Skill("vanta-sync")` |
| "security audit", "check security", "audit this", "cso" | gstack | `Skill("gstack")` with context "run /cso" |
| "office hours", "strategy session", "roadmap review", "think with me" | gstack | `Skill("gstack")` with context "run /office-hours" |
| "execute phase", "start the phase", "let's build it", "build this", "start building" | GSD | `Skill("gsd-execute-phase")` |
| "resume work", "pick up where", "continue the phase", "get back to work" | GSD | `Skill("gsd-resume-work")` |
| "complete milestone", "wrap up milestone", "milestone done" | GSD | `Skill("gsd-complete-milestone")` |
| "write the plan", "document the approach", "spec this out" | superpowers | `Skill("writing-plans")` |
| "execute the plan", "run the plan", "implement the plan" | superpowers | `Skill("execute-plan")` |
| "follow tdd", "test first", "tdd this", "test-driven" | superpowers | `Skill("tdd-workflow")` |
| "verify before done", "check before shipping", "pre-ship check" | superpowers | `Skill("verification-before-completion")` |

**Collision Rule:**
- "review this" matches both gstack `/review` AND `gsd-code-review`
- If gstack already fired this session → prefer `Skill("gsd-code-review")` (avoid preamble spam)
- If gstack has NOT fired → prefer `Skill("gstack")` with context "run /review"
- Always confirm on cross-framework collision before invoking

**Compound Action Routes:**

| Trigger keywords | Vanta does |
|---|---|
| "resume and ship", "get this ready to ship", "pick up and ship" | reads .planning/ state → chains /review → /qa → /ship |
| "resume and debug", "pick up and debug" | reads .planning/ state → invokes `Skill("gsd-debug")` |
| "resume and plan", "pick up and plan next" | reads .planning/ state → invokes `Skill("gsd-plan-phase")` |
| "retro and sync", "end of sprint", "wrap up this sprint" | `Skill("gstack")` with context "run /retro" → `Skill("vanta-sync")` |
| "review and ship", "review then merge", "check and deploy" | `Skill("gstack")` with context "run /review" → confirm → `Skill("gstack")` with context "run /ship" |

Compound route format — emit before chaining:
```
[Vanta] <project> · Phase N/M: <phase-name> · Last: <skill> <time-ago>
Chain: /review → /qa → /ship. Proceed? [y/n]
```
On confirmation: invoke each step in sequence. Confirm each step's output before chaining next.

**Routing feedback:** Always emit one line before invoking any route:
- High-confidence single-framework match: `→ Routing to /<skill> via <framework>. Proceeding.`
- Cross-framework collision or compound route: `→ Routing to /<skill> via <framework>. Proceed? [y/n]`

**On routing miss:** When no keyword matches:
1. Log the miss by running this Bash block (replace PHRASE with the actual unmatched text):
```bash
mkdir -p ~/.vanta
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"phrase\":\"PHRASE\",\"fallthrough\":\"generic-intent\"}" >> ~/.vanta/missed-intents.jsonl
```
2. Emit: "Routing miss — phrases I understand: ship this · review this · debug this · write tests · checkpoint · what's next · retro · investigate"
3. Fall through to state 4 generic intent handling.

## Intent (state 4)

When given an argument that did not match routing:
1. Treat as a feature/task description
2. Check if it fits current phase or needs a new phase
3. Plan with GSD (`/gsd-plan-phase`) if available, else describe the steps inline
4. Execute

## Proactive Suggestions (always active)

After significant work in a session:
- Milestone complete → invoke `Skill("vanta-sync")` or say "This is a good time for `/vanta-sync`."
- Before arch change or large refactor → "Want a `/council` review before we start?"
- When conversation has had many exchanges and a new large task begins → "This session is getting long. Run `/compact` before we start, or I may lose track of earlier decisions."

**If gstack is available**, invoke directly (do not suggest — invoke):
- Before merging → `Skill("gstack")` with context "run /ship — tests + PR"
- Browser testing needed → `Skill("gstack")` with context "run /qa"
- Pre-merge code review → `Skill("gstack")` with context "run /review"

## What You Never Do

- Never ask the user to remember a sub-command — you run it or suggest it
- Never start implementing >3 files without a plan
- Never call a skill that might not be installed without checking first
