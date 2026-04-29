#!/usr/bin/env node
// vanta-index-code — code-knowledge indexer.
//
// Both councils (Codex + Gemini, R1+R2) flagged that ~12 months of operational
// LW knowledge (POCSO scanner reconciliation, DPDP boundaries, output-filter
// veto, two-signal rule, Indian-norms gates) lives in code and is invisible to
// the harness. This indexer is the council-converged Tier 2: crawl a project,
// extract sensitive boundary code + per-subdir CLAUDE.md gotchas, emit them as
// project-tagged "code-knowledge" entries that vanta-resolve queries alongside
// invariants/decisions/gotchas/episodes.
//
// Approach: pattern-based, deterministic. AST parsing is tempting but brittle
// across TS/JS/Python/Rust. Regex over content scales to 1000+ files in <2s
// and is auditable — each match is reviewable by the user.
//
// Output: ~/.vanta/code-knowledge.jsonl (one JSON entry per match)
// Cursor: ~/.vanta/code-knowledge-cursor.json (last-indexed file mtimes)
//
// Usage:
//   node vanta-index-code.js [--cwd /path] [--project slug] [--full] [--quiet]
//   node vanta-index-code.js --file /path/to/single/file.ts   # incremental
//   node vanta-index-code.js --dump --project little-wins      # show indexed entries

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const VANTA_DIR = path.join(os.homedir(), '.vanta');
const KNOWLEDGE_FILE = path.join(VANTA_DIR, 'code-knowledge.jsonl');
const CURSOR_FILE = path.join(VANTA_DIR, 'code-knowledge-cursor.json');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go']);
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage',
  '.cache', '.vercel', '.turbo', '__pycache__', 'target', 'venv', '.venv',
  '.pytest_cache', 'test-results', 'qa-reports', '.expo',
]);
const MAX_FILE_BYTES = 200_000;  // skip giant generated files
const MAX_FILES_PER_RUN = 5_000;

// Same project-keywords table as vanta-resolve. Kept inline (not imported)
// so the indexer stays a single-file utility.
const PROJECT_KEYWORDS = {
  'little-wins':       [/\blittle[\s-]?wins?\b/i, /\bMitthu\b/i, /\bPOCSO\b/i, /\bSDQ\b/i, /\bIndian norms\b/i, /\btwo[- ]signal\b/i, /\bDPDP\b/i, /\bbajajvinamr-little-wins\b/],
  'pi-perception':     [/\bpi[- ]?perception\b/i, /\b12[- ]dim\b/i, /\bperception intelligence\b/i, /\bbajajvinamr-pi-perception\b/],
  'sales-agent-publisher': [/\bsales[- ]agent[- ]publisher\b/i, /\bsalestracker\b/i],
  'founderos':         [/\bfounder ?os\b/i, /\bpaperclip\b/i],
  'priyaa-audit':      [/\bpriyaa\b/i],
  'vanta':             [/\bvanta[- ]run\b/i, /\bvanta[- ]council\b/i, /\bvanta[- ]sync\b/i, /\bvanta-resolve\b/, /\bvanta-brief\b/, /\bcouncil[- ]advisory\b/, /\bplan[- ]watcher\b/],
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

// Detection patterns. Each entry is a (category, regex, description) triple.
// Categories double as filter keys for vanta-resolve queries.
//
// Tuning notes (council-driven):
//   - `child-safety` covers POCSO/COPPA/safeguarding — these are the highest-
//      stakes paths in LW. Surface aggressively.
//   - `output-filter` catches Mitthu's final veto layer — a regression here
//      means LLM output reaches the child unfiltered.
//   - `consent` catches DPDP-region routing and parental gates.
//   - `auth-boundary` catches middleware + service-role usage (anti-pattern
//      detection: service-role in client code is a council BLOCK).
//   - `pii` catches name/dob/age/school_name handling — DPDP §11 territory.
//   - `tz-cron` catches scheduled jobs (TZ=Asia/Kolkata is load-bearing).
//   - `red-team` catches the LW Mitthu adversarial harness — never delete.
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

// CLAUDE.md sections to harvest as code-knowledge. These are project-internal
// gotchas that the user already wrote — Tier 1 only read root CLAUDE.md, but
// LW has app/CLAUDE.md with the actual game-engine rules.
const CLAUDE_MD_SECTIONS = [
  'Gotchas', 'Safety', 'Code Conventions', 'Architecture', 'Game Engine Rules',
  'Testing Discipline', 'Current State', 'Commands',
];

// ─── Helpers ────────────────────────────────────────────────────────────────
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function ensureVantaDir() {
  if (!fs.existsSync(VANTA_DIR)) fs.mkdirSync(VANTA_DIR, { recursive: true });
}

function loadCursor() {
  const c = readSafe(CURSOR_FILE);
  if (!c) return {};
  try { return JSON.parse(c); } catch { return {}; }
}

function saveCursor(cursor) {
  ensureVantaDir();
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
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

// Walk the tree, yielding source files. Honors SKIP_DIRS, MAX_FILE_BYTES.
function* walkSource(root) {
  const stack = [root];
  let yielded = 0;
  while (stack.length && yielded < MAX_FILES_PER_RUN) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
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

// Walk the tree for CLAUDE.md files (root + subdirs, but not in node_modules).
function* walkClaudeMd(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
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

// Find sensitive-pattern matches in source. Returns array of entries with
// surrounding comment context + the matched line.
function extractFromSource(filePath, projectRoot, projectSlug) {
  const content = readSafe(filePath);
  if (!content) return [];
  const lines = content.split('\n');
  const out = [];
  const seen = new Set();  // dedup: one entry per (file, line, category)

  for (const { cat, re, why } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip pure import/require lines — too noisy
      if (/^\s*(import|from|require\s*\(|export\s*\*\s*from)/.test(line)) continue;
      const fresh = new RegExp(re.source, re.flags.replace('g', ''));
      if (!fresh.test(line)) continue;
      const key = `${filePath}:${i+1}:${cat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Pull surrounding comment context: walk backward up to 8 lines for
      // /* */ block or // line comments, stop at first non-comment non-blank.
      const ctxLines = [];
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const l = lines[j];
        if (/^\s*\/\//.test(l) || /^\s*\*/.test(l) || /^\s*\/\*/.test(l) || /^\s*#/.test(l)) {
          ctxLines.unshift(l.trim());
        } else if (/^\s*$/.test(l)) {
          if (ctxLines.length) break;  // blank between comment and code = end
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
        ts: new Date().toISOString(),
      });
    }
  }
  return out;
}

// Harvest CLAUDE.md sections — project-internal documentation.
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
        // Split bullet sub-entries — each "- " gets its own knowledge entry
        // for granular recall.
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

// ─── Index runner ───────────────────────────────────────────────────────────

function runIndex({ cwd, project, full, quiet, singleFile }) {
  ensureVantaDir();
  const projectRoot = path.resolve(cwd);
  const projectSlug = canonProject(project) || canonProject(getProjectSlug(projectRoot)) || path.basename(projectRoot);
  const cursor = loadCursor();
  const projCursor = cursor[projectSlug] || {};

  const filesProcessed = [];
  const allEntries = [];

  // Single-file mode (used by code-index-watch hook)
  if (singleFile) {
    const abs = path.resolve(singleFile);
    if (fs.existsSync(abs)) {
      const ext = path.extname(abs);
      let entries = [];
      if (path.basename(abs) === 'CLAUDE.md') {
        entries = extractFromClaudeMd(abs, projectRoot, projectSlug);
      } else if (SOURCE_EXTS.has(ext)) {
        entries = extractFromSource(abs, projectRoot, projectSlug);
      }
      filesProcessed.push(abs);
      allEntries.push(...entries);
      const st = statSafe(abs);
      if (st) projCursor[abs] = st.mtimeMs;
    }
  } else {
    // Full crawl: source + CLAUDE.md
    for (const f of walkSource(projectRoot)) {
      const st = statSafe(f);
      if (!st) continue;
      if (!full && projCursor[f] === st.mtimeMs) continue;  // unchanged since last run
      const entries = extractFromSource(f, projectRoot, projectSlug);
      filesProcessed.push(f);
      allEntries.push(...entries);
      projCursor[f] = st.mtimeMs;
    }
    for (const f of walkClaudeMd(projectRoot)) {
      const st = statSafe(f);
      if (!st) continue;
      if (!full && projCursor[f] === st.mtimeMs) continue;
      const entries = extractFromClaudeMd(f, projectRoot, projectSlug);
      filesProcessed.push(f);
      allEntries.push(...entries);
      projCursor[f] = st.mtimeMs;
    }
  }

  // Rewrite policy: read all existing entries, drop stale entries for files
  // we just reprocessed (so renames/deletions don't leak), append new entries.
  // Keep entries from OTHER projects untouched.
  let existing = [];
  const ek = readSafe(KNOWLEDGE_FILE);
  if (ek) {
    for (const line of ek.split('\n')) {
      if (!line.trim()) continue;
      try { existing.push(JSON.parse(line)); } catch {}
    }
  }
  const reprocessedSources = new Set();
  for (const f of filesProcessed) {
    reprocessedSources.add(path.relative(projectRoot, f));
  }
  const kept = existing.filter(e => {
    if (e.project !== projectSlug) return true;  // foreign-project entries: keep
    // Same project: drop if its source file is one we just reprocessed
    const sourceFile = (e.source || '').split(':')[0];
    return !reprocessedSources.has(sourceFile);
  });
  // Full-crawl mode: ALSO drop entries whose source file no longer exists
  // (handles deletions and renames cleanly).
  const finalExisting = full
    ? kept.filter(e => {
        if (e.project !== projectSlug) return true;
        const sourceFile = (e.source || '').split(':')[0];
        return fs.existsSync(path.join(projectRoot, sourceFile));
      })
    : kept;

  const finalEntries = [...finalExisting, ...allEntries];
  fs.writeFileSync(KNOWLEDGE_FILE, finalEntries.map(e => JSON.stringify(e)).join('\n') + (finalEntries.length ? '\n' : ''));

  cursor[projectSlug] = projCursor;
  saveCursor(cursor);

  if (!quiet) {
    const byCat = {};
    for (const e of allEntries) byCat[e.category] = (byCat[e.category] || 0) + 1;
    process.stdout.write(`Indexed ${filesProcessed.length} file(s) for ${projectSlug}: ${allEntries.length} entries\n`);
    for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${cat.padEnd(24)} ${n}\n`);
    }
    process.stdout.write(`Total knowledge file: ${finalEntries.length} entries → ${KNOWLEDGE_FILE}\n`);
  }
  return { processed: filesProcessed.length, entries: allEntries.length, totalEntries: finalEntries.length };
}

function dumpEntries(project) {
  const c = readSafe(KNOWLEDGE_FILE);
  if (!c) { process.stdout.write('(no entries)\n'); return; }
  const target = canonProject(project);
  const lines = c.split('\n').filter(Boolean);
  let n = 0;
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (target && canonProject(e.project) !== target) continue;
    n++;
    process.stdout.write(`[${e.category}] ${e.source}\n  ${e.snippet}\n${e.context ? '  ctx: ' + e.context.slice(0, 120) + '\n' : ''}\n`);
  }
  process.stdout.write(`Total: ${n} entries${target ? ` for ${target}` : ''}\n`);
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
module.exports = { runIndex, canonProject, SENSITIVE_PATTERNS };
