#!/usr/bin/env node
// vanta-index-code — code-knowledge indexer (v3.4 Tier 3).
//
// Both councils (Codex + Gemini) ruled BLOCK on Tier 2 with two converged
// architectural findings. Tier 3 closes them:
//
//   1. Per-project shards (was: single global ~/.vanta/code-knowledge.jsonl).
//      Gemini P1: every Write/Edit triggered a full O(N) read-modify-write of
//      a global JSONL that grows boundlessly across all projects. At scale
//      the 1s hook timeout fires silently and the index dies.
//      Codex P2: same write path was racy under concurrent edits.
//      Fix: shard to ~/.vanta/knowledge/<slug>.jsonl. Hot path is now O(1)
//      in number of projects. Atomic write via temp + rename. Privacy blast
//      radius is also scoped per-project.
//
//   2. UNKNOWN_PROJECT bucket (was: unknown slugs leaked to GLOBAL).
//      Gemini P1: when a slug didn't match PROJECT_KEYWORDS, the indexer
//      tagged it raw (e.g. "my-side-project"); resolver canonProject() fell
//      through to GLOBAL_PROJECT, and applyProjectScope injected it into
//      every query (no FOREIGN_PENALTY). Permanent bleed.
//      Fix: indexer now tags unknown slugs with the explicit token
//      "__unknown_project__" + the raw slug; resolver treats it as foreign.
//
//   3. Patterns-hash drift detection (Gemini P2).
//      When SENSITIVE_PATTERNS is updated, old files don't get re-evaluated
//      (the watch hook only reindexes edited files). Cursor now stores a
//      hash of the active patterns; mismatch on indexer run forces --full.
//
//   4. Skip .claude/ vendor (Codex P3).
//      Walking ".claude/" pulled gstack vendor scaffolding into LW's index.
//
//   5. Path-based down-rank (Codex P3).
//      app/src/app/**/page.tsx is page COPY, not implementation. __tests__/
//      describes patterns, doesn't enforce them. Both flagged with a
//      pathRank field that the resolver uses as a multiplier.
//
//   6. Orphan cleanup in single-file mode (Codex P2).
//      Watch hook reindex of a deleted file now drops its entries from the
//      project shard. Previously only --full did this.
//
// Sources (per-project shard):
//   ~/.vanta/knowledge/<slug>.jsonl
// Cursor:
//   ~/.vanta/code-knowledge-cursor.json   (per-project mtimes + patterns hash)
//
// Usage:
//   node vanta-index-code.js [--cwd /path] [--project slug] [--full] [--quiet]
//   node vanta-index-code.js --file /path/to/single/file.ts   # incremental
//   node vanta-index-code.js --dump --project little-wins      # show entries

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const VANTA_DIR = path.join(os.homedir(), '.vanta');
const KNOWLEDGE_DIR = path.join(VANTA_DIR, 'knowledge');
const CURSOR_FILE = path.join(VANTA_DIR, 'code-knowledge-cursor.json');

// Legacy file from v3.4 Tier 2 (pre-shard). On first Tier 3 run we migrate
// its content into per-project shards then leave it in place (rename to .bak)
// so a downgrade still has its data.
const LEGACY_KNOWLEDGE_FILE = path.join(VANTA_DIR, 'code-knowledge.jsonl');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go']);
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', '__pycache__', 'target', 'venv', '.venv',
  '.pytest_cache', 'test-results', 'qa-reports', '.expo',
  '.claude',  // Codex P3: vendor scaffolding (gstack, plugins) lives here
]);
const MAX_FILE_BYTES = 200_000;
const MAX_FILES_PER_RUN = 5_000;

// Tag for slugs that don't match any known project keyword. Resolver treats
// these as foreign (penalized/dropped), not global. Keeps unknown projects
// from leaking into every query.
const UNKNOWN_PROJECT = '__unknown_project__';

const PROJECT_KEYWORDS = {
  'little-wins':       [/\blittle[\s-]?wins?\b/i, /\bMitthu\b/i, /\bPOCSO\b/i, /\bSDQ\b/i, /\bIndian norms\b/i, /\btwo[- ]signal\b/i, /\bDPDP\b/i, /\bbajajvinamr-little-wins\b/],
  'pi-perception':     [/\bpi[- ]?perception\b/i, /\b12[- ]dim\b/i, /\bperception intelligence\b/i, /\bbajajvinamr-pi-perception\b/],
  'sales-agent-publisher': [/\bsales[- ]agent[- ]publisher\b/i, /\bsalestracker\b/i],
  'founderos':         [/\bfounder ?os\b/i, /\bpaperclip\b/i],
  'priyaa-audit':      [/\bpriyaa\b/i],
  'vanta':             [/\bvanta[- ]run\b/i, /\bvanta[- ]council\b/i, /\bvanta[- ]sync\b/i, /\bvanta-resolve\b/, /\bvanta-brief\b/, /\bvanta-index\b/, /\bcouncil[- ]advisory\b/, /\bplan[- ]watcher\b/],
};

function canonProject(slug) {
  if (!slug) return null;
  const lower = slug.toLowerCase();
  for (const [proj, regexes] of Object.entries(PROJECT_KEYWORDS)) {
    if (regexes.some(re => re.test(lower))) return proj;
  }
  const m = lower.match(/^([a-z0-9]+)-(.+)$/);
  if (m && m[2].includes('-')) return m[2];
  return lower;
}

// Returns the CANONICAL slug for known projects; UNKNOWN_PROJECT for unknown.
// Resolver uses this distinction to prevent unknown-project bleed.
function projectTagForIndex(slug) {
  if (!slug) return UNKNOWN_PROJECT;
  const canon = canonProject(slug);
  // canonProject returns the lowered slug as fallback; check if it matched a
  // known project. Known if canon appears as a key in PROJECT_KEYWORDS.
  if (canon && PROJECT_KEYWORDS[canon]) return canon;
  return UNKNOWN_PROJECT;
}

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

// Hash of SENSITIVE_PATTERNS — written to cursor; mismatch on next run forces
// --full re-crawl so older files get re-evaluated under new patterns.
function patternsHash() {
  const sig = SENSITIVE_PATTERNS.map(p => `${p.cat}|${p.re.source}|${p.re.flags}|${p.why}`).join('\n');
  return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
}

// CLAUDE.md sections worth harvesting. Codex P3: "Commands" section is
// launcher noise (npm run dev). Drop it.
const CLAUDE_MD_SECTIONS = [
  'Gotchas', 'Safety', 'Code Conventions', 'Architecture', 'Game Engine Rules',
  'Testing Discipline', 'Current State',
];

// Path-based rank multipliers applied at index time so the resolver doesn't
// need project knowledge. <1.0 = down-rank (less authoritative).
//   - app/src/app/**/page.tsx = marketing/legal/explanatory page copy
//   - __tests__/ + .test.ts = describes patterns, doesn't enforce
//   - .stories.tsx + storybook = component documentation
const PATH_RANK_RULES = [
  { match: /[/\\]__tests__[/\\]/,                        rank: 0.45 },
  { match: /\.test\.[tj]sx?$/,                            rank: 0.45 },
  { match: /\.spec\.[tj]sx?$/,                            rank: 0.45 },
  { match: /\.stories\.[tj]sx?$/,                         rank: 0.40 },
  // src/app/**/page.tsx — Next.js App Router page files (any depth)
  { match: /[/\\]src[/\\]app[/\\].+[/\\]page\.tsx$/,      rank: 0.55 },
  // App-router layouts/templates are also UI shells
  { match: /[/\\]src[/\\]app[/\\].+[/\\]layout\.tsx$/,    rank: 0.65 },
  { match: /[/\\](demo|pitch|marketing|landing|public)[/\\]/, rank: 0.40 },
  // Vanta's own indexer code: regex tables look like pattern hits to itself.
  // Self-indexing a project that contains pattern definitions creates
  // recursive false positives ("POCSO" matched in vanta-index-code.js because
  // the SENSITIVE_PATTERNS table mentions POCSO). Down-rank so user-curated
  // truth dominates if the user is working on vanta itself.
  { match: /[/\\]bin[/\\]vanta-(index|resolve|brief)/,    rank: 0.20 },
];

function pathRank(filePath) {
  for (const rule of PATH_RANK_RULES) {
    if (rule.match.test(filePath)) return rule.rank;
  }
  return 1.0;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function ensureKnowledgeDir() {
  if (!fs.existsSync(VANTA_DIR)) fs.mkdirSync(VANTA_DIR, { recursive: true });
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

function shardPath(slug) {
  // Sanitize slug for filesystem use.
  const safe = slug.replace(/[^a-z0-9_.-]/gi, '_');
  return path.join(KNOWLEDGE_DIR, `${safe}.jsonl`);
}

function loadCursor() {
  const c = readSafe(CURSOR_FILE);
  if (!c) return { patternsHash: null, projects: {} };
  try {
    const j = JSON.parse(c);
    // Migrate legacy cursor schema if needed
    if (j.projects) return { patternsHash: j.patternsHash || null, projects: j.projects };
    // Old shape: top-level keys are project slugs
    return { patternsHash: null, projects: j };
  } catch { return { patternsHash: null, projects: {} }; }
}

function saveCursor(cursor) {
  ensureKnowledgeDir();
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
}

// Atomic write: stage to .tmp then rename. Survives concurrent hook fires
// because rename is atomic on POSIX. Last-writer-wins is still possible but
// the file is never observed in a half-written state.
function atomicWriteJsonl(file, entries) {
  ensureKnowledgeDir();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
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

function* walkSource(root) {
  const stack = [root];
  let yielded = 0;
  while (stack.length && yielded < MAX_FILES_PER_RUN) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Honor SKIP_DIRS for hidden + non-hidden alike (.claude is now skipped).
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
        pathRank: rank,           // resolver uses this as a score multiplier
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
        if (bullets && bullets.length > 1) {
          for (const b of bullets) {
            const text = b.replace(/^\s*-\s+/, '').trim();
            if (text.length < 10) continue;
            out.push({
              kind: 'claude-md',
              project: projectSlug,
              category: `claude-md:${curSection.toLowerCase().replace(/\s+/g, '-')}`,
              why: `Project gotcha from ${rel} § ${curSection}`,
              source: `${rel}:${curStart}`,
              snippet: text.slice(0, 240),
              context: null,
              pathRank: 1.0,  // CLAUDE.md is always high-trust
              ts: new Date().toISOString(),
            });
          }
        } else {
          out.push({
            kind: 'claude-md',
            project: projectSlug,
            category: `claude-md:${curSection.toLowerCase().replace(/\s+/g, '-')}`,
            why: `Project gotcha from ${rel} § ${curSection}`,
            source: `${rel}:${curStart}`,
            snippet: body.slice(0, 400),
            context: null,
            pathRank: 1.0,
            ts: new Date().toISOString(),
          });
        }
      }
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h2 = l.match(/^##\s+(.+)/);
    if (h2) {
      flush();
      curSection = h2[1].trim();
      curStart = i + 1;
    } else if (curSection) {
      buf.push(l);
    }
  }
  flush();
  return out;
}

// ─── One-time legacy migration ──────────────────────────────────────────────
// Tier 2 wrote a single global ~/.vanta/code-knowledge.jsonl. On first Tier 3
// run, split it into per-project shards and rename the legacy file to .bak.
function migrateLegacyIfNeeded(quiet) {
  if (!fs.existsSync(LEGACY_KNOWLEDGE_FILE)) return;
  const content = readSafe(LEGACY_KNOWLEDGE_FILE);
  if (!content) { return; }
  ensureKnowledgeDir();
  const byProject = {};
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const slug = (e.project && e.project !== '__global__') ? e.project : UNKNOWN_PROJECT;
    (byProject[slug] = byProject[slug] || []).push(e);
  }
  let migrated = 0;
  for (const [slug, entries] of Object.entries(byProject)) {
    // Merge with existing shard (preserves any post-migration entries)
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
  fs.renameSync(LEGACY_KNOWLEDGE_FILE, LEGACY_KNOWLEDGE_FILE + '.bak');
  if (!quiet) process.stdout.write(`Migrated ${migrated} legacy entries into ${Object.keys(byProject).length} per-project shard(s).\n`);
}

// ─── Index runner ───────────────────────────────────────────────────────────

function runIndex({ cwd, project, full, quiet, singleFile }) {
  ensureKnowledgeDir();
  migrateLegacyIfNeeded(quiet);

  const projectRoot = path.resolve(cwd);
  const inferredSlug = canonProject(project) || canonProject(getProjectSlug(projectRoot)) || path.basename(projectRoot);
  const tag = projectTagForIndex(inferredSlug);

  // Patterns hash — Gemini P2 fix. If hash drifted vs cursor, force --full.
  const cursor = loadCursor();
  const curHash = patternsHash();
  if (cursor.patternsHash !== curHash && !singleFile) {
    if (!quiet && cursor.patternsHash) {
      process.stdout.write(`SENSITIVE_PATTERNS changed (was ${cursor.patternsHash} → now ${curHash}); forcing --full.\n`);
    }
    full = true;
  }
  cursor.projects = cursor.projects || {};
  const projCursor = cursor.projects[tag] || {};

  const filesProcessed = [];
  const allEntries = [];

  if (singleFile) {
    const abs = path.resolve(singleFile);
    let entries = [];
    if (fs.existsSync(abs)) {
      const ext = path.extname(abs);
      if (path.basename(abs) === 'CLAUDE.md') {
        entries = extractFromClaudeMd(abs, projectRoot, tag);
      } else if (SOURCE_EXTS.has(ext)) {
        entries = extractFromSource(abs, projectRoot, tag);
      }
      const st = statSafe(abs);
      if (st) projCursor[abs] = st.mtimeMs;
    } else {
      // Codex P2: file deleted → drop its entries from cursor too
      delete projCursor[abs];
    }
    filesProcessed.push(abs);
    allEntries.push(...entries);
  } else {
    for (const f of walkSource(projectRoot)) {
      const st = statSafe(f);
      if (!st) continue;
      if (!full && projCursor[f] === st.mtimeMs) continue;
      const entries = extractFromSource(f, projectRoot, tag);
      filesProcessed.push(f);
      allEntries.push(...entries);
      projCursor[f] = st.mtimeMs;
    }
    for (const f of walkClaudeMd(projectRoot)) {
      const st = statSafe(f);
      if (!st) continue;
      if (!full && projCursor[f] === st.mtimeMs) continue;
      const entries = extractFromClaudeMd(f, projectRoot, tag);
      filesProcessed.push(f);
      allEntries.push(...entries);
      projCursor[f] = st.mtimeMs;
    }
  }

  // Per-project shard read-modify-write — now O(N entries in THIS project),
  // not across all projects. Hot path stays fast even at scale.
  const shard = shardPath(tag);
  const existing = loadShard(tag);
  const reprocessedSources = new Set();
  for (const f of filesProcessed) {
    const rel = path.relative(projectRoot, f);
    reprocessedSources.add(rel);
    // Codex P2 fix: in single-file mode, also drop entries for this file
    // even if reindex returned nothing (handles delete + zero-match edits).
  }
  const kept = existing.filter(e => {
    const sourceFile = (e.source || '').split(':')[0];
    return !reprocessedSources.has(sourceFile);
  });
  // --full mode: also drop entries whose source no longer exists
  const finalExisting = full
    ? kept.filter(e => {
        const sourceFile = (e.source || '').split(':')[0];
        return fs.existsSync(path.join(projectRoot, sourceFile));
      })
    : kept;

  const finalEntries = [...finalExisting, ...allEntries];
  atomicWriteJsonl(shard, finalEntries);

  cursor.projects[tag] = projCursor;
  cursor.patternsHash = curHash;
  saveCursor(cursor);

  if (!quiet) {
    const byCat = {};
    for (const e of allEntries) byCat[e.category] = (byCat[e.category] || 0) + 1;
    process.stdout.write(`Indexed ${filesProcessed.length} file(s) for ${tag}: ${allEntries.length} entries\n`);
    for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${cat.padEnd(28)} ${n}\n`);
    }
    process.stdout.write(`Shard total: ${finalEntries.length} entries → ${shard}\n`);
  }
  return { processed: filesProcessed.length, entries: allEntries.length, totalEntries: finalEntries.length, shard };
}

function dumpEntries(project) {
  const tag = projectTagForIndex(project) === UNKNOWN_PROJECT
    ? canonProject(project) || project
    : projectTagForIndex(project);
  const file = shardPath(tag || UNKNOWN_PROJECT);
  if (!fs.existsSync(file)) {
    process.stdout.write(`(no shard at ${file})\n`);
    return;
  }
  const entries = loadShard(tag);
  for (const e of entries) {
    process.stdout.write(`[${e.category}] ${e.source} (rank=${e.pathRank ?? 1.0})\n  ${e.snippet}\n${e.context ? '  ctx: ' + e.context.slice(0, 120) + '\n' : ''}\n`);
  }
  process.stdout.write(`Total: ${entries.length} entries for ${tag}\n`);
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
  if (args.dump) {
    dumpEntries(args.project);
    return;
  }
  runIndex({
    cwd: args.cwd || process.cwd(),
    project: args.project,
    full: !!args.full,
    quiet: !!args.quiet,
    singleFile: args.file || null,
  });
}

if (require.main === module) main();
module.exports = { runIndex, canonProject, projectTagForIndex, SENSITIVE_PATTERNS, UNKNOWN_PROJECT, shardPath, KNOWLEDGE_DIR };
