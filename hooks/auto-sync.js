#!/usr/bin/env node
// Stop hook — fires when a Claude Code session ends.
//
// Two outputs:
//   1. ~/.vanta/sync-queue.jsonl — pending items for /vanta-sync to process
//   2. ~/.vanta/episodes.jsonl   — durable episodic memory: {topic, decision, outcome, date, project}
//
// A session is captured when:
//   - >5 tool calls (meaningful work), OR
//   - transcript contains decision/fix markers (root cause / fixed it / decided to / shipped / merged)
//
// Episodes enable time-aware recall: "what did we discuss about X last week"

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const VANTA_DIR = path.join(os.homedir(), '.vanta');
const QUEUE_PATH = path.join(VANTA_DIR, 'sync-queue.jsonl');
const EPISODES_PATH = path.join(VANTA_DIR, 'episodes.jsonl');
const TOOL_CALL_THRESHOLD = 5;
const DECISION_MARKERS = /\b(root cause|fixed it|decided to|shipped|merged|landed|figured out|the bug was)\b/i;

// Topic extraction: scan for technical nouns/proper nouns that appear repeatedly.
// Cheap heuristic — looks for capitalized multi-word phrases and common stack terms.
const TECH_TERMS = /\b(JWT|OAuth|Stripe|Supabase|Prisma|Next\.?js|React|Redis|BullMQ|PixiJS|Cloudflare|Vercel|Docker|Postgres|GraphQL|WebSocket|TLS|CORS|CSP|RBAC|Webhook|Migration|Auth|Payment|Council|Memory|Routing|Hook|Skill|Vanta|gstack|GSD)\b/g;

function topTopics(text, max = 3) {
  const counts = new Map();
  const matches = text.match(TECH_TERMS) || [];
  for (const m of matches) {
    const key = m.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([term]) => term);
}

// Extract a 1-line decision summary from text following a decision marker.
// Strips markdown noise (code blocks, headers, list bullets) so we capture
// actual prose, not skill documentation that mentions "root cause" in passing.
function extractDecision(text) {
  // Remove fenced code blocks first — they often contain marker words.
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
  // Match the marker and capture up to ~200 chars of prose, but stop at
  // markdown structure (newline + #, -, *, >, |, or another code fence).
  const re = /(decided to|the bug was|root cause(?:\s+was)?|fixed it|the fix was)([^\n]{10,300})/i;
  const m = cleaned.match(re);
  if (!m) return null;
  const candidate = (m[1] + m[2])
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[*_`#>|-]+/g, '')  // strip leftover markdown
    .trim();
  // Reject if it still looks like markdown skeleton or is too generic.
  if (/^[#\-*]/.test(candidate)) return null;
  if (candidate.length < 20) return null;
  return candidate.slice(0, 200);
}

// Outcome detection: did this session ship/land/resolve?
function detectOutcome(text) {
  if (/\b(shipped|merged|landed|deployed|fixed|resolved)\b/i.test(text)) return 'resolved';
  if (/\b(blocked|stuck|reverted|rolled back)\b/i.test(text)) return 'blocked';
  if (/\b(decided to|chose|went with)\b/i.test(text)) return 'decided';
  return 'in-progress';
}

let input = '';
const timeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const { session_id, transcript_path, cwd } = data;

    if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

    const transcript = fs.readFileSync(transcript_path, 'utf8');
    const toolCallCount = (transcript.match(/"type"\s*:\s*"tool_use"/g) || []).length;
    const hasDecisionMarker = DECISION_MARKERS.test(transcript);

    if (toolCallCount <= TOOL_CALL_THRESHOLD && !hasDecisionMarker) process.exit(0);

    fs.mkdirSync(VANTA_DIR, { recursive: true });

    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString().trim();
    } catch (_) {}

    const slug = path.basename(cwd || process.cwd());
    const ts = new Date().toISOString();

    const sid = session_id || 'unknown';

    // upsertJsonl: replace existing entry with same session_id, else append.
    // Stop hook can fire multiple times per session (compact, /clear, end) —
    // dedup keeps the latest tool_call count + ts per session.
    const upsertJsonl = (file, newEntry) => {
      let lines = [];
      if (fs.existsSync(file)) {
        lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      }
      let replaced = false;
      const updated = lines.map(l => {
        try {
          const e = JSON.parse(l);
          if (e.session_id === newEntry.session_id) {
            replaced = true;
            return JSON.stringify(newEntry);
          }
          return l;
        } catch { return l; }
      });
      if (!replaced) updated.push(JSON.stringify(newEntry));
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, updated.join('\n') + '\n');
      fs.renameSync(tmp, file);  // atomic on POSIX
    };

    // 1. Sync queue (pending learning extraction)
    upsertJsonl(QUEUE_PATH, {
      ts, cwd: cwd || process.cwd(), slug, branch,
      session_id: sid,
      transcript_path,
      tool_calls: toolCallCount,
      decision_marker: hasDecisionMarker,
      synced: false,
    });

    // 2. Episode (durable, time-aware memory) — only if decision-marker session
    if (hasDecisionMarker) {
      const topics = topTopics(transcript);
      const decision = extractDecision(transcript);
      const outcome = detectOutcome(transcript);

      upsertJsonl(EPISODES_PATH, {
        ts, slug, branch,
        topics,           // ["jwt", "auth"] etc.
        decision,         // 1-line decision summary (null if extractor rejected noise)
        outcome,          // "resolved" | "blocked" | "decided" | "in-progress"
        session_id: sid,
      });
    }
  } catch (_) {
    // Never block a session from ending
  }
  process.exit(0);
});
