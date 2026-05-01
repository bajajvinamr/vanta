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

// Cleanup #11: lazy logger.
let _vlog;
function vlog() {
  if (_vlog) return _vlog;
  for (const p of [
    path.join(process.env.HOME || '', '.claude', 'bin', 'vanta-log.js'),
    path.join(process.env.HOME || '', 'Projects', 'vanta', 'bin', 'vanta-log.js'),
  ]) { try { _vlog = require(p); return _vlog; } catch {} }
  _vlog = { info: () => {}, warn: () => {}, error: () => {} };
  return _vlog;
}

// Codex R4 P3 fix — honor VANTA_DIR_OVERRIDE so tests don't pollute ~/.vanta.
function _vantaDir() {
  return process.env.VANTA_DIR_OVERRIDE || path.join(os.homedir(), '.vanta');
}
function _queuePath()    { return path.join(_vantaDir(), 'sync-queue.jsonl'); }
function _episodesPath() { return path.join(_vantaDir(), 'episodes.jsonl'); }
const MAX_BYTES = 5_000_000;
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
// Strips markdown noise (code blocks, headers, list bullets), rejects skill-
// documentation patterns, and demands actual prose — not just a marker phrase
// followed by a section header.
const SKILL_DOC_PHRASES = [
  /\bUse when\b/i, /\bDon'?t use\b/i, /\bUse if\b/i, /\bWhen to (Run|Use)\b/i,
  /\bMultiple subsystems\b/i, /\bEach problem\b/i, /\bNo shared state\b/i,
  /\bUse this skill\b/i, /\bThis skill (is|will|can)\b/i,
];

function extractDecision(text) {
  // Remove fenced code blocks and inline code first — they contain marker words.
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
  // Match the marker and capture up to ~300 chars of following prose.
  const re = /(decided to|the bug was|root cause(?:\s+was)?|fixed it|the fix was)([^\n]{10,300})/i;
  const m = cleaned.match(re);
  if (!m) return null;
  const candidate = (m[1] + m[2])
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[*_`#>|-]+/g, '')  // strip leftover markdown
    .trim();
  if (/^[#\-*]/.test(candidate)) return null;
  if (candidate.length < 30) return null;  // too short = noise
  // Reject if it looks like skill documentation
  if (SKILL_DOC_PHRASES.some(rx => rx.test(candidate))) return null;
  // Reject if more than 2 of these doc-section words are present together
  const docMarkers = (candidate.match(/\b(investigation|subsystem|problem|step|phase|skill)\b/gi) || []).length;
  if (docMarkers >= 3) return null;
  return candidate.slice(0, 200);
}

// Outcome detection: did this session ship/land/resolve?
function detectOutcome(text) {
  if (/\b(shipped|merged|landed|deployed|fixed|resolved)\b/i.test(text)) return 'resolved';
  if (/\b(blocked|stuck|reverted|rolled back)\b/i.test(text)) return 'blocked';
  if (/\b(decided to|chose|went with)\b/i.test(text)) return 'decided';
  return 'in-progress';
}

// Codex R7 P3 fix — earlier impl cleared the timeout BEFORE reading the
// transcript, then ran fs.readFileSync + several regex scans on a file
// that can be MB. On long sessions this could exceed Claude Code's ~10s
// Stop-hook budget and the hook would be force-killed mid-write,
// stranding sync-queue/episode entries. Now: keep the deadline alive
// through the entire hook lifetime AND cap the transcript bytes
// processed so even a 100MB transcript doesn't push us past budget.
const TRANSCRIPT_BYTES_CAP = 8 * 1024 * 1024;  // 8MB — typical session is <2MB
let input = '';
const timeout = setTimeout(() => process.exit(0), 9500);  // 0.5s margin under 10s
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  // Note: timeout still armed; cleared only at process.exit at end.
  try {
    const data = JSON.parse(input);
    const { session_id, transcript_path, cwd } = data;

    if (!transcript_path || !fs.existsSync(transcript_path)) {
      clearTimeout(timeout); process.exit(0);
    }

    // Read up to the cap from the END of the transcript (most recent
    // content is most relevant for decision-marker + tool-use detection).
    let transcript;
    try {
      const st = fs.statSync(transcript_path);
      if (st.size > TRANSCRIPT_BYTES_CAP) {
        const fd = fs.openSync(transcript_path, 'r');
        const buf = Buffer.alloc(TRANSCRIPT_BYTES_CAP);
        fs.readSync(fd, buf, 0, TRANSCRIPT_BYTES_CAP, st.size - TRANSCRIPT_BYTES_CAP);
        fs.closeSync(fd);
        transcript = buf.toString('utf8');
      } else {
        transcript = fs.readFileSync(transcript_path, 'utf8');
      }
    } catch {
      clearTimeout(timeout); process.exit(0);
    }
    const toolCallCount = (transcript.match(/"type"\s*:\s*"tool_use"/g) || []).length;
    const hasDecisionMarker = DECISION_MARKERS.test(transcript);

    if (toolCallCount <= TOOL_CALL_THRESHOLD && !hasDecisionMarker) {
      clearTimeout(timeout); process.exit(0);
    }

    fs.mkdirSync(_vantaDir(), { recursive: true });

    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString().trim();
    } catch (_) {}

    // R7 P2 fix — robust slug. Use shared resolver from vanta-projects;
    // basename(cwd) collided across projects with the same directory name.
    let slug = path.basename(cwd || process.cwd());
    try {
      const projects = require(path.join(os.homedir(), '.claude', 'bin', 'vanta-projects.js'));
      if (projects.slugFromCwd) {
        const better = projects.slugFromCwd(cwd || process.cwd());
        if (better) slug = better;
      }
    } catch {
      try {
        const projects = require(path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-projects.js'));
        if (projects.slugFromCwd) {
          const better = projects.slugFromCwd(cwd || process.cwd());
          if (better) slug = better;
        }
      } catch { /* fall back to basename */ }
    }
    const ts = new Date().toISOString();

    const sid = session_id || 'unknown';

    // Codex R4 P2 fix — was read-modify-write under .tmp+rename. Two
    // sessions stopping concurrently could both load the same baseline and
    // the second rename would clobber the first session's entry. Now we
    // append-only; readers dedup by session_id taking the LAST occurrence.
    // POSIX appendFileSync < PIPE_BUF (4096B) is atomic; each entry is
    // a few hundred bytes, well under the limit.
    //
    // Rotation: if file > 5MB, fold to last-occurrence-per-session before
    // appending. This is a per-Stop-hook event (not per tool call), so
    // the fold cost is negligible vs hook lifetime.
    // R5 P2 fix — earlier rotation read+folded then renamed tmp→file. A
    // concurrent appendFileSync between the read and the rename would be
    // lost. New: rename live file to .bak when oversized, then write the
    // folded snapshot as the fresh file. POSIX rename is atomic; any
    // concurrent appendFileSync either lands in the soon-to-be-.bak file
    // (preserved) or the freshly-recreated file. No clobber window.
    const appendJsonl = (file, newEntry) => {
      try {
        if (fs.existsSync(file)) {
          const st = fs.statSync(file);
          if (st.size > MAX_BYTES) {
            // Capture the file under .bak first — atomic. Then fold from .bak
            // and write the snapshot fresh. Concurrent writers see fresh file.
            const bak = file + '.bak';
            fs.renameSync(file, bak);
            try {
              const lines = fs.readFileSync(bak, 'utf8').split('\n').filter(Boolean);
              const latest = new Map();
              for (const l of lines) {
                try {
                  const e = JSON.parse(l);
                  if (e.session_id) latest.set(e.session_id, l);
                } catch {}
              }
              fs.writeFileSync(file, [...latest.values()].join('\n') + '\n');
            } catch { /* fold failure: leave fresh empty, .bak preserved */ }
          }
        }
      } catch { /* never block on rotation */ }
      try {
        fs.appendFileSync(file, JSON.stringify(newEntry) + '\n');
      } catch (e) { vlog().error('auto-sync.append', e.message || String(e)); }
    };

    // 1. Sync queue (pending learning extraction)
    appendJsonl(_queuePath(), {
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

      appendJsonl(_episodesPath(), {
        ts, slug, branch,
        topics,           // ["jwt", "auth"] etc.
        decision,         // 1-line decision summary (null if extractor rejected noise)
        outcome,          // "resolved" | "blocked" | "decided" | "in-progress"
        session_id: sid,
      });
    }
  } catch (err) {
    // Never block a session from ending — but log so silent breakage is visible.
    vlog().error('auto-sync', err && err.message || String(err));
  }
  process.exit(0);
});
