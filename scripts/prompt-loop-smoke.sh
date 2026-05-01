#!/usr/bin/env bash
# prompt-loop-smoke.sh — v3.7.1 hard gate.
#
# This is the ONLY test that decides whether the user-loop works.
# Test count + council pass don't earn v3.7.2; THIS does.
#
# 13/15 prompts must produce sensible behavior (right rewrite OR right
# ASK OR right passthrough).
#
# Run: bash scripts/prompt-loop-smoke.sh
#   exit 0 when ≥13/15 pass; exit 1 otherwise.

set -euo pipefail

cd "$(dirname "$0")/.."

REWRITER="bin/vanta-rewriter.js"
[ -f "$REWRITER" ] || { echo "FATAL: $REWRITER not found"; exit 2; }

# Each test: prompt | expected_mode | expected_intent_or_route_substr | expected_skill_route
# expected_mode is one of: rule | ask | passthrough
# Match is substring on intent OR rule_id, plus optional skill_route.
TESTS=(
  "it didn't work|rule|diagnose-recent|/investigate"
  "fix this|rule|fix-bug|/investigate"
  "make this better|rule|optimize|/review"
  "ship it|rule|ship|/ship"
  "review this|rule|review|/review"
  "continue from last time|rule|resume|continue-state"
  "write tests|rule|tdd|/qa"
  "find gaps|rule|audit-gaps|/codex"
  "what changed?|rule|diff-summary|git-diff"
  "should we pivot pricing?|passthrough|safety-floor|/council"
  "rename tier to plan_level|ask|taxonomy-rename|/council"
  "push this|rule|ship|/ship"
  "deploy this|rule|ship|/ship"
  "what is in this file?|passthrough||"
  "what's next|rule|resume|continue-state"
)

PASS=0
FAIL=0
RESULTS=()

# Pre-warm safety-floor with the repo's policy file so the smoke is hermetic.
export VANTA_SAFETY_FLOOR="$(pwd)/policy/safety-floor.yaml"

for entry in "${TESTS[@]}"; do
  IFS='|' read -r prompt exp_mode exp_intent exp_route <<< "$entry"
  out="$(node "$REWRITER" --prompt "$prompt" 2>/dev/null || echo '{}')"

  mode=$(printf '%s' "$out" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except: d={}
print(d.get('mode','-'))")
  intent=$(printf '%s' "$out" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except: d={}
print(d.get('intent','-') or '-')")
  rule_id=$(printf '%s' "$out" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except: d={}
print(d.get('rule_id','-') or '-')")
  route=$(printf '%s' "$out" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except: d={}
print(d.get('skill_route','-') or '-')")
  why=$(printf '%s' "$out" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except: d={}
print((d.get('why','-') or '-')[:60])")

  ok=true
  [ "$mode" = "$exp_mode" ] || ok=false

  # Intent/rule_id substring match (intent OR rule_id contains expected token)
  if [ -n "$exp_intent" ]; then
    if [[ "$intent" != *"$exp_intent"* ]] && [[ "$rule_id" != *"$exp_intent"* ]] && [[ "$why" != *"$exp_intent"* ]]; then
      ok=false
    fi
  fi

  # Skill route check — only when expected non-empty
  if [ -n "$exp_route" ]; then
    [ "$route" = "$exp_route" ] || ok=false
  fi

  if $ok; then
    PASS=$((PASS+1))
    status="✓"
  else
    FAIL=$((FAIL+1))
    status="✗"
  fi

  RESULTS+=("$status  prompt=$(printf '%-32s' "\"$prompt\"")  mode=$(printf '%-12s' "$mode")  intent=$(printf '%-18s' "$intent")  route=$(printf '%-16s' "$route")  why=$why")
done

echo "── v3.7.1 prompt-loop smoke ──"
for line in "${RESULTS[@]}"; do
  printf '%s\n' "$line"
done
echo "──────────────────────────────"
echo "PASS: $PASS / $((PASS+FAIL))   GATE: ≥13"
if [ "$PASS" -ge 13 ]; then
  echo "RESULT: PASS — v3.7.2 unlocked"
  exit 0
else
  echo "RESULT: FAIL — fix rules until ≥13/15 before moving on"
  exit 1
fi
