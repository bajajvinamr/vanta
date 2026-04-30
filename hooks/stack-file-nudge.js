#!/usr/bin/env node
// PostToolUse on Write|Edit — detect modifications to stack/config files,
// inject a targeted follow-up reminder so nothing silently breaks after
// a config change.

// Map filename (or path suffix) → advisory message.
// null = skip silently (lockfiles, auto-generated).
const STACK_ADVISORIES = {
  'package.json':         'package.json changed. If new packages were added, use Context7 (mcp__context7__query-docs) to fetch current API docs before implementing. Run `npm install` if dependencies were added/removed.',
  'package-lock.json':    null,
  'yarn.lock':            null,
  'pnpm-lock.yaml':       null,
  'bun.lockb':            null,
  'Cargo.toml':           'Cargo.toml changed. Run `cargo build` to verify deps resolve. For new crates, check docs.rs before using their APIs.',
  'Cargo.lock':           null,
  'go.mod':               'go.mod changed. Run `go mod tidy && go build ./...` to verify. Check pkg.go.dev for new package APIs.',
  'go.sum':               null,
  'pyproject.toml':       'pyproject.toml changed. Run `pip install -e .` or `uv sync`. Use Context7 for new package docs.',
  'requirements.txt':     'requirements.txt changed. Run `pip install -r requirements.txt`. Verify new package APIs on PyPI.',
  'tsconfig.json':        'tsconfig.json changed. Run `npx tsc --noEmit` immediately — compiler option changes can expose hidden type errors.',
  'tsconfig.base.json':   'tsconfig.base.json changed. Run `npx tsc --noEmit` across all packages that extend it.',
  'jsconfig.json':        'jsconfig.json changed. Verify IDE resolution still works and run any type-check script.',
  'next.config.js':       'next.config.js changed. Test `npm run build` — misconfig here fails silently until prod. Check for new CSP `connect-src` entries if new external origins were added.',
  'next.config.ts':       'next.config.ts changed. Test `npm run build`. Check CSP headers if new origins were added.',
  'next.config.mjs':      'next.config.mjs changed. Test `npm run build`. Check CSP headers if new origins were added.',
  'vite.config.ts':       'vite.config.ts changed. Run `npm run build` to catch config errors before dev diverges from prod.',
  'vite.config.js':       'vite.config.js changed. Run `npm run build` to catch config errors.',
  'tailwind.config.js':   'tailwind.config.js changed. Verify purge paths are correct — wrong paths silently strip classes in prod.',
  'tailwind.config.ts':   'tailwind.config.ts changed. Verify content paths are correct.',
  'schema.prisma':        'Prisma schema changed. Run `npx prisma generate` to update the client, then `npx prisma migrate dev` for a new migration. Never skip generate after schema edits.',
  'drizzle.config.ts':    'drizzle.config.ts changed. Run `npx drizzle-kit generate` to sync schema artifacts.',
  'drizzle.config.js':    'drizzle.config.js changed. Run `npx drizzle-kit generate`.',
  'wrangler.toml':        'wrangler.toml changed. Test with `wrangler dev` locally. Env var changes must also be set in the CF dashboard — `wrangler.toml` does not push secrets.',
  'wrangler.jsonc':       'wrangler.jsonc changed. Test with `wrangler dev`. Secrets must still be set separately.',
  'supabase/config.toml': 'Supabase config changed. Restart local dev: `supabase stop && supabase start`. Verify edge function env vars are still set.',
  '.env.example':         '.env.example changed. Ensure all new keys are documented and added to any CI secret store or deployment checklist.',
  'vercel.json':          'vercel.json changed. Check headers/rewrites/redirects syntax. Verify CSP connect-src if new API origins were added.',
  '_headers':             '_headers changed (Cloudflare Pages). Verify CSP connect-src is updated if new external origins are in use.',
  'fly.toml':             'fly.toml changed. Run `fly deploy --dry-run` or verify with `fly config validate`.',
  'railway.toml':         'railway.toml changed. Verify env vars are in sync with the Railway dashboard.',
  'docker-compose.yml':   'docker-compose.yml changed. Run `docker-compose config` to validate, then `docker-compose up --build`.',
  'Dockerfile':           'Dockerfile changed. Run `docker build .` locally to catch layer errors before CI.',
};

function extractFilePath(data) {
  return String(data.tool_input?.file_path || data.tool_input?.path || '');
}

// Cleanup #11: lazy logger.
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

    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1] || '';

    let advisory = undefined;

    // Direct filename match
    if (Object.prototype.hasOwnProperty.call(STACK_ADVISORIES, fileName)) {
      advisory = STACK_ADVISORIES[fileName];
    }

    // Path-suffix match (e.g. prisma/schema.prisma, supabase/config.toml)
    if (advisory === undefined) {
      for (const [pattern, msg] of Object.entries(STACK_ADVISORIES)) {
        if (filePath.endsWith('/' + pattern) || filePath === pattern) {
          advisory = msg;
          break;
        }
      }
    }

    // null = explicitly skip
    if (advisory === null || advisory === undefined) {
      process.exit(0);
    }

    const result = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `STACK FILE MODIFIED: ${advisory}`,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    vlog().error('stack-file-nudge', err && err.message || String(err));
    process.exit(0);
  }
});
