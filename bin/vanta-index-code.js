#!/usr/bin/env node
// vanta-index-code — code-knowledge indexer (v3.4 Tier 4).
//
// Council convergence history:
//   Tier 2: single global jsonl → BLOCK (O(N) growth + write race + UNKNOWN
//           bleed + .claude/ vendor noise + page-copy outranking impl)
//   Tier 3: per-project shards + atomic write + UNKNOWN_PROJECT bucket
//           → BLOCK (UNKNOWN bucket recreated O(N) bug; global cursor is the
//           new write race hot path; same-project concurrent writes still
//           lose entries despite atomic rename)
//   Tier 4 (this): shard by RAW SLUG (no UNKNOWN routing), per-shard cursor,
//           lockfile with retry for concurrent same-project writes, shared
//           projects module to kill PROJECT_KEYWORDS sync-drift.
//
// Layout:
//   ~/.vanta/knowledge/<slug>.jsonl          — entries shard
//   ~/.vanta/knowledge/<slug>.cursor.json    — per-project mtimes + patterns hash
//   ~/.vanta/knowledge/<slug>.lock           — advisory lock for shard writes
//
// Usage:
//   node vanta-index-code.js [--cwd /path] [--project slug] [--full] [--quiet]
//   node vanta-index-code.js --file /path/to/file.ts                 # incremental
//   node vanta-index-code.js --dump --project little-wins             # show entries

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { canonProject, isKnownProject, slugForFilesystem } = require('./vanta-projects');

// ─── Config ─────────────────────────────────────────────────────────────────
const VANTA_DIR = path.join(os.homedir(), '.vanta');
const KNOWLEDGE_DIR = path.join(VANTA_DIR, 'knowledge');

// Legacy paths from earlier tiers. On first Tier 4 run we migrate forward.
const LEGACY_GLOBAL_JSONL = path.join(VANTA_DIR, 'code-knowledge.jsonl');
const LEGACY_GLOBAL_CURSOR = path.join(VANTA_DIR, 'code-knowledge-cursor.json');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go']);
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', '__pycache__', 'target', 'venv', '.venv',
  '.pytest_cache', 'test-results', 'qa-reports', '.expo',
  '.claude',  // Codex Tier 2 P3: vendor scaffolding (gstack, plugins) lives here
]);
const MAX_FILE_BYTES = 200_000;
const MAX_FILES_PER_RUN = 5_000;

// Lock retry params — kept short. The hook's parent timeout is 3000ms so
// even worst-case 10*100ms = 1s leaves headroom.
const LOCK_MAX_RETRIES = 10;
const LOCK_RETRY_MS = 100;

// Detection patterns — each (category, regex, why) triple.
const SENSITIVE_PATTERNS = [
  { cat: 'child-safety',  re: /\b(POCSO|COPPA|safeguard(?:ing)?|child[- ]safe|mandatory[- ]report|incident[- ]rout)/gi, why: 'Child-safety boundary — POCSO §19/§21 reporting, mandatory incident routing.' },
  { cat: 'output-filter', re: /\b(filterOutput|outputFilter|output[- ]filter|filter[- ]veto|llm[- ]safe(?:ty)?|output[- ]gate)\b/gi, why: 'LLM output filter — final veto gate. Regression here = unfiltered LLM reaches child.' },
  { cat: 'consent',       re: /\b(DPDP|parental[- ]consent|guardian[- ]consent|child[- ]pii|EU[- ]region|india[- ]region)\b/gi, why: 'DPDP Rules 2025 — child PII region restriction, parental consent flow.' },
  { cat: 'auth-boundary', re: /\b(SUPABASE_SERVICE_ROLE_KEY|service[- ]role|middleware\.ts|withAuth|requireAuth|requireRole|getSession|auth\.uid)\b/g, why: 'Auth boundary — service-role usage, middleware, role gating.' },
  { cat: 'pii',           re: /\b(child_name|parent_phone|school_name|dob|date[- ]of[- ]birth|guardian_email|aadhaar|aadhar|pan_number)\b/gi, why: 'PII field — DPDP §11 territory, must be region-locked and encrypted at rest.' },
  { cat: 'tz-cron',       re: /\b(TZ=Asia\/Kolkata|cron[- ]schedule|node[- ]cron|new CronJob|scheduleAt|sendWindow)\b/gi, why: 'Timezone-sensitive cron — TZ=Asia/Kolkata is load-bearing for IST send windows.' },
  { cat: 'red-team',      re: /\b(red[- ]team|MALICIOUS_LLM|adversarial[- ]eval|attack[- ]corpus|RED_TEAM=1)\b/gi, why: 'Red-team harness — must run green before any Mitthu/safety-layer change.' },
  { cat: 'two-signal',    re: /\btwo[- ]signal\b|\bpaired[- ]sensors?\b|\bcorrobor(?:ate|ation)\b/gi, why: 'Two-signal rule — clinical claim requires ≥2 independent paradigms agreeing.' },
  { cat: 'norms-gate',    re: /\b(indian[- ]norms?|cbse[- ]norms?|norms[- ]gate|age[- ]band|band[- ]baseline|isParadigmEnabled)\b/gi, why: 'Norms gate — age-band enablement, single source of truth for paradigm dispatch.' },
];

function patternsHash() {
  const sig = SENSITIVE_PATTERNS.map(p => `${p.cat}|${p.re.source}|${p.re.flags}|${p.why}`).join('\n');
  return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
}

const CLAUDE_MD_SECTIONS = [
  'Gotchas', 'Safety', 'Code Conventions', 'Architecture', 'Game Engine Rules',
  'Testing Discipline', 'Current State',
];

const PATH_RANK_RULES = [
  { match: /[/\\]__tests__[/\\]/,                        rank: 0.45 },
  { match: /\.test\.[tj]sx?$/,                            rank: 0.45 },
  { match: /\.spec\.[tj]sx?$/,                            rank: 0.45 },
  { match: /\.stories\.[tj]sx?$/,                         rank: 0.40 },
  { match: /[/\\]src[/\\]app[/\\].+[/\\]page\.tsx$/,      rank: 0.55 },
  { match: /[/\\]src[/\\]app[/\\].+[/\\]layout\.tsx$/,    rank: 0.65 },
  { match: /[/\\](demo|pitch|marketing|landing|public)[/\\]/, rank: 0.40 },
  // Vanta's own indexer code: regex tables look like pattern hits to itself.
  { match: /[/\\]bin[/\\]vanta-(index|resolve|brief|projects)/, rank: 0.20 },
];

function pathRank(filePath) {
  for (const rule of PATH_RANK_RULES) {
    if (rule.match.test(filePath)) return rule.rank;
  }
  return 1.0;
}

// ─── Path helpers ───────────────────────────────────────────────────────────
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function ensureKnowledgeDir() {
  if (!fs.existsSync(VANTA_DIR)) fs.mkdirSync(VANTA_DIR, { recursive: true });
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

function shardPath(slug)  { return path.join(KNOWLEDGE_DIR, `${slugForFilesystem(slug)}.jsonl`); }
function cursorPath(slug) { return path.join(KNOWLEDGE_DIR, `${slugForFilesystem(slug)}.cursor.json`); }
function lockPath(slug)   { return path.join(KNOWLEDGE_DIR, `${slugForFilesystem(slug)}.lock`); }

// ─── Shard locking ──────────────────────────────────────────────────────────
// Advisory file lock via O_EXCL. Codex Tier 3 P2 + Gemini Tier 3 P1 fix:
// atomic rename prevents torn files, but two same-project hook fires can
// still both read the shard, both write, and last-writer-wins drops entries.
// O_EXCL + retry serializes those.
//
// Stale-lock heuristic: if lock file exists and is >5s old, assume crashed
// holder and steal it. Indexer runs are <1s in practice so this is safe.
function acquireLock(slug) {
  const file = lockPath(slug);
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      // Steal stale lock
      const st = statSafe(file);
      if (st && Date.now() - st.mtimeMs > 5000) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      // Sync sleep — hook context has no event loop pressure
      const t = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < t) { /* spin */ }
    }
  }
  return false;
}

function releaseLock(slug) {
  try { fs.unlinkSync(lockPath(slug)); } catch {}
}

function atomicWriteJsonl(file, entries) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const body = entries.length ? entries.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function loadShard(slug) {
  const file = shardPath(slug);
  const c = readSafe(file);
  if (!c) return [];
  const out = [];
  for (const line of c.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// ─── Per-shard cursor ───────────────────────────────────────────────────────
function loadCursor(slug) {
  const c = readSafe(cursorPath(slug));
  if (!c) return { patternsHash: null, files: {} };
  try {
    const j = JSON.parse(c);
    return { patternsHash: j.patternsHash || null, files: j.files || {} };
  } catch {
    return { patternsHash: null, files: {} };
  }
}

function saveCursor(slug, cursor) {
  const file = cursorPath(slug);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2));
  fs.renameSync(tmp, file);
}

// ─── Project resolution ─────────────────────────────────────────────────────
function getProjectSlug(cwd) {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
    }).toString().trim();
    const m = remote.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return canonProject(`${m[1]}-${m[2]}`) || `${m[1]}-${m[2]}`;
  } catch {}
  return canonProject(path.basename(cwd)) || path.basename(cwd);
}

// Tier 4: shard by inferred slug, NOT __unknown_project__.
// Both councils flagged that bucketing unknown repos into one shard recreated
// the O(N) bug. Resolver decides scope (scoped vs foreign) at query time
// based on canonProject() match, not at index time.
function shardSlug(inferred) {
  return canonProject(inferred) || inferred;
}

// ─── Walkers ────────────────────────────────────────────────────────────────
function* walkSource(root) {
  const stack = [root];
  let yielded = 0;
  while (stack.length && yielded < MAX_FILES_PER_RUN) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!SOURCE_EXTS.has(ext)) continue;
        const st = statSafe(p);
        if (!st || st.size > MAX_FILE_BYTES) continue;
        yield p;
        yielded++;
        if (yielded >= MAX_FILES_PER_RUN) break;
      }
    }
  }
}

function* walkClaudeMd(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(p);
      } else if (e.isFile() && e.name === 'CLAUDE.md') {
        yield p;
      }
    }
  }
}

// ─── Extractors ─────────────────────────────────────────────────────────────
function extractFromSource(filePath, projectRoot, projectSlug) {
  const content = readSafe(filePath);
  if (!content) return [];
  const lines = content.split('\n');
  const out = [];
  const seen = new Set();
  const rank = pathRank(filePath);

  for (const { cat, re, why } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(import|from|require\s*\(|export\s*\*\s*from)/.test(line)) continue;
      const fresh = new RegExp(re.source, re.flags.replace('g', ''));
      if (!fresh.test(line)) continue;
      const key = `${filePath}:${i+1}:${cat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ctxLines = [];
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const l = lines[j];
        if (/^\s*\/\//.test(l) || /^\s*\*/.test(l) || /^\s*\/\*/.test(l) || /^\s*#/.test(l)) {
          ctxLines.unshift(l.trim());
        } else if (/^\s*$/.test(l)) {
          if (ctxLines.length) break;
        } else {
          break;
        }
      }
      const rel = path.relative(projectRoot, filePath);
      out.push({
        kind: 'code',
        project: projectSlug,
        category: cat,
        why,
        source: `${rel}:${i+1}`,
        snippet: line.trim().slice(0, 240),
        context: ctxLines.length ? ctxLines.join('\n').slice(0, 400) : null,
        pathRank: rank,
        ts: new Date().toISOString(),
      });
    }
  }
  return out;
}

function extractFromClaudeMd(filePath, projectRoot, projectSlug) {
  const content = readSafe(filePath);
  if (!content) return [];
  const out = [];
  const rel = path.relative(projectRoot, filePath) || 'CLAUDE.md';
  const lines = content.split('\n');
  let curSection = null;
  let curStart = 0;
  let buf = [];

  const flush = () => {
    if (curSection && CLAUDE_MD_SECTIONS.some(s => curSection.toLowerCase().includes(s.toLowerCase())) && buf.length) {
      const body = buf.join('\n').trim();
      if (body) {
        const bullets = body.match(/(^|\n)\s*-\s+[\s\S]*?(?=\n\s*-\s+|$)/g);
        const push = (snippet) => out.push({
          kind: 'claude-md',
          project: projectSlug,
          category: `claude-md:${curSection.toLowerCase().replace(/\s+/g, '-')}`,
          why: `Project gotcha from ${rel} § ${curSection}`,
          source: `${rel}:${curStart}`,
          snippet,
          context: null,
          pathRank: 1.0,
          ts: new Date().toISOString(),
        });
        if (bullets && bullets.length > 1) {
          for (const b of bullets) {
            const text = b.replace(/^\s*-\s+/, '').trim();
            if (text.length >= 10) push(text.slice(0, 240));
          }
        } else {
          push(body.slice(0, 400));
        }
      }
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h2 = l.match(/^##\s+(.+)/);
    if (h2) { flush(); curSection = h2[1].trim(); curStart = i + 1; }
    else if (curSection) { buf.push(l); }
  }
  flush();
  return out;
}

// ─── Legacy migration ───────────────────────────────────────────────────────
// Forward-migrate Tier 2 (single global jsonl) and Tier 3 (per-shard with
// __unknown_project__ + global cursor) into Tier 4 layout. Idempotent.
//
// Legacy detection: presence of LEGACY_GLOBAL_JSONL means Tier 2 wasn't
// migrated; presence of LEGACY_GLOBAL_CURSOR means Tier 2/3 cursor exists.
// Both get processed if found, then renamed to .bak.
function migrateLegacyIfNeeded(quiet) {
  ensureKnowledgeDir();
  let migrated = 0;

  // Tier 2 global jsonl → split into per-slug shards
  if (fs.existsSync(LEGACY_GLOBAL_JSONL)) {
    const content = readSafe(LEGACY_GLOBAL_JSONL);
    if (content) {
      const byProject = {};
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const slug = (e.project && e.project !== '__global__' && e.project !== '__unknown_project__')
          ? canonProject(e.project)
          : null;
        if (!slug) continue;  // skip unknowns; they'll be reindexed under raw slug
        (byProject[slug] = byProject[slug] || []).push(e);
      }
      for (const [slug, entries] of Object.entries(byProject)) {
        const existing = loadShard(slug);
        const seen = new Set(existing.map(e => `${e.source}|${e.category}`));
        const merged = [...existing];
        for (const e of entries) {
          const k = `${e.source}|${e.category}`;
          if (!seen.has(k)) { merged.push(e); seen.add(k); }
        }
        atomicWriteJsonl(shardPath(slug), merged);
        migrated += entries.length;
      }
    }
    fs.renameSync(LEGACY_GLOBAL_JSONL, LEGACY_GLOBAL_JSONL + '.bak');
  }

  // Tier 3 __unknown_project__ shard → re-shard by raw slug if any entries
  // can be salvaged. Most can't (they didn't carry the original project),
  // so we drop the shard and let next --full re-extract.
  const unknownShard = path.join(KNOWLEDGE_DIR, '__unknown_project__.jsonl');
  if (fs.existsSync(unknownShard)) {
    fs.renameSync(unknownShard, unknownShard + '.bak');
  }

  // Tier 3 global cursor → drop. Per-project cursors get rebuilt on next run.
  if (fs.existsSync(LEGACY_GLOBAL_CURSOR)) {
    const content = readSafe(LEGACY_GLOBAL_CURSOR);
    if (content) {
      try {
        const j = JSON.parse(content);
        // Old shape: { patternsHash, projects: { <slug>: { <file>: mtime } } }
        if (j.projects) {
          for (const [slug, files] of Object.entries(j.projects)) {
            if (!slug || slug === '__global__') continue;
            const canon = canonProject(slug) || slug;
            const cur = loadCursor(canon);
            cur.files = { ...cur.files, ...files };
            cur.patternsHash = j.patternsHash || null;
            saveCursor(canon, cur);
          }
        }
      } catch {}
    }
    fs.renameSync(LEGACY_GLOBAL_CURSOR, LEGACY_GLOBAL_CURSOR + '.bak');
  }

  if (!quiet && migrated > 0) {
    process.stdout.write(`Migrated ${migrated} legacy entries to per-slug shards.\n`);
  }
}

// ─── Index runner ───────────────────────────────────────────────────────────
function runIndex({ cwd, project, full, quiet, singleFile }) {
  ensureKnowledgeDir();
  migrateLegacyIfNeeded(quiet);

  const projectRoot = path.resolve(cwd);
  const inferred = canonProject(project) || canonProject(getProjectSlug(projectRoot)) || path.basename(projectRoot);
  const slug = shardSlug(inferred);

  // Acquire shard lock — serializes same-project concurrent writes (Codex P2,
  // Gemini P1). Failure is non-fatal; we just skip and let the next run cover.
  if (!acquireLock(slug)) {
    if (!quiet) process.stdout.write(`Could not acquire lock on ${slug} — skipping (another indexer is active).\n`);
    return { processed: 0, entries: 0, totalEntries: 0, shard: shardPath(slug), locked: true };
  }

  try {
    // Patterns hash — drift detection.
    const cursor = loadCursor(slug);
    const curHash = patternsHash();
    if (cursor.patternsHash !== curHash && !singleFile) {
      if (!quiet && cursor.patternsHash) {
        process.stdout.write(`SENSITIVE_PATTERNS changed (was ${cursor.patternsHash} → now ${curHash}); forcing --full.\n`);
      }
      full = true;
    }

    const filesProcessed = [];
    const allEntries = [];

    if (singleFile) {
      const abs = path.resolve(singleFile);
      let entries = [];
      if (fs.existsSync(abs)) {
        const ext = path.extname(abs);
        if (path.basename(abs) === 'CLAUDE.md') entries = extractFromClaudeMd(abs, projectRoot, slug);
        else if (SOURCE_EXTS.has(ext))         entries = extractFromSource(abs, projectRoot, slug);
        const st = statSafe(abs);
        if (st) cursor.files[abs] = st.mtimeMs;
      } else {
        delete cursor.files[abs];
      }
      filesProcessed.push(abs);
      allEntries.push(...entries);
    } else {
      for (const f of walkSource(projectRoot)) {
        const st = statSafe(f);
        if (!st) continue;
        if (!full && cursor.files[f] === st.mtimeMs) continue;
        const entries = extractFromSource(f, projectRoot, slug);
        filesProcessed.push(f);
        allEntries.push(...entries);
        cursor.files[f] = st.mtimeMs;
      }
      for (const f of walkClaudeMd(projectRoot)) {
        const st = statSafe(f);
        if (!st) continue;
        if (!full && cursor.files[f] === st.mtimeMs) continue;
        const entries = extractFromClaudeMd(f, projectRoot, slug);
        filesProcessed.push(f);
        allEntries.push(...entries);
        cursor.files[f] = st.mtimeMs;
      }
    }

    // Read-modify-write the shard. Lock is held, so safe.
    const existing = loadShard(slug);
    const reprocessedSources = new Set();
    for (const f of filesProcessed) reprocessedSources.add(path.relative(projectRoot, f));
    const kept = existing.filter(e => !reprocessedSources.has((e.source || '').split(':')[0]));
    const finalExisting = full
      ? kept.filter(e => fs.existsSync(path.join(projectRoot, (e.source || '').split(':')[0])))
      : kept;
    const finalEntries = [...finalExisting, ...allEntries];
    atomicWriteJsonl(shardPath(slug), finalEntries);

    cursor.patternsHash = curHash;
    saveCursor(slug, cursor);

    if (!quiet) {
      const byCat = {};
      for (const e of allEntries) byCat[e.category] = (byCat[e.category] || 0) + 1;
      const isKnown = isKnownProject(slug) ? '' : ' (raw slug — unknown project)';
      process.stdout.write(`Indexed ${filesProcessed.length} file(s) for ${slug}${isKnown}: ${allEntries.length} entries\n`);
      for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`  ${cat.padEnd(28)} ${n}\n`);
      }
      process.stdout.write(`Shard total: ${finalEntries.length} entries → ${shardPath(slug)}\n`);
    }
    return { processed: filesProcessed.length, entries: allEntries.length, totalEntries: finalEntries.length, shard: shardPath(slug) };
  } finally {
    releaseLock(slug);
  }
}

function dumpEntries(project) {
  const slug = canonProject(project) || project;
  const file = shardPath(slug);
  if (!fs.existsSync(file)) {
    process.stdout.write(`(no shard at ${file})\n`);
    return;
  }
  const entries = loadShard(slug);
  for (const e of entries) {
    process.stdout.write(`[${e.category}] ${e.source} (rank=${e.pathRank ?? 1.0})\n  ${e.snippet}\n${e.context ? '  ctx: ' + e.context.slice(0, 120) + '\n' : ''}\n`);
  }
  process.stdout.write(`Total: ${entries.length} entries for ${slug}\n`);
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
  if (args.dump) { dumpEntries(args.project); return; }
  runIndex({
    cwd: args.cwd || process.cwd(),
    project: args.project,
    full: !!args.full,
    quiet: !!args.quiet,
    singleFile: args.file || null,
  });
}

if (require.main === module) main();
module.exports = { runIndex, canonProject, shardSlug, SENSITIVE_PATTERNS, KNOWLEDGE_DIR, shardPath, cursorPath };
