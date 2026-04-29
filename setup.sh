#!/usr/bin/env bash
# Vanta install script.
# Run from the repo root: ./setup.sh
# Deploys skills, hooks, Stop hook registration, and CLAUDE.md context injection.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"
HOOKS_DIR="$HOME/.claude/hooks"
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

for hook in council-advisory.js test-failure-advisor.js stack-file-nudge.js auto-sync.js; do
  src="$REPO_DIR/hooks/$hook"
  if [ -f "$src" ]; then
    cp "$src" "$HOOKS_DIR/$hook"
    echo "  ✓ $hook"
  fi
done
echo ""

# ── Hook registration in settings.json (all 4 hooks, not just Stop) ─────────
# Without this, council-advisory.js, test-failure-advisor.js, and stack-file-nudge.js
# exist on disk but never fire — a fresh install would silently lose 75% of the harness.
echo "Registering hooks in settings.json..."

if [ ! -f "$SETTINGS" ]; then
  echo '{"hooks":{}}' > "$SETTINGS"
fi

node - "$SETTINGS" "$HOOKS_DIR" << 'JS'
const fs = require('fs');
const [,, settingsPath, hooksDir] = process.argv;
const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
s.hooks = s.hooks || {};

// Each registration: event -> matcher -> hook file
// matcher uses Claude Code's tool-name pipe syntax (e.g. "Write|Edit", "Bash")
const REGISTRATIONS = [
  { event: 'Stop',         matcher: '',          file: 'auto-sync.js',            timeout: 10 },
  { event: 'PreToolUse',   matcher: 'Write|Edit', file: 'council-advisory.js',     timeout: 5 },
  { event: 'PostToolUse',  matcher: 'Bash',       file: 'test-failure-advisor.js', timeout: 5 },
  { event: 'PostToolUse',  matcher: 'Write|Edit', file: 'stack-file-nudge.js',     timeout: 5 },
];

let added = 0, skipped = 0, missing = 0;
for (const r of REGISTRATIONS) {
  const hookPath = `${hooksDir}/${r.file}`;
  if (!fs.existsSync(hookPath)) { console.log(`  - ${r.file} (missing on disk, skipped)`); missing++; continue; }
  const cmd = `node "${hookPath}"`;
  s.hooks[r.event] = s.hooks[r.event] || [];
  // Look for an existing entry that already runs this command (any matcher).
  const already = s.hooks[r.event].some(e => (e.hooks || []).some(h => h.command === cmd));
  if (already) { skipped++; continue; }
  const entry = { hooks: [{ type: 'command', command: cmd, timeout: r.timeout }] };
  if (r.matcher) entry.matcher = r.matcher;
  s.hooks[r.event].push(entry);
  added++;
  console.log(`  ✓ ${r.event}${r.matcher ? '['+r.matcher+']' : ''} → ${r.file}`);
}
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log(`  Summary: ${added} added, ${skipped} already present, ${missing} missing`);
JS
echo ""

# ── CLAUDE.md context injection ───────────────────────────────────────────────
# using-vanta loads as always-active context, not a deployed skill.
# The @-import must point to the repo copy so edits take effect without re-running setup.
echo "Wiring session context..."

IMPORT_LINE="@~/Projects/vanta/skills/using-vanta/SKILL.md"

if [ -f "$CLAUDE_MD" ] && grep -qF "$IMPORT_LINE" "$CLAUDE_MD"; then
  echo "  ✓ using-vanta already in CLAUDE.md"
else
  echo "" >> "$CLAUDE_MD"
  echo "# Vanta session protocol" >> "$CLAUDE_MD"
  echo "$IMPORT_LINE" >> "$CLAUDE_MD"
  echo "  ✓ using-vanta added to ~/.claude/CLAUDE.md"
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
