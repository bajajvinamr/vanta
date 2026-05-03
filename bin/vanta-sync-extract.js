#!/usr/bin/env node
// vanta-sync-extract — pure extract bin for /vanta-sync (v3.11).
//
// Per .planning/v3-11/PLAN.md council R1+R2 verdict:
//
//   C-2 (P1 Gemini single) — LLM cannot locate transcript path. This bin
//   discovers it from sync-queue.jsonl + bak siblings and emits a
//   {type: 'transcript_hint', path, session_id} record so SKILL.md can
//   tail-read it for forward-compat fallback.
//
//   C-4 (P2 Gemini single) — slug must come from slugFromCwd(), not LLM
//   interpolation. No --project CLI arg; bin computes slug internally.
//
//   C-3 (P2 both-confirmed) — cross-source dedup with priority ordering
//   so the same fix in episode + git + decision doesn't stage 3 times.
//
//   C-6 (P2 Codex single) — git uses commit subject as candidate, body
//   as evidence only; review/trailer blocks stripped before scoring.
//
//   C-8 (P3 R2 Gemini new) — `git -C "$cwd" log` form; no inherited cwd.
//
// Pure read-side. Zero LLM calls. Zero writes (caller stages via
// vanta-extract-score; consume marking happens in SKILL.md Step 9 via
// vanta-sync-consume).
//
// Surface Impact Discipline: INTERNAL MACHINERY. No new commands.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const child = require('child_process');
const crypto = require('crypto');

// ─── Paths / constants ──────────────────────────────────────────────────

const MAX_PARSE_BYTES_TOTAL = 100 * 1024 * 1024; // 100MB hard cap per source
const TAIL_BYTES = 8 * 1024 * 1024;              // 8MB tail when over cap
const DEFAULT_MAX_PER_SOURCE = 20;

function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}

function _gstackHome() {
  return process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack');
}

// ─── Cross-source dedup priority (lower = higher signal) ────────────────

const SOURCE_PRIORITY = {
  decision:   0,  // human-curated council/decision artifacts
  retro:      1,  // phase retros — semi-curated
  episode:    2,  // auto-extracted from session
  failure:    3,
  git:        4,  // commit prose — most prone to noise
  transcript: 5,  // forward-compat fallback only
};

// ─── Helpers ────────────────────────────────────────────────────────────

function _vlog() {
  // Lazy-load shared logger; degrade silently if absent.
  try { return require(path.join(os.homedir(), '.claude', 'bin', 'vanta-log.js')); }
  catch {}
  try { return require(path.join(__dirname, 'vanta-log.js')); } catch {}
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function _isoMinusDays(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

function _normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function _hash16(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function _safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Bounded read: full file if ≤ TAIL_BYTES, else last TAIL_BYTES.
// Hard cap MAX_PARSE_BYTES_TOTAL — anything over the cap returns
// just the tail; never load >8MB into memory regardless.
function _boundedRead(file) {
  const st = _safeStat(file);
  if (!st) return '';
  if (st.size === 0) return '';
  if (st.size <= TAIL_BYTES) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// Read across .bak.* siblings + live for append-only JSONL files.
// Mirrors the v3.10 R8 P1 invariant from auto-sync.js.
function _readJsonlMerged(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const parts = [];
  try {
    const baks = fs.readdirSync(dir)
      .filter(n => n.startsWith(base + '.bak.'))
      .sort();
    for (const b of baks) parts.push(_boundedRead(path.join(dir, b)));
  } catch { /* dir missing — fine */ }
  parts.push(_boundedRead(file));
  const merged = parts.filter(Boolean).join('\n');
  const out = [];
  for (const line of merged.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

// ─── Slug resolution ────────────────────────────────────────────────────

function _slugFromCwd(cwd) {
  // Reuse the canonical resolver — see vinamr-invariants.md note.
  for (const p of [
    path.join(__dirname, 'vanta-projects.js'),
    path.join(os.homedir(), '.claude', 'bin', 'vanta-projects.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-projects.js'),
  ]) {
    try {
      const projects = require(p);
      if (projects.slugFromCwd) return projects.slugFromCwd(cwd);
    } catch { /* try next */ }
  }
  return null;
}

// ─── Source scanners ────────────────────────────────────────────────────

function scanEpisodes({ slug, lookbackTs, consumed, max }) {
  const file = path.join(_vantaDir(), 'episodes.jsonl');
  const entries = _readJsonlMerged(file);
  const out = [];
  const lookbackMs = Date.parse(lookbackTs);
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.project !== slug) continue;
    const ts = e.ts || e.date;
    if (!ts) continue;
    const t = Date.parse(ts);
    if (isNaN(t) || t < lookbackMs) continue;
    const ref = e.session_id || `episode-${_hash16(JSON.stringify(e))}`;
    if (consumed.has('episode|' + ref)) continue;
    const decisionText = e.decision || e.outcome || '';
    if (!decisionText || String(decisionText).trim().length < 10) continue;
    const candidate = String(decisionText).trim().slice(0, 200);
    out.push({
      source: 'episode',
      ref,
      ts,
      candidate,
      evidence: JSON.stringify({ topics: e.topics, outcome: e.outcome, branch: e.branch }).slice(0, 500),
    });
    if (out.length >= max) break;
  }
  return out;
}

function scanFailures({ slug, lookbackTs, consumed, max }) {
  const file = path.join(_vantaDir(), 'recent-failures.jsonl');
  const entries = _readJsonlMerged(file);
  const out = [];
  const lookbackMs = Date.parse(lookbackTs);
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.project !== slug) continue;
    // Per plan: emit only resolved failures (the resolution is the learning).
    if (e.outcome !== 'resolved') continue;
    const ts = e.ts;
    if (!ts) continue;
    const t = Date.parse(ts);
    if (isNaN(t) || t < lookbackMs) continue;
    const ref = e.session_id ? (e.session_id + ':' + (e.kind || 'unknown')) : `failure-${_hash16(JSON.stringify(e))}`;
    if (consumed.has('failure|' + ref)) continue;
    // Build candidate from structured fields ONLY (per v3.10 C-2 hardening).
    const parts = [];
    if (e.kind) parts.push(e.kind);
    if (e.tool_name) parts.push('via ' + e.tool_name);
    if (e.test_name) parts.push('test: ' + e.test_name);
    if (e.file) parts.push('file: ' + e.file);
    if (parts.length === 0) continue;
    const candidate = ('Resolved: ' + parts.join(' ')).slice(0, 200);
    out.push({
      source: 'failure',
      ref,
      ts,
      candidate,
      evidence: JSON.stringify({ kind: e.kind, tool: e.tool_name, file: e.file, line: e.line, test: e.test_name }).slice(0, 500),
    });
    if (out.length >= max) break;
  }
  return out;
}

// Strip review prose / trailers / P-tag findings from commit body before
// using as evidence (C-6). Conservative — if pattern matches, drop the
// matched line and continue.
const TRAILER_PATTERNS = [
  /^Co-Authored-By:/i,
  /^Constraint:/i,
  /^Rejected:/i,
  /^Directive:/i,
  /^Confidence:/i,
  /^Scope-risk:/i,
  /^Not-tested:/i,
  /^Signed-off-by:/i,
];
const COUNCIL_PROSE_PATTERNS = [
  /^\s*\[P[1-4]\]/,                      // [P1] CRITICAL...
  /^\s*##\s+(Round|Council|R[1-3])/i,    // section headers
  /^\s*\*\*Council/i,
  /^\s*\*\*Verdict/i,
  /^\s*-\s*\[P[1-4]\]/,
];

function _stripCouncilProse(body) {
  if (!body) return '';
  return body.split('\n')
    .filter(line => {
      for (const rx of TRAILER_PATTERNS) if (rx.test(line)) return false;
      for (const rx of COUNCIL_PROSE_PATTERNS) if (rx.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ALLOWED_COMMIT_TYPES = /^(feat|fix|refactor|perf)(\([\w/-]+\))?:/i;

function scanGit({ cwd, lookbackTs, consumed, max }) {
  if (!cwd) return [];
  // No .git → silent skip.
  try {
    child.execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
  } catch { return []; }

  let raw = '';
  try {
    raw = child.execFileSync('git',
      ['-C', cwd, 'log', `--since=${lookbackTs}`, '--no-merges',
       '--pretty=format:%H%x1f%s%x1f%b%x1e'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    ).toString();
  } catch { return []; }

  const out = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    const parts = rec.split('\x1f');
    if (parts.length < 2) continue;
    // Git's --pretty=format:%H... emits records joined by \x1e; the first
    // record has no leading separator but subsequent records start with
    // a newline left over from the prior record's body. Trim it off the
    // hash so the consume ledger ref matches `git log -1 --format=%H`.
    const hash = (parts[0] || '').trim();
    const subjStr = (parts[1] || '').trim();
    const body = (parts[2] || '').trim();
    if (!hash || !subjStr) continue;
    if (!ALLOWED_COMMIT_TYPES.test(subjStr)) continue;
    if (consumed.has('git|' + hash)) continue;
    // Subject is the candidate; body (sanitized) is evidence.
    const evidence = _stripCouncilProse(body || '').slice(0, 500);
    out.push({
      source: 'git',
      ref: hash,
      ts: '',  // populated below from `git log -1 --format=%cI`
      candidate: subjStr.slice(0, 200),
      evidence,
    });
    if (out.length >= max) break;
  }
  // Fill in committer-iso timestamps in a single batch call.
  if (out.length > 0) {
    try {
      const args = ['-C', cwd, 'log', '--no-walk',
        '--pretty=format:%H%x1f%cI', ...out.map(o => o.ref)];
      const r = child.execFileSync('git', args,
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
      const tsMap = new Map();
      for (const line of r.split('\n')) {
        const [h, t] = line.split('\x1f');
        if (h && t) tsMap.set(h, t);
      }
      for (const o of out) o.ts = tsMap.get(o.ref) || new Date().toISOString();
    } catch {
      for (const o of out) o.ts = new Date().toISOString();
    }
  }
  return out;
}

// Parse RETRO.md sections: ## Lessons / ## Invariants / ## Gotchas
// Line-walk approach (no \Z anchor in JS regex; line-based parse is safer
// for an arbitrary file that may end with a target section).
function _parseRetroSections(content) {
  const out = [];
  const lines = content.split('\n');
  const headerRx = /^##\s+(Lessons|Invariants|Gotchas)\s*$/i;
  const sectionRx = /^##\s/;
  let curSection = null;
  for (const line of lines) {
    const m = line.match(headerRx);
    if (m) {
      curSection = m[1];
      continue;
    }
    if (sectionRx.test(line)) {
      // Different ## heading — close out current section.
      curSection = null;
      continue;
    }
    if (!curSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet && bullet[1].trim().length >= 20) {
      out.push({ section: curSection, text: bullet[1].trim() });
    }
  }
  return out;
}

function scanRetro({ cwd, lookbackTs, consumed, max }) {
  if (!cwd) return [];
  const planningDir = path.join(cwd, '.planning');
  if (!fs.existsSync(planningDir)) return [];
  const lookbackMs = Date.parse(lookbackTs);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(planningDir); } catch { return []; }
  for (const d of dirs) {
    const retroPath = path.join(planningDir, d, 'RETRO.md');
    const st = _safeStat(retroPath);
    if (!st) continue;
    if (st.mtimeMs < lookbackMs) continue;
    let content;
    try { content = fs.readFileSync(retroPath, 'utf8'); } catch { continue; }
    const sections = _parseRetroSections(content);
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const ref = `${d}/RETRO.md:${s.section}:${i}`;
      if (consumed.has('retro|' + ref)) continue;
      out.push({
        source: 'retro',
        ref,
        ts: new Date(st.mtimeMs).toISOString(),
        candidate: s.text.slice(0, 200),
        evidence: ('section=' + s.section + ' phase=' + d + ' text=' + s.text).slice(0, 500),
      });
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out;
}

// Parse decisions.md entries: ## YYYY-MM-DD: <topic>
// Implementation note: JS regex has no \Z. Walk lines instead of relying
// on lookahead-to-end-of-string.
function scanDecisions({ slug, lookbackTs, consumed, max }) {
  const file = path.join(_gstackHome(), 'projects', slug, 'decisions.md');
  if (!fs.existsSync(file)) return [];
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lookbackMs = Date.parse(lookbackTs);
  const lines = content.split('\n');
  const headerRx = /^##\s+(\d{4}-\d{2}-\d{2})(?::\s*(.+?))?\s*$/;
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(headerRx);
    if (m) {
      if (cur) sections.push(cur);
      cur = { date: m[1], topic: (m[2] || '').trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) sections.push(cur);

  const out = [];
  for (const s of sections) {
    const t = Date.parse(s.date + 'T00:00:00.000Z');
    if (isNaN(t) || t < lookbackMs) continue;
    const body = s.bodyLines.join('\n').trim();
    const ref = s.date + ':' + (s.topic || _hash16(body).slice(0, 8));
    if (consumed.has('decision|' + ref)) continue;
    let candidate = s.topic || body.slice(0, 200);
    const decMatch = body.match(/\*\*Decision:\*\*\s*([^\n]+)/i);
    if (decMatch && decMatch[1].trim()) {
      candidate = (s.topic ? s.topic + ' — ' : '') + decMatch[1].trim();
    }
    candidate = candidate.slice(0, 200);
    if (candidate.length < 10) continue;
    out.push({
      source: 'decision',
      ref,
      ts: s.date + 'T00:00:00.000Z',
      candidate,
      evidence: body.slice(0, 500),
    });
    if (out.length >= max) break;
  }
  return out;
}

// Discover transcript path for the current slug from sync-queue.jsonl.
// Returns one hint record (latest unsynced entry) or null.
function discoverTranscriptHint({ cwd, slug }) {
  const file = path.join(_vantaDir(), 'sync-queue.jsonl');
  const entries = _readJsonlMerged(file);
  // Fold by session_id, latest entry wins (matches auto-sync.js semantics).
  const latest = new Map();
  for (const e of entries) {
    if (!e || !e.session_id) continue;
    latest.set(e.session_id, e);
  }
  // Filter to entries matching current cwd or slug, unsynced, with transcript_path.
  const candidates = [];
  for (const e of latest.values()) {
    if (e.synced === true) continue;
    if (!e.transcript_path) continue;
    const matchesCwd = e.cwd && (e.cwd === cwd);
    const matchesSlug = (e.project === slug) || (e.cwd && _slugFromCwd(e.cwd) === slug);
    if (!matchesCwd && !matchesSlug) continue;
    if (!fs.existsSync(e.transcript_path)) continue;
    candidates.push(e);
  }
  if (candidates.length === 0) return null;
  // Sort by ts desc, take latest.
  candidates.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const c = candidates[0];
  return {
    type: 'transcript_hint',
    path: c.transcript_path,
    session_id: c.session_id,
    discovered_via: 'sync-queue.jsonl',
  };
}

// ─── Cross-source dedup ────────────────────────────────────────────────

// Deduplicate candidates by normalized-text hash; lower-priority sources
// drop if a higher-priority source already emitted the same hash.
// Returns the filtered list with `candidate_hash` field added.
function dedupBySourcePriority(allCandidates) {
  // Sort by priority (lower = higher signal first), then by ts desc within source.
  const sorted = [...allCandidates].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 99;
    const pb = SOURCE_PRIORITY[b.source] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.ts || '').localeCompare(a.ts || '');
  });
  const seen = new Map();  // hash → emitted entry
  const out = [];
  for (const c of sorted) {
    const norm = _normalize(c.candidate);
    if (!norm) continue;
    const hash = _hash16(norm);
    if (seen.has(hash)) continue;  // already covered by higher-priority source
    seen.set(hash, c);
    out.push({ ...c, candidate_hash: hash });
  }
  return out;
}

// ─── Main extract ──────────────────────────────────────────────────────

function extract({ cwd, max = DEFAULT_MAX_PER_SOURCE, allHistory = false } = {}) {
  if (!cwd) {
    return { records: [], warnings: ['cwd required'] };
  }
  const slug = _slugFromCwd(cwd);
  if (!slug) {
    return {
      records: [],
      warnings: ['slugFromCwd returned null (ambiguous basename) — exiting cleanly'],
    };
  }

  // Load consume ledger (per-slug isolated).
  let consumed = new Set();
  let lookbackTs = _isoMinusDays(7);
  try {
    const consumeMod = require('./vanta-sync-consume.js');
    if (!allHistory) {
      consumed = consumeMod.read({ slug });
      lookbackTs = consumeMod.lookback({ slug });
    } else {
      lookbackTs = _isoMinusDays(7);  // hard floor even with --all-history
    }
  } catch (e) {
    _vlog().warn('vanta-sync-extract', 'consume module unavailable: ' + e.message);
  }

  const ctx = { slug, cwd, lookbackTs, consumed, max };
  const all = [];
  const sources = [
    ['episode',  () => scanEpisodes(ctx)],
    ['failure',  () => scanFailures(ctx)],
    ['git',      () => scanGit(ctx)],
    ['retro',    () => scanRetro(ctx)],
    ['decision', () => scanDecisions(ctx)],
  ];
  const warnings = [];
  for (const [name, fn] of sources) {
    try {
      const items = fn();
      for (const it of items) all.push(it);
    } catch (e) {
      warnings.push(`source=${name} error=${e.message}`);
    }
  }

  // Cross-source dedup with priority order (C-3).
  const candidates = dedupBySourcePriority(all);

  // Transcript hint discovery (C-2).
  let hint = null;
  try { hint = discoverTranscriptHint({ cwd, slug }); }
  catch (e) { warnings.push('transcript_hint: ' + e.message); }

  const records = candidates.map(c => ({ type: 'candidate', ...c }));
  if (hint) records.push(hint);

  return { records, warnings, slug, lookbackTs };
}

// ─── CLI ────────────────────────────────────────────────────────────────

function _flag(argv, name) {
  const eq = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!eq) return null;
  if (eq.includes('=')) return eq.slice(eq.indexOf('=') + 1);
  const idx = argv.indexOf(eq);
  return argv[idx + 1] || null;
}

function _hasFlag(argv, name) {
  return argv.includes('--' + name);
}

// v3.11 commit 5 — telemetry for soak report §10. Atomic per-line append.
// Single source of truth for /vanta-sync extraction health metrics:
//   - extract success rate
//   - transcript_fallback rate (transcript_hint emitted)
//   - candidate yield distribution
function _logEvent(event) {
  try {
    const dir = _vantaDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sync-extract-events.jsonl');
    const line = '\n' + JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line, 'utf8') < 4096) {
      fs.appendFileSync(file, line);
    }
  } catch { /* never break the bin on telemetry */ }
}

function cli() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    process.stderr.write('Usage: vanta-sync-extract --cwd <path> [--max N] [--all-history]\n');
    process.exit(2);
  }
  const cwd = _flag(argv, 'cwd');
  const max = parseInt(_flag(argv, 'max') || String(DEFAULT_MAX_PER_SOURCE), 10);
  const allHistory = _hasFlag(argv, 'all-history');
  if (!cwd) {
    process.stderr.write('--cwd is required\n');
    process.exit(2);
  }
  const t0 = Date.now();
  let result, success = false;
  try {
    result = extract({ cwd, max, allHistory });
    success = true;
  } catch (e) {
    result = { records: [], warnings: ['fatal: ' + e.message] };
  }
  for (const w of result.warnings) {
    process.stderr.write('warn: ' + w + '\n');
  }
  for (const r of result.records) {
    process.stdout.write(JSON.stringify(r) + '\n');
  }
  const candidateCount = result.records.filter(r => r.type === 'candidate').length;
  const hintEmitted = result.records.some(r => r.type === 'transcript_hint');
  _logEvent({
    type: 'extract_run',
    ts: new Date().toISOString(),
    slug: result.slug || null,
    success,
    duration_ms: Date.now() - t0,
    candidate_count: candidateCount,
    transcript_hint_emitted: hintEmitted,
    used_all_history: allHistory,
    warning_count: (result.warnings || []).length,
  });
}

if (require.main === module) cli();

module.exports = {
  extract,
  scanEpisodes,
  scanFailures,
  scanGit,
  scanRetro,
  scanDecisions,
  dedupBySourcePriority,
  discoverTranscriptHint,
  _stripCouncilProse,
  _normalize,
  _hash16,
  SOURCE_PRIORITY,
};
