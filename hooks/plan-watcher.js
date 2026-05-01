#!/usr/bin/env node
// PostToolUse on Write|Edit to .planning/*.md — Shadow Council lite.
//
// When a sensitive plan is written (auth/payment/migration/security keywords),
// flag it for council review BEFORE any code is written. Writes a marker to
// ~/.gstack/projects/<slug>/.shadow_pending.md that council-advisory.js reads
// on the next code edit and surfaces in the constraint pack.
//
// This is the "anticipatory governance" loop: by the time you start implementing,
// you already see "this plan touched auth and hasn't been council-reviewed."
//
// v1 = flag only (no async Codex/Gemini fire). The flag itself is the signal —
// the user decides whether to run /council. Real async multi-model review can
// land in v3.4 once we know the false-positive rate.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Cleanup #11: lazy logger so silent breakage becomes visible at ~/.vanta/hook.log.
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

// Map sensitive keywords found in the plan to council topics.
const SENSITIVE_TOPICS = [
  { re: /\b(jwt|oauth|auth(n|z)?|authentication|authorization|credential|password|token)\b/i, topic: 'auth' },
  { re: /\b(session|cookie)\b/i,                                                                topic: 'session' },
  { re: /\b(stripe|payment|billing|subscription|checkout|webhook)\b/i,                          topic: 'payment' },
  { re: /\b(migration|prisma|schema)\b/i,                                                       topic: 'migration' },
  { re: /\b(rbac|permission|admin role|access control)\b/i,                                     topic: 'rbac' },
  { re: /\b(cors|csp|helmet|xss|csrf|sql injection)\b/i,                                        topic: 'security' },
  { re: /\b(terraform|kubernetes|k8s)\b/i,                                                      topic: 'infra' },
];

function getProjectSlug(cwd) {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
    }).toString().trim();
    const m = remote.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}-${m[2]}`;
  } catch (_) {}
  return path.basename(cwd);
}

function detectTopics(content) {
  const found = new Set();
  for (const { re, topic } of SENSITIVE_TOPICS) {
    if (re.test(content)) found.add(topic);
  }
  return [...found];
}

let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const filePath = String(data.tool_input?.file_path || '');
    if (!/\/\.planning\/.*\.md$/.test(filePath)) process.exit(0);

    let content; try { content = fs.readFileSync(filePath, 'utf8'); } catch { process.exit(0); }
    const topics = detectTopics(content);
    if (!topics.length) process.exit(0);

    const cwd = data.cwd || process.cwd();
    const slug = getProjectSlug(cwd);
    const projDir = path.join(os.homedir(), '.gstack', 'projects', slug);
    fs.mkdirSync(projDir, { recursive: true });

    const flagFile = path.join(projDir, '.shadow_pending.md');
    const ts = new Date().toISOString();
    const planName = path.basename(filePath);

    // Append a flag block. council-advisory reads this when sensitive code edits start.
    // Section heading must contain a topic word so the consumer can match by trigger.
    const block = `\n## ${planName} · ${topics.join(', ')} · flagged ${ts}\n` +
                  `Plan path: ${filePath}\n` +
                  `Sensitive topics detected: ${topics.join(', ')}\n` +
                  `Status: PENDING — run /council on this plan before implementing\n`;

    // Gemini R4 P3 fix — idempotency. If Claude Code retries the Write/Edit
    // tool call, plan-watcher fires again on the same plan. Skip the append
    // if the same planName already has a PENDING flag in the file. User
    // edits the flag (or deletes it) when they're done; that's the "ok to
    // re-flag" signal.
    let existing = '';
    try { existing = fs.readFileSync(flagFile, 'utf8'); } catch {}
    const alreadyFlagged = new RegExp(
      `^## ${planName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')} .*\\nPlan path: ${filePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\n[\\s\\S]*?Status: PENDING`,
      'm'
    ).test(existing);
    if (!alreadyFlagged) fs.appendFileSync(flagFile, block);

    // Also emit a soft advisory back to the user.
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `🌑 Shadow Council flag: this plan touches ${topics.join(', ')}. ` +
          `Recommended: /council on ${planName} before implementing — verdict will be cached and surfaced on the first code edit.`,
      },
    };
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    vlog().error('plan-watcher', err && err.message || String(err));
    process.exit(0);
  }
});
