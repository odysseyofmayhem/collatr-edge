#!/bin/bash
# CollatrEdge Ralph Wiggum Loop
#
# Usage:
#   ./ralph.sh              # Build mode, max 10 iterations
#   ./ralph.sh 20           # Build mode, max 20 iterations
#   ./ralph.sh plan         # Plan mode, max 3 iterations
#   ./ralph.sh plan 5       # Plan mode, max 5 iterations
#
# Prerequisites:
#   - claude CLI installed and authenticated
#   - Run from project root (where CLAUDE.md lives)

set -e

# Parse arguments
if [ "$1" = "plan" ]; then
  MODE="plan"
  PROMPT_FILE="PROMPT_plan.md"
  MAX_ITERATIONS=${2:-3}
elif [[ "$1" =~ ^[0-9]+$ ]]; then
  MODE="build"
  PROMPT_FILE="PROMPT_build.md"
  MAX_ITERATIONS=$1
else
  MODE="build"
  PROMPT_FILE="PROMPT_build.md"
  MAX_ITERATIONS=10
fi

ITERATION=0
CURRENT_BRANCH=$(git branch --show-current)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CollatrEdge Ralph Loop"
echo "  Mode: $MODE"
echo "  Prompt: $PROMPT_FILE"
echo "  Branch: $CURRENT_BRANCH"
echo "  Max iterations: $MAX_ITERATIONS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Verify files exist
if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: $PROMPT_FILE not found. Run from project root."
  exit 1
fi

if [ ! -f "CLAUDE.md" ]; then
  echo "Error: CLAUDE.md not found. Run from project root."
  exit 1
fi

while true; do
  if [ $ITERATION -ge $MAX_ITERATIONS ]; then
    echo ""
    echo "━━━ Reached max iterations: $MAX_ITERATIONS ━━━"
    break
  fi

  ITERATION=$((ITERATION + 1))
  echo ""
  echo "━━━ Iteration $ITERATION / $MAX_ITERATIONS ━━━"
  echo "Started: $(date)"

  # Run Claude Code in headless mode with the prompt
  result=$(cat "$PROMPT_FILE" | claude -p --dangerously-skip-permissions 2>&1) || true

  echo "$result"

  # Check for completion signals
  if echo "$result" | grep -q "PHASE_COMPLETE"; then
    echo ""
    echo "━━━ PHASE COMPLETE! All tasks done. ━━━"
    exit 0
  fi

  if echo "$result" | grep -q "PLAN_COMPLETE"; then
    echo ""
    echo "━━━ PLAN COMPLETE ━━━"
    exit 0
  fi

  # Push after each iteration (if build mode and there are changes)
  if [ "$MODE" = "build" ]; then
    if git diff --quiet HEAD 2>/dev/null; then
      echo "(no new commits this iteration)"
    else
      echo "Pushing changes..."
      git push 2>/dev/null || echo "(push failed, continuing)"
    fi
  fi

  echo "Finished: $(date)"
done

echo ""
echo "━━━ Loop finished after $ITERATION iterations ━━━"
