#!/usr/bin/env node
// vanta-status — single-screen health summary.
//
// Cleanup #10: vanta has many silent failure modes (stale shards, runaway
// hook errors, unsynced sync-queue, orphaned cursors). This dumps everything
// observable from local state in one screen so debugging "why isn't X
// surfacing?" doesn't require manually catting JSONL files.
//
// Reads only — never writes, never network. Safe to run anywhere.
//
// Sections (each prints "—" if empty/absent):
//   1. Shards    — per-project entry counts, file size, mtime, dormancy
//   2. Cursors   — patternsHash, files-tracked count, cursor mtime
//   3. Queues    — sync-queue (synced false count), episodes, missed-intents
//   4. Hooks     — last 10 ERROR lines from hook.log + counts by source
//   5. Locks     — any leftover .lock files (stuck migrations / crashes)
//
// Flags:
//   --json     emit one JSON object per section (for scripts)
//   --quiet    summary line only (for shell prompts)
//   --since N  filter hook errors to last N minutes (default: all)

const fs = require('fs');
const path = require('path');
const os = require('os');

const VANTA_DIR = path.join(os.homedir(), '.vanta');
const KNOWLEDGE_DIR = path.join(VANTA_DIR, 'knowledge');
const HOOK_LOG = path.join(VANTA_DIR, 'hook.log');

const args = process.argv.slice(2);
const FLAG_JSON  = args.includes('--json');
const FLAG_QUIET = args.includes('--quiet');
const sinceArg   = args.find(a => a.startsWith('--since='));
const SINCE_MIN  = sinceArg ? parseInt(sinceArg.slice('--since='.length), 10) : 0;

// ── helpers ─────────────────────────────────────────────────────────────────

function ageHuman(mtimeMs) {
  const sec = Math.floor((Date.now() - mtimeMs) / 1000);
  if (sec < 60)        return `${sec}s ago`;
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400)     return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function bytesHuman(n) {
  if (n < 1024)        return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function countLines(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

function safeJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

// ── 1. shards ──────────────────────────────────────────────────────────────

function readShards() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const out = [];
  let files;
  try { files = fs.readdirSync(KNOWLEDGE_DIR); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const slug = f.slice(0, -'.jsonl'.length);
    const jsonl = path.join(KNOWLEDGE_DIR, f);
    const cursor = path.join(KNOWLEDGE_DIR, slug + '.cursor.json');
    const lock   = path.join(KNOWLEDGE_DIR, slug + '.lock');
    const stJsonl = safeStat(jsonl);
    const stCursor = safeStat(cursor);
    const cur = safeJSON(cursor);
    out.push({
      slug,
      entries: countLines(jsonl),
      bytes: stJsonl ? stJsonl.size : 0,
      mtime: stJsonl ? stJsonl.mtimeMs : 0,
      cursorMtime: stCursor ? stCursor.mtimeMs : null,
      filesTracked: cur && cur.files ? Object.keys(cur.files).length : 0,
      patternsHash: cur && cur.patternsHash ? cur.patternsHash.slice(0, 8) : '—',
      hasLock: fs.existsSync(lock),
    });
  }
  out.sort((a, b) => b.entries - a.entries);
  return out;
}

// ── 2. queues ──────────────────────────────────────────────────────────────

function readQueues() {
  const items = [
    { name: 'sync-queue',     file: path.join(VANTA_DIR, 'sync-queue.jsonl'),     special: 'unsynced' },
    { name: 'episodes',       file: path.join(VANTA_DIR, 'episodes.jsonl'),       special: null      },
    { name: 'missed-intents', file: path.join(VANTA_DIR, 'missed-intents.jsonl'), special: null      },
    // R6 P2 fix — surface always-on telemetry so it isn't a write-only tax.
    // Counts events in the last 24h so the user sees active hook coverage.
    { name: 'interactions',   file: path.join(VANTA_DIR, 'interactions.jsonl'),   special: 'interactions' },
    // Tier 6 #16: surface staged invariants pending review so they don't
    // pile up silently. Counts <!-- vanta-sync: --> blocks.
    { name: 'staging-invariants', file: path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.staging.md'), special: 'staging' },
  ];
  const out = [];
  for (const q of items) {
    const st = safeStat(q.file);
    if (!st) { out.push({ name: q.name, present: false }); continue; }
    let unsynced = null;
    let stagingCount = null;
    if (q.special === 'unsynced') {
      // Codex R4 P2 fix — sync-queue is now append-only; multiple Stop hook
      // fires for the same session produce duplicate entries. Count
      // unsynced by latest-per-session, not raw line match.
      // R8 P1 — read merged across rotated `.bak.<ts>` + live file.
      try {
        const { readMergedJsonl } = require('./vanta-jsonl');
        const raw = readMergedJsonl(q.file);
        const latest = new Map();
        for (const l of raw.split('\n')) {
          if (!l) continue;
          try {
            const e = JSON.parse(l);
            if (e.session_id) latest.set(e.session_id, e.synced !== true);
          } catch {}
        }
        unsynced = [...latest.values()].filter(Boolean).length;
      } catch {}
    } else if (q.special === 'staging') {
      try {
        const raw = fs.readFileSync(q.file, 'utf8');
        stagingCount = (raw.match(/<!-- vanta-sync:/g) || []).length;
      } catch {}
    }
    let interactions24h = null;
    if (q.special === 'interactions') {
      // Cheap pass: count events in last 24h, count failures, top 3 tools.
      // R10 P2 / R8 P1 — read across rotated `.bak.<ts>` siblings.
      // Earlier impl only read the live file; right after a rotation,
      // counts plummeted to whatever had been written since the rename.
      try {
        const { readMergedJsonl } = require('./vanta-jsonl');
        const raw = readMergedJsonl(q.file);
        const cutoff = Date.now() - 24 * 60 * 60_000;
        let total = 0, failures = 0;
        const byTool = new Map();
        for (const l of raw.split('\n')) {
          if (!l) continue;
          try {
            const e = JSON.parse(l);
            if (Date.parse(e.ts) < cutoff) continue;
            total++;
            if (e.ok === false) failures++;
            byTool.set(e.tool, (byTool.get(e.tool) || 0) + 1);
          } catch {}
        }
        const topTools = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        interactions24h = { total, failures, topTools };
      } catch {}
    }
    // R11 P2 — Codex+Gemini council finding. Earlier impl reported only
    // the live file's size. After R8 P1 moved rotation to `.bak.<ts>`
    // siblings (no fold-on-rotate), bak files accumulate across the year
    // and were invisible to vanta-status. Now: aggregate live + all baks
    // so the user actually sees disk footprint and rotation count.
    let bakBytes = 0, bakCount = 0;
    try {
      const { listBaks } = require('./vanta-jsonl');
      const baks = listBaks(q.file);
      bakCount = baks.length;
      for (const b of baks) {
        try { bakBytes += fs.statSync(b).size; } catch {}
      }
    } catch { /* vanta-jsonl optional — degrade gracefully */ }
    out.push({
      name: q.name,
      present: true,
      lines: countLines(q.file),
      bytes: st.size,
      bytesTotal: st.size + bakBytes,
      bakCount,
      mtime: st.mtimeMs,
      unsynced,
      stagingCount,
      interactions24h,
    });
  }
  return out;
}

// ── 3. hook errors ─────────────────────────────────────────────────────────

function readHookErrors() {
  if (!fs.existsSync(HOOK_LOG)) return { present: false, recent: [], counts: {} };
  let lines;
  try { lines = fs.readFileSync(HOOK_LOG, 'utf8').split('\n').filter(Boolean); }
  catch { return { present: false, recent: [], counts: {} }; }

  const cutoff = SINCE_MIN > 0 ? Date.now() - SINCE_MIN * 60_000 : 0;
  const errors = [];
  const counts = {};
  for (const line of lines) {
    // format: ISO-ts | level | source | message
    const parts = line.split(' | ');
    if (parts.length < 4) continue;
    const [ts, level, source, ...rest] = parts;
    if (level.trim() !== 'ERROR') continue;
    if (cutoff && Date.parse(ts) < cutoff) continue;
    const src = source.trim();
    counts[src] = (counts[src] || 0) + 1;
    errors.push({ ts, source: src, message: rest.join(' | ').slice(0, 120) });
  }
  return { present: true, recent: errors.slice(-10), counts, totalLines: lines.length };
}

// ── 4. stuck locks ─────────────────────────────────────────────────────────

function readLocks() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const out = [];
  let files;
  try { files = fs.readdirSync(KNOWLEDGE_DIR); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith('.lock')) continue;
    const lockPath = path.join(KNOWLEDGE_DIR, f);
    const st = safeStat(lockPath);
    if (!st) continue;
    let pid = null;
    try { pid = fs.readFileSync(lockPath, 'utf8').trim(); } catch {}
    let alive = false;
    if (pid && /^\d+$/.test(pid)) {
      try { process.kill(parseInt(pid, 10), 0); alive = true; } catch {}
    }
    out.push({ slug: f.slice(0, -'.lock'.length), pid: pid || '?', mtime: st.mtimeMs, alive });
  }
  return out;
}

// ── render ─────────────────────────────────────────────────────────────────

// Tier 6 #17: surface council readiness as one of the health signals.
let _councilHealth = null;
function readCouncilHealth() {
  if (_councilHealth !== null) return _councilHealth;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-council-health.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-council-health.js'),
  ]) {
    try {
      const m = require(p);
      if (m && m.gather) { _councilHealth = m.gather(); return _councilHealth; }
    } catch {}
  }
  _councilHealth = null;
  return null;
}

// Tier 6 #15: per-model council finding accuracy. Cheap to compute from
// the JSONL logs at session-start time.
let _councilFeedback = null;
function readCouncilFeedback() {
  if (_councilFeedback !== null) return _councilFeedback;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-council-feedback.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-council-feedback.js'),
  ]) {
    try {
      const m = require(p);
      if (m && m.stats) { _councilFeedback = m.stats({ days: 90 }); return _councilFeedback; }
    } catch {}
  }
  _councilFeedback = null;
  return null;
}

// Codex P2 fix: read council-runs.jsonl for machine-checked degradation data
// instead of trusting prose model_health blocks in the report text.
let _councilRunsAudit = null;
function readCouncilRunsAudit() {
  if (_councilRunsAudit !== null) return _councilRunsAudit;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-council-run.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-council-run.js'),
  ]) {
    try {
      const m = require(p);
      if (m && m.audit) {
        _councilRunsAudit = { audit: m.audit({ days: 90 }), last: m.last() };
        return _councilRunsAudit;
      }
    } catch {}
  }
  _councilRunsAudit = null;
  return null;
}

function renderText() {
  const shards   = readShards();
  const queues   = readQueues();
  const hookErr  = readHookErrors();
  const locks    = readLocks();
  const council  = readCouncilHealth();

  if (FLAG_QUIET) {
    const totalEntries = shards.reduce((s, x) => s + x.entries, 0);
    const unsynced = (queues.find(q => q.name === 'sync-queue') || {}).unsynced || 0;
    const errs = Object.values(hookErr.counts || {}).reduce((s, x) => s + x, 0);
    const stuck = locks.filter(l => !l.alive).length;
    const parts = [`${shards.length} shards / ${totalEntries} entries`];
    if (unsynced)  parts.push(`${unsynced} unsynced`);
    if (errs)      parts.push(`${errs} hook errors${SINCE_MIN ? ` (${SINCE_MIN}m)` : ''}`);
    if (stuck)     parts.push(`${stuck} stuck lock`);
    if (council && !council.mcp.registered) parts.push('council unavailable');
    console.log('vanta: ' + parts.join(' · '));
    return;
  }

  console.log('=== vanta-status ===');
  console.log('');

  // Shards
  console.log('SHARDS');
  if (shards.length === 0) {
    console.log('  — no shards yet (run: node ~/.claude/bin/vanta-index-code.js --full)');
  } else {
    const w = Math.max(...shards.map(s => s.slug.length), 8);
    console.log('  ' + 'slug'.padEnd(w) + '  entries     size   files    last-write    patterns');
    for (const s of shards) {
      const dormant = (Date.now() - s.mtime) > 7 * 86400_000 ? ' (dormant)' : '';
      console.log('  ' +
        s.slug.padEnd(w) + '  ' +
        String(s.entries).padStart(6)  + '  ' +
        bytesHuman(s.bytes).padStart(7) + '  ' +
        String(s.filesTracked).padStart(5) + '   ' +
        ageHuman(s.mtime).padEnd(11) + '   ' +
        s.patternsHash + dormant +
        (s.hasLock ? ' [LOCK]' : '')
      );
    }
  }
  console.log('');

  // Queues
  console.log('QUEUES');
  for (const q of queues) {
    if (!q.present) {
      console.log('  ' + q.name.padEnd(16) + '  —');
      continue;
    }
    const extras = [];
    if (q.unsynced != null && q.unsynced > 0) extras.push(`${q.unsynced} unsynced`);
    if (q.unsynced === 0) extras.push('all synced');
    if (q.stagingCount != null && q.stagingCount > 0) extras.push(`${q.stagingCount} pending review`);
    if (q.interactions24h) {
      const { total, failures, topTools } = q.interactions24h;
      if (total > 0) {
        const topStr = topTools.map(([t, n]) => `${t}:${n}`).join(' ');
        extras.push(`${total} 24h${failures ? ` (${failures} failed)` : ''}${topStr ? ' · ' + topStr : ''}`);
      }
    }
    // R12 P2 — Codex council finding. The R11 fix computed bytesTotal +
    // bakCount but renderText still printed only q.bytes (live file).
    // Disk footprint of rotated history stayed invisible. Now: when bak
    // files exist, append "+<n> bak (<total>)" to the size column.
    let sizeStr = bytesHuman(q.bytes).padStart(6);
    if (q.bakCount > 0) {
      sizeStr += ` +${q.bakCount} bak (${bytesHuman(q.bytesTotal)})`;
    }
    console.log('  ' +
      q.name.padEnd(16) + '  ' +
      String(q.lines).padStart(4) + ' lines  ' +
      sizeStr + '  ' +
      ageHuman(q.mtime).padEnd(10) +
      (extras.length ? '  (' + extras.join(', ') + ')' : '')
    );
  }
  console.log('');

  // Hook errors
  console.log('HOOK ERRORS' + (SINCE_MIN ? ` (last ${SINCE_MIN}m)` : ''));
  if (!hookErr.present) {
    console.log('  — no hook log yet (~/.vanta/hook.log absent)');
  } else if (Object.keys(hookErr.counts).length === 0) {
    console.log(`  — clean (${hookErr.totalLines} log lines, no ERROR level)`);
  } else {
    const sources = Object.entries(hookErr.counts).sort((a, b) => b[1] - a[1]);
    for (const [src, n] of sources) {
      console.log('  ' + src.padEnd(24) + '  ' + String(n).padStart(3) + ' errors');
    }
    if (hookErr.recent.length) {
      console.log('  ─ last 3:');
      for (const e of hookErr.recent.slice(-3)) {
        console.log('    [' + e.ts.slice(11, 19) + '] ' + e.source + ': ' + e.message);
      }
    }
  }
  console.log('');

  // Locks
  if (locks.length) {
    console.log('LOCKS');
    for (const l of locks) {
      const flag = l.alive ? '(active pid ' + l.pid + ')' : '⚠ STALE — process dead';
      console.log('  ' + l.slug + '.lock  pid=' + l.pid + '  age=' + ageHuman(l.mtime) + '  ' + flag);
    }
    console.log('');
  }

  // Council readiness (Tier 6 #17)
  if (council) {
    console.log('COUNCIL');
    console.log('  Multi-CLI:  ' + (council.mcp.registered
      ? `✓ registered (${council.mcp.scope}${council.mcp.scope === 'project' ? ': ' + council.mcp.projectPath : ''})`
      : '✗ ' + council.mcp.reason.slice(0, 80)));
    console.log('  Gemini:     ' + (council.gemini.ok
      ? `✓ trust ok (${council.gemini.source})`
      : '⚠ ' + council.gemini.reason.slice(0, 60)));
    console.log('  Codex:      ' + (council.codex.ok ? '✓ config present' : '✗ ' + council.codex.reason));
    // Prefer the machine-checked council-runs.jsonl over decisions.md prose.
    const runsAudit = readCouncilRunsAudit();
    if (runsAudit && runsAudit.last) {
      const r = runsAudit.last;
      const flags = [];
      if (r.mode !== 'FULL') flags.push(r.mode);
      if (r.fallbacks && r.fallbacks.length) flags.push(`${r.fallbacks.length} fallback${r.fallbacks.length === 1 ? '' : 's'}`);
      console.log(`  Last run:   ${r.ts.slice(0, 10)} · ${r.topic.slice(0, 40)} · ${r.verdict}${flags.length ? ' · ⚠ ' + flags.join(', ') : ''}`);
    } else if (council.lastCouncil) {
      console.log(`  Last run:   ${council.lastCouncil.date} · ${council.lastCouncil.topic.slice(0, 50)}`);
    } else {
      console.log('  Last run:   — none for this project');
    }
    if (runsAudit && runsAudit.audit && runsAudit.audit.total > 0) {
      const a = runsAudit.audit;
      const partial = Math.round(a.partial_rate * 100);
      const fallback = Math.round(a.fallback_rate * 100);
      if (partial > 20 || fallback > 20) {
        console.log(`  Degradation: ${a.total} run(s) in 90d · ${partial}% PARTIAL · ${fallback}% had fallbacks · check vanta-council-run audit`);
      }
    }
    // Tier 6 #15: per-model accuracy if any feedback has accumulated.
    const feedback = readCouncilFeedback();
    if (feedback && feedback.total_findings > 0) {
      const judged = feedback.tp + feedback.fp;
      const overall = judged > 0 ? Math.round((feedback.tp / judged) * 100) + '%' : '—';
      console.log(`  Accuracy:   ${feedback.total_findings} P1/P2 findings (${feedback.window_days}d) · ${feedback.tp} TP / ${feedback.fp} FP / ${feedback.pending} pending · overall ${overall}`);
      // Per-model summary, max 3 models
      const byModel = new Map();
      for (const b of feedback.by_model_priority) {
        const m = byModel.get(b.model) || { tp: 0, fp: 0, total: 0 };
        m.tp += b.tp; m.fp += b.fp; m.total += b.total;
        byModel.set(b.model, m);
      }
      for (const [model, m] of [...byModel].slice(0, 3)) {
        const judged = m.tp + m.fp;
        const acc = judged > 0 ? Math.round((m.tp / judged) * 100) + '%' : '—';
        console.log(`              ${model.padEnd(10)} ${m.tp} TP / ${m.fp} FP / ${m.total} total · ${acc}`);
      }
    }
    console.log('');
  }

  // Suggestions
  const sugg = [];
  // R11 P1 — Codex+Gemini council finding. The R8 P2 fix touched
  // `~/.vanta/.bin-missing` when prompt-context couldn't load deps, but
  // vanta-status never read it. The user could be running with the
  // always-on layer entirely disabled and never know. Surface it as a
  // CRITICAL suggestion so the diagnostic loop closes.
  try {
    const sentinel = path.join(VANTA_DIR, '.bin-missing');
    if (fs.existsSync(sentinel)) {
      const content = fs.readFileSync(sentinel, 'utf8').trim();
      const firstLine = content.split('\n').pop() || '(no detail)';
      sugg.push(`CRITICAL: bin-missing sentinel set — always-on layer disabled. Last: ${firstLine.slice(0, 120)}`);
    }
  } catch { /* never block status */ }
  const unsynced = (queues.find(q => q.name === 'sync-queue') || {}).unsynced || 0;
  if (unsynced > 0)        sugg.push(`/vanta-sync to clear ${unsynced} unsynced session(s)`);
  const staging = (queues.find(q => q.name === 'staging-invariants') || {}).stagingCount || 0;
  // Surface Impact Discipline: don't suggest a new command name. The next
  // /vanta-sync run is responsible for clearing staging — say that instead.
  if (staging > 0)         sugg.push(`/vanta-sync to review ${staging} staged invariant(s)`);
  if (locks.some(l => !l.alive)) sugg.push('rm ~/.vanta/knowledge/*.lock (stale, owning pid is dead)');
  const dormantUnknown = shards.filter(s =>
    (Date.now() - s.mtime) > 30 * 86400_000 && !['little-wins','pi-perception','sales-agent-publisher','founderos','priyaa-audit','vanta'].includes(s.slug)
  );
  if (dormantUnknown.length) sugg.push(`vanta-prune candidates: ${dormantUnknown.map(s => s.slug).join(', ')}`);
  const errSources = Object.keys(hookErr.counts || {});
  if (errSources.length) sugg.push(`tail ~/.vanta/hook.log to debug: ${errSources.join(', ')}`);
  if (council && !council.mcp.registered) sugg.push('install Multi-CLI MCP before /council can fire (vanta-council-health for details)');
  if (council && council.mcp.registered && !council.gemini.ok) sugg.push('council may run partial — set GEMINI_CLI_TRUST_WORKSPACE=true in MCP env');

  if (sugg.length) {
    console.log('SUGGESTIONS');
    for (const s of sugg) console.log('  • ' + s);
    console.log('');
  }
}

function renderJSON() {
  const out = {
    shards:  readShards(),
    queues:  readQueues(),
    hookErr: readHookErrors(),
    locks:   readLocks(),
    ts:      new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));
}

if (FLAG_JSON) renderJSON();
else renderText();
