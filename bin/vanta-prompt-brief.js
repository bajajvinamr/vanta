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
  { phase: 'debug',  re: /\b(?:bug|broken|crashe?d?|fails?|error|stack trace|why (?:is|does|did)|not working|investigate|fix(?:ing)?(?:\s+(?:a|the|this|that|my|our))?\b)\b/i },
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

// Codex+Gemini council R6 P1 fix — extractTopics was noise-driven. Generic
// verbs ('build', 'fix', 'ship', 'design', 'investigate', 'decide') survived
// the stopword filter and became resolver queries, returning unrelated junk
// (Codex tested: "build the new sync flow" hit `tz-cron`).
//
// New rules:
// 1. The verbs that classify the PHASE are by definition not topic-bearing.
//    Strip them before topic extraction.
// 2. Prefer identifier-shaped tokens: camelCase, dotted names, file paths,
//    Capitalized terms. These are far more likely to land in invariants
//    or decisions than English nouns.
// 3. If after filtering nothing remains, return [] — buildBrief stays silent
//    rather than firing a low-quality query.
const STOP = new Set([
  // English filler
  'the','this','that','for','and','but','with','from','what','when','how','why','who',
  'should','could','would','will','can','also','then','there','here','have','has','had',
  'are','was','were','been','being','your','our','their','its','any','some','all',
  'now','need','want','make','just','like','one','two','really','very','please','help',
  'into','onto','over','under','about','than','more','most','less','only','own',
  'both','either','neither','each','every','same','other','another','such',
  // Phase verbs — these classify intent, NOT topic
  'plan','design','architect','approach','propose','decide','decision',
  'build','add','wire','integrate','create','implement','implementation',
  'debug','bug','broken','fix','crash','crashed','fail','fails','error','investigate',
  'ship','deploy','merge','land','release',
  'review','audit','check','critique',
  'recall','remember','history','earlier','prior',
  // Common build verbs that aren't topical
  'run','test','tests','testing','trying','try','use','using',
  'work','works','working','works','start','started','stop','stopped','done','finished',
  'show','tell','find','get','got','put','set','call','calls','called',
  'looks','look','looking','seem','seems','seeming','still','already',
  // Generic nouns that almost never carry resolver value
  'thing','things','stuff','way','ways','time','times','case','cases',
  'flow','flows','step','steps','task','tasks','part','parts','side','sides',
  // Trivial modifiers — they don't add intent, only churn the cooldown key
  'new','old','next','prev','previous','current','last','first','final',
  'simple','quick','small','large','big','tiny','main','sub','full','partial',
]);

const ID_PATTERN = /^(?:[a-z]+[A-Z]|[A-Z][a-z]|[\w-]+\.|.*\/|.*-.*-)/;  // camelCase | PascalCase | dotted | path | hyphenated

// extractTopicsTagged returns topics with a `kind` flag — 'id' (identifier-
// shaped, high-confidence resolver query) vs 'word' (English token, lower
// confidence). buildBrief uses kind to weight scores, so a JWT identifier
// hit beats a "path" English-word hit on the Claude Code section.
function extractTopicsTagged(prompt) {
  if (!prompt) return [];
  const out = [];
  const seen = new Set();
  // Pass 1: identifier-shaped tokens. Includes uppercase acronyms like
  // 'JWT' as well as camelCase / dotted / hyphenated forms.
  const idCandidates = prompt.match(/[A-Za-z][\w./-]{2,}/g) || [];
  for (const t of idCandidates) {
    const lower = t.toLowerCase();
    if (seen.has(lower) || STOP.has(lower)) continue;
    const isAcronym = /^[A-Z]{2,}$/.test(t);
    const isPattern = ID_PATTERN.test(t);
    if (!isAcronym && !isPattern) continue;
    seen.add(lower);
    out.push({ topic: lower, kind: 'id' });
    if (out.length >= 3) break;
  }
  // Pass 2: pad with English words IF we still have slots. Mark them as
  // lower-confidence so buildBrief can downweight their resolver hits.
  if (out.length < 3) {
    const words = prompt.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
    for (const w of words) {
      if (seen.has(w) || STOP.has(w)) continue;
      seen.add(w);
      out.push({ topic: w, kind: 'word' });
      if (out.length >= 3) break;
    }
  }
  return out;
}

function extractTopics(prompt) {
  // Back-compat: callers and tests expect a flat string array.
  return extractTopicsTagged(prompt).map(t => t.topic);
}

// Hash the prompt's classified shape for cooldown keys.
//
// Codex+Gemini R6 P1 fix — earlier hash used raw token order, so trivial
// rephrases ("build the sync flow" vs "build the new sync flow" vs
// "implement the sync flow") produced different keys and the cooldown
// never bit. Now: sort the topics + drop length-2 words + dedup before
// hashing. Same intent → same key → cooldown engages.
const crypto = require('crypto');
function shapeKey(prompt) {
  const phase = classify(prompt);
  const topics = extractTopics(prompt)
    .filter(t => t.length >= 3)
    .sort();
  const canonical = [...new Set(topics)].join('|');
  const h = crypto.createHash('sha256').update(`${phase}|${canonical}`).digest('hex').slice(0, 8);
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

  const tagged = extractTopicsTagged(prompt);
  if (tagged.length === 0) return null;

  const lines = [];
  const tag = `[Vanta:${phase}]`;

  const resolve = _resolver();
  if (!resolve) return null;

  // Codex+Gemini council R6 P1 fix — score floor + topic-kind weight.
  //
  // 1. 200ms wall-clock budget (resolver caches; first call may do I/O).
  // 2. MIN_SCORE_ID for identifier topics, MIN_SCORE_WORD (higher) for
  //    English topics — generic words must clear a higher bar.
  // 3. Source must be curated (invariant/decision/gotcha; not auto-
  //    extracted episode/memory).
  // 4. Compare ACROSS all topics with a kind weight: identifier topics
  //    (JWT, JWTVerifier, pi-perception) get 1.5×, English words ('path',
  //    'failure') get 0.7×. Effect: JWT score 2.2 → effective 3.3 beats
  //    'path' score 2.1 → effective 1.5 on the same prompt.
  const BUDGET_MS = 200;
  const MIN_SCORE_ID = 1.5;
  const MIN_SCORE_WORD = 2.5;
  const KIND_WEIGHT = { id: 1.5, word: 0.7 };
  const TRUSTED_SOURCES = new Set(['invariant', 'decision', 'gotcha']);
  const startedAt = Date.now();
  let topResult = null;
  let topResultTopic = null;
  let topResultEffective = -1;
  let contradictions = null;
  for (const { topic, kind } of tagged) {
    if (Date.now() - startedAt > BUDGET_MS) break;
    try {
      const out = resolve({ topic, project: slug, cwd, max: 3 });
      if (!out || !out.results || out.results.length === 0) continue;
      const minScore = kind === 'id' ? MIN_SCORE_ID : MIN_SCORE_WORD;
      const candidates = out.results.filter(
        r => TRUSTED_SOURCES.has(r.source) && (r.score || 0) >= minScore,
      );
      if (candidates.length === 0) continue;
      const best = candidates[0];
      const effective = (best.score || 0) * (KIND_WEIGHT[kind] || 1);
      if (effective > topResultEffective) {
        topResult = best;
        topResultTopic = topic;
        topResultEffective = effective;
        contradictions = out.contradictions || [];
      }
    } catch { /* keep trying next topic */ }
  }

  if (!topResult) return null;

  // Line 1: tag + topic. Use the topic that actually produced the hit
  // (R6 P1) so the user sees the relevant identifier (e.g. "JWT") instead
  // of the first English token in the prompt.
  lines.push(`${tag} ${topResult.section || topResultTopic || tagged[0].topic}`);

  // Line 2: the actual fact (truncated to 1 line, no leading dash)
  const excerpt = String(topResult.excerpt || '').replace(/\n.*$/s, '').replace(/^\s*-\s*/, '').slice(0, 140);
  lines.push(`  ${excerpt}`);

  return lines.join('\n');
}

// R6 P3 fix — contradiction dedup. The brief generator no longer emits
// the contradiction warning inline; instead it returns the contradictions
// alongside the brief text. The HOOK layer (prompt-context, council-advisory)
// gates the warning through runtime-state's `contradiction-shown:<hash>`
// cooldown so it surfaces once per topic per session, not in every brief.
function buildBriefDetail({ prompt, slug, cwd } = {}) {
  // Reuse buildBrief by re-running the contradiction lookup. This is a thin
  // wrapper rather than a full duplicate; signal-quality and perf rules from
  // buildBrief still apply because the resolver cache memoizes the second
  // call within the 60s TTL window.
  const phase = classify(prompt);
  if (phase === 'unknown' || phase === 'review') return { line: null, contradictions: [] };
  const topics = extractTopics(prompt);
  if (topics.length === 0) return { line: null, contradictions: [] };
  const resolve = _resolver();
  if (!resolve) return { line: null, contradictions: [] };
  const line = buildBrief({ prompt, slug, cwd });
  // Re-query for contradictions only — we already have the cache hit.
  let contradictions = [];
  for (const topic of topics) {
    try {
      const out = resolve({ topic, project: slug, cwd, max: 3 });
      if (out && out.contradictions && out.contradictions.length) {
        contradictions = out.contradictions;
        break;
      }
    } catch {}
  }
  return { line, contradictions };
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

module.exports = { classify, extractTopics, shapeKey, buildBrief, buildBriefDetail };
