#!/usr/bin/env node
// vanta-failure-extract — pure parser for tool-call failures.
//
// v3.10 commit 4. Per the v3.10 PLAN.md C-2 council fix:
//
//   "Reflexion-as-context with hardened structured-fields-only schema.
//    NO freeform 'context' or 'details' string. Allowlist of structured
//    fields ONLY: kind, tool_name, file, line, test_name, exit_status,
//    count, signal. Anything else is a prompt-injection vector."
//
// Why a pure parser: the Stop hook reads transcripts that contain
// arbitrary tool output. If we naively pass that text into the brief,
// every test failure is a potential prompt injection. The defense is
// not sanitization — it's NEVER passing the raw text. Only structured
// fields extracted via REGEX from known-shape patterns reach the brief.
// If the parser doesn't recognize the shape, we return null (better to
// lose the signal than leak attacker text).
//
// Surface Impact Discipline: INTERNAL MACHINERY. No new commands.
// Pure function — no filesystem, no env, no requires beyond `path`.

'use strict';
const path = require('path');

// ─── Allowlist of structured fields ──────────────────────────────────
//
// Any caller that constructs a Failure object MUST only set keys in
// this list. Tests verify the schema. Adding a field here is a
// security review trigger — never add a freeform message field.
const ALLOWED_FIELDS = Object.freeze([
  'ts',
  'project',
  'session_id',
  'kind',
  'tool_name',
  'file',
  'line',
  'test_name',
  'exit_status',
  'count',
  'signal',
]);

const VALID_KINDS = Object.freeze([
  'test_failure',
  'type_failure',
  'lint_failure',
  'build_failure',
]);

// ─── Field validation/sanitization helpers ───────────────────────────

// Truncate + strip control characters. Used for ANY string field that
// originates outside our process. Even though the parser is regex-only,
// the captured group may contain user-supplied bytes (e.g. test name).
function _safeString(s, maxLen) {
  if (typeof s !== 'string') return null;
  // Strip ASCII control chars (0-31, 127) except \t. They can carry
  // ANSI escape sequences and break terminal rendering when later
  // surfaced in a brief; they're never useful in a structured field.
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '').trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLen);
}

// File path → basename only. Defense in depth: full paths leak the
// home directory layout in shared briefs. Basename is the actionable
// signal ("which file", not "where on disk").
function _safeFileBasename(s, maxLen = 64) {
  if (typeof s !== 'string') return null;
  const norm = s.trim();
  if (!norm) return null;
  return path.basename(norm).slice(0, maxLen);
}

function _safeInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── Pattern matchers ────────────────────────────────────────────────
//
// Each matcher takes (command, text) and returns a partial Failure
// (without ts/project/session_id/count/signal — those are filled by
// the writer). Matchers are mutually exclusive: first match wins.
// Order matters — most specific first.

// v3.10 final-council Codex P3 + Gemini P3: broaden to cover real
// invocations seen in the wild (pnpm/yarn/bare/jest, vitest run, npm
// run typecheck, etc.). Mirror hooks/test-failure-advisor.js coverage.
const TEST_COMMAND_RX = /(?:^|\s)(node\s+--test|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test|npx\s+vitest|vitest(?:\s+run)?|npx\s+jest|jest|bun\s+test|pytest)\b/;
const TYPE_COMMAND_RX = /(?:^|\s)(npx\s+tsc|tsc\b|--noEmit\b|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+typecheck)\b/;
const LINT_COMMAND_RX = /(?:^|\s)(eslint|npx\s+eslint|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+lint)\b/;
const BUILD_COMMAND_RX = /(?:^|\s)((?:npm|pnpm|yarn|bun)(?:\s+run)?\s+build|next\s+build|vite\s+build|webpack|bun\s+build|tsc\s+--build|cargo\s+build|go\s+build)\b/;

// node --test / vitest output:
//   ✖ test name (123ms)
//   ✗ test name
//   FAIL test/file.test.js
function _matchTestFailure(command, text) {
  if (!TEST_COMMAND_RX.test(command || '')) return null;
  // First failing test name from common patterns. We only capture the
  // test NAME — never the surrounding output.
  const failureRx = /(?:^|\n)\s*(?:✖|✗|×|FAIL|✘)\s+([^\n(]{1,80})/m;
  const m = text.match(failureRx);
  return {
    kind: 'test_failure',
    tool_name: 'test-runner',
    test_name: m ? _safeString(m[1], 80) : null,
    file: null,
    line: null,
  };
}

// tsc output:
//   src/api.ts(42,7): error TS2322: Type 'X' is not assignable...
function _matchTypeFailure(command, text) {
  if (!TYPE_COMMAND_RX.test(command || '')) return null;
  const tsErr = text.match(/^([^(\s]{1,200})\((\d+),\d+\):\s*error\s+TS\d+:/m);
  return {
    kind: 'type_failure',
    tool_name: 'tsc',
    file: tsErr ? _safeFileBasename(tsErr[1]) : null,
    line: tsErr ? _safeInt(tsErr[2]) : null,
    test_name: null,
  };
}

// eslint output:
//   /path/to/file.ts
//     42:7  error  Unexpected console statement  no-console
function _matchLintFailure(command, text) {
  if (!LINT_COMMAND_RX.test(command || '')) return null;
  // Capture the file from the LAST file header before the first error.
  const fileMatches = [...text.matchAll(/^(\/[^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs))\s*$/gm)];
  const errMatch = text.match(/(\d+):\d+\s+error\s+/);
  let file = null, line = null;
  if (errMatch) {
    line = _safeInt(errMatch[1]);
    if (fileMatches.length > 0) {
      file = _safeFileBasename(fileMatches[fileMatches.length - 1][1]);
    }
  }
  return {
    kind: 'lint_failure',
    tool_name: 'eslint',
    file,
    line,
    test_name: null,
  };
}

// build output: many shapes. We only capture the kind + tool_name.
// Building is exit-code driven; the diagnostic file/line, if any,
// belongs to a downstream type/lint failure that should match those
// matchers if the user re-runs them in isolation.
function _matchBuildFailure(command, text) {
  if (!BUILD_COMMAND_RX.test(command || '')) return null;
  const toolMatch = command.match(BUILD_COMMAND_RX);
  return {
    kind: 'build_failure',
    tool_name: toolMatch ? _safeString(toolMatch[1].trim(), 32) : 'build',
    file: null,
    line: null,
    test_name: null,
  };
}

// ─── Public extractor ────────────────────────────────────────────────
//
// Returns a partial Failure (no ts/project/session_id/count/signal) or
// null if the call wasn't a recognizable failure. Adding ts/project/
// session_id/signal is the writer's job (auto-sync.js).
//
// Inputs:
//   tool_name: 'Bash' | 'Read' | etc — only Bash currently extracts
//   command:   the bash command string (can be partial)
//   exit_code: number; non-zero or null means non-zero (best-effort)
//   stderr, stdout: strings, may be empty
function extractFailure(input) {
  if (input == null || typeof input !== 'object') return null;
  const { tool_name, command, exit_code, stderr, stdout } = input;
  if (tool_name !== 'Bash') return null;
  // exit_code 0 or undefined+empty stderr = success-ish
  if (exit_code === 0) return null;
  const cmd = typeof command === 'string' ? command : '';
  const text = (typeof stderr === 'string' ? stderr : '')
    + '\n'
    + (typeof stdout === 'string' ? stdout : '');
  if (!text.trim()) return null;
  // Most specific first
  const matchers = [
    _matchTypeFailure,
    _matchLintFailure,
    _matchTestFailure,  // last among precise — test patterns are loose
    _matchBuildFailure,
  ];
  for (const m of matchers) {
    const r = m(cmd, text);
    if (r) {
      r.exit_status = _safeInt(exit_code);
      // Strip any keys not in ALLOWED_FIELDS (defensive — should be no-op)
      for (const k of Object.keys(r)) {
        if (!ALLOWED_FIELDS.includes(k)) delete r[k];
      }
      return r;
    }
  }
  return null;
}

// ─── Validate a Failure record before write ──────────────────────────
//
// The writer (auto-sync.js) calls this immediately before appendJsonl.
// Throws if any field is outside the allowlist. This is the C-2 hard
// gate — anything not on the schema doesn't reach disk.
function validateFailure(f) {
  if (!f || typeof f !== 'object') {
    throw new Error('failure: must be object');
  }
  for (const k of Object.keys(f)) {
    if (!ALLOWED_FIELDS.includes(k)) {
      throw new Error(`failure: forbidden field '${k}' (not in ALLOWED_FIELDS)`);
    }
  }
  if (!VALID_KINDS.includes(f.kind)) {
    throw new Error(`failure: kind must be one of ${VALID_KINDS.join('|')}, got '${f.kind}'`);
  }
  // Type checks per field
  for (const [k, v] of Object.entries(f)) {
    if (v == null) continue;
    if (k === 'line' || k === 'count' || k === 'exit_status') {
      if (!Number.isFinite(v) || v < 0) throw new Error(`failure: ${k} must be non-negative number`);
    } else if (k === 'ts' || k === 'project' || k === 'session_id' || k === 'kind' || k === 'tool_name' || k === 'file' || k === 'test_name' || k === 'signal') {
      if (typeof v !== 'string') throw new Error(`failure: ${k} must be string`);
    }
  }
  // v3.10 final-council R2 (Codex P1 + Gemini P3): re-sanitize string
  // content on read, not just type-check. A forged file written
  // directly to recent-failures.jsonl can have ANSI escape sequences,
  // control characters, or path-leak content in test_name/file even if
  // it passes type validation. Mutate IN PLACE so callers receive the
  // sanitized object.
  if (typeof f.test_name === 'string') {
    const cleaned = _safeString(f.test_name, 80);
    f.test_name = cleaned;  // null if all-control-chars, else stripped
  }
  if (typeof f.file === 'string') {
    f.file = _safeFileBasename(f.file, 64);
  }
  if (typeof f.tool_name === 'string') {
    f.tool_name = _safeString(f.tool_name, 32);
  }
  if (typeof f.project === 'string') {
    f.project = _safeString(f.project, 64);
  }
  if (typeof f.session_id === 'string') {
    f.session_id = _safeString(f.session_id, 64);
  }
  return f;
}

module.exports = {
  extractFailure,
  validateFailure,
  ALLOWED_FIELDS,
  VALID_KINDS,
  // Exposed for tests
  _safeString,
  _safeFileBasename,
  _safeInt,
};

// CLI for ad-hoc parsing: echo a JSON object on stdin, get extracted
// failure on stdout (or null). For debugging only.
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(input);
      const out = extractFailure(parsed);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
  });
}
