#!/usr/bin/env node
// PostToolUse hook — incremental code-knowledge refresh.
//
// Fires after Write/Edit on a source file or CLAUDE.md. Reindexes that single
// file so vanta-resolve queries reflect the user's latest edits without a
// full crawl. Full crawl runs are reserved for explicit `vanta-index-code --full`.
//
// Why per-file and not per-session: a session may touch hundreds of files
// across stacks; reindexing all of them on every PostToolUse would multiply
// cost. Per-file keeps the hook <50ms typical.
//
// Failure mode: hooks must never block. Any error → exit 0 silently.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Cleanup #11: log unexpected errors so silently-broken hooks become visible.
// Logger lives at ~/.claude/bin/vanta-log.js (deployed by setup.sh) or repo
// fallback. Loading is best-effort — if it fails, we still don't block.
let _vlog;
function vlog() {
  if (_vlog) return _vlog;
  for (const p of [
    path.join(process.env.HOME || '', '.claude', 'bin', 'vanta-log.js'),
    path.join(process.env.HOME || '', 'Projects', 'vanta', 'bin', 'vanta-log.js'),
  ]) {
    try { _vlog = require(p); return _vlog; } catch {}
  }
  _vlog = { info: () => {}, warn: () => {}, error: () => {} };
  return _vlog;
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go']);

function exitOk() { process.stdout.write('{}'); process.exit(0); }

function findIndexer() {
  // Prefer deployed bin, fall back to repo location.
  const deployed = path.join(process.env.HOME || '', '.claude', 'bin', 'vanta-index-code.js');
  const repo = path.join(process.env.HOME || '', 'Projects', 'vanta', 'bin', 'vanta-index-code.js');
  if (fs.existsSync(deployed)) return deployed;
  if (fs.existsSync(repo)) return repo;
  return null;
}

function findProjectRoot(filePath) {
  // Walk up from filePath looking for package.json, pyproject.toml, or .git
  let dir = path.dirname(filePath);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) ||
        fs.existsSync(path.join(dir, 'pyproject.toml')) ||
        fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    if (!raw) return exitOk();
    input = JSON.parse(raw);
  } catch { return exitOk(); }

  const tool = input.tool_name;
  if (tool !== 'Write' && tool !== 'Edit' && tool !== 'NotebookEdit') return exitOk();

  const filePath = input.tool_input?.file_path;
  if (!filePath) return exitOk();

  const ext = path.extname(filePath);
  const basename = path.basename(filePath);
  // Index source files OR CLAUDE.md (which holds project-internal gotchas).
  if (!SOURCE_EXTS.has(ext) && basename !== 'CLAUDE.md') return exitOk();

  // Skip files in node_modules, .git, etc. — defensive even though they shouldn't
  // appear in tool_input (user wouldn't normally edit them).
  if (/[/\\](node_modules|\.git|dist|build|\.next|coverage)[/\\]/.test(filePath)) return exitOk();

  const indexer = findIndexer();
  if (!indexer) return exitOk();

  const projectRoot = findProjectRoot(filePath);
  if (!projectRoot) return exitOk();

  // Codex council R7 P1 fix — shell injection.
  // The earlier execSync interpolated `filePath` and `projectRoot` into
  // a shell command, so a path containing `"` or `$()` was code execution
  // inside this hook. Now: execFileSync passes argv directly with
  // shell:false. No shell parser ever sees user-controlled data.
  // Run indexer in --quiet --file mode — single-file reindex, no console noise.
  // Timeout aggressively (1s) so a stuck indexer can't slow the user.
  try {
    execFileSync(process.execPath,
      [indexer, '--cwd', projectRoot, '--file', filePath, '--quiet'],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 1000, shell: false },
    );
  } catch (err) {
    // Cleanup #11: log so broken indexer doesn't rot invisibly.
    vlog().error('code-index-watch', `indexer failed for ${filePath}: ${err.message}`);
  }

  exitOk();
}

main().catch(err => {
  vlog().error('code-index-watch', `unhandled: ${err && err.message || err}`);
  exitOk();
});
