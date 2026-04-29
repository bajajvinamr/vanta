#!/usr/bin/env bash
# Vanta local install script.
# Run from the repo root: ./setup.sh
# Installs skills and hooks into ~/.claude/, checks all three dependencies.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"
HOOKS_DIR="$HOME/.claude/hooks"

echo "=== Vanta Setup ==="
echo ""

# ── Skills ──────────────────────────────────────────────────────────────────
echo "Installing skills..."
mkdir -p "$SKILLS_DIR/vanta"

for skill in using-vanta vanta vanta-sync council; do
  src="$REPO_DIR/skills/$skill"
  dst="$SKILLS_DIR/vanta/$skill"
  rm -rf "$dst" 2>/dev/null || true
  cp -r "$src" "$dst"
  echo "  ✓ $skill"
done

# ── Hooks ────────────────────────────────────────────────────────────────────
echo "Installing hooks..."
cp "$REPO_DIR/hooks/council-advisory.js"    "$HOOKS_DIR/"
cp "$REPO_DIR/hooks/test-failure-advisor.js" "$HOOKS_DIR/"
cp "$REPO_DIR/hooks/stack-file-nudge.js"    "$HOOKS_DIR/"
cp "$REPO_DIR/hooks/session-start"          "$HOOKS_DIR/vanta-session-start"
chmod +x "$HOOKS_DIR/vanta-session-start"
echo "  ✓ council-advisory.js"
echo "  ✓ test-failure-advisor.js"
echo "  ✓ stack-file-nudge.js"
echo "  ✓ session-start → vanta-session-start"
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
  echo "      Or: https://github.com/gsd-build/get-shit-done"
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
  echo "✓ All dependencies installed. Vanta is ready."
  echo "  Start a Claude Code session and run: /vanta"
else
  echo "⚠  $MISSING dependency(ies) missing."
  echo "   Vanta degrades gracefully — install for full functionality."
fi

echo ""
echo "Note: hooks.json will be used automatically when Vanta is installed"
echo "as a plugin. For manual installs, hooks are already wired in settings.json."
