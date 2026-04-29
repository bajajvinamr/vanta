#!/usr/bin/env node
// vanta-resolve — single canonical knowledge query layer.
//
// Replaces the four separate greps in /recall and the three separate parsers
// in council-advisory.js with one ranked, deduped, metadata-aware index.
//
// Sources (in order of authority):
//   1. invariants  — ~/.claude/rules/vinamr-invariants.md
//   2. decisions   — ~/.gstack/projects/<slug>/decisions.md
//   3. gotchas     — <project>/CLAUDE.md  Gotchas section
//   4. episodes    — ~/.vanta/episodes.jsonl
//   5. memory      — ~/.claude/projects/-Users-vinamr/memory/*.md
//
// Filters: drop expired decisions, drop superseded decisions.
// Ranking:  source_weight × confidence_mult × recency_mult + topic_match_bonus
//
// Usage:
//   node vanta-resolve.js --topic <name> [--project <slug>] [--max 5] [--format json|text]
//   echo '{"topic":"jwt","project":"pi-perception"}' | node vanta-resolve.js --stdin
//
// Returns ranked results for downstream consumers (council-advisory, /recall, etc.)

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ─────────────────────────────────────────────────────────────────
const SOURCE_WEIGHTS = { invariant: 2.0, decision: 1.5, gotcha: 1.5, episode: 1.0, memory: 0.8 };
const CONFIDENCE_MULT = { high: 1.5, medium: 1.0, low: 0.7, unknown: 1.0 };
const TODAY = new Date().toISOString().slice(0, 10);

// Cross-project bleed penalty — multiplies the final score of any result whose
// project tag does NOT match the active project (and isn't 'global'). Values <1
// down-rank foreign results so they only appear if no active-project results
// score higher. Both councils flagged this as the v3.4 safety prerequisite.
const FOREIGN_PENALTY = 0.15;
const GLOBAL_PROJECT = '__global__';

// Project-keyword index. Used to tag invariants and memory entries with the
// project they belong to. Slugs match gstack convention: <user>-<repo>.
// Add new projects here as they grow LW-specific or pi-perception-specific
// invariants. Untagged content defaults to GLOBAL (applies everywhere).
const PROJECT_KEYWORDS = {
  'little-wins':       [/\blittle[\s-]?wins?\b/i, /\bMitthu\b/i, /\bPOCSO\b/i, /\bSDQ\b/i, /\bIndian norms\b/i, /\btwo[- ]signal\b/i, /\bDPDP\b/i, /\bbajajvinamr-little-wins\b/],
  'pi-perception':     [/\bpi[- ]?perception\b/i, /\b12[- ]dim\b/i, /\bperception intelligence\b/i, /\bbajajvinamr-pi-perception\b/],
  'sales-agent-publisher': [/\bsales[- ]agent[- ]publisher\b/i, /\bsalestracker\b/i],
  'founderos':         [/\bfounder ?os\b/i, /\bpaperclip\b/i],
  'priyaa-audit':      [/\bpriyaa\b/i],
  'vanta':             [/\bvanta[- ]run\b/i, /\bvanta[- ]council\b/i, /\bvanta[- ]sync\b/i, /\bvanta[- ]patterns\b/i, /\bvanta-resolve\b/, /\bvanta-brief\b/, /\bcouncil[- ]advisory\b/, /\bplan[- ]watcher\b/],
};

// Detect project tag for arbitrary text. Returns first matching slug, or
// GLOBAL_PROJECT if no project keywords matched.
function detectProject(text) {
  if (!text) return GLOBAL_PROJECT;
  for (const [slug, regexes] of Object.entries(PROJECT_KEYWORDS)) {
    if (regexes.some(re => re.test(text))) return slug;
  }
  return GLOBAL_PROJECT;
}

// Normalize project slug — handles bare repo names ("little-wins"), gstack
// slugs ("bajajvinamr-little-wins"), and suffixed memory slugs ("little-wins-stack")
// to the same canonical form for matching.
// Order: PROJECT_KEYWORDS lookup first (covers "little-wins-stack" → "little-wins"
// and "bajajvinamr-little-wins" → "little-wins"), then fall back to user-prefix
// stripping for unknown projects.
function canonProject(slug) {
  if (!slug) return null;
  const lower = slug.toLowerCase();
  // Check known projects first — handles all suffix and prefix variants.
  for (const [proj, regexes] of Object.entries(PROJECT_KEYWORDS)) {
    if (regexes.some(re => re.test(lower))) return proj;
  }
  // Fallback: strip GitHub-user-prefix if remainder still has a dash.
  const m = lower.match(/^([a-z0-9]+)-(.+)$/);
  if (m && m[2].includes('-')) return m[2];
  return lower;
}

// Map invariant section names → stack tags that must be present in the project
// for the invariant to apply. If the project doesn't use the stack, the
// invariant is filtered out before it can pollute the constraint pack.
// Sections without a stack mapping are always-applicable (e.g. "Security / Config").
const SECTION_STACK_MAP = {
  'prisma':            ['prisma', '@prisma/client'],
  'pixijs v8':         ['pixi.js', '@pixi/react', 'pixijs'],
  'next.js / cloudflare pages': ['next'],
  'whatsapp / baileys': ['@whiskeysockets/baileys', 'baileys'],
  'bullmq / redis':    ['bullmq', 'ioredis'],
  'multi-llm / api clients': ['@anthropic-ai/sdk', 'openai'],
  'supabase / deno edge functions': ['@supabase/supabase-js', '@supabase/ssr'],
};

// Detect which stacks a project uses by parsing package manifests.
// Walks the cwd plus common subdirs (app/, web/, frontend/, packages/*,
// services/*) since monorepos and apps-in-subdirs are common.
// Memoized per cwd because manifests don't change across resolver calls.
const _stackCache = new Map();
const STACK_SUBDIRS = ['', 'app', 'web', 'frontend', 'backend', 'server', 'api', 'apps/web', 'apps/api', 'packages/web'];

function _readPkg(dir) {
  const c = readSafe(path.join(dir, 'package.json'));
  if (!c) return [];
  try {
    const j = JSON.parse(c);
    return Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies });
  } catch { return []; }
}

function detectStack(cwd) {
  if (!cwd) return new Set();
  if (_stackCache.has(cwd)) return _stackCache.get(cwd);
  const stacks = new Set();
  // Walk likely subdirs for package.json. Empty string means cwd itself.
  for (const sub of STACK_SUBDIRS) {
    const dir = sub ? path.join(cwd, sub) : cwd;
    if (!fs.existsSync(dir)) continue;
    for (const dep of _readPkg(dir)) stacks.add(dep.toLowerCase());
  }
  // Also discover any package.json under packages/ or services/ (common monorepo)
  for (const monoDir of ['packages', 'services', 'apps']) {
    const d = path.join(cwd, monoDir);
    if (!fs.existsSync(d)) continue;
    try {
      for (const sub of fs.readdirSync(d)) {
        for (const dep of _readPkg(path.join(d, sub))) stacks.add(dep.toLowerCase());
      }
    } catch { /* ignore */ }
  }
  // Python
  for (const f of ['pyproject.toml', 'requirements.txt']) {
    const c = readSafe(path.join(cwd, f));
    if (c) c.toLowerCase().match(/^([a-z0-9._-]+)/gm)?.forEach(p => stacks.add(p));
  }
  // Supabase config = strong signal even without npm deps
  for (const sub of ['', 'app', 'web']) {
    if (fs.existsSync(path.join(cwd, sub, 'supabase', 'config.toml'))) stacks.add('@supabase/supabase-js');
  }
  _stackCache.set(cwd, stacks);
  return stacks;
}

// True if the section is allowed under the active project's stack.
// Sections not in the map are always allowed (general security/config rules etc).
function sectionAllowedForStack(section, stacks) {
  if (!section) return true;
  const lower = section.toLowerCase();
  for (const [secKey, requiredDeps] of Object.entries(SECTION_STACK_MAP)) {
    if (lower.includes(secKey)) {
      // Section maps to a stack — require ANY of the stack deps to be present.
      return requiredDeps.some(dep => stacks.has(dep.toLowerCase()));
    }
  }
  return true;  // Unmapped section = always allowed
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function recencyMult(dateStr) {
  if (!dateStr) return 0.8;
  const days = Math.max(0, (Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days < 30)  return 1.0;
  if (days < 90)  return 0.85;
  if (days < 365) return 0.6;
  return 0.3;
}

function topicMatch(text, topic) {
  if (!text || !topic) return 0;
  // Allow optional trailing 's' (plurals: JWT/JWTs, hook/hooks, token/tokens).
  // Word-boundary on the left, optional 's' before right boundary.
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}s?\\b`, 'gi');
  const matches = (text.match(re) || []).length;
  return matches > 0 ? Math.min(matches, 5) : 0;
}

// ─── Source readers ─────────────────────────────────────────────────────────
function readInvariants(topic, cwd) {
  const file = path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.md');
  const content = readSafe(file);
  if (!content) return [];
  const stacks = detectStack(cwd);
  const out = [];
  let section = '(unsectioned)';
  let buf = null;
  const flush = () => {
    if (buf && topicMatch(buf.text, topic) > 0) {
      // Stack filter: drop invariants whose section maps to a stack the project
      // doesn't use. E.g. "## Prisma" is dropped on a Supabase-only project.
      // Both councils flagged this as the "Prisma on Supabase" false-positive.
      if (cwd && !sectionAllowedForStack(section, stacks)) { buf = null; return; }
      const project = detectProject(`${section}\n${buf.text}`);
      out.push({ source: 'invariant', section, excerpt: buf.text.trim(), path: file, line: buf.line, project });
    }
    buf = null;
  };
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h2 = l.match(/^##\s+(.+)/);
    if (h2) { flush(); section = h2[1].trim(); continue; }
    if (/^\s*-\s/.test(l))      { flush(); buf = { text: l, line: i + 1 }; }
    else if (buf && /^\s+\S/.test(l)) { buf.text += '\n' + l; }
    else                        { flush(); }
  }
  flush();
  return out;
}

function readDecisions(slug, topic) {
  if (!slug) return [];
  const file = path.join(os.homedir(), '.gstack', 'projects', slug, 'decisions.md');
  const content = readSafe(file);
  if (!content) return [];
  const get = (body, re) => { const m = body.match(re); return m ? m[1].trim() : null; };
  const blocks = content.split(/^## /m).slice(1);
  const entries = blocks.map(blob => {
    const lines = blob.split('\n');
    const heading = (lines[0] || '').trim();
    const body = lines.slice(1).join('\n');
    const dateMatch = heading.match(/(\d{4}-\d{2}-\d{2})/);
    return {
      heading, body,
      date: dateMatch ? dateMatch[1] : null,
      meta: {
        decision:   get(body, /\*\*Decision:?\*\*\s*([^\n]+)/i),
        verdict:    get(body, /\*\*Verdict:?\*\*\s*([^\n]+)/i),
        confidence: (get(body, /\*\*Confidence:?\*\*\s*([^\n]+)/i) || 'unknown').toLowerCase(),
        scope:      get(body, /\*\*Scope:?\*\*\s*([^\n]+)/i),
        expires:    get(body, /\*\*Expires:?\*\*\s*([^\n]+)/i),
        supersedes: get(body, /\*\*Supersedes:?\*\*\s*([^\n]+)/i),
      },
    };
  });
  // Drop expired
  const live = entries.filter(e => {
    const exp = e.meta.expires;
    if (!exp || /until superseded|n\/?a|none/i.test(exp)) return true;
    const m = exp.match(/(\d{4}-\d{2}-\d{2})/);
    return !m || m[1] >= TODAY;
  });
  // Drop superseded (when X.supersedes references Y.date, drop Y)
  const supersededDates = new Set(
    live.map(e => e.meta.supersedes && (e.meta.supersedes.match(/\d{4}-\d{2}-\d{2}/) || [])[0]).filter(Boolean)
  );
  return live
    .filter(e => !supersededDates.has(e.date))
    .filter(e => topicMatch(e.heading, topic) + topicMatch(e.body, topic) > 0)
    .map(e => ({
      source: 'decision',
      section: e.heading,
      excerpt: (e.meta.decision || e.meta.verdict || e.heading).slice(0, 200),
      confidence: e.meta.confidence,
      scope: e.meta.scope,
      expires: e.meta.expires,
      date: e.date,
      path: file,
      // Decisions are inherently project-scoped (file lives under project dir).
      project: canonProject(slug) || slug,
    }));
}

function readGotchas(cwd, topic) {
  if (!cwd) return [];
  const file = path.join(cwd, 'CLAUDE.md');
  const content = readSafe(file);
  if (!content) return [];
  const after = content.split(/^##\s+Gotchas/im)[1];
  if (!after) return [];
  const section = after.split(/^##\s+/m)[0];
  // Project = the directory we're reading from. Always project-scoped.
  const project = canonProject(path.basename(cwd)) || path.basename(cwd);
  const out = [];
  let buf = null;
  const flush = () => {
    if (buf && topicMatch(buf, topic) > 0) {
      out.push({ source: 'gotcha', excerpt: buf.trim(), path: file, project });
    }
    buf = null;
  };
  for (const l of section.split('\n')) {
    if (/^\s*-\s/.test(l))         { flush(); buf = l; }
    else if (buf && /^\s+\S/.test(l)) { buf += '\n' + l; }
    else                            { flush(); }
  }
  flush();
  return out;
}

function readEpisodes(topic, max = 5) {
  const file = path.join(os.homedir(), '.vanta', 'episodes.jsonl');
  const content = readSafe(file);
  if (!content) return [];
  const lines = content.split('\n').filter(Boolean);
  const seen = new Set();
  const out = [];
  // Iterate newest-first by reversing
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (seen.has(e.session_id)) continue;
    seen.add(e.session_id);
    const haystack = [e.decision, ...(e.topics || [])].filter(Boolean).join(' ');
    if (topicMatch(haystack, topic) === 0) continue;
    out.push({
      source: 'episode',
      excerpt: e.decision || `[${(e.topics || []).join(', ')}] ${e.outcome || ''}`,
      date: (e.ts || '').slice(0, 10),
      slug: e.slug,
      outcome: e.outcome,
      path: file,
      // Episodes always carry a slug from the originating session's cwd.
      project: canonProject(e.slug) || e.slug || GLOBAL_PROJECT,
    });
    if (out.length >= max * 3) break;  // overshoot for ranking
  }
  return out;
}

function readMemory(topic) {
  const dir = path.join(os.homedir(), '.claude', 'projects', '-Users-vinamr', 'memory');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const file = path.join(dir, f);
    const content = readSafe(file);
    if (!content || topicMatch(content, topic) === 0) continue;
    // Memory filenames follow the convention: <type>_<slug>.md
    // e.g. project_little_wins.md → little-wins, reference_pi_perception.md → pi-perception
    let project = GLOBAL_PROJECT;
    const fnameMatch = f.match(/^(?:project|reference)_(.+)\.md$/);
    if (fnameMatch) {
      project = fnameMatch[1].replace(/_/g, '-');
    } else {
      // Fallback: scan content for project keywords
      project = detectProject(content);
    }
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    const firstPara = body.split(/\n\n/)[0].slice(0, 200);
    out.push({ source: 'memory', excerpt: firstPara, path: file, project });
  }
  return out;
}

// ─── Scoring ────────────────────────────────────────────────────────────────
function scoreResult(r, topic) {
  const sw = SOURCE_WEIGHTS[r.source] || 1.0;
  const cm = CONFIDENCE_MULT[r.confidence || 'unknown'] || 1.0;
  const rm = recencyMult(r.date);
  const tm = topicMatch(r.excerpt + ' ' + (r.section || ''), topic);
  return Math.round((sw * cm * rm + tm * 0.5) * 100) / 100;
}

// Apply project-scope filter. activeProject = canonical slug of the active project.
// Default behavior: HARD-FILTER foreign results — they never enter the result set.
// (Gemini council R2: "a lower score does not prevent an LLM from reading injected
// text — foreign projects must be filtered, not just penalized.")
// includeForeign=true: keep foreign results but down-rank to FOREIGN_PENALTY × score
// so they only appear in /recall when the user explicitly opts in.
function applyProjectScope(results, activeProject, includeForeign) {
  const active = canonProject(activeProject);
  const out = [];
  for (const r of results) {
    const rp = canonProject(r.project) || GLOBAL_PROJECT;
    if (!active || rp === GLOBAL_PROJECT) {
      r.scope_match = 'global';
      out.push(r);
    } else if (rp === active) {
      r.scope_match = 'scoped';
      out.push(r);
    } else {
      r.scope_match = 'foreign';
      if (includeForeign) {
        r.score *= FOREIGN_PENALTY;
        out.push(r);
      }
      // Default: drop foreign entirely. Never lands in constraint pack or /recall.
    }
  }
  return out;
}

// ─── Main resolver ──────────────────────────────────────────────────────────
function resolve({ topic, project, cwd, max = 5, includeForeign = false }) {
  if (!topic) return { topic: null, results: [], error: 'topic required' };
  const all = [
    ...readInvariants(topic, cwd),
    ...readDecisions(project, topic),
    ...readGotchas(cwd, topic),
    ...readEpisodes(topic),
    ...readMemory(topic),
  ];
  for (const r of all) r.score = scoreResult(r, topic);
  // applyProjectScope returns the FILTERED list — foreign dropped by default.
  const filtered = applyProjectScope(all, project, includeForeign);
  filtered.sort((a, b) => b.score - a.score);
  return {
    topic,
    project: project || null,
    activeProjectCanon: canonProject(project),
    count: filtered.length,
    foreignDropped: all.length - filtered.length,
    results: filtered.slice(0, max),
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { args[k] = argv[++i]; }
      else { args[k] = true; }
    }
  }
  return args;
}

function formatText(out) {
  if (!out.results.length) return `No results for "${out.topic}".`;
  const header = out.activeProjectCanon
    ? `${out.count} result(s) for "${out.topic}" (active project: ${out.activeProjectCanon}):`
    : `${out.count} result(s) for "${out.topic}":`;
  const lines = [header, ''];
  const icon = { invariant: '⚠️ ', decision: '📌', gotcha: '🔒', episode: '🧠', memory: '💭' };
  const scopeIcon = { scoped: '◉', global: '○', foreign: '⊗' };
  for (const r of out.results) {
    // Provenance: show canonical project tag and scope match status.
    // ⊗ = foreign (other project), ◉ = scoped to active, ○ = global.
    const canonical = r.project && r.project !== GLOBAL_PROJECT ? canonProject(r.project) : null;
    const provenance = canonical
      ? ` ${scopeIcon[r.scope_match] || '·'}${canonical}`
      : ` ○global`;
    const head = `${icon[r.source] || '·'} ${r.source.toUpperCase()}` +
      provenance +
      (r.section ? ` (${r.section})` : '') +
      (r.confidence && r.confidence !== 'unknown' ? ` [${r.confidence}]` : '') +
      (r.date ? ` · ${r.date}` : '') +
      ` · score=${r.score}`;
    lines.push(head);
    lines.push('  ' + r.excerpt.replace(/\n/g, '\n  '));
    if (r.path) lines.push(`  → ${r.path}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const args = parseArgs(process.argv);
  let input = args;
  if (args.stdin) {
    try { input = { ...args, ...JSON.parse(await readStdin()) }; } catch { /* ignore */ }
  }
  const out = resolve({
    topic: input.topic,
    project: input.project,
    cwd: input.cwd || process.cwd(),
    max: parseInt(input.max, 10) || 5,
    includeForeign: !!input['include-foreign'],
  });
  if (input.format === 'text') {
    process.stdout.write(formatText(out));
  } else {
    process.stdout.write(JSON.stringify(out, null, 2));
  }
}

if (require.main === module) main();
module.exports = { resolve, scoreResult };
