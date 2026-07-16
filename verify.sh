#!/usr/bin/env bash
# verify.sh — local definition-of-done gate for vanta.
#
# Vanta is a Node.js harness with no build step and no TypeScript — plain JS.
# The only automated check is the test suite (node --test).
#
# Usage:
#   ./verify.sh

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RESULTS=()
FAILED=0

run_check() {
  local name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  CHECK: ${name}"
  echo "════════════════════════════════════════════════════"
  if "$@"; then
    RESULTS+=("PASS  ${name}")
  else
    RESULTS+=("FAIL  ${name}")
    FAILED=1
  fi
}

# ── Preconditions ────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node not found." >&2
  exit 2
fi

# ── Gate ─────────────────────────────────────────────────────────────
# 1. Tests — node --test (no build, no typecheck; plain JS harness).
run_check "tests (node --test)" npm test

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  VERIFY SUMMARY — vanta"
echo "════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "  RESULT: FAIL — fix failing tests before releasing. See DONE.md."
  exit 1
fi
echo "  RESULT: PASS (local gate). See DONE.md."
exit 0
