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
      try {
        const raw = fs.readFileSync(q.file, 'utf8');
        unsynced = (raw.match(/"synced"\s*:\s*false/g) || []).length;
      } catch {}
    } else if (q.special === 'staging') {
      try {
        const raw = fs.readFileSync(q.file, 'utf8');
        stagingCount = (raw.match(/<!-- vanta-sync:/g) || []).length;
      } catch {}
    }
    out.push({
      name: q.name,
      present: true,
      lines: countLines(q.file),
      bytes: st.size,
      mtime: st.mtimeMs,
      unsynced,
      stagingCount,
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
    console.log('  ' +
      q.name.padEnd(16) + '  ' +
      String(q.lines).padStart(4) + ' lines  ' +
      bytesHuman(q.bytes).padStart(6) + '  ' +
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
    if (council.lastCouncil) {
      console.log(`  Last run:   ${council.lastCouncil.date} · ${council.lastCouncil.topic.slice(0, 50)}`);
    } else {
      console.log('  Last run:   — none for this project');
    }
    console.log('');
  }

  // Suggestions
  const sugg = [];
  const unsynced = (queues.find(q => q.name === 'sync-queue') || {}).unsynced || 0;
  if (unsynced > 0)        sugg.push(`/vanta-sync to clear ${unsynced} unsynced session(s)`);
  const staging = (queues.find(q => q.name === 'staging-invariants') || {}).stagingCount || 0;
  if (staging > 0)         sugg.push(`vanta-extract-score list-staging — review ${staging} pending invariant(s)`);
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
