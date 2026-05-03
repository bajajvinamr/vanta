---
name: using-vanta
description: Vanta session protocol — when and how to invoke /vanta, /vanta-sync, and /council proactively. Loaded at every session start. Vinamr focuses on building; Claude manages when to run meta-commands.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

# Vanta — Session Protocol

Vanta has three commands. **You manage when to run them. Never make Vinamr remember.**

## Session-Start Project Brief

At every session start, silently check project context and emit a brief (4 lines max):

1. **GSD phase** (`.planning/` exists in cwd):
   - Read the newest `.planning/*.md` file by mtime (cap at 5 files)
   - Extract: current phase name, phase number/total, any blocking item
   - PHASE.md is authoritative when sources conflict

2. **gstack timeline** (`~/.gstack/projects/<slug>/timeline.jsonl` exists):
   - Read last 3 entries; ignore entries older than 7 days
   - Surface: last skill run + time since

3. **Memory context** (`~/.claude/projects/-Users-vinamr/memory/MEMORY.md`):
   - Already loaded. Pull active project name + last known status.

4. **Recent decisions** (`~/.gstack/projects/<slug>/decisions.md` exists):
   - Read last 2 `## <date>: <topic>` entries
   - Surface: topic + date — one-word summary each

Source priority when sources contradict: PHASE.md > timeline.jsonl > MEMORY.md

**Brief format** (4 lines max, injected into first response silently):
```
[Vanta] Active: <project> · Phase <N>/<M>: <phase-name> · Last: <skill> <time-ago>
Decisions: <topic> (<age>) · <topic> (<age>)   [omit line if no decisions.md or file is empty]
Next: <suggested command based on phase state>
Routes: ship this · review this · debug this · write tests · checkpoint · what's next · retro
```

If no `.planning/` and no timeline: omit the brief. Do not say "no context found."
Omit the Decisions line if `~/.gstack/projects/<slug>/decisions.md` doesn't exist or has no entries.

## The Three Commands

| Command | How to invoke | When |
|---|---|---|
| `/vanta` | `Skill("vanta-run")` | New project / no `.planning/` / "start", "new project", "fresh" |
| `/vanta-sync` | `Skill("vanta-sync")` | After "done", "shipped", "merged", "that's working" / after `/gsd-ship` |
| `/council` | `Skill("vanta-council")` | Before arch decisions, auth/payments/security, hard-to-reverse refactor |

## Conversational Intents (v3.9.0 — internal machinery)

Four extra intents fire automatically from natural language — the user types them inline, no slash command. They are wired into the prompt-rewriter hook and run BEFORE the executor; each short-circuits and returns a `[Vanta]` shadow injection. **No new surface — three commands still hold.**

| Intent | Trigger phrases (regex-matched) | What happens |
|---|---|---|
| **Stop** | "stop", "pause", "halt", "abort", "nevermind", "cancel that" | Halts the most recent `pending` action via two-phase CAS claim. Cost-honest about possibly-billed remote council calls; reconciles next session. |
| **Undo** | "undo", "undo that", "revert that", "roll back" | Finds reversible actions in last 30min. Single candidate → applies inverse. Multiple within 5min → asks user A/B/C. |
| **Re-route** | "actually X", "wait, X instead", "no, X" (where X = test/review/ship/qa/council/investigate/undo) | Halts in-flight, pivots to new intent on the same context. Original prompt is read-time redacted before re-use. |
| **Safe mode** | Engage: "be careful", "safe mode", "safe mode on", "don't auto", "stop suggesting things", "conservative mode". Exit: "back to normal", "exit safe mode", "safe mode off" | Top-level masking flag (does NOT clobber preferences). Forces ambient/council/memory_promotion/inline_preview to "off" until exit. |

When a user says one of these phrases, do **not** also fire the rewriter or invoke a skill — the hook handles it. Confirm what happened conversationally, then continue.

**Crash-recovery brief at session start:** if the prior session left `pending` actions or cancellations needing reconciliation, the session brief surfaces a `🛟` line:
```
🛟 N stale action(s) from a prior session — say "accept", "re-run", or "skip"
```
Wait for the user's choice. "accept" finalizes pending → applied; "re-run" leaves them and the executor re-fires on next prompt (idempotent); "skip" marks them rollback_failed with reason `crash-recovery:skip`. In safe mode the "re-run" option is hidden — accept and skip remain.

## Hidden Observability (v3.8.2 — for builders, not surface)

These exist for debugging Vanta itself; never expose to the user as commands:
- `node bin/vanta-executor.js --explain "<prompt>"` — show the full Decision (rule_id, confidence, top1_top2_margin, n_candidates, skill_route, tier).
- `node tools/vanta-soak-report.js --window 7` — markdown report of route quality, recall events, action lifecycle, and missed intents over the last N days.
- Telemetry streams (read-only, secret-redacted): `~/.vanta/route-quality.jsonl`, `~/.vanta/manual-recalls.jsonl`, `~/.vanta/actions.jsonl`, `~/.vanta/cancellations.jsonl`.

## Proactive Trigger Rules

**Suggest /vanta when:**
- Session opens in a project directory with no `.planning/` directory
- User says "starting a new project", "new feature from scratch", "fresh start"
- No project context is loaded and the user is about to build something

**Suggest /vanta-sync immediately after:**
- User says "done", "shipped", "merged", "that's working", "this is working now"
- `/gsd-ship` completed
- A significant bug was fixed (especially >1 hour of work)
- A major PR merged
- One mention is enough — do not nag

**Suggest /council before (planning phase only — `council-advisory.js` hook covers file writes):**
- Architecture decision touching >2 services or >10 files — before any code is written
- User is *about to start* implementing auth, payment, migration, or security features (planning discussion, not file write)
- Hard-to-reverse refactor being *planned* — suggest before first file is touched
- Any PR touching shared infrastructure — at design time, not after

Note: `council-advisory.js` fires automatically when auth/payment/migration files are written.
Do not suggest `/council` after file writes have already started — the hook handles that.

## Staleness Detection

After loading the session-start brief, silently check for stale signals:

```bash
# Open PRs older than 3 days
gh pr list --state open --json number,title,createdAt 2>/dev/null | python3 -c "
import json,sys,datetime
prs=json.load(sys.stdin)
now=datetime.datetime.utcnow()
for p in prs:
  created=datetime.datetime.strptime(p['createdAt'][:10],'%Y-%m-%d')
  age=(now-created).days
  if age>=3: print(f'STALE_PR: #{p[\"number\"]} {p[\"title\"][:40]} ({age}d old)')
" 2>/dev/null

# Unsynced sessions — sync-queue is append-only, dedup by session_id (latest wins).
# R10 P2 / R8 P1 fix — also read across rotated `.bak.<ts>` siblings; producer
# no longer compacts on rotate, so old unsynced sessions live in the bak files.
{ [ -f ~/.vanta/sync-queue.jsonl ] || ls ~/.vanta/sync-queue.jsonl.bak.* >/dev/null 2>&1; } && _U=$(python3 -c "
import json, os, glob
base=os.path.expanduser('~/.vanta/sync-queue.jsonl')
files=sorted(glob.glob(base+'.bak.*')) + ([base] if os.path.exists(base) else [])
latest={}
for fp in files:
  try:
    for l in open(fp):
      try:
        e=json.loads(l); sid=e.get('session_id')
        if sid: latest[sid]=(e.get('synced') is not True)
      except: pass
  except: pass
print(sum(1 for v in latest.values() if v))
" 2>/dev/null || echo 0) && [ "$_U" -gt 0 ] && echo "UNSYNCED: $_U sessions"

# Routing misses this week
[ -f ~/.vanta/missed-intents.jsonl ] && _WEEK=$(date -u -d '7 days ago' +%Y-%m-%dT 2>/dev/null || date -u -v-7d +%Y-%m-%dT 2>/dev/null) && [ -n "$_WEEK" ] && _M=$(awk -v w="$_WEEK" '$0>=w' ~/.vanta/missed-intents.jsonl 2>/dev/null | wc -l | tr -d ' ') && [ "$_M" -ge 3 ] && echo "ROUTING_MISSES: $_M this week"

# Pending Shadow Council reviews for this project
_SLUG=$(basename "$PWD")
_SHADOW=~/.gstack/projects/"$_SLUG"/.shadow_pending.md
[ -f "$_SHADOW" ] && _SC=$(grep -c '^## ' "$_SHADOW" 2>/dev/null || echo 0) && [ "$_SC" -gt 0 ] && echo "SHADOW_PENDING: $_SC plan(s) flagged but not council-reviewed"

# Decisions approaching expiry (within 30 days)
_DEC=~/.gstack/projects/"$_SLUG"/decisions.md
[ -f "$_DEC" ] && python3 -c "
import re, datetime, sys
content = open('$_DEC').read()
today = datetime.date.today()
warn = []
for m in re.finditer(r'## (\\d{4}-\\d{2}-\\d{2})[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\Z)', content):
  date, body = m.group(1), m.group(2)
  exp = re.search(r'\\*\\*Expires:?\\*\\*\\s*(\\d{4}-\\d{2}-\\d{2})', body)
  if exp:
    exp_date = datetime.datetime.strptime(exp.group(1), '%Y-%m-%d').date()
    days = (exp_date - today).days
    if 0 <= days <= 30:
      warn.append(f'{date} expires in {days}d')
if warn: print('STALE_DECISION: ' + '; '.join(warn[:2]))
" 2>/dev/null
```

Surface in the brief if signals found:
- `STALE_PR`: "PR #N open Xd — /review or /ship?"
- `UNSYNCED`: shown by vanta-run Resume (already handled)
- `ROUTING_MISSES ≥ 3`: "N routing misses this week — add routes? (check ~/.vanta/missed-intents.jsonl)"
- `SHADOW_PENDING`: "🌑 N plan(s) flagged for council review — /council before implementing"
- `STALE_DECISION`: "Decision <date> expires in Nd — re-evaluate or extend?"

One line per signal, appended after the Routes line. Cap at 2 stale signals — don't overwhelm.

## Rule

After any session with substantial work, offer `/vanta-sync`. Do not wait to be asked.

## Context Watchdog

No token counting is possible from SKILL.md. Apply this heuristic instead:

When the conversation has had many exchanges AND the user asks for a new large task:
- Say once: "This session is getting long. Run `/compact` before we start, or I may lose track of earlier decisions."
- If a GSD phase is active: add "Or `/gsd-resume-work` to checkpoint the phase first."

When the user says something new after extended work ("now let's also…", "one more thing…"):
- If the conversation has been going a while, offer `/compact <brief hint>` before proceeding.

One mention per session is enough. Do not nag.

## Dependency Detection

Skills detect what's installed at runtime and adapt:
- **GSD installed** (`~/.claude/skills/gsd-new-project/` exists) → use `/gsd-new-project`, `/gsd-plan-phase`, `/gsd-extract_learnings`
- **GSD absent** → fall back to superpowers `/brainstorm` + `/write-plan` for planning
- **gstack installed** (`~/.claude/skills/gstack/` exists) → offer `/ship`, `/qa`, `/review`, `/investigate` suggestions
- **gstack absent** → describe the action without invoking the skill by name
- **Multi-CLI configured** (`mcp__Multi-CLI__Ask-Gemini` in tool list) → full council mode
- **Multi-CLI absent** → solo adversarial review with explicit degradation notice
