#!/usr/bin/env bash
# Vanta install script.
# Run from the repo root: ./setup.sh
# Deploys skills, hooks, Stop hook registration, and CLAUDE.md context injection.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"
HOOKS_DIR="$HOME/.claude/hooks"
BIN_DIR="$HOME/.claude/bin"
SETTINGS="$HOME/.claude/settings.json"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

echo "=== Vanta Setup ==="
echo ""

# ── Skills (flat — one level under ~/.claude/skills/) ──────────────────────
# Claude Code scanner reads ~/.claude/skills/<name>/SKILL.md — one level only.
# Repo dir → deployed name mapping:
#   skills/vanta/    → ~/.claude/skills/vanta-run/
#   skills/council/  → ~/.claude/skills/vanta-council/
#   skills/vanta-sync/ → ~/.claude/skills/vanta-sync/
# skills/using-vanta/ is NOT deployed — loaded as always-active context via CLAUDE.md @.

echo "Installing skills..."
mkdir -p "$SKILLS_DIR"

deploy_skill() {
  local src="$1" dst_name="$2"
  rm -rf "$SKILLS_DIR/$dst_name"
  cp -r "$src" "$SKILLS_DIR/$dst_name"
  echo "  ✓ $dst_name"
}

deploy_skill "$REPO_DIR/skills/vanta"          "vanta-run"
deploy_skill "$REPO_DIR/skills/council"        "vanta-council"
deploy_skill "$REPO_DIR/skills/vanta-sync"     "vanta-sync"
deploy_skill "$REPO_DIR/skills/vanta-patterns" "vanta-patterns"
echo ""

# ── Hooks ────────────────────────────────────────────────────────────────────
echo "Installing hooks..."
mkdir -p "$HOOKS_DIR"

for hook in council-advisory.js test-failure-advisor.js stack-file-nudge.js auto-sync.js plan-watcher.js code-index-watch.js git-guardrails.js prompt-context.js prompt-rewriter.js tool-observer.js session-start; do
  src="$REPO_DIR/hooks/$hook"
  if [ -f "$src" ]; then
    cp "$src" "$HOOKS_DIR/$hook"
    chmod +x "$HOOKS_DIR/$hook"
    echo "  ✓ $hook"
  fi
done
echo ""

# ── Policy (safety floor for the executor) ──────────────────────────────────
# v3.6.13 — deterministic always-ask layer. Floor file is deployed to
# ~/.vanta/policy/ so user-edits survive across upgrades. Repo copy is
# the read-only baseline if the deployed copy is missing.
mkdir -p "$HOME/.vanta/policy"
if [ ! -f "$HOME/.vanta/policy/safety-floor.yaml" ]; then
  cp "$REPO_DIR/policy/safety-floor.yaml" "$HOME/.vanta/policy/safety-floor.yaml"
  echo "  ✓ safety-floor.yaml deployed to ~/.vanta/policy/"
else
  echo "  ✓ safety-floor.yaml present (preserved user edits)"
fi
if [ ! -f "$HOME/.vanta/policy/peer-routing.yaml" ]; then
  cp "$REPO_DIR/policy/peer-routing.yaml" "$HOME/.vanta/policy/peer-routing.yaml"
  echo "  ✓ peer-routing.yaml deployed to ~/.vanta/policy/"
else
  echo "  ✓ peer-routing.yaml present (preserved user edits)"
fi
echo ""

# ── Bin (knowledge resolver and other shared scripts) ───────────────────────
echo "Installing shared bins..."
mkdir -p "$BIN_DIR"
for binfile in vanta-projects.js vanta-log.js vanta-resolve.js vanta-brief.js vanta-index-code.js vanta-status.js vanta-prune.js vanta-council-health.js vanta-council-feedback.js vanta-extract-score.js vanta-council-run.js vanta-runtime-state.js vanta-prompt-brief.js vanta-interaction-log.js vanta-jsonl.js vanta-safety-floor.js vanta-kill-switch.js vanta-action-log.js vanta-trust-metrics.js vanta-rewriter.js vanta-peer-router.js vanta-risk-classifier.js vanta-undo.js vanta-regret-detector.js vanta-autonomy.js vanta-memory-promote.js vanta-confidence-decay.js; do
  src="$REPO_DIR/bin/$binfile"
  if [ -f "$src" ]; then
    cp "$src" "$BIN_DIR/$binfile"
    chmod +x "$BIN_DIR/$binfile"
    echo "  ✓ $binfile"
  fi
done
echo ""

# ── Hook registration in settings.json (all 4 hooks, not just Stop) ─────────
# Without this, council-advisory.js, test-failure-advisor.js, and stack-file-nudge.js
# exist on disk but never fire — a fresh install would silently lose 75% of the harness.
echo "Regenerating hooks/hooks.json from manifest.json (single source of truth)..."
node - "$REPO_DIR/hooks/manifest.json" "$REPO_DIR/hooks/hooks.json" << 'JS'
const fs = require('fs');
const [,, manifestPath, outPath] = process.argv;
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const out = { hooks: {} };
for (const r of m.registrations) {
  out.hooks[r.event] = out.hooks[r.event] || [];
  // Group by matcher within the same event so plugin install sees one entry
  // per matcher (Claude Code merges these correctly).
  let bucket = out.hooks[r.event].find(e => (e.matcher || '') === (r.matcher || ''));
  if (!bucket) {
    bucket = r.matcher ? { matcher: r.matcher, hooks: [] } : { hooks: [] };
    out.hooks[r.event].push(bucket);
  }
  const cmd = r.runtime === 'bash'
    ? `"\${CLAUDE_PLUGIN_ROOT}/hooks/${r.file}"`
    : `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${r.file}"`;
  bucket.hooks.push({ type: 'command', command: cmd, timeout: r.timeout });
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log('  ✓ hooks/hooks.json regenerated');
JS
echo ""

echo "Registering hooks in settings.json..."

if [ ! -f "$SETTINGS" ]; then
  echo '{"hooks":{}}' > "$SETTINGS"
fi

node - "$SETTINGS" "$HOOKS_DIR" "$REPO_DIR/hooks/manifest.json" << 'JS'
const fs = require('fs');
const [,, settingsPath, hooksDir, manifestPath] = process.argv;
const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
s.hooks = s.hooks || {};

// Single source of truth: hooks/manifest.json — Codex council P2 fix.
// Drift between this script + hooks/hooks.json + README was the failure
// mode. All three now point to the manifest.
const REGISTRATIONS = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).registrations;

// Codex R2 P2 + R3 P2 fix: settings.json was append-only — old/renamed hooks
// lingered forever, and reordered manifest entries silently double-registered.
// We purge BEFORE inserting the fresh manifest.
//
// R3 narrowed the purge: the original `cmd.includes(hooksDir + '/')` would
// match user-authored hooks placed under ~/.claude/hooks/ that are NOT part
// of Vanta. Now we only purge commands that name a file currently or
// historically managed by Vanta. The historical list is the union of the
// current manifest plus a stable retired-hooks list (so renames flush
// cleanly without nuking unrelated hooks).
const hooksDirAbs = hooksDir.replace(/\/$/, '');
const RETIRED_HOOKS = [
  // Add filenames of hooks Vanta no longer ships but may have written
  // to settings.json in earlier setup runs. Empty today; reserve for
  // future renames so a `setup.sh` always cleans up after itself.
];
const VANTA_HOOK_NAMES = new Set([
  ...REGISTRATIONS.map(r => r.file),
  ...RETIRED_HOOKS,
]);
const isVantaHook = (cmd) => {
  if (typeof cmd !== 'string') return false;
  // Command shape from setup: `bash "<dir>/<file>"` or `node "<dir>/<file>"`.
  // Match the file basename strictly — substring match would catch unrelated
  // hooks under the same dir.
  const pattern = new RegExp(`["'\\s]${hooksDirAbs.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/([^"'\\s]+)`);
  const m = cmd.match(pattern);
  if (!m) return false;
  return VANTA_HOOK_NAMES.has(m[1]);
};

let purged = 0;
for (const event of Object.keys(s.hooks)) {
  const arr = s.hooks[event];
  if (!Array.isArray(arr)) continue;
  const cleaned = [];
  for (const entry of arr) {
    const keepHooks = (entry.hooks || []).filter(h => {
      if (isVantaHook(h.command)) { purged++; return false; }
      return true;
    });
    if (keepHooks.length > 0) cleaned.push({ ...entry, hooks: keepHooks });
    else if (!entry.hooks) cleaned.push(entry);
  }
  if (cleaned.length === 0) delete s.hooks[event];
  else s.hooks[event] = cleaned;
}
if (purged > 0) console.log(`  ✓ purged ${purged} stale Vanta hook entr(ies) from settings.json`);

// Codex+Gemini council R10 P1 — composability ordering.
// Earlier setup appended Vanta hooks to settings.json. If another plugin
// had registered a PreToolUse:Bash hook FIRST and that hook exited
// non-zero (blocking the tool call), Vanta's tool-observer never fired
// — telemetry blind. The "always-on observability" promise was broken
// for users who installed Vanta after another telemetry plugin.
//
// Fix: hooks tagged `prepend: true` in manifest.json land at the FRONT
// of the matcher's hook list. tool-observer is the only one that needs
// this — it's pure telemetry that must see every event before any
// blocker can short-circuit the chain. git-guardrails stays appended
// because it's a blocker itself; appending preserves a sensible order
// where guardrails fire after telemetry but before downstream hooks.
let added = 0, missing = 0;
for (const r of REGISTRATIONS) {
  const hookPath = `${hooksDir}/${r.file}`;
  if (!fs.existsSync(hookPath)) { console.log(`  - ${r.file} (missing on disk, skipped)`); missing++; continue; }
  const cmd = r.runtime === 'bash' ? `bash "${hookPath}"` : `node "${hookPath}"`;
  s.hooks[r.event] = s.hooks[r.event] || [];
  const entry = { hooks: [{ type: 'command', command: cmd, timeout: r.timeout }] };
  if (r.matcher) entry.matcher = r.matcher;
  if (r.prepend) s.hooks[r.event].unshift(entry);
  else           s.hooks[r.event].push(entry);
  added++;
  console.log(`  ✓ ${r.event}${r.matcher ? '['+r.matcher+']' : ''} → ${r.file}${r.prepend ? ' (prepend)' : ''}`);
}
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log(`  Summary: ${added} added, ${purged} purged, ${missing} missing`);
JS
echo ""

# ── CLAUDE.md context injection ───────────────────────────────────────────────
# using-vanta loads as always-active context, not a deployed skill.
# The @-import must point to the repo copy so edits take effect without re-running setup.
echo "Wiring session context..."

# Codex+Gemini council R10 P1 — IMPORT_LINE was hardcoded to
# `~/Projects/vanta/...`. If the user cloned anywhere else (Documents,
# work/, code/, a forked org-named dir), the @-import resolved to a
# non-existent file and CLAUDE.md context loading silently broke. Use
# REPO_DIR to derive the actual path. Translate $HOME → ~ for cosmetic
# tidiness in the rendered CLAUDE.md.
_IMPORT_TARGET="$REPO_DIR/skills/using-vanta/SKILL.md"
case "$_IMPORT_TARGET" in
  "$HOME"/*) IMPORT_LINE="@~${_IMPORT_TARGET#$HOME}" ;;
  *)         IMPORT_LINE="@$_IMPORT_TARGET" ;;
esac

# R10 P2 — also clean up any pre-v3.6.9 hardcoded import line so users
# upgrading don't end up with both a stale + a fresh @-import after
# moving the repo. Match by the using-vanta tail, not the full path.
if [ -f "$CLAUDE_MD" ]; then
  # Remove any existing line containing skills/using-vanta/SKILL.md that
  # ISN'T the one we're about to write.
  awk -v keep="$IMPORT_LINE" '
    /skills\/using-vanta\/SKILL\.md/ && $0 != keep { next }
    { print }
  ' "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
fi

if [ -f "$CLAUDE_MD" ] && grep -qF "$IMPORT_LINE" "$CLAUDE_MD"; then
  echo "  ✓ using-vanta already in CLAUDE.md"
else
  echo "" >> "$CLAUDE_MD"
  echo "# Vanta session protocol" >> "$CLAUDE_MD"
  echo "$IMPORT_LINE" >> "$CLAUDE_MD"
  echo "  ✓ using-vanta added to ~/.claude/CLAUDE.md ($IMPORT_LINE)"
fi
echo ""

# ── Dependency check ─────────────────────────────────────────────────────────
echo "=== Dependency Check ==="
MISSING=0

if [ -d "$SKILLS_DIR/gstack" ]; then
  echo "  ✓ garrytan/gstack"
else
  echo "  ✗ garrytan/gstack — NOT found"
  echo "      Install: git clone --depth 1 https://github.com/garrytan/gstack ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup"
  MISSING=$((MISSING + 1))
fi

if [ -d "$SKILLS_DIR/gsd-new-project" ]; then
  echo "  ✓ gsd-build/get-shit-done"
else
  echo "  ✗ gsd-build/get-shit-done — NOT found"
  echo "      Install: /plugin install gsd@claude-plugins-official  (in Claude Code)"
  MISSING=$((MISSING + 1))
fi

if ls "$HOME/.claude/plugins/cache/claude-plugins-official/superpowers" >/dev/null 2>&1; then
  echo "  ✓ obra/superpowers"
else
  echo "  ✗ obra/superpowers — NOT found"
  echo "      Install: /plugin install superpowers@claude-plugins-official  (in Claude Code)"
  MISSING=$((MISSING + 1))
fi

echo ""
if [ "$MISSING" -eq 0 ]; then
  echo "✓ All dependencies present. Vanta is ready."
else
  echo "⚠  $MISSING dependency(ies) missing. Vanta degrades gracefully — routes to whatever is installed."
fi

echo ""
echo "Restart Claude Code for skill changes to take effect."
echo "Then run: /vanta"
