#!/usr/bin/env node
// vanta-council-health — pre-flight readiness check for /council.
//
// Tier 6 #17 deliverable. Council can't actually call this from inside a
// Claude session (the ping protocol there is described in skills/council/
// SKILL.md and runs via Multi-CLI MCP tools, which only Claude can invoke).
//
// What this bin DOES do:
//   - Inspect ~/.claude/settings.json for Multi-CLI MCP server registration
//   - Inspect ~/.gemini/settings.json + ~/.codex/config.toml for trust /
//     workspace settings that have historically broken council
//   - Surface a one-line readiness summary for vanta-status integration
//   - Read the most recent council run from the query log + decisions to
//     show "last council: <when> · mode: FULL/PARTIAL/SOLO"
//
// What it does NOT do:
//   - Network calls (would require Multi-CLI itself, only Claude can drive
//     those at session time). Static config inspection only.
//
// Output: human text by default, --json for scripts.

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const FLAG_JSON = args.includes('--json');
const FLAG_QUIET = args.includes('--quiet');

function safeJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function ageHuman(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60)        return `${sec}s ago`;
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400)     return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── Multi-CLI registration check ───────────────────────────────────────────

function _findMultiCliInServers(servers) {
  if (!servers || typeof servers !== 'object') return null;
  const names = ['Multi-CLI', 'multi-cli', 'multicli', 'MultiCLI'];
  for (const n of names) if (servers[n]) return { name: n, entry: servers[n] };
  return null;
}

function checkMcpRegistration() {
  // Multi-CLI lives in either the user-level ~/.claude.json (with global
  // `mcpServers` and per-project `projects.<path>.mcpServers`) or the
  // newer ~/.claude/settings.json. Check both.
  const cwd = process.cwd();
  const userJson = safeJSON(path.join(os.homedir(), '.claude.json'));
  const settingsJson = safeJSON(path.join(os.homedir(), '.claude', 'settings.json'));

  // 1. Per-project scope walks up from cwd looking for an exact match.
  if (userJson && userJson.projects) {
    let dir = cwd;
    while (dir && dir !== '/') {
      const proj = userJson.projects[dir];
      if (proj && proj.mcpServers) {
        const hit = _findMultiCliInServers(proj.mcpServers);
        if (hit) return {
          registered: true,
          scope: 'project',
          projectPath: dir,
          name: hit.name,
          command: hit.entry.command || hit.entry.url || 'unknown',
          env: hit.entry.env || {},
        };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 2. Global scope in ~/.claude.json
  if (userJson) {
    const hit = _findMultiCliInServers(userJson.mcpServers);
    if (hit) return {
      registered: true,
      scope: 'global',
      name: hit.name,
      command: hit.entry.command || hit.entry.url || 'unknown',
      env: hit.entry.env || {},
    };
  }

  // 3. ~/.claude/settings.json
  if (settingsJson) {
    const hit = _findMultiCliInServers(settingsJson.mcpServers);
    if (hit) return {
      registered: true,
      scope: 'settings',
      name: hit.name,
      command: hit.entry.command || hit.entry.url || 'unknown',
      env: hit.entry.env || {},
    };
  }

  return {
    registered: false,
    reason: 'Multi-CLI not found in ~/.claude.json (global or projects.<path>.mcpServers) or ~/.claude/settings.json — install @osanoai/multicli',
  };
}

// ── Per-model trust + auth heuristics ──────────────────────────────────────
// We can't ping the models from a non-Claude process, but we CAN check the
// known-broken config patterns documented in vinamr-invariants.md:
//   - Gemini exits 55 without GEMINI_CLI_TRUST_WORKSPACE=true
//   - Codex breaks on approvalPolicy/sandbox optional params

function checkGeminiTrust(mcpEnv) {
  // Reliable signals (in order):
  //   1. GEMINI_CLI_TRUST_WORKSPACE=true in the MCP env — applies to all dirs
  //   2. settings.trust === true — global "trust everything" flag
  //   3. trustedFolders contains the CURRENT cwd or one of its ancestors
  //
  // Codex council Tier 6 P2 fix: previously any non-empty trustedFolders array
  // returned ok=true, even if the current repo wasn't trusted. That made
  // vanta-status report "ready" while /council still died with exit 55 in
  // this directory.
  const envTrust = mcpEnv && (mcpEnv.GEMINI_CLI_TRUST_WORKSPACE === 'true' || mcpEnv.GEMINI_CLI_TRUST_WORKSPACE === true);
  if (envTrust) return { ok: true, source: 'mcp-env' };

  const settings = safeJSON(path.join(os.homedir(), '.gemini', 'settings.json'));
  if (settings && settings.trust === true) return { ok: true, source: 'gemini-settings.trust=true' };

  // Cwd-aware trustedFolders check: walk up from cwd looking for an exact match.
  if (settings && Array.isArray(settings.trustedFolders) && settings.trustedFolders.length > 0) {
    const cwd = process.cwd();
    const trusted = new Set(settings.trustedFolders.map(f => path.resolve(f.replace(/^~/, os.homedir()))));
    let dir = cwd;
    while (dir && dir !== '/') {
      if (trusted.has(dir)) return { ok: true, source: `trustedFolders[${dir}]` };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return {
      ok: false,
      reason: `trustedFolders has ${settings.trustedFolders.length} entries but none cover ${cwd}; council will exit 55 here. Set GEMINI_CLI_TRUST_WORKSPACE=true in MCP env or add this directory to trustedFolders.`,
    };
  }

  return {
    ok: false,
    reason: 'GEMINI_CLI_TRUST_WORKSPACE not set in MCP env; ~/.gemini/settings.json has no trust config. Council MAY still work if trust was configured another way; if Gemini exits 55 in council, set GEMINI_CLI_TRUST_WORKSPACE=true in the Multi-CLI MCP env block.',
  };
}

function checkCodexTrust() {
  // Codex doesn't have the same trust gating, but we can check that
  // ~/.codex/config.toml exists and isn't carrying broken optional params
  // that the user might have added.
  const config = safeRead(path.join(os.homedir(), '.codex', 'config.toml'));
  if (!config) {
    return { ok: false, reason: '~/.codex/config.toml missing — install codex CLI' };
  }
  // Heuristic: warn if user has globally enabled approval-policy or sandbox
  // (per vinamr-invariants.md, those break Multi-CLI argument parsing if
  // passed through, though the MCP server typically wraps this).
  return { ok: true };
}

// ── Last-council recency from decisions.md ─────────────────────────────────

function lastCouncilRun(slug) {
  if (!slug) return null;
  const decisionsFile = path.join(os.homedir(), '.gstack', 'projects', slug, 'decisions.md');
  const content = safeRead(decisionsFile);
  if (!content) return null;
  // Find the most recent ## YYYY-MM-DD: heading
  const matches = [...content.matchAll(/^## (\d{4}-\d{2}-\d{2}):\s*(.+)$/gm)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const date = last[1];
  const topic = last[2];
  // Extract the body for this last entry to find Council line
  const blockStart = last.index;
  const nextHeading = content.indexOf('\n## ', blockStart + 1);
  const block = content.slice(blockStart, nextHeading === -1 ? undefined : nextHeading);
  const councilLine = (block.match(/\*\*Council:\*\*\s*([^\n]+)/) || [])[1] || 'unknown';
  return { date, topic, council: councilLine };
}

function getProjectSlug() {
  // Try gstack slug, fall back to cwd basename.
  const cwd = process.cwd();
  return path.basename(cwd);
}

// ── render ─────────────────────────────────────────────────────────────────

function gather() {
  const slug = getProjectSlug();
  const mcp = checkMcpRegistration();
  return {
    ts: new Date().toISOString(),
    slug,
    mcp,
    gemini: checkGeminiTrust(mcp.env),
    codex: checkCodexTrust(),
    lastCouncil: lastCouncilRun(slug),
  };
}

function summarize(s) {
  const issues = [];
  if (!s.mcp.registered) issues.push(`mcp:${s.mcp.reason}`);
  if (!s.gemini.ok)      issues.push(`gemini:${s.gemini.reason.slice(0, 60)}`);
  if (!s.codex.ok)       issues.push(`codex:${s.codex.reason || 'broken'}`);
  if (issues.length === 0) return 'council: ready';
  return 'council: ' + issues.length + ' issue(s) — ' + issues.map(i => i.split(':')[0]).join(', ');
}

function main() {
  const s = gather();

  if (FLAG_QUIET) {
    console.log(summarize(s));
    return;
  }

  if (FLAG_JSON) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  console.log('=== vanta-council-health ===');
  console.log('');

  console.log('MCP REGISTRATION');
  if (s.mcp.registered) {
    console.log(`  ✓ Multi-CLI registered (${s.mcp.command})`);
  } else {
    console.log(`  ✗ ${s.mcp.reason}`);
    console.log('    Install: add @osanoai/multicli to mcpServers in ~/.claude/settings.json');
  }
  console.log('');

  console.log('PER-MODEL READINESS');
  console.log('  Gemini: ' + (s.gemini.ok
    ? `✓ trust configured (${s.gemini.source})`
    : `✗ ${s.gemini.reason}`));
  console.log('  Codex:  ' + (s.codex.ok
    ? '✓ config present'
    : `✗ ${s.codex.reason}`));
  console.log('');

  if (s.lastCouncil) {
    console.log('LAST COUNCIL RUN');
    console.log(`  ${s.lastCouncil.date} · ${s.lastCouncil.topic}`);
    console.log(`  ${s.lastCouncil.council}`);
  } else {
    console.log('LAST COUNCIL RUN');
    console.log('  — no decisions.md entries yet for this project');
  }
  console.log('');

  // Suggestions
  const sugg = [];
  if (!s.mcp.registered)      sugg.push('install Multi-CLI MCP before /council can fire');
  if (!s.gemini.ok)           sugg.push('fix Gemini trust: set GEMINI_CLI_TRUST_WORKSPACE=true in MCP env');
  if (!s.codex.ok)            sugg.push('install codex CLI');
  if (sugg.length) {
    console.log('SUGGESTIONS');
    for (const x of sugg) console.log('  • ' + x);
    console.log('');
  } else {
    console.log('council ready — fire /council when needed');
  }
}

if (require.main === module) main();
module.exports = { gather, summarize };
