#!/usr/bin/env node
// Stop hook — fires when a Claude Code session ends.
// Appends to ~/.vanta/sync-queue.jsonl when session is "meaningful":
//   - >5 tool calls, OR
//   - transcript contains decision/fix markers (root cause / fixed / decided / shipped / merged)
// Records enough context for vanta-sync to replay the session later.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const QUEUE_PATH = path.join(os.homedir(), '.vanta', 'sync-queue.jsonl');
const TOOL_CALL_THRESHOLD = 5;
const DECISION_MARKERS = /\b(root cause|fixed it|decided to|shipped|merged|landed|figured out|the bug was)\b/i;

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

    // Skip only if BOTH thresholds fail (saves short but high-value sessions)
    if (toolCallCount <= TOOL_CALL_THRESHOLD && !hasDecisionMarker) process.exit(0);

    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });

    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString().trim();
    } catch (_) { /* not a git repo, leave as unknown */ }

    const slug = path.basename(cwd || process.cwd());

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      cwd: cwd || process.cwd(),
      slug,
      branch,
      session_id: session_id || 'unknown',
      transcript_path,
      tool_calls: toolCallCount,
      decision_marker: hasDecisionMarker,
      synced: false,
    });

    fs.appendFileSync(QUEUE_PATH, entry + '\n');
  } catch (_) {
    // Never block a session from ending
  }
  process.exit(0);
});
