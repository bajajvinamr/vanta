#!/usr/bin/env node
// PreToolUse:Bash — git + destructive-command guardrails.
//
// Two tiers:
//   HARD BLOCK   — exits 1, prevents the tool call. Reserved for guardrails
//                  the user marked non-negotiable in CLAUDE.md (force-push
//                  to main/master, --no-verify, --no-gpg-sign, rm -rf /,
//                  destructive SQL).
//   ADVISORY     — exits 0 with stderr warning. Surfaces destructive intent
//                  but doesn't block; user already requires confirmation in
//                  CLAUDE.md "Confirm before rm -rf, reset --hard, drop..."
//
// Why two tiers: the user's policy distinguishes "always block" from
// "block by confirmation". Hard-blocking everything destructive would
// fight legitimate workflows (force-push to a feature branch, git clean
// in a sandbox). Hard-blocking only what's marked non-negotiable matches
// the user's stated policy.
//
// Composition: this hook coexists with slopsquatting-guard.sh under the
// same PreToolUse:Bash matcher. Their regex tables don't overlap (this
// targets git/sql/rm; slopsquatting targets npm/pip install). Either
// returning non-zero blocks the tool call. We documented the empirical
// composition behavior as an invariant.
//
// Upstream provenance:
//   Inspired by mattpocock/skills/git-guardrails-claude-code (MIT)
//   https://github.com/mattpocock/skills/tree/main/git-guardrails-claude-code
//   Forked patterns; consolidated tiered approach is Vanta-original.

const path = require('path');

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

// ─── Tier 1: HARD BLOCK ─────────────────────────────────────────────────────
// These match the "Guardrails (non-negotiable)" section of ~/.claude/CLAUDE.md.
// Exit 1 = tool call is blocked. The user explicitly authorized only one
// escape path: removing this hook from settings.json (manual config change).
//
// R7 P3 — bounded quantifiers. The previous patterns used `[^\n]*` between
// adjacent capture groups. On adversarial inputs (a 1MB single-line
// command with no `main`/`master` token), the engine could backtrack
// O(n²) trying alternate splits. All `[^\n]*` are now capped at
// `{0,256}` — long enough for any realistic shell command, short enough
// that worst-case match time is bounded. Also removed the alternate-
// ordering rule: the unified pattern below covers both `git push -f main`
// and `git push main -f` shapes via the optional middle segment.
const HARD_BLOCK = [
  {
    re: /\bgit\s+push\s+(?:[^\n]{0,128}\s)?(?:-f\b|--force\b|--force-with-lease\b)[^\n]{0,256}\b(?:main|master|origin\s+main|origin\s+master)\b/,
    msg: 'force-push to main/master is non-negotiable per CLAUDE.md guardrails',
  },
  {
    re: /\bgit\s+push\s+(?:[^\n]{0,128}\s)?\b(?:main|master|origin\s+main|origin\s+master)\b[^\n]{0,128}(?:-f\b|--force\b|--force-with-lease\b)/,
    msg: 'force-push to main/master (target-first ordering) is blocked per CLAUDE.md',
  },
  {
    re: /\bgit\s+(?:commit|push|merge|rebase|cherry-pick)\s+[^\n]{0,256}--no-verify\b/,
    msg: '--no-verify bypasses pre-commit hooks — non-negotiable per CLAUDE.md',
  },
  {
    re: /\bgit\s+(?:commit|push|merge)\s+[^\n]{0,256}--no-gpg-sign\b/,
    msg: '--no-gpg-sign bypasses signing — never use unless explicitly authorized',
  },
  {
    re: /-c\s+commit\.gpgsign\s*=\s*false/i,
    msg: 'bypassing GPG signing via -c flag — not authorized',
  },
  {
    re: /\brm\s+(?:-rf?|-fr|-Rf|--recursive\s+--force)\s+\/(?:[^/.\s]|$)/,
    msg: 'rm -rf with absolute path under / — destructive, requires user confirmation',
  },
  {
    re: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    msg: 'destructive SQL (DROP/TRUNCATE) — confirm with user before running',
  },
];

// ─── Tier 2: ADVISORY ──────────────────────────────────────────────────────
// These echo a stderr warning but don't block. The user's CLAUDE.md says
// "Confirm before rm -rf, reset --hard, drop, destructive SQL, any one-way
// door" — confirmation, not block. Surface intent so the user notices.
const ADVISORY = [
  {
    re: /\bgit\s+push\s+(?:-f|--force(?!-with-lease)|--force-with-lease)\b/,
    msg: 'force-push detected — confirm branch is not shared with others',
  },
  {
    re: /\bgit\s+reset\s+(?:--hard|--keep)\b/,
    msg: 'git reset --hard/--keep discards uncommitted work — confirm intent',
  },
  {
    re: /\bgit\s+(?:checkout|restore)\s+\.(?:\s|$)/,
    msg: 'git checkout/restore . discards all uncommitted changes',
  },
  {
    re: /\bgit\s+clean\s+[^\n]{0,128}-[fF]/,
    msg: 'git clean -f deletes untracked files (potential lost work)',
  },
  {
    re: /\bgit\s+branch\s+-D\b/,
    msg: 'git branch -D force-deletes — verify branch is merged or pushed',
  },
  {
    re: /\bgit\s+(?:rebase|add)\s+-i\b/,
    msg: 'interactive flag — not supported in non-interactive tool calls',
  },
  {
    re: /\brm\s+(?:-rf?|-fr|-Rf)\s+(?!\s|\/)/,
    msg: 'rm -rf with non-absolute path — confirm scope before running',
  },
];

function checkCommand(command) {
  if (!command || typeof command !== 'string') return { action: 'allow' };
  for (const rule of HARD_BLOCK) {
    if (rule.re.test(command)) {
      return { action: 'block', message: rule.msg };
    }
  }
  const advisories = [];
  for (const rule of ADVISORY) {
    if (rule.re.test(command)) advisories.push(rule.msg);
  }
  return advisories.length
    ? { action: 'advise', message: advisories.join('; ') }
    : { action: 'allow' };
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input || '{}');
    const command = String(data.tool_input?.command || '');
    const verdict = checkCommand(command);

    if (verdict.action === 'block') {
      vlog().warn('git-guardrails', `BLOCKED: ${command.slice(0, 200)} — ${verdict.message}`);
      // stderr appears to user; non-zero exit blocks the tool call.
      process.stderr.write(`🚫 git-guardrails BLOCKED: ${verdict.message}\n  command: ${command.slice(0, 200)}\n  to override: edit ~/.claude/settings.json to remove this hook\n`);
      process.exit(1);
    }

    if (verdict.action === 'advise') {
      vlog().info('git-guardrails', `ADVISORY: ${command.slice(0, 200)} — ${verdict.message}`);
      // Surface the warning via additionalContext (council-advisory.js pattern).
      const result = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `⚠️ DESTRUCTIVE COMMAND ADVISORY: ${verdict.message}. The user requires confirmation before destructive operations per CLAUDE.md — pause and confirm intent before running.`,
        },
      };
      process.stdout.write(JSON.stringify(result));
    }
    // verdict.action === 'allow' → silent pass-through, exit 0
  } catch (err) {
    vlog().error('git-guardrails', err && err.message || String(err));
  }
  process.exit(0);
});

// Module export for testing.
module.exports = { checkCommand, HARD_BLOCK, ADVISORY };
