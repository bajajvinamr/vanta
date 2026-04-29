#!/usr/bin/env node
// PreToolUse on Write|Edit — gate feature code writes on planning phase.
// Walks up from the target file looking for .planning/ with content.
// Advisory (not a block) — informs but does not prevent.

const path = require('path');
const fs = require('fs');

// Directories that indicate feature code (not config, docs, or tests)
const FEATURE_CODE_RE = /\/(src|app|pages|components|lib|utils|services|api|routes|controllers|models|features|modules)\//;

// Directories to always skip — no advisory needed
const SKIP_RE = /\/(\.git|node_modules|\.next|dist|build|__tests__|test|tests|spec|specs|\.planning|docs|hooks|scripts)\//;

function isFeatureCode(filePath) {
  const normalized = '/' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (SKIP_RE.test(normalized)) return false;
  return FEATURE_CODE_RE.test(normalized);
}

function findPlanningDir(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;

  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.planning');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch (_) {}

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return null;
}

function hasPlanningContent(planningDir) {
  try {
    const files = fs.readdirSync(planningDir);
    return files.some(f => /\.(md|json|txt|yaml|yml)$/.test(f));
  } catch (_) {
    return false;
  }
}

function extractFilePath(data) {
  return String(data.tool_input?.file_path || data.tool_input?.path || '');
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

    if (!isFeatureCode(filePath)) process.exit(0);

    const planningDir = findPlanningDir(filePath);
    if (planningDir && hasPlanningContent(planningDir)) process.exit(0);

    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `PHASE GATE: Writing feature code to ${path.basename(filePath)} without a .planning/ directory. ` +
          `If this is a new feature, run /vanta first to create planning context. ` +
          `Safe to proceed for: bug fixes, small edits, maintenance work, or if a plan already exists in this conversation.`,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch (_) {
    process.exit(0);
  }
});
