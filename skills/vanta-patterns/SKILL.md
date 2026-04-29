---
name: vanta-patterns
description: Weekly governance retrospective on Vanta itself. Analyzes routing telemetry, repeat invariants, decision reversals, and stale memory to surface patterns that would otherwise stay invisible. Outputs vanta-health.md and proposes self-improvements.
argument-hint: "[--weekly | --monthly | --since=YYYY-MM-DD]"
user-invocable: true
model: opus
---

# Vanta-Patterns — Self-Governance Loop

Vanta logs everything: route hits, route misses, decisions, episodes, sync events. This skill turns that telemetry into actionable insight about how Vanta itself is performing.

## When to Run

- Weekly (every Monday) — review the week's routing health
- Before any v-bump — confirm features are being used
- After a frustrating session — find the pattern in the friction
- User says "vanta health", "how is vanta doing", "patterns this week"

## Process

### Step 1 — Window selection

Default: last 7 days (rolling). Override via `--monthly`, `--since=YYYY-MM-DD`, or `--all`.

```bash
WINDOW_START=$(date -u -v-7d +%Y-%m-%dT 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT)
echo "Analyzing window: $WINDOW_START → now"
```

### Step 2 — Pull telemetry

Read four log files, all jsonl, all in `~/.vanta/`:

```bash
_LOGS=~/.vanta
[ -f "$_LOGS/routing-events.jsonl" ] && _ROUTES=$(awk -v w="$WINDOW_START" '$0>=w' "$_LOGS/routing-events.jsonl" | wc -l | tr -d ' ')
[ -f "$_LOGS/missed-intents.jsonl" ] && _MISSES=$(awk -v w="$WINDOW_START" '$0>=w' "$_LOGS/missed-intents.jsonl" | wc -l | tr -d ' ')
[ -f "$_LOGS/sync-queue.jsonl" ] && _QUEUE=$(awk -v w="$WINDOW_START" '$0>=w' "$_LOGS/sync-queue.jsonl" | wc -l | tr -d ' ')
[ -f "$_LOGS/episodes.jsonl" ] && _EPISODES=$(awk -v w="$WINDOW_START" '$0>=w' "$_LOGS/episodes.jsonl" | wc -l | tr -d ' ')
echo "Routes: $_ROUTES · Misses: $_MISSES · Sessions queued: $_QUEUE · Episodes: $_EPISODES"
```

### Step 3 — Compute four metrics

Use Node to compute aggregates (no jq dependency). The script outputs the report.

```bash
node - "$WINDOW_START" << 'JS'
const fs = require('fs');
const path = require('path');
const os = require('os');
const since = process.argv[2];
const dir = path.join(os.homedir(), '.vanta');
const read = f => {
  try { return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};

const routes = read('routing-events.jsonl').filter(e => (e.ts || '') >= since);
const misses = read('missed-intents.jsonl').filter(e => (e.ts || '') >= since);
const episodes = read('episodes.jsonl').filter(e => (e.ts || '') >= since);
const queue = read('sync-queue.jsonl').filter(e => (e.ts || '') >= since);

// Top routes
const routeCounts = {};
routes.forEach(r => { routeCounts[r.route || 'unknown'] = (routeCounts[r.route || 'unknown'] || 0) + 1; });
const topRoutes = Object.entries(routeCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);

// Top missed phrases (cluster similar ones)
const missCounts = {};
misses.forEach(m => {
  const key = (m.phrase || '').toLowerCase().slice(0, 30);
  missCounts[key] = (missCounts[key] || 0) + 1;
});
const topMisses = Object.entries(missCounts).filter(([_,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,5);

// Repeat episode topics (recurring problems)
const topicCounts = {};
episodes.forEach(e => (e.topics || []).forEach(t => { topicCounts[t] = (topicCounts[t] || 0) + 1; }));
const repeatTopics = Object.entries(topicCounts).filter(([_,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,5);

// Sync coverage: % of queued sessions actually synced
const synced = queue.filter(q => q.synced).length;
const syncCoverage = queue.length > 0 ? Math.round((synced / queue.length) * 100) : 100;

// Outcome distribution
const outcomes = { resolved: 0, blocked: 0, decided: 0, 'in-progress': 0 };
episodes.forEach(e => { if (outcomes[e.outcome] !== undefined) outcomes[e.outcome]++; });

// Generate report
const today = new Date().toISOString().slice(0, 10);
const report = `# Vanta Health Report — ${today}

Window: ${since.slice(0, 10)} → ${today}

## Activity

- Sessions captured: ${queue.length}
- Routes invoked: ${routes.length}
- Routing misses: ${misses.length}
- Episodes recorded: ${episodes.length}
- Sync coverage: ${syncCoverage}% (${synced}/${queue.length} synced)

## Top Routes

${topRoutes.map(([r,c])=>`- \`${r}\` × ${c}`).join('\n') || '- (none)'}

## Top Missed Phrases (worth adding routes)

${topMisses.map(([p,c])=>`- "${p}" × ${c}  → consider new route`).join('\n') || '- (no repeated misses)'}

## Repeat Topics (recurring problems)

${repeatTopics.map(([t,c])=>`- **${t}** × ${c} sessions  → likely needs a durable invariant`).join('\n') || '- (no repeats)'}

## Outcome Distribution

- Resolved: ${outcomes.resolved}
- Blocked: ${outcomes.blocked}
- Decided: ${outcomes.decided}
- In-progress: ${outcomes['in-progress']}

## Recommendations

${syncCoverage < 80 ? '- ⚠️  Sync coverage below 80% — sessions are being captured but not flushed. Run /vanta-sync more often.' : ''}
${topMisses.length >= 3 ? '- ⚠️  3+ recurring missed phrases — add explicit routes for these in vanta-run SKILL.md.' : ''}
${repeatTopics.length >= 2 ? '- ⚠️  2+ recurring topics — these should be promoted to invariants if not already there.' : ''}
${outcomes.blocked > outcomes.resolved ? '- ⚠️  More blocked than resolved sessions this window — investigate root causes.' : ''}
${routes.length === 0 ? '- ℹ️  No routing telemetry yet. Use /vanta with intent phrases to start collecting data.' : ''}
`;

const reportPath = path.join(os.homedir(), '.vanta', 'vanta-health.md');
fs.writeFileSync(reportPath, report);
console.log(report);
console.log(`\n✓ Written to ${reportPath}`);
JS
```

### Step 4 — Run /council on the report (governance loop)

If the report flags ≥2 warnings, propose a council review of Vanta itself:

> The health report flagged N issues. Run `/council` on `~/.vanta/vanta-health.md` to design fixes? [y/n]

This closes the loop: Vanta uses its own adversarial review process to redesign itself based on observed failures.

### Step 5 — Auto-propose route additions

For each missed phrase appearing 3+ times, propose adding it to vanta-run's routing table. Format:

```
Suggested new route for "<phrase>":
| "<phrase>", "<variants>" | <framework> | `Skill("<target>")` |

Add to ~/.claude/skills/vanta-run/SKILL.md? [y/n]
```

Apply confirmed additions to the SKILL.md routing table directly.

## What Good Reports Look Like

A healthy Vanta produces reports with:
- **High sync coverage** (>80%): learnings are being captured
- **Few repeated misses**: the routing table covers common intents
- **Topic distribution matches active work**: what you're doing is what's logged
- **Outcomes skew resolved over blocked**: progress is being made

A report that's mostly empty means vanta isn't being used heavily yet — that's fine, just informational.
