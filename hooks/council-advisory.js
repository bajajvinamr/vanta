#!/usr/bin/env node
// PreToolUse on Write|Edit — anticipatory constraint pack injector.
//
// When you write to security/architecture-critical paths, this hook surfaces:
//   1. Ranked, deduped knowledge via bin/vanta-resolve.js (the canonical query layer)
//   2. Pending Shadow Council verdicts (if a recent plan flagged this topic)
//   3. The standard council advisory if no prior context exists
//
// As of v3.3, the three separate parsers (decisions/invariants/gotchas) are gone —
// vanta-resolve owns ranking, expiry, and supersession in one place.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Load the canonical resolver. Try the deployed path first, fall back to repo.
let resolveKnowledge = null;
for (const p of [
  path.join(os.homedir(), '.claude', 'bin', 'vanta-resolve.js'),
  path.join(os.homedir(), 'Projects', 'vanta', 'bin', 'vanta-resolve.js'),
]) {
  try { ({ resolve: resolveKnowledge } = require(p)); break; } catch { /* keep looking */ }
}

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

// Topics ordered MOST SPECIFIC → LEAST SPECIFIC. The resolver matches each one
// independently; specific topics surface tighter results, generic ones widen reach
// when nothing specific hits. 'session' is intentionally NOT in the broad auth
// trigger — it pulls in unrelated Stop-hook invariants. Sessions get their own row.
const COUNCIL_TRIGGERS = [
  { re: /\/(auth|authn|authz|authentication|authorization|oauth|jwt|token|credential|password)([\/.]|$)/i, reason: 'auth/credential code', topics: ['jwt', 'oauth', 'token', 'credential', 'password', 'auth'] },
  { re: /\/sessions?([\/.]|$)/i, reason: 'auth/session code', topics: ['session', 'cookie', 'auth'] },
  { re: /\/(payment|billing|stripe|subscription|checkout)/i, reason: 'payment/billing code', topics: ['stripe', 'subscription', 'payment', 'billing', 'webhook'] },
  { re: /\/(admin|privilege|rbac|role)\//i, reason: 'access-control code', topics: ['rbac', 'permission', 'role', 'admin'] },
  { re: /\/migrations?\//i, reason: 'database migration', topics: ['prisma', 'migration', 'schema'] },
  { re: /schema\.prisma$/i, reason: 'database schema', topics: ['prisma', 'schema', 'migration'] },
  { re: /\/(middleware|security|cors|helmet)\//i, reason: 'security middleware', topics: ['csp', 'cors', 'helmet', 'security'] },
  { re: /\/(infrastructure|terraform|k8s|kubernetes)\//i, reason: 'infrastructure code', topics: ['terraform', 'kubernetes', 'k8s', 'infra'] },
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

// Read pending Shadow Council reviews for this project. plan-watcher.js writes
// these flags when a sensitive plan file gets edited but hasn't been council-reviewed.
function readPendingShadowReviews(slug, topics) {
  if (!slug) return [];
  const file = path.join(os.homedir(), '.gstack', 'projects', slug, '.shadow_pending.md');
  let content; try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const re = new RegExp(`\\b(${topics.join('|')})s?\\b`, 'i');
  const out = [];
  for (const block of content.split(/\n## /).slice(1)) {
    if (re.test(block)) {
      const firstLine = block.split('\n')[0];
      out.push(firstLine.trim());
      if (out.length >= 2) break;
    }
  }
  return out;
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

    // Query the canonical knowledge resolver across all topics for this trigger.
    // Earlier topics in the list are more specific — boost their scores so they
    // dominate over results that only hit a generic later topic.
    const aggregated = [];
    if (resolveKnowledge) {
      const seen = new Set();
      for (let ti = 0; ti < trigger.topics.length; ti++) {
        const topic = trigger.topics[ti];
        const specificity = 1 + (trigger.topics.length - ti) * 0.3;  // 1st topic ~3x the boost vs last
        const out = resolveKnowledge({ topic, project: slug, cwd, max: 3, log: true });
        for (const r of (out.results || [])) {
          const key = r.path + '|' + (r.excerpt || '').slice(0, 80);
          if (seen.has(key)) continue;
          seen.add(key);
          r.score = (r.score || 0) * specificity;
          r.matched_topic = topic;
          aggregated.push(r);
        }
      }
      aggregated.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    // Cap at 4 total — beyond that the pack stops being focused.
    const buckets = { decision: [], invariant: [], gotcha: [], episode: [], memory: [] };
    for (const r of aggregated.slice(0, 4)) (buckets[r.source] || []).push(r);

    const sections = [];
    if (buckets.decision.length) {
      sections.push('📌 PRIOR DECISIONS:\n' + buckets.decision.map(d => {
        const conf = d.confidence && d.confidence !== 'unknown' ? ` [${d.confidence}]` : '';
        return `- ${d.section || d.date || ''}${conf} — ${d.excerpt}`;
      }).join('\n'));
    }
    if (buckets.invariant.length) {
      sections.push('⚠️  INVARIANTS:\n' + buckets.invariant.map(i => i.excerpt.replace(/^\s*-\s/, '- ')).join('\n'));
    }
    if (buckets.gotcha.length) {
      sections.push('🔒 PROJECT GOTCHAS:\n' + buckets.gotcha.map(g => g.excerpt.replace(/^\s*-\s/, '- ')).join('\n'));
    }
    if (buckets.episode.length) {
      sections.push('🧠 RECENT EPISODES:\n' + buckets.episode.map(e =>
        `- ${e.date || ''} (${e.outcome || '?'}): ${e.excerpt}`).join('\n'));
    }

    // Shadow Council pending reviews for this topic
    const pendingShadow = readPendingShadowReviews(slug, trigger.topics);
    if (pendingShadow.length) {
      sections.push('🌑 PENDING SHADOW REVIEW (plan flagged but not council-reviewed):\n' +
        pendingShadow.map(p => `- ${p}`).join('\n') +
        '\n  → Run /council before implementing.');
    }

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
  } catch (err) {
    vlog().error('council-advisory', err && err.message || String(err));
    process.exit(0);
  }
});
