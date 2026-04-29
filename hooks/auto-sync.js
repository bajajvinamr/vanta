#!/usr/bin/env node
// Stop hook — fires when a Claude Code session ends.
// Appends to ~/.vanta/sync-queue.jsonl if session had >5 tool calls.
// Vanta-run reads this queue at session start and offers /vanta-sync.

const fs = require('fs');
const path = require('path');
const os = require('os');

const QUEUE_PATH = path.join(os.homedir(), '.vanta', 'sync-queue.jsonl');
const TOOL_CALL_THRESHOLD = 5;

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

    if (toolCallCount <= TOOL_CALL_THRESHOLD) process.exit(0);

    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      cwd: cwd || process.cwd(),
      session_id: session_id || 'unknown',
      tool_calls: toolCallCount,
      synced: false,
    });

    fs.appendFileSync(QUEUE_PATH, entry + '\n');
  } catch (_) {
    // Never block a session from ending
  }
  process.exit(0);
});
