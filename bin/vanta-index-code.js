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
const { canonProject, isKnownProject, slugForFilesystem, projectPatternsFor } = require('./vanta-projects');

// ─── Config ─────────────────────────────────────────────────────────────────
//
// Codex council R5 P2 fix — VANTA_DIR_OVERRIDE was previously ignored here.
// The code-index-watch hook shells into runIndex() and would always write
// to the user's real ~/.vanta even under test sandbox. Replaced with
// resolver functions so every read of these paths picks up the current
// value of process.env.VANTA_DIR_OVERRIDE.
function _vantaDir()     { return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta'); }
function _knowledgeDir() { return path.join(_vantaDir(), 'knowledge'); }
function _legacyJsonl()  { return path.join(_vantaDir(), 'code-knowledge.jsonl'); }
function _legacyCursor() { return path.join(_vantaDir(), 'code-knowledge-cursor.json'); }
// Back-compat const exports for callers that imported VANTA_DIR directly.
// Resolved lazily — re-read each access via the helpers above.
const VANTA_DIR = path.join(os.homedir(), '.vanta');
const KNOWLEDGE_DIR = path.join(VANTA_DIR, 'knowledge');

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

// Detection patterns — three layers, merged at index time:
//
//   1. BASELINE_PATTERNS — universal across all projects (auth, secrets, PII,
//      TZ, red-team). Apply regardless of project.
//   2. PROJECT_SPECIFIC_PATTERNS — curated per known project. LW gets POCSO/
//      DPDP/two-signal/output-filter; pi-perception gets 12-dim/perception
//      vocabulary; etc. Lives in code so updates ship via repo.
//   3. CLAUDE.md `## Sensitive Patterns` — user-defined additions, loaded
//      from project CLAUDE.md at index time. Lets users extend without code
//      changes.
//
// Council Tier 4 finding: hardcoding LW patterns in the baseline made the
// indexer effectively LW-only for non-LW projects. This 3-layer structure
// fixes that: baseline is generic, per-project is curated and switchable,
// CLAUDE.md is the user extension surface.
const BASELINE_PATTERNS = [
  { cat: 'auth-boundary', re: /\b(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|service[- ]role|middleware\.ts|withAuth|requireAuth|requireRole|getSession|auth\.uid|JWT_SECRET)\b/g, why: 'Auth boundary — service-role usage, middleware, role gating, JWT secrets.' },
  { cat: 'pii',           re: /\b(date[- ]of[- ]birth|guardian_email|aadhaar|aadhar|pan_number|ssn|tax_id|passport_number)\b/gi, why: 'PII field — region-locked + encrypted at rest, must not log in plain text.' },
  { cat: 'tz-cron',       re: /\b(TZ=[A-Za-z_/]+|cron[- ]schedule|node[- ]cron|new CronJob|scheduleAt|sendWindow)\b/g, why: 'Timezone-sensitive cron — TZ env var is load-bearing for scheduled jobs.' },
  { cat: 'red-team',      re: /\b(red[- ]team|adversarial[- ]eval|attack[- ]corpus|RED_TEAM=1)\b/gi, why: 'Red-team / adversarial harness — must pass before merging changes near it.' },
  { cat: 'secrets',       re: /\b(API_KEY|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|process\.env\.[A-Z_]+_(KEY|SECRET|TOKEN))\b/g, why: 'Secret value — never log, never commit, validate presence at boot.' },
];

// Curated per-project patterns moved to bin/vanta-projects.js (Tier 5 cleanup #2).
// PROJECT_KEYWORDS + PROJECT_SPECIFIC_PATTERNS now live in one module so
// adding a new project edits a single file. Use projectPatternsFor(slug).

// Read project-specific patterns from CLAUDE.md `## Sensitive Patterns` section.
// Format (one per line):
//   - <regex> → <category> [optional: | <why explanation>]
// Example LW CLAUDE.md:
//   ## Sensitive Patterns
//   - POCSO|COPPA|safeguard → child-safety | POCSO §19/§21 mandatory reporting
//   - DPDP|parental[- ]consent|child[- ]pii → consent | DPDP child PII region restriction
//   - filterOutput|output[- ]filter → output-filter | LLM output veto gate
//
// Patterns are case-insensitive (added 'gi' flags).
// Returns array of {cat, re, why} compatible with BASELINE_PATTERNS.
function loadProjectPatterns(projectRoot) {
  const out = [];
  // Walk all CLAUDE.md files (root + subdirs) for sections.
  for (const filePath of walkClaudeMd(projectRoot)) {
    const content = readSafe(filePath);
    if (!content) continue;
    const m = content.match(/^##\s+Sensitive Patterns\s*$([\s\S]*?)(?=\n##\s|\n*$)/m);
    if (!m) continue;
    const section = m[1];
    for (const rawLine of section.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('-')) continue;
      const body = line.slice(1).trim();
      // Split: <regex> → <category> [| <why>]
      const arrowParts = body.split(/\s*[→]\s*/);
      if (arrowParts.length < 2) continue;
      const reSrc = arrowParts[0].trim();
      const rest = arrowParts.slice(1).join('→').trim();
      const [cat, ...whyParts] = rest.split(/\s*\|\s*/);
      const why = whyParts.join(' | ').trim() || `Project pattern from ${path.basename(filePath)}: ${cat}`;
      try {
        const re = new RegExp(reSrc, 'gi');
        out.push({ cat: cat.trim(), re, why });
      } catch (err) {
        // Tier 5 P3 (Codex): silent swallow created invisible coverage gaps.
        // Warn to stderr (only path that gets through quiet mode is critical).
        process.stderr.write(`vanta-index: invalid regex in ${path.relative(projectRoot, filePath) || filePath}: ${reSrc} — ${err.message}\n`);
      }
    }
  }
  return out;
}

// Effective patterns for a project = baseline + project-curated + CLAUDE.md.
// Order matters for category labelling but not correctness — duplicates by
// category are fine; distinct entries fire independently.
function effectivePatterns(slug, projectRoot) {
  return [...BASELINE_PATTERNS, ...projectPatternsFor(slug), ...loadProjectPatterns(projectRoot)];
}

// Backwards compat for tests / dump / external imports — kept as a
// reference to the baseline only (project patterns are dynamic).
const SENSITIVE_PATTERNS = BASELINE_PATTERNS;

// Hash includes the active patterns (baseline + project) so cursor drift is
// detected when EITHER the baseline changes OR the project's CLAUDE.md
// `## Sensitive Patterns` section is edited.
function patternsHash(patterns) {
  const arr = patterns || SENSITIVE_PATTERNS;
  const sig = arr.map(p => `${p.cat}|${p.re.source}|${p.re.flags}|${p.why}`).join('\n');
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
  if (!fs.existsSync(_vantaDir()))     fs.mkdirSync(_vantaDir(),     { recursive: true });
  if (!fs.existsSync(_knowledgeDir())) fs.mkdirSync(_knowledgeDir(), { recursive: true });
}

function shardPath(slug)  { return path.join(_knowledgeDir(), `${slugForFilesystem(slug)}.jsonl`); }
function cursorPath(slug) { return path.join(_knowledgeDir(), `${slugForFilesystem(slug)}.cursor.json`); }
function lockPath(slug)   { return path.join(_knowledgeDir(), `${slugForFilesystem(slug)}.lock`); }

// ─── Shard locking ──────────────────────────────────────────────────────────
// Advisory file lock via O_EXCL. Tier 3/4/5 evolution:
//   Atomic rename alone wasn't enough — two same-project hook fires both
//   read, both write, last-writer-wins. Lock serializes them.
//
// Tier 5 hardening (Codex P2): stale-lock steal now also checks PID liveness.
// Pure time-based steal (>5s) was risky for slow --full runs on large
// projects. With PID check: if the holder PID still exists, we wait;
// only kill the lock when the process is genuinely gone OR exceeded a
// generous safety threshold (60s, well beyond any realistic run).
function _isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function _readLockMeta(file) {
  const c = readSafe(file);
  if (!c) return null;
  try { return JSON.parse(c); } catch { return null; }
}

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
      // Stale-lock steal — Tier 5: PID-aware.
      const st = statSafe(file);
      const meta = _readLockMeta(file);
      if (st) {
        const ageMs = Date.now() - st.mtimeMs;
        const holderAlive = meta && _isPidAlive(meta.pid);
        if (!holderAlive || ageMs > 60_000) {
          try { fs.unlinkSync(file); } catch {}
          continue;
        }
      }
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
//
// Codex council R7 P3 — symlink handling. `withFileTypes: true` returns
// Dirent objects whose `isDirectory()` / `isFile()` reflect the link itself,
// not its target. The previous walkers silently dropped every symlinked
// directory and file. Common cases that broke: pnpm node_modules layouts,
// monorepos with symlinked shared dirs, devs who symlink CLAUDE.md across
// related projects.
//
// Fix: when entry is a symlink, statSync to follow it. Use realpath to
// detect cycles (don't recurse into a dir we already visited) and to scope
// the resolved target to projectRoot — symlinks pointing outside the tree
// are skipped (defense against malicious repos symlinking to ~/.ssh etc).
function _resolveEntry(p, projectRoot, visited) {
  // Returns { type: 'file' | 'dir' | null, real: <realpath> } or null on skip.
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  // Scope check: resolved path must stay inside projectRoot. Reject otherwise.
  // path.relative returning '..'-prefixed means outside root.
  const rel = path.relative(projectRoot, real);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  if (visited.has(real)) return null;
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (st.isDirectory()) { visited.add(real); return { type: 'dir',  real, st }; }
  if (st.isFile())      {                    return { type: 'file', real, st }; }
  return null;
}

function* walkSource(root) {
  const projectRoot = path.resolve(root);
  const visited = new Set([projectRoot]);
  const stack = [projectRoot];
  let yielded = 0;
  while (stack.length && yielded < MAX_FILES_PER_RUN) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        const r = _resolveEntry(p, projectRoot, visited);
        if (!r) continue;
        isDir  = r.type === 'dir';
        isFile = r.type === 'file';
      }
      if (isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(p);
      } else if (isFile) {
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
  const projectRoot = path.resolve(root);
  const visited = new Set([projectRoot]);
  const stack = [projectRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        const r = _resolveEntry(p, projectRoot, visited);
        if (!r) continue;
        isDir  = r.type === 'dir';
        isFile = r.type === 'file';
      }
      if (isDir) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(p);
      } else if (isFile && e.name === 'CLAUDE.md') {
        yield p;
      }
    }
  }
}

// ─── Extractors ─────────────────────────────────────────────────────────────
function extractFromSource(filePath, projectRoot, projectSlug, sensitivePatterns) {
  const content = readSafe(filePath);
  if (!content) return [];
  const lines = content.split('\n');
  const out = [];
  const seen = new Set();
  const rank = pathRank(filePath);

  for (const { cat, re, why } of sensitivePatterns) {
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
        // Tier 5 P1 fix: same-slug collision. Two repos both resolving to
        // slug "vanta" share vanta.jsonl. Without a per-root field, the
        // indexer's filter would drop entries from the other repo. Including
        // projectRoot lets the shard hold both repos' entries side-by-side.
        projectRoot,
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
          projectRoot,  // Tier 5 P1: same-slug collision fix
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
// Legacy detection: presence of _legacyJsonl() means Tier 2 wasn't
// migrated; presence of _legacyCursor() means Tier 2/3 cursor exists.
// Both get processed if found, then renamed to .bak.
function migrateLegacyIfNeeded(quiet) {
  ensureKnowledgeDir();
  // Tier 5 P2: migration writes shards via atomicWriteJsonl. Two parallel
  // runs (e.g. two indexers triggered by simultaneous edits in different
  // tmux panes) could both migrate, doubling entries. Guard with a single
  // global migration lock — first run does the work, others skip.
  const migrationLock = path.join(_knowledgeDir(), '.migration.lock');
  if (!acquireMigrationLock(migrationLock)) return;

  let migrated = 0;

  // Tier 2 global jsonl → split into per-slug shards
  if (fs.existsSync(_legacyJsonl())) {
    const content = readSafe(_legacyJsonl());
    let allShardsMigrated = true;  // Tier 5.2 (Codex): track partial failure
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
        if (!acquireLock(slug)) {
          // Tier 5.2 fix (Codex): if any shard's lock acquisition fails,
          // DON'T rename legacy to .bak — entries for that shard would be
          // permanently lost. Next migration run retries.
          allShardsMigrated = false;
          continue;
        }
        try {
          const existing = loadShard(slug);
          const seen = new Set(existing.map(e => `${e.source}|${e.category}`));
          const merged = [...existing];
          for (const e of entries) {
            const k = `${e.source}|${e.category}`;
            if (!seen.has(k)) { merged.push(e); seen.add(k); }
          }
          atomicWriteJsonl(shardPath(slug), merged);
          migrated += entries.length;
        } finally {
          releaseLock(slug);
        }
      }
    }
    // Only rename legacy file when EVERY shard migrated successfully.
    if (allShardsMigrated) {
      fs.renameSync(_legacyJsonl(), _legacyJsonl() + '.bak');
    } else if (!quiet) {
      process.stderr.write(`vanta-index: legacy migration partial (some shards locked); leaving ${_legacyJsonl()} for next run\n`);
    }
  }

  // Tier 3 __unknown_project__ shard → re-shard by raw slug if any entries
  // can be salvaged. Most can't (they didn't carry the original project),
  // so we drop the shard and let next --full re-extract.
  const unknownShard = path.join(_knowledgeDir(), '__unknown_project__.jsonl');
  if (fs.existsSync(unknownShard)) {
    fs.renameSync(unknownShard, unknownShard + '.bak');
  }

  // Tier 3 global cursor → drop. Per-project cursors get rebuilt on next run.
  if (fs.existsSync(_legacyCursor())) {
    const content = readSafe(_legacyCursor());
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
    fs.renameSync(_legacyCursor(), _legacyCursor() + '.bak');
  }

  if (!quiet && migrated > 0) {
    process.stdout.write(`Migrated ${migrated} legacy entries to per-slug shards.\n`);
  }
  try { fs.unlinkSync(migrationLock); } catch {}
}

// Migration lock — non-retrying. Either we get it or we skip migration.
// If another run is migrating, by the time it's done the legacy files are
// renamed to .bak, so on next run migration is a no-op.
function acquireMigrationLock(file) {
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    // Stale (>120s) → steal. Migration shouldn't take that long.
    const st = statSafe(file);
    const meta = _readLockMeta(file);
    if (st && (Date.now() - st.mtimeMs > 120_000 || !(meta && _isPidAlive(meta.pid)))) {
      try { fs.unlinkSync(file); } catch {}
      return acquireMigrationLock(file);
    }
    return false;
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
    // Tier 5: patterns now include project-defined additions from CLAUDE.md
    // `## Sensitive Patterns` section. Hash covers both baseline + project,
    // so editing the section auto-triggers --full on next run.
    const projectPatterns = effectivePatterns(slug, projectRoot);
    const cursor = loadCursor(slug);
    const curHash = patternsHash(projectPatterns);
    if (cursor.patternsHash !== curHash && !singleFile) {
      if (!quiet && cursor.patternsHash) {
        process.stdout.write(`Patterns changed (was ${cursor.patternsHash} → now ${curHash}); forcing --full.\n`);
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
        else if (SOURCE_EXTS.has(ext))         entries = extractFromSource(abs, projectRoot, slug, projectPatterns);
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
        const entries = extractFromSource(f, projectRoot, slug, projectPatterns);
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
    // Tier 5 P1: same-slug collision fix. When two repos share a shard
    // (both resolve to slug "vanta"), entries from OTHER project roots must
    // be preserved. Filter only entries whose projectRoot matches THIS run.
    const existing = loadShard(slug);
    const reprocessedSources = new Set();
    for (const f of filesProcessed) reprocessedSources.add(path.relative(projectRoot, f));
    const kept = existing.filter(e => {
      // Different project root → keep untouched (sibling repo's entries)
      if (e.projectRoot && e.projectRoot !== projectRoot) return true;
      // Same project root → drop if its source file was reprocessed this run
      const sourceFile = (e.source || '').split(':')[0];
      return !reprocessedSources.has(sourceFile);
    });
    // --full mode: drop entries whose source no longer exists, but only for
    // THIS project root. Sibling repo entries stay (they'll be cleaned by
    // their own --full run).
    const finalExisting = full
      ? kept.filter(e => {
          if (e.projectRoot && e.projectRoot !== projectRoot) return true;
          const sourceFile = (e.source || '').split(':')[0];
          return fs.existsSync(path.join(projectRoot, sourceFile));
        })
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
