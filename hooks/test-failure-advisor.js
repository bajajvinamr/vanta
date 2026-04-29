#!/usr/bin/env node
// PostToolUse on Bash — detect test/build failures, inject blocker advisory.
// Makes Claude treat failing tests as a hard stop, not a soft signal.

const TEST_CMD = /\b(npm\s+test|npm\s+run\s+test|npx\s+vitest|vitest\s+run|npx\s+jest|jest\b|pytest|py\.test|go\s+test|cargo\s+test|yarn\s+test|bun\s+test|bun\s+run\s+test|pnpm\s+test)\b/;
const BUILD_CMD = /\b(npm\s+run\s+build|npx\s+tsc|tsc\s+--noEmit|cargo\s+build|go\s+build|npm\s+run\s+typecheck|tsc\b)\b/;

// Failure signals: exit codes, test runner output, compiler errors
const FAILURE_PATTERNS = [
  /\bFAILED\b/,
  /\bfailed\b/,
  /\d+\s+failed/,
  /Tests?\s+failed/i,
  /✕\s+\d+|✗\s+\d+/,
  /×\s+\d+\s+failed/,
  /error\[E\d+\]/,            // Rust compiler errors
  /^error TS\d+:/m,           // TypeScript errors
  /\berror:\s+/,              // general build error
  /npm\s+ERR!/,
  /Process exited with code [1-9]/i,
];

// Confidence reducers — presence of these alongside failures = possible false positive
const PASS_PATTERNS = [
  /\d+\s+passed/,
  /All\s+tests?\s+passed/i,
  /Tests?:\s+\d+\s+passed/i,
  /✓\s+\d+|✔\s+\d+/,
  /pass(?:ed|ing)/i,
];

function extractContent(resp) {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';
  const c = resp.content;
  if (Array.isArray(c)) return c.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
  if (c != null) return String(c);
  // Some runtimes put the text directly in resp.output or resp.text
  return String(resp.output || resp.text || '');
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const command = String(data.tool_input?.command || '');
    const isTest = TEST_CMD.test(command);
    const isBuild = BUILD_CMD.test(command);

    if (!isTest && !isBuild) {
      process.exit(0);
    }

    const output = extractContent(data.tool_response);
    if (!output || output.length < 10) {
      process.exit(0);
    }

    const failCount = FAILURE_PATTERNS.filter(p => p.test(output)).length;
    const passCount = PASS_PATTERNS.filter(p => p.test(output)).length;

    // Require at least one failure signal and that it's not drowned by pass signals
    if (failCount === 0 || passCount > failCount * 2) {
      process.exit(0);
    }

    const type = isTest ? 'tests' : 'build';
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `BLOCKER — ${type.toUpperCase()} FAILING: The ${type} command just produced errors. ` +
          `Do NOT continue with new work, new features, or unrelated tasks. ` +
          `Treat this as a hard stop: diagnose the root cause from the output above, ` +
          `fix it, re-run ${type}, and confirm green before proceeding. ` +
          `Broken ${type} means every subsequent change ships without a safety net.`,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch (_) {
    process.exit(0);
  }
});
