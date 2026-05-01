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
//   4. code        — ~/.vanta/code-knowledge.jsonl  (Tier 2 indexer output)
//   5. episodes    — ~/.vanta/episodes.jsonl
//   6. memory      — ~/.claude/projects/-Users-vinamr/memory/*.md
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
const crypto = require('crypto');

// Tier 4: PROJECT_KEYWORDS + canonProject extracted to shared module.
// Both councils flagged the duplication as silent sync-drift surface.
const { PROJECT_KEYWORDS, GLOBAL_PROJECT, canonProject, isKnownProject, detectProject, slugForFilesystem } = require('./vanta-projects');

// ─── Config ─────────────────────────────────────────────────────────────────
// Source weights: invariants are user-curated truths (highest); decisions are
// dated/scoped (high); gotchas + code are auto-extracted from project (medium-
// high — code beats episode because it's ground truth in the repo); episodes
// are session derivations (medium); memory is conversational (lowest).
const SOURCE_WEIGHTS = { invariant: 2.0, decision: 1.5, gotcha: 1.5, code: 1.3, episode: 1.0, memory: 0.8 };
const CONFIDENCE_MULT = { high: 1.5, medium: 1.0, low: 0.7, unknown: 1.0 };
const TODAY = new Date().toISOString().slice(0, 10);

// Cross-project bleed penalty.
const FOREIGN_PENALTY = 0.15;

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
//
// readSafe per-process memo (Gemini R4 P1 fix). council-advisory.js fires
// up to 6 topic-specific resolve() calls in a loop — each used to do
// O(sources) disk reads. With this memo, each source file is read at
// most once per (path, mtime) within a process. The regex match still
// runs per topic, but against in-memory strings.
//
// Bounded at 32 entries to avoid retaining MB of source content if the
// resolver is reused across many cwds (e.g. an audit run).
const _readCache = new Map();
const _READ_CACHE_MAX = 32;

function readSafe(p) {
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { return null; }
  const cached = _readCache.get(p);
  if (cached && cached.mtime === mtime) return cached.content;
  let content = null;
  try { content = fs.readFileSync(p, 'utf8'); } catch { return null; }
  if (_readCache.size >= _READ_CACHE_MAX) {
    _readCache.delete(_readCache.keys().next().value);
  }
  _readCache.set(p, { mtime, content });
  return content;
}

function _clearReadCache() { _readCache.clear(); }

function recencyMult(dateStr) {
  if (!dateStr) return 0.8;
  const days = Math.max(0, (Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days < 30)  return 1.0;
  if (days < 90)  return 0.85;
  if (days < 365) return 0.6;
  return 0.3;
}

// Cleanup #12: synonym pre-expansion. When a user queries --topic JWT, also
// match `bearer token`, `access token`, etc. Widens recall without requiring
// the exact term to appear in source. Conservative table — false positives
// would silently inject foreign material via the council-advisory hook.
//
// Rules:
//   - Disjoint groups only (no transitive expansion). Joining "token" into
//     both jwt + secret would explode the regex into nonsense.
//   - Anchor each synonym at \b boundaries.
//   - Synonyms support spaces / hyphens via [\s-]+ tolerance.
//   - Skip expansion for single-char or all-digit topics.
//
// Add new groups when a query repeatedly returns 0 results despite the
// content existing under a different vocabulary (visible via --analyze).
const SYNONYM_GROUPS = {
  jwt:       ['JWT', 'JWTs', 'JSON web token', 'bearer token', 'access token', 'refresh token', 'auth token', 'id token'],
  session:   ['session', 'session id', 'sessionid', 'session token', 'session cookie', 'JSESSIONID'],
  auth:      ['auth', 'authn', 'authz', 'authentication', 'authorization'],
  payment:   ['payment', 'billing', 'charge', 'invoice', 'subscription', 'stripe', 'checkout'],
  migration: ['migration', 'schema migration', 'database migration', 'migrate', 'prisma migrate', 'drizzle-kit', 'alembic'],
  cors:      ['CORS', 'cross-origin', 'access-control-allow', 'access-control-request'],
  csp:       ['CSP', 'content-security-policy', 'content security policy', 'connect-src'],
  pii:       ['PII', 'personal data', 'personal information', 'privacy', 'GDPR', 'DPDP'],
  webhook:   ['webhook', 'webhooks', 'callback url', 'event endpoint'],
  secret:    ['secret', 'API key', 'credential', 'private key', 'env var', 'environment variable'],
};

function expandTopic(topic) {
  if (!topic) return [];
  const lower = String(topic).toLowerCase().trim();
  if (lower.length < 2) return [topic];
  if (/^\d+$/.test(lower)) return [topic];
  // Direct hit on a synonym group key
  if (SYNONYM_GROUPS[lower]) return SYNONYM_GROUPS[lower];
  // Reverse lookup — topic is one of the synonyms inside a group
  for (const [, synonyms] of Object.entries(SYNONYM_GROUPS)) {
    if (synonyms.some(s => s.toLowerCase() === lower)) return synonyms;
  }
  // No synonym match — return the topic itself for normal matching
  return [topic];
}

// Cache compiled regex per expanded topic. Resolver reads many sources per
// call — recompiling the same regex per source is wasted work.
const _topicRegexCache = new Map();

function _topicRegex(topic) {
  if (_topicRegexCache.has(topic)) return _topicRegexCache.get(topic);
  const terms = expandTopic(topic);
  const escaped = terms.map(t =>
    // Allow whitespace / hyphen variation between words: "bearer token" matches
    // "bearer-token", "bearer  token", "Bearer Token". Each space in a synonym
    // becomes [\s-]+ in the regex.
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')
  );
  // \b only works for ASCII word chars — synonyms with phrases need (?:^|[\s.,;:!?]) boundaries.
  const alternation = escaped.join('|');
  const re = new RegExp(`(?:^|[^\\w-])(?:${alternation})s?(?=[^\\w-]|$)`, 'gi');
  _topicRegexCache.set(topic, re);
  return re;
}

function topicMatch(text, topic) {
  if (!text || !topic) return 0;
  // Reset lastIndex on global regex (cached) before each match call.
  const re = _topicRegex(topic);
  re.lastIndex = 0;
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

// Read code-knowledge from per-project shards at ~/.vanta/knowledge/<slug>.jsonl
// (Tier 4). Both councils flagged that the Tier 3 fallback path (reading ALL
// shards when no active project) was the new O(N) bug — every council-advisory
// hook fires before the user has typed anything, often without project context.
//
// Tier 4 rule: if no active project, return [] for code-knowledge. Callers
// MUST pass --project for code results to surface. Invariants/decisions/
// memory still work without project; only code-knowledge requires it.
//
// This is the CORRECT semantics: code-knowledge is structurally project-tagged
// at index time. A query with no project context can't meaningfully match
// project-scoped truth — better to return nothing than scan everything.
function readCodeKnowledge(topic, activeProject, max = 20, cwd = null) {
  if (!activeProject) return [];  // Tier 4: refuse multi-shard scan
  const dir = path.join(os.homedir(), '.vanta', 'knowledge');
  const active = canonProject(activeProject);
  if (!active) return [];

  // Codex council R7 P2 fix — same-slug-different-cwd cross-leak.
  // Two unrelated projects ("/Users/x/work/api" and "/Users/x/personal/api")
  // collapse to the same canonical slug "api". Both shards survive the slug
  // filter; entries from BOTH end up in the result. Indexer stores
  // `projectRoot` per entry (path.resolve(cwd) at index time) — resolver
  // now uses it to drop entries whose projectRoot doesn't match this call's
  // active cwd. Legacy entries without projectRoot pass through unchanged
  // for back-compat.
  const activeRoot = cwd ? path.resolve(cwd) : null;

  // Cleanup #4: alias-shard merge. The same logical project can have multiple
  // shard files when an alias slug existed before its keyword regex was added
  // to PROJECT_KEYWORDS — e.g. bajajvinamr-vanta.jsonl + vanta.jsonl both hold
  // entries for the canonical "vanta" project.
  //
  // Fold-on-read: scan every shard file in the dir, canonicalize its filename
  // slug, and merge contents from any shard whose canon matches the active
  // project. Each entry is still filtered by canonProject(entry.project) ===
  // active inside _readCodeKnowledgeFromFile via the filter below — so a
  // contaminated shard (entries from multiple projects) doesn't bleed.
  const out = [];
  let shards = [];
  try { shards = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { shards = []; }
  for (const f of shards) {
    const fileSlug = f.slice(0, -'.jsonl'.length);
    if (canonProject(fileSlug) !== active) continue;
    const shardFile = path.join(dir, f);
    const entries = _readCodeKnowledgeFromFile(shardFile, topic, max, active, activeRoot)
      .filter(r => canonProject(r.project) === active);
    for (const e of entries) out.push(e);
    if (out.length >= max * 3) break;  // overshoot for ranking, capped
  }
  if (out.length > 0) return out;

  // Final-tier compatibility: Tier 2 legacy file still exists if migration
  // hasn't run. Read it once, scoped to the active project.
  const legacy = path.join(os.homedir(), '.vanta', 'code-knowledge.jsonl');
  if (fs.existsSync(legacy)) {
    return _readCodeKnowledgeFromFile(legacy, topic, max, active, activeRoot)
      .filter(r => canonProject(r.project) === active);
  }
  return [];
}

function _readCodeKnowledgeFromFile(file, topic, max, fallbackSlug, activeRoot = null) {
  const content = readSafe(file);
  if (!content) return [];
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    // R7 P2 — projectRoot scope filter. Drop entries indexed from a
    // different cwd that just happened to canonicalize to the same slug.
    // Entries without projectRoot (legacy / pre-Tier-5) pass through.
    if (activeRoot && e.projectRoot && e.projectRoot !== activeRoot) continue;
    const haystack = [e.snippet, e.context, e.category, e.why].filter(Boolean).join(' ');
    if (topicMatch(haystack, topic) === 0) continue;
    let project = e.project;
    if (!project || project === GLOBAL_PROJECT) project = fallbackSlug;
    out.push({
      source: 'code',
      section: e.category,
      excerpt: e.snippet + (e.context ? `\n  context: ${e.context.slice(0, 160)}` : '') + (e.why ? `\n  why: ${e.why}` : ''),
      date: (e.ts || '').slice(0, 10),
      path: file,
      sourceLocation: e.source,
      // Path-based rank multiplier from indexer — Codex P3 fix.
      pathRank: typeof e.pathRank === 'number' ? e.pathRank : 1.0,
      project: canonProject(project) || project,
    });
    if (out.length >= max * 3) break;
  }
  return out;
}

// R8 P1 — episodes are now read across rotated .bak.<ts> + live file.
// Producers (auto-sync.js Stop hook) no longer compact on rotate; merge
// happens here. Also R8 P3 back-compat: old episodes had `topic` (singular)
// + `project` instead of current `topics` + `slug`. We accept both shapes.
const { readMergedJsonl } = require('./vanta-jsonl');

function readEpisodes(topic, max = 5) {
  const file = path.join(os.homedir(), '.vanta', 'episodes.jsonl');
  const merged = readMergedJsonl(file);
  if (!merged) return [];
  const lines = merged.split('\n').filter(Boolean);
  const seen = new Set();
  const out = [];
  // Iterate newest-first by reversing
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (seen.has(e.session_id)) continue;
    seen.add(e.session_id);
    // R8 P3 — accept both v3.6.0 ({topic, project}) and v3.6.6 ({topics, slug}).
    const topicsList = e.topics || (e.topic ? [e.topic] : []);
    const slug = e.slug || e.project;
    const haystack = [e.decision, ...topicsList].filter(Boolean).join(' ');
    if (topicMatch(haystack, topic) === 0) continue;
    out.push({
      source: 'episode',
      excerpt: e.decision || `[${topicsList.join(', ')}] ${e.outcome || ''}`,
      date: (e.ts || '').slice(0, 10),
      slug,
      outcome: e.outcome,
      path: file,
      // Episodes always carry a slug from the originating session's cwd.
      // R8 P3 — `slug` falls back to legacy `project` field via the local
      // var resolved above. canonProject normalizes either shape.
      project: canonProject(slug) || slug || GLOBAL_PROJECT,
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
  // pathRank — applied to code entries only (defaults to 1.0 elsewhere).
  // Codex P3 fix: page.tsx page-copy + __tests__ pattern descriptions get
  // <1.0 multiplier so real implementation code outranks them.
  const pr = typeof r.pathRank === 'number' ? r.pathRank : 1.0;
  return Math.round((sw * cm * rm * pr + tm * 0.5) * 100) / 100;
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
    // Tier 4: indexer no longer tags entries with __unknown_project__; raw
    // slugs land in their own shard. Resolver decides scope by canonical
    // match: scoped (matches active), global (no project tag), or foreign
    // (different known project). No UNKNOWN bucket.
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
      // Default: drop foreign entirely.
    }
  }
  return out;
}

// ─── Query log (cleanup #6) ────────────────────────────────────────────────
// Lightweight passive logging: every resolve() with `log: true` appends one
// line to ~/.vanta/query-log.jsonl. We log SHAPE — topic, project, count,
// foreignDropped, score distribution — never excerpts or paths inside results
// (could be sensitive PII, secrets, etc.).
//
// Volume: council-advisory fires on every Write|Edit to auth/payment/migration
// files. ~50/day × 365 days × 200B/entry = 3.6MB/year. Best-effort rotation
// at 5MB to bound disk impact.
//
// Why opt-in: programmatic callers (tests, future automation) shouldn't
// silently write to the log. CLI mode and council-advisory both pass log:true.
//
// Codex council R5 P2 fix — earlier impl logged raw `topic` (user query
// term) and `cwd` (absolute filesystem path). That violates the
// shape-only contract claimed two lines up. Now: topic is hashed to
// 8 hex chars; cwd is dropped. Project canon stays — it's a known slug
// from PROJECT_KEYWORDS, not user-typed content.
//
// Codex council R5 P2 fix — rotation was read-trim-writeFileSync, racing
// with concurrent appendFileSync from a parallel hook. New approach:
// rename the live file to .bak and start fresh — the rename is atomic,
// no in-flight writer's bytes are clobbered. The losing-half is dropped
// (acceptable: query log is best-effort observability, not durability).
function _qlogVantaDir() { return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta'); }
function _queryLogFile() { return path.join(_qlogVantaDir(), 'query-log.jsonl'); }
const QUERY_LOG_MAX_BYTES = 5_000_000;
// Back-compat const for any external readers; resolved at module load.
const QUERY_LOG = _queryLogFile();

function _shapeTopic(t) {
  if (!t) return null;
  return crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8);
}

function _logQuery(entry) {
  try {
    const file = _queryLogFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic rotation: rename (POSIX-atomic) so concurrent appendFileSync
    // calls keep working — they either land in the old file (preserved as
    // .bak) or the freshly-created new file. No lost-update race.
    try {
      const st = fs.statSync(file);
      if (st.size > QUERY_LOG_MAX_BYTES) fs.renameSync(file, file + '.bak');
    } catch { /* file doesn't exist yet — fine */ }
    // Strip identifying fields before persisting. Keep coarse counts +
    // canonical project slug + hashed topic for trend/audit utility.
    const safe = {
      ts: entry.ts,
      topic_hash:  _shapeTopic(entry.topic),
      project:     entry.project || null,
      activeCanon: entry.activeCanon || null,
      count:       entry.count,
      foreignDropped: entry.foreignDropped,
      top: entry.top || [],
    };
    // R9 P1 — torn-line guard. See bin/vanta-jsonl.js comment.
    fs.appendFileSync(file, '\n' + JSON.stringify(safe) + '\n');
  } catch { /* never block resolve() on log failure */ }
}

// ─── Contradiction detection (Tier 6 #14) ──────────────────────────────────
//
// Cross-source contradiction signal. The resolver pulls from 6 sources; they
// can disagree silently and inject contradictory facts into the council
// CONSTRAINT PACK. This detector flags binary-opposition pairs explicitly so
// the LLM sees disagreement instead of treating both halves as truth.
//
// Conservative by design: false positives are noise (every Write|Edit hook
// pays the cost), false negatives are the actual bug we ship. Confidence
// floor of 0.7 — if the heuristic isn't sure, stay quiet.
//
// Decisions are pre-filtered for supersession by readDecisions(), so a
// SUPERSEDED stale decision can't reach this detector at all. That handles
// the "stale-but-flagged" case for free.
const BINARY_PAIRS = [
  // pi-perception's actual past bug — the one this whole feature exists for.
  { tokens: ['ES256', 'HS256'], context: null,            confidence: 0.9 },
  // PixiJS context required — "sync" and "async" are too generic on their own.
  { tokens: ['v7', 'v8'],       context: ['pixi'],        confidence: 0.85 },
  { tokens: ['sync', 'async'],  context: ['pixi'],        confidence: 0.75 },
  // generic but high-stakes
  { tokens: ['include', 'exclude'], context: null,        confidence: 0.7 },
  // CommonJS vs ES modules conflict (recurrent in stack-and-skills.md)
  { tokens: ['CommonJS', 'ESM'], context: null,           confidence: 0.85 },
  // HTTP migration vs deploy — burned us in Prisma invariants
  { tokens: ['migrate dev', 'migrate deploy'], context: ['prisma'], confidence: 0.9 },
];

// Looser sources are reduced because they often discuss BOTH options
// conversationally (e.g., an episode noting "we tried HS256 first, then ES256").
const LOOSE_SOURCES = new Set(['episode', 'memory']);

function detectContradictions(results) {
  const out = [];
  const seen = new Set();
  for (const pair of BINARY_PAIRS) {
    const [tA, tB] = pair.tokens;
    const reA = new RegExp(`\\b${tA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const reB = new RegExp(`\\b${tB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const hasA = results.filter(r => reA.test(r.excerpt || '') && !reB.test(r.excerpt || ''));
    const hasB = results.filter(r => reB.test(r.excerpt || '') && !reA.test(r.excerpt || ''));
    for (const a of hasA) {
      for (const b of hasB) {
        if (pair.context) {
          const ctxRe = new RegExp(pair.context.join('|'), 'i');
          const aCtx = ctxRe.test(a.excerpt || '') || ctxRe.test(a.section || '');
          const bCtx = ctxRe.test(b.excerpt || '') || ctxRe.test(b.section || '');
          if (!aCtx || !bCtx) continue;
        }
        let conf = pair.confidence;
        if (LOOSE_SOURCES.has(a.source) || LOOSE_SOURCES.has(b.source)) conf -= 0.2;
        if (conf < 0.7) continue;
        const key = [a.source, b.source, (a.excerpt || '').slice(0, 40), (b.excerpt || '').slice(0, 40)].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          pair: [a, b],
          type: 'binary',
          confidence: Math.round(conf * 100) / 100,
          hint: `"${tA}" (${a.source}${a.date ? ' '+a.date : ''}) vs "${tB}" (${b.source}${b.date ? ' '+b.date : ''})`,
        });
      }
    }
  }
  return out;
}

// ─── Main resolver ──────────────────────────────────────────────────────────
// ─── Result cache (Codex R2 P2 + R3 P2 fix) ────────────────────────────────
//
// The always-on prompt-context hook calls resolve() once or twice per user
// prompt. Without caching, every keystroke-submitted prompt re-reads the
// invariants file, walks decisions/, parses code-knowledge.jsonl, etc. —
// the resolver became the dominant cost of the always-on layer.
//
// Cache strategy:
//   - In-process Map (per-CLI-invocation OR per-hook-process — both are
//     short-lived; caching across processes wasn't worth the disk/IO).
//   - Key: ${topic}|${project}|${cwd}|${max}|${includeForeign}|${log}
//   - TTL: 60s wall-clock floor — short enough that vanta-sync edits
//     propagate before users notice.
//   - **Source-version vector** (R3 P2 fix): cache mtime of every file the
//     resolver consults: invariants, decisions for the project, project
//     CLAUDE.md (gotchas), code-knowledge.jsonl, episodes.jsonl, and
//     ~/.claude/projects/-Users-vinamr/memory/. Any change in any source
//     busts the cached entry. Each source is one stat() call — cheap.
//   - LRU bounded at 64 entries — Map preserves insertion order.
//
// Earlier impl only watched the invariants file. R3 caught: editing
// decisions.md, gotchas, or running the indexer wouldn't invalidate the
// cache, so the next prompt-context call would return stale results
// for up to 60s.
const _resolveCache = new Map();
const _RESOLVE_CACHE_TTL = 60_000;
const _RESOLVE_CACHE_MAX = 64;
const INVARIANTS_FILE = path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.md');
const CODE_KNOWLEDGE_DIR = path.join(os.homedir(), '.vanta', 'knowledge');
const CODE_KNOWLEDGE_LEGACY = path.join(os.homedir(), '.vanta', 'code-knowledge.jsonl');
const EPISODES_FILE = path.join(os.homedir(), '.vanta', 'episodes.jsonl');
const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects', '-Users-vinamr', 'memory');

function _mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function _dirMtime(p) {
  // Directory mtime — changes when files inside are added/removed/renamed.
  // Doesn't catch in-place edits to memory files; we sample the index file
  // (MEMORY.md) below to cover that.
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function _sourceVector({ project, cwd }) {
  const slug = project ? slugForFilesystem(project) : '';
  const decisionsFile = slug ? path.join(os.homedir(), '.gstack', 'projects', slug, 'decisions.md') : '';
  const gotchasFile   = cwd  ? path.join(cwd, 'CLAUDE.md') : '';
  // Code knowledge moved from a single global file to per-project shards
  // in v3.x (Tier 4). Watch the active project's shard if we have a slug,
  // and fall back to the legacy file. Gemini R4 P1 fix.
  const shardFile = slug ? path.join(CODE_KNOWLEDGE_DIR, slug + '.jsonl') : '';
  return [
    _mtime(INVARIANTS_FILE),
    decisionsFile ? _mtime(decisionsFile) : 0,
    gotchasFile   ? _mtime(gotchasFile)   : 0,
    shardFile     ? _mtime(shardFile)     : 0,
    _mtime(CODE_KNOWLEDGE_LEGACY),
    _mtime(EPISODES_FILE),
    _dirMtime(MEMORY_DIR),
    _mtime(path.join(MEMORY_DIR, 'MEMORY.md')),
  ].join(':');
}

function _cacheGet(key, ctx) {
  const hit = _resolveCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > _RESOLVE_CACHE_TTL) { _resolveCache.delete(key); return null; }
  if (hit.vector !== _sourceVector(ctx)) { _resolveCache.delete(key); return null; }
  // Touch — move to end for LRU behavior.
  _resolveCache.delete(key); _resolveCache.set(key, hit);
  return hit.value;
}

function _cacheSet(key, value, ctx) {
  if (_resolveCache.size >= _RESOLVE_CACHE_MAX) {
    const oldest = _resolveCache.keys().next().value;
    if (oldest) _resolveCache.delete(oldest);
  }
  _resolveCache.set(key, { ts: Date.now(), vector: _sourceVector(ctx), value });
}

function clearCache() { _resolveCache.clear(); _readCache.clear(); }

function resolve({ topic, project, cwd, max = 5, includeForeign = false, log = false }) {
  if (!topic) return { topic: null, results: [], error: 'topic required' };
  // Cache key: include `log` so cached calls don't accidentally suppress
  // logging when a logged caller hits a no-log cache entry.
  const cacheKey = `${topic}|${project || ''}|${cwd || ''}|${max}|${includeForeign}|${log}`;
  const cacheCtx = { project, cwd };
  const cached = _cacheGet(cacheKey, cacheCtx);
  if (cached) return cached;

  const all = [
    ...readInvariants(topic, cwd),
    ...readDecisions(project, topic),
    ...readGotchas(cwd, topic),
    ...readCodeKnowledge(topic, project, 20, cwd),
    ...readEpisodes(topic),
    ...readMemory(topic),
  ];
  for (const r of all) r.score = scoreResult(r, topic);
  // applyProjectScope returns the FILTERED list — foreign dropped by default.
  const filtered = applyProjectScope(all, project, includeForeign);
  filtered.sort((a, b) => b.score - a.score);
  const topResults = filtered.slice(0, max);
  // Run contradiction detection on the SAME slice the caller will see —
  // detecting against entries the user won't get is misleading noise.
  const contradictions = detectContradictions(topResults);
  const out = {
    topic,
    project: project || null,
    activeProjectCanon: canonProject(project),
    count: filtered.length,
    foreignDropped: all.length - filtered.length,
    results: topResults,
    contradictions,
  };
  if (log) {
    // Log SHAPE, not content. Top-3 score-source-scope tuples are enough to
    // diagnose: empty results, foreign bleed, score collapse, source bias.
    _logQuery({
      ts: new Date().toISOString(),
      topic,
      project: project || null,
      activeCanon: out.activeProjectCanon,
      cwd: cwd || null,
      count: out.count,
      foreignDropped: out.foreignDropped,
      top: out.results.slice(0, 3).map(r => ({
        source: r.source,
        score: r.score,
        scope: r.scope_match,
      })),
    });
  }
  _cacheSet(cacheKey, out, cacheCtx);
  return out;
}

// Read query-log and produce diagnostics. Surfaces:
//   - Top-N most queried topics
//   - Topics where count=0 (gaps in the index)
//   - Total foreign-bleed events (filter working / not)
//   - Score-distribution sketch (are top-1 results actually scoring high,
//     or are we emitting noise that barely passes the threshold?)
function analyzeLog({ last = 500 } = {}) {
  if (!fs.existsSync(QUERY_LOG)) {
    return { present: false, message: 'no query log yet (~/.vanta/query-log.jsonl absent)' };
  }
  const lines = fs.readFileSync(QUERY_LOG, 'utf8').split('\n').filter(Boolean).slice(-last);
  const entries = [];
  for (const l of lines) { try { entries.push(JSON.parse(l)); } catch { /* skip */ } }
  if (!entries.length) return { present: true, count: 0, message: 'log present but empty' };
  // Most queried topics. Post-R5 the persisted field is `topic_hash`
  // (not the raw query string) — analytics now key on the hash. Old
  // entries with `topic` are folded in for backwards compatibility
  // during the transition window.
  const topicCount = new Map();
  let zeroResultQueries = 0;
  let foreignBleedTotal = 0;
  const topScores = [];
  const sourceCount = new Map();
  const topicKey = e => e.topic_hash || e.topic || null;
  for (const e of entries) {
    const k = topicKey(e);
    if (k) topicCount.set(k, (topicCount.get(k) || 0) + 1);
    if (e.count === 0) zeroResultQueries++;
    foreignBleedTotal += (e.foreignDropped || 0);
    if (e.top && e.top[0]) {
      topScores.push(e.top[0].score);
      const src = e.top[0].source;
      sourceCount.set(src, (sourceCount.get(src) || 0) + 1);
    }
  }
  const topicsRanked = [...topicCount.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  // Topics that returned nothing on >50% of their attempts → index gap
  const gapTopics = [...topicCount.entries()]
    .filter(([t, n]) => n >= 2)
    .map(([t, n]) => {
      const zero = entries.filter(e => topicKey(e) === t && e.count === 0).length;
      return { topic: t, attempts: n, zero, ratio: zero / n };
    })
    .filter(g => g.ratio >= 0.5)
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 10);
  // Top score percentiles
  topScores.sort((a, b) => a - b);
  const p = (q) => topScores.length ? topScores[Math.floor(topScores.length * q)] : 0;
  return {
    present: true,
    sampleSize: entries.length,
    spanFrom: entries[0].ts,
    spanTo:   entries[entries.length - 1].ts,
    topTopics: topicsRanked,
    zeroResultQueries,
    zeroResultRatio: Math.round(zeroResultQueries / entries.length * 100) / 100,
    foreignBleedTotal,
    topScoreP50: p(0.5),
    topScoreP90: p(0.9),
    topSourceMix: [...sourceCount.entries()].sort((a, b) => b[1] - a[1]),
    gapTopics,
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
  // Tier 6 #14: surface contradictions BEFORE results so the LLM/user sees
  // the warning before reading either contradictory entry.
  if (out.contradictions && out.contradictions.length > 0) {
    lines.push('⚠️  CONTRADICTION DETECTED — resolve before relying on either entry:');
    for (const c of out.contradictions) {
      lines.push(`  • ${c.hint} [confidence ${c.confidence}]`);
    }
    lines.push('  → newer source typically wins; if old decision is wrong, deprecate via /council.');
    lines.push('');
  }
  const icon = { invariant: '⚠️ ', decision: '📌', gotcha: '🔒', code: '▤', episode: '🧠', memory: '💭' };
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
    // Code entries also surface their file:line location for fast jump-to.
    if (r.sourceLocation) lines.push(`  ↳ ${r.sourceLocation}`);
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

function formatAnalysis(a) {
  if (!a.present) return a.message;
  if (a.count === 0) return a.message;
  const lines = [];
  lines.push(`=== query-log analysis (last ${a.sampleSize} entries) ===`);
  lines.push(`span: ${a.spanFrom} → ${a.spanTo}`);
  lines.push('');
  lines.push('TOP TOPICS');
  for (const [t, n] of a.topTopics) lines.push(`  ${String(n).padStart(4)}  ${t}`);
  lines.push('');
  lines.push(`ZERO-RESULT QUERIES: ${a.zeroResultQueries} (${(a.zeroResultRatio * 100).toFixed(0)}%)`);
  lines.push(`FOREIGN-BLEED EVENTS DROPPED: ${a.foreignBleedTotal}`);
  lines.push(`TOP-1 SCORE p50=${a.topScoreP50}  p90=${a.topScoreP90}`);
  lines.push('');
  lines.push('SOURCE MIX (top-1 by source)');
  for (const [s, n] of a.topSourceMix) lines.push(`  ${String(n).padStart(4)}  ${s}`);
  if (a.gapTopics.length) {
    lines.push('');
    lines.push('INDEX GAPS (topics that returned nothing ≥50% of attempts)');
    for (const g of a.gapTopics) {
      lines.push(`  ${g.topic.padEnd(20)}  ${g.zero}/${g.attempts} empty (${(g.ratio * 100).toFixed(0)}%)`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  let input = args;
  if (args.stdin) {
    try { input = { ...args, ...JSON.parse(await readStdin()) }; } catch { /* ignore */ }
  }

  // Cleanup #6: --analyze surfaces query-log diagnostics. Bypasses normal
  // resolve flow.
  if (input.analyze) {
    const a = analyzeLog({ last: parseInt(input.last, 10) || 500 });
    if (input.format === 'json') {
      process.stdout.write(JSON.stringify(a, null, 2));
    } else {
      process.stdout.write(formatAnalysis(a));
    }
    return;
  }

  const out = resolve({
    topic: input.topic,
    project: input.project,
    cwd: input.cwd || process.cwd(),
    max: parseInt(input.max, 10) || 5,
    includeForeign: !!input['include-foreign'],
    log: !input['no-log'],  // CLI logs by default; --no-log opts out
  });
  if (input.format === 'text') {
    process.stdout.write(formatText(out));
  } else {
    process.stdout.write(JSON.stringify(out, null, 2));
  }
}

if (require.main === module) main();
module.exports = { resolve, scoreResult, analyzeLog, detectContradictions, clearCache };
