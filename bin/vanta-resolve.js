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
function readInvariants(topic) {
  const file = path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.md');
  const content = readSafe(file);
  if (!content) return [];
  const out = [];
  let section = '(unsectioned)';
  let buf = null;
  const flush = () => {
    if (buf && topicMatch(buf.text, topic) > 0) {
      out.push({ source: 'invariant', section, excerpt: buf.text.trim(), path: file, line: buf.line });
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
  const out = [];
  let buf = null;
  const flush = () => {
    if (buf && topicMatch(buf, topic) > 0) {
      out.push({ source: 'gotcha', excerpt: buf.trim(), path: file });
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
    // Extract first paragraph after frontmatter
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    const firstPara = body.split(/\n\n/)[0].slice(0, 200);
    out.push({ source: 'memory', excerpt: firstPara, path: file });
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

// ─── Main resolver ──────────────────────────────────────────────────────────
function resolve({ topic, project, cwd, max = 5 }) {
  if (!topic) return { topic: null, results: [], error: 'topic required' };
  const all = [
    ...readInvariants(topic),
    ...readDecisions(project, topic),
    ...readGotchas(cwd, topic),
    ...readEpisodes(topic),
    ...readMemory(topic),
  ];
  for (const r of all) r.score = scoreResult(r, topic);
  all.sort((a, b) => b.score - a.score);
  return { topic, project: project || null, count: all.length, results: all.slice(0, max) };
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
  const lines = [`${out.count} result(s) for "${out.topic}":`, ''];
  const icon = { invariant: '⚠️ ', decision: '📌', gotcha: '🔒', episode: '🧠', memory: '💭' };
  for (const r of out.results) {
    const head = `${icon[r.source] || '·'} ${r.source.toUpperCase()}` +
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
  });
  if (input.format === 'text') {
    process.stdout.write(formatText(out));
  } else {
    process.stdout.write(JSON.stringify(out, null, 2));
  }
}

if (require.main === module) main();
module.exports = { resolve, scoreResult };
