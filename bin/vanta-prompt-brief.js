#!/usr/bin/env node
// vanta-prompt-brief — prompt classifier + brief generator.
//
// Codex council P1 fix (always-on layer): the only Claude Code primitive
// that fires on every user prompt is UserPromptSubmit. This module is the
// brain the prompt-context hook calls — it classifies prompt intent and
// produces a 3-line brief drawn from existing Vanta state, deduped via
// runtime-state.
//
// Pure logic — no I/O at module load. CLI mode reads stdin (the prompt
// text) and prints the brief to stdout. Hook calls module API directly.
//
// Classification: rule-based keyword matching. Cheap, deterministic, and
// fast enough to run on every keystroke-submitted prompt.
//
//   plan    → "design", "approach", "architecture", "what should"
//   build   → "build", "add", "implement", "wire", "integrate"
//   debug   → "bug", "broken", "fail", "error", "why is", "not working"
//   ship    → "ship", "deploy", "merge", "land", "release", "PR"
//   review  → "review", "audit", "check", "opinion on"
//   recall  → "remember", "what did we", "history", "earlier"
//   unknown → no signal — return null brief
//
// Brief shape (≤ 2 lines, plus an optional contradiction warning):
//   line 1: phase + topic-hash (terse handle)
//   line 2: one Vanta-resolved fact (existing invariant or decision)
//   line 3: ONLY if a binary contradiction was detected on the same topic —
//           e.g. "ES256 vs HS256 in pi-perception". Factual safety signal.
//
// Codex R2 P3 fix: NO route hints. Earlier versions appended "→ /ship runs
// tests" / "→ /investigate for systematic debug". Those turn the
// always-on layer from factual recall into product-surface advertisement
// on every prompt, violating the three-command promise. The user already
// knows the three commands; the brief's job is fact recall, not routing.
//
// If there's nothing sharp to add, return null. Silence > noise.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Lazy-load the resolver — avoids slow startup when prompt is unknown phase
// or rate-limited by runtime-state (the hook checks shouldInject first).
let _resolveKnowledge = null;
function _resolver() {
  if (_resolveKnowledge !== null) return _resolveKnowledge;
  for (const p of [
    path.join(os.homedir(), '.claude', 'bin', 'vanta-resolve.js'),
    path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-resolve.js'),
  ]) {
    try { _resolveKnowledge = require(p).resolve; if (_resolveKnowledge) return _resolveKnowledge; }
    catch {}
  }
  _resolveKnowledge = null;
  return null;
}

// ─── classification ─────────────────────────────────────────────────────────

const CLASSIFIERS = [
  // Order matters — first match wins. More specific phrases first.
  { phase: 'ship',   re: /\b(?:ship|deploy(?:ing)?|merge|land(?:ing)?|push to (?:main|master|prod)|cut a release|pr (?:up|ready))\b/i },
  { phase: 'debug',  re: /\b(?:bug|broken|crashe?d?|fails?|error|stack trace|why (?:is|does|did)|not working|investigate)\b/i },
  { phase: 'review', re: /\b(?:review (?:this|the)|audit|second opinion|sanity check|critique|look (?:at|over))\b/i },
  { phase: 'recall', re: /\b(?:remember|recall|what (?:did|do) we|history|earlier|when did we|do we (?:have|already))\b/i },
  { phase: 'plan',   re: /\b(?:design (?:for|the|a)|architect(?:ure)?|approach|propose|how should|what (?:approach|design))\b/i },
  { phase: 'build',  re: /\b(?:build (?:a|the|an|out)|implement|add (?:a|the|an|support)|wire (?:up|in)|integrate|create (?:a|the|an))\b/i },
];

function classify(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'unknown';
  for (const c of CLASSIFIERS) if (c.re.test(prompt)) return c.phase;
  return 'unknown';
}

// Pull bare keywords from the prompt for resolver queries. Strip common
// English words; keep capitalized identifiers, file paths, technical tokens.
function extractTopics(prompt) {
  if (!prompt) return [];
  const STOP = new Set([
    'the','this','that','for','and','but','with','from','what','when','how','why','who',
    'should','could','would','will','can','also','then','there','here','have','has','had',
    'are','was','were','been','being','being','your','our','their','its','any','some','all',
    'now','need','want','make','just','like','one','two','really','very','please','help',
  ]);
  const words = prompt.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
  const uniq = [];
  const seen = new Set();
  for (const w of words) {
    if (STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

// Hash the prompt's classified shape for cooldown keys. Same phase + same
// top-3-topics in the same session → same key, so the hook deduplicates.
const crypto = require('crypto');
function shapeKey(prompt) {
  const phase = classify(prompt);
  const topics = extractTopics(prompt).join('-');
  const h = crypto.createHash('sha256').update(`${phase}|${topics}`).digest('hex').slice(0, 8);
  return `${phase}:${h}`;
}

// ─── brief generation ──────────────────────────────────────────────────────

function buildBrief({ prompt, slug, cwd } = {}) {
  const phase = classify(prompt);
  if (phase === 'unknown' || phase === 'review') {
    // 'review' = user is asking model to review; injecting Vanta context
    // would be noise. Stay silent.
    return null;
  }

  const topics = extractTopics(prompt);
  if (topics.length === 0) return null;

  const lines = [];
  const tag = `[Vanta:${phase}]`;

  // Try the resolver against the first topic. If it returns nothing, we
  // probably don't have anything sharp to say — return null.
  const resolve = _resolver();
  if (!resolve) {
    // No resolver loadable — silent degradation. Hooks must work without it.
    return null;
  }

  // Codex R2 P2 fix: hard wall-clock budget. The resolver caches results
  // (60s TTL), so steady-state cost is near-zero, but the FIRST call after
  // cache invalidation can do real I/O. 200ms is generous — if we can't
  // produce a brief in that time, return null. The prompt still goes
  // through; we just don't enrich it. Silence > slow prompt.
  const BUDGET_MS = 200;
  const startedAt = Date.now();
  let topResult = null;
  let contradictions = null;
  for (const topic of topics) {
    if (Date.now() - startedAt > BUDGET_MS) break;
    try {
      const out = resolve({ topic, project: slug, cwd, max: 1 });
      if (out && out.results && out.results.length > 0) {
        topResult = out.results[0];
        contradictions = out.contradictions || [];
        break;
      }
    } catch { /* keep trying next topic */ }
  }

  if (!topResult) return null;

  // Line 1: tag + topic
  lines.push(`${tag} ${topResult.section || topics[0]}`);

  // Line 2: the actual fact (truncated to 1 line, no leading dash)
  const excerpt = String(topResult.excerpt || '').replace(/\n.*$/s, '').replace(/^\s*-\s*/, '').slice(0, 140);
  lines.push(`  ${excerpt}`);

  // Line 3 (optional): contradiction warning ONLY — no route hints.
  // Contradictions are factual safety signals (e.g. ES256 vs HS256 same
  // project) and stay. Phase-based "/ship runs tests" hints were stripped
  // per Codex R2 P3.
  if (contradictions && contradictions.length > 0) {
    lines.push(`  ⚠ contradiction: ${contradictions[0].hint.slice(0, 120)}`);
  }

  return lines.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => buf += c);
    process.stdin.on('end', () => resolve(buf));
  });
}

async function main() {
  const cmd = process.argv[2] || 'brief';
  const args = process.argv.slice(3);
  const argMap = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) argMap[k] = args[++i];
      else argMap[k] = true;
    }
  }

  if (cmd === 'classify') {
    const prompt = argMap.prompt || (await readStdin());
    console.log(classify(prompt));
    return;
  }
  if (cmd === 'topics') {
    const prompt = argMap.prompt || (await readStdin());
    console.log(JSON.stringify(extractTopics(prompt)));
    return;
  }
  if (cmd === 'shape-key') {
    const prompt = argMap.prompt || (await readStdin());
    console.log(shapeKey(prompt));
    return;
  }
  if (cmd === 'brief') {
    const prompt = argMap.prompt || (await readStdin());
    const brief = buildBrief({
      prompt,
      slug: argMap.slug,
      cwd: argMap.cwd || process.cwd(),
    });
    if (brief) console.log(brief);
    return;
  }
  console.error('Usage: vanta-prompt-brief {brief|classify|topics|shape-key} [--prompt "..."] [--slug X] [--cwd Y]');
  console.error('  Most usage: pipe prompt text on stdin.');
  process.exit(2);
}

if (require.main === module) main().catch(e => { process.stderr.write(`vanta-prompt-brief: ${e.message}\n`); process.exit(0); });

module.exports = { classify, extractTopics, shapeKey, buildBrief };
