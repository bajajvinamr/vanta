#!/usr/bin/env bash
# Vanta uninstall script.
# Run from the repo root: ./uninstall.sh
#
# Codex council R7 P4 — without an uninstall path, removing Vanta required
# the user to hand-edit ~/.claude/settings.json, find the right hook entries,
# and `rm -rf` deployed dirs from memory. Mistakes leave dangling hook
# registrations that fail every prompt with cryptic exec errors.
#
# This script reverses what setup.sh did, using hooks/manifest.json as the
# authoritative file list — same single-source-of-truth pattern.
#
# What it removes:
#   1. Hook registrations in ~/.claude/settings.json (purge by manifest filename)
#   2. Deployed hook files in ~/.claude/hooks/
#   3. Deployed skills (vanta-run, vanta-council, vanta-sync, vanta-patterns)
#   4. Shared bins in ~/.claude/bin/ that match the install list
#
# What it does NOT touch:
#   - User data: ~/.vanta/ (sync-queue, episodes, code-knowledge, query-log)
#   - User invariants: ~/.claude/rules/vinamr-invariants.md
#
# Codex+Gemini council R10 P2 — earlier uninstall left the @-import line
# in CLAUDE.md verbatim. Users uninstalling typically also delete the
# repo, leaving Claude Code with a dangling reference that errored on
# every session start. Now: strip the using-vanta @-import + the "# Vanta
# session protocol" header line that setup.sh added above it. Other
# CLAUDE.md content (user instructions, other @-imports) is preserved.
#
# Why preserve user data: an uninstall might be temporary (debugging a hook,
# upgrading to a new version). Wiping ~/.vanta would lose months of decisions,
# episodes, and indexed knowledge. The user can `rm -rf ~/.vanta/` if they
# truly want a clean slate.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"
HOOKS_DIR="$HOME/.claude/hooks"
BIN_DIR="$HOME/.claude/bin"
SETTINGS="$HOME/.claude/settings.json"
MANIFEST="$REPO_DIR/hooks/manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST not found. Run from repo root." >&2
  exit 1
fi

echo "=== Vanta Uninstall ==="
echo ""
echo "Will remove:"
echo "  - Hook registrations in $SETTINGS"
echo "  - Hook files in $HOOKS_DIR/"
echo "  - Skills: vanta-run, vanta-council, vanta-sync, vanta-patterns"
echo "  - Shared bins in $BIN_DIR/"
echo ""
echo "Will preserve:"
echo "  - ~/.vanta/ (decisions, episodes, code-knowledge, sync-queue)"
echo "  - ~/.claude/rules/vinamr-invariants.md"
echo "  - ~/.claude/CLAUDE.md (manual @-import cleanup if desired)"
echo ""

# ── Confirm ─────────────────────────────────────────────────────────────────
if [ "${VANTA_UNINSTALL_FORCE:-}" != "1" ]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi
echo ""

# ── Purge hook registrations from settings.json ─────────────────────────────
# Mirrors the purge logic in setup.sh: identify Vanta-managed hooks by filename
# match against the manifest's `file` field, then strip them. Leaves
# user-authored hooks under ~/.claude/hooks/ untouched.
if [ -f "$SETTINGS" ]; then
  echo "Purging hook registrations from settings.json..."
  node - "$SETTINGS" "$HOOKS_DIR" "$MANIFEST" << 'JS'
const fs = require('fs');
const [,, settingsPath, hooksDir, manifestPath] = process.argv;
const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
s.hooks = s.hooks || {};

const REGISTRATIONS = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).registrations;
const hooksDirAbs = hooksDir.replace(/\/$/, '');
const RETIRED_HOOKS = [];  // populate when files are renamed/dropped from manifest
const VANTA_HOOK_NAMES = new Set([
  ...REGISTRATIONS.map(r => r.file),
  ...RETIRED_HOOKS,
]);
const isVantaHook = (cmd) => {
  if (typeof cmd !== 'string') return false;
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
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log(`  ✓ purged ${purged} Vanta hook registration(s)`);
JS
else
  echo "  (no settings.json — skipping registration purge)"
fi
echo ""

# ── Remove hook files ────────────────────────────────────────────────────────
echo "Removing hook files..."
node - "$MANIFEST" << 'JS' | while IFS= read -r f; do
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seen = new Set();
for (const r of m.registrations) {
  if (!seen.has(r.file)) { seen.add(r.file); console.log(r.file); }
}
JS
  if [ -f "$HOOKS_DIR/$f" ]; then
    rm -f "$HOOKS_DIR/$f"
    echo "  ✓ removed $f"
  fi
done
echo ""

# ── Remove skills ────────────────────────────────────────────────────────────
echo "Removing skills..."
for skill in vanta-run vanta-council vanta-sync vanta-patterns; do
  if [ -d "$SKILLS_DIR/$skill" ]; then
    rm -rf "$SKILLS_DIR/$skill"
    echo "  ✓ removed $skill"
  fi
done
echo ""

# ── Strip CLAUDE.md @-import (R10 P2) ───────────────────────────────────────
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  echo "Stripping using-vanta @-import from CLAUDE.md..."
  # Remove lines matching the @-import pattern AND the immediately preceding
  # "# Vanta session protocol" header that setup.sh added above it.
  awk '
    /^# Vanta session protocol$/ { saved=$0; skip_next=1; next }
    skip_next && /skills\/using-vanta\/SKILL\.md/ { skip_next=0; next }
    skip_next { print saved; saved=""; skip_next=0 }
    /skills\/using-vanta\/SKILL\.md/ { next }  # any stragglers
    { print }
  ' "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
  echo "  ✓ CLAUDE.md @-import stripped"
fi
echo ""

# ── Remove shared bins ──────────────────────────────────────────────────────
echo "Removing shared bins..."
for binfile in vanta-projects.js vanta-log.js vanta-resolve.js vanta-brief.js \
               vanta-index-code.js vanta-status.js vanta-prune.js \
               vanta-council-health.js vanta-council-feedback.js \
               vanta-extract-score.js vanta-council-run.js \
               vanta-runtime-state.js vanta-prompt-brief.js \
               vanta-interaction-log.js vanta-jsonl.js; do
  if [ -f "$BIN_DIR/$binfile" ]; then
    rm -f "$BIN_DIR/$binfile"
    echo "  ✓ removed $binfile"
  fi
done
echo ""

echo "=== Vanta Uninstall Complete ==="
echo ""
echo "User data preserved at:"
echo "  ~/.vanta/                         (decisions, episodes, code-knowledge)"
echo "  ~/.claude/rules/vinamr-invariants.md"
echo ""
echo "If you want a fully clean slate:"
echo "  rm -rf ~/.vanta/"
echo ""
echo "Note: any '@~/Projects/vanta/...' references in ~/.claude/CLAUDE.md"
echo "are not auto-stripped — remove them manually if you no longer want them."
