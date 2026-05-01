#!/usr/bin/env node
// vanta-brief — deterministic session-start brief generator.
//
// Codex and Gemini both flagged that the "brief" described in using-vanta/SKILL.md
// was instructions to Claude, not actually computed. This generator does the work:
// reads .planning/, ~/.gstack/projects/<slug>/{decisions.md,timeline.jsonl},
// ~/.vanta/{sync-queue,episodes,missed-intents}.jsonl, and produces a 4-7 line
// brief deterministically — no LLM hallucination.
//
// Usage: node vanta-brief.js [--cwd /path/to/project] [--format json|text]
// Output (text): newline-separated lines suitable for additionalContext injection.
// Output (json): structured object for programmatic consumers.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonl(p) {
  const c = readSafe(p);
  if (!c) return [];
  return c.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function getProjectSlug(cwd) {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
    }).toString().trim();
    const m = remote.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}-${m[2]}`;
  } catch (_) {}
  return path.basename(cwd);
}

function getBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
    }).toString().trim();
  } catch { return null; }
}

function ageStr(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Phase detection (.planning/) ───────────────────────────────────────────
function detectPhase(cwd) {
  const planDir = path.join(cwd, '.planning');
  if (!fs.existsSync(planDir)) return null;
  // PHASE.md is authoritative; otherwise use newest .md mtime
  const phasePath = path.join(planDir, 'PHASE.md');
  if (fs.existsSync(phasePath)) {
    const c = readSafe(phasePath);
    if (c) {
      const titleLine = (c.match(/^#\s+(.+)/m) || [])[1] || '';
      const phaseMatch = titleLine.match(/[Pp]hase\s+(\d+)(?:\s*\/\s*(\d+))?[:\s-]*(.*)/);
      if (phaseMatch) {
        return { num: phaseMatch[1], total: phaseMatch[2] || null, name: (phaseMatch[3] || titleLine).trim() };
      }
      return { name: titleLine.trim() };
    }
  }
  // Fall back to newest .md
  let newest = null, newestMtime = 0;
  for (const f of fs.readdirSync(planDir)) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(planDir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = f; }
  }
  if (newest) return { name: newest.replace(/\.md$/, '') };
  return null;
}

// ─── Recent decisions (last 2) ──────────────────────────────────────────────
function recentDecisions(slug) {
  const file = path.join(os.homedir(), '.gstack', 'projects', slug, 'decisions.md');
  const c = readSafe(file);
  if (!c) return [];
  const blocks = c.split(/^## /m).slice(1);
  return blocks.slice(-2).reverse().map(b => {
    const heading = (b.split('\n')[0] || '').trim();
    const m = heading.match(/(\d{4}-\d{2}-\d{2}):\s*(.+)/);
    if (!m) return { topic: heading };
    const days = Math.floor((Date.now() - new Date(m[1]).getTime()) / 86400000);
    return { date: m[1], topic: m[2], age: days < 1 ? 'today' : `${days}d ago` };
  });
}

// ─── Last gstack timeline event ─────────────────────────────────────────────
function lastTimelineEvent(slug) {
  const file = path.join(os.homedir(), '.gstack', 'projects', slug, 'timeline.jsonl');
  const events = readJsonl(file);
  if (!events.length) return null;
  const last = events[events.length - 1];
  return { skill: last.skill || 'unknown', age: ageStr(last.ts || last.timestamp) };
}

// ─── Stale signals ──────────────────────────────────────────────────────────
function shadowPending(slug) {
  const file = path.join(os.homedir(), '.gstack', 'projects', slug, '.shadow_pending.md');
  const c = readSafe(file);
  if (!c) return 0;
  return (c.match(/^## /gm) || []).length;
}

function staleDecisions(slug, withinDays = 30) {
  const file = path.join(os.homedir(), '.gstack', 'projects', slug, 'decisions.md');
  const c = readSafe(file);
  if (!c) return [];
  const today = new Date();
  const out = [];
  for (const b of c.split(/^## /m).slice(1)) {
    const heading = (b.split('\n')[0] || '').trim();
    const date = (heading.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    const exp = (b.match(/\*\*Expires:?\*\*\s*(\d{4}-\d{2}-\d{2})/i) || [])[1];
    if (!exp) continue;
    const days = Math.ceil((new Date(exp) - today) / 86400000);
    if (days >= 0 && days <= withinDays) out.push({ date, expires_in: days });
  }
  return out.slice(0, 2);
}

function unsyncedSessions(cwd) {
  // R8 P1 — read merged across rotated `.bak.<ts>` + live file. Producer
  // no longer compacts on rotate (concurrent-write data loss); merge here.
  const { readMergedJsonl } = require('./vanta-jsonl');
  const file = path.join(os.homedir(), '.vanta', 'sync-queue.jsonl');
  const merged = readMergedJsonl(file);
  const entries = merged.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  // Codex R4 P2: sync-queue is now append-only; dedup by session_id, taking
  // the LATEST (rightmost) entry as the source of truth.
  const latest = new Map();
  for (const e of entries) if (e.session_id) latest.set(e.session_id, e);
  return [...latest.values()].filter(e => e.synced === false && e.cwd === cwd).length;
}

function recentMisses(days = 7) {
  const file = path.join(os.homedir(), '.vanta', 'missed-intents.jsonl');
  const entries = readJsonl(file);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return entries.filter(e => (e.ts || '') >= cutoff).length;
}

function stalePRs(cwd, days = 3) {
  try {
    const out = execSync('gh pr list --state open --json number,title,createdAt 2>/dev/null', {
      cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000,
    }).toString();
    const prs = JSON.parse(out);
    const cutoff = Date.now() - days * 86400000;
    return prs
      .filter(p => new Date(p.createdAt).getTime() < cutoff)
      .map(p => ({ number: p.number, title: p.title.slice(0, 40), age: Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000) }));
  } catch { return []; }
}

// ─── Compose brief ──────────────────────────────────────────────────────────
function compose({ cwd }) {
  const slug = getProjectSlug(cwd);
  const project = path.basename(cwd);
  const branch = getBranch(cwd);

  const phase = detectPhase(cwd);
  const last = lastTimelineEvent(slug);
  const decisions = recentDecisions(slug);

  const signals = {
    shadow_pending: shadowPending(slug),
    stale_decisions: staleDecisions(slug),
    unsynced: unsyncedSessions(cwd),
    routing_misses: recentMisses(),
    stale_prs: stalePRs(cwd),
  };

  const lines = [];
  // Line 1 — active context
  const parts = [`Active: ${project}`];
  if (branch && branch !== 'unknown') parts.push(`branch ${branch}`);
  if (phase) {
    const ph = phase.num ? `Phase ${phase.num}${phase.total ? '/' + phase.total : ''}: ${phase.name}` : phase.name;
    parts.push(ph);
  }
  if (last) parts.push(`Last: /${last.skill} ${last.age}`);
  lines.push(`[Vanta] ${parts.join(' · ')}`);

  // Line 2 — recent decisions
  if (decisions.length) {
    lines.push('Decisions: ' + decisions.map(d => `${d.topic} (${d.age || ''})`.trim()).join(' · '));
  }

  // Line 3 — stale signals (cap at 2 — don't overwhelm)
  const stale = [];
  if (signals.shadow_pending > 0) stale.push(`🌑 ${signals.shadow_pending} plan(s) flagged — /council before implementing`);
  if (signals.stale_decisions.length) {
    stale.push(`Decision ${signals.stale_decisions[0].date} expires in ${signals.stale_decisions[0].expires_in}d`);
  }
  if (signals.stale_prs.length) {
    const pr = signals.stale_prs[0];
    stale.push(`PR #${pr.number} open ${pr.age}d — /review or /ship?`);
  }
  if (signals.routing_misses >= 3) {
    stale.push(`${signals.routing_misses} routing misses this week`);
  }
  for (const s of stale.slice(0, 2)) lines.push(s);

  // Line 4 — routes hint (always last)
  lines.push('Routes: ship · review · debug · write tests · what do I know about X · checkpoint · what\'s next');

  return { slug, project, branch, phase, decisions, signals, last, lines };
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[key] = argv[++i];
      else a[key] = true;
    }
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  const cwd = args.cwd || process.cwd();
  const out = compose({ cwd });
  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(out, null, 2));
  } else {
    process.stdout.write(out.lines.join('\n'));
  }
}

if (require.main === module) main();
module.exports = { compose };
