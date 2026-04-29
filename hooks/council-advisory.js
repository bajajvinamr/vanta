#!/usr/bin/env node
// PreToolUse on Write|Edit — anticipatory constraint pack injector.
//
// When you write to security/architecture-critical paths, this hook surfaces:
//   1. Relevant prior decisions from ~/.gstack/projects/<slug>/decisions.md
//   2. Tool-specific invariants from ~/.claude/rules/vinamr-invariants.md
//   3. Project-specific gotchas from ./CLAUDE.md (Gotchas section)
//   4. The standard council advisory if no prior context exists
//
// This turns "remember to /council" into "here is what you've already decided."
// Anticipatory memory > reactive nudges.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const COUNCIL_TRIGGERS = [
  { re: /\/(auth|authn|authz|authentication|authorization|oauth|jwt|token|credential|password)([\/.]|$)/i, reason: 'auth/credential code', topics: ['auth', 'jwt', 'oauth', 'token', 'credential', 'password', 'session'] },
  { re: /\/sessions?([\/.]|$)/i, reason: 'auth/session code', topics: ['session', 'auth'] },
  { re: /\/(payment|billing|stripe|subscription|checkout)/i, reason: 'payment/billing code', topics: ['payment', 'stripe', 'billing', 'subscription'] },
  { re: /\/(admin|privilege|rbac|role)\//i, reason: 'access-control code', topics: ['rbac', 'role', 'permission', 'admin'] },
  { re: /\/migrations?\//i, reason: 'database migration', topics: ['migration', 'schema', 'prisma'] },
  { re: /schema\.prisma$/i, reason: 'database schema', topics: ['prisma', 'schema', 'migration'] },
  { re: /\/(middleware|security|cors|helmet)\//i, reason: 'security middleware', topics: ['cors', 'csp', 'security'] },
  { re: /\/(infrastructure|terraform|k8s|kubernetes)\//i, reason: 'infrastructure code', topics: ['terraform', 'k8s', 'infra'] },
];

function extractFilePath(data) {
  return String(data.tool_input?.file_path || data.tool_input?.path || '');
}

function safeReadFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function getProjectSlug(cwd) {
  // gstack slug convention: <github-user>-<repo>; fall back to basename
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd, stdio: ['pipe', 'pipe', 'ignore'],
    }).toString().trim();
    const m = remote.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}-${m[2]}`;
  } catch (_) {}
  return path.basename(cwd);
}

// Find relevant lines in a file matching any of the topics.
function grepTopics(content, topics, maxLines = 3) {
  if (!content) return [];
  const re = new RegExp(`\\b(${topics.join('|')})\\b`, 'i');
  return content.split('\n').filter(l => re.test(l)).slice(0, maxLines);
}

// Extract recent decision entries (## headings + first bullet) for matching topics.
function relevantDecisions(content, topics, maxEntries = 2) {
  if (!content) return [];
  const re = new RegExp(`\\b(${topics.join('|')})\\b`, 'i');
  const entries = content.split(/^## /m).slice(1); // each starts with date: topic
  const matches = entries.filter(e => re.test(e)).slice(-maxEntries); // recent matches
  return matches.map(e => {
    const lines = e.split('\n').filter(Boolean);
    const heading = lines[0] || '';
    const decision = lines.find(l => /\*\*Decision/i.test(l)) || '';
    return `## ${heading} — ${decision.replace(/\*\*Decision:?\*\*\s*/i, '').slice(0, 100)}`;
  });
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const filePath = extractFilePath(data);
    if (!filePath) process.exit(0);

    const normalized = filePath.replace(/\\/g, '/');
    const trigger = COUNCIL_TRIGGERS.find(t => t.re.test(normalized));
    if (!trigger) process.exit(0);

    const cwd = data.cwd || process.cwd();
    const slug = getProjectSlug(cwd);

    // Build constraint pack
    const sections = [];

    // 1. Prior decisions on this topic
    const decisionsFile = path.join(os.homedir(), '.gstack', 'projects', slug, 'decisions.md');
    const decisions = relevantDecisions(safeReadFile(decisionsFile), trigger.topics);
    if (decisions.length) {
      sections.push(`📌 PRIOR DECISIONS (${slug}):\n` + decisions.join('\n'));
    }

    // 2. Tool-specific invariants
    const invariantsFile = path.join(os.homedir(), '.claude', 'rules', 'vinamr-invariants.md');
    const invariants = grepTopics(safeReadFile(invariantsFile), trigger.topics, 3);
    if (invariants.length) {
      sections.push(`⚠️  INVARIANTS:\n` + invariants.map(l => l.trim()).join('\n'));
    }

    // 3. Project-specific gotchas
    const projectClaudeMd = path.join(cwd, 'CLAUDE.md');
    const projectContent = safeReadFile(projectClaudeMd);
    if (projectContent) {
      const gotchasMatch = projectContent.split(/^##\s+Gotchas/im)[1];
      if (gotchasMatch) {
        const gotchas = grepTopics(gotchasMatch.split(/^##\s+/m)[0], trigger.topics, 2);
        if (gotchas.length) sections.push(`🔒 PROJECT GOTCHAS:\n` + gotchas.map(l => l.trim()).join('\n'));
      }
    }

    // Build the additionalContext message
    const baseAdvisory =
      `COUNCIL ADVISORY: Editing ${trigger.reason} — ${filePath}. ` +
      `If this introduces a new flow (not a small fix), run /council first.`;

    const constraintPack = sections.length > 0
      ? `\n\nCONSTRAINT PACK — what you already know about this:\n\n${sections.join('\n\n')}`
      : '';

    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: baseAdvisory + constraintPack,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch (_) {
    process.exit(0);
  }
});
