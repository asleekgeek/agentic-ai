#!/usr/bin/env bash
# spawn-worktree.sh — create a git worktree for a parallel-port mission.
#
# Usage:   ./scripts/spawn-worktree.sh <module>
# Example: ./scripts/spawn-worktree.sh cortex-recall
#
# Creates worktrees/port-<module>/ branched off main, with MISSION.md
# pre-populated from the template. Does NOT start any work — that is the
# operator's job.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <module>" >&2
  echo "" >&2
  echo "Phase-4 cortex worktrees (per docs/PHASE_PLAN.md §4):" >&2
  echo "  cortex-shared              cortex-recall              cortex-remember" >&2
  echo "  cortex-consolidation       cortex-codebase-analysis   cortex-wiki" >&2
  echo "  cortex-graph-navigation    cortex-methodology         cortex-narrative" >&2
  echo "  cortex-import              cortex-workflow-graph      cortex-automation" >&2
  echo "  cortex-hooks" >&2
  echo "" >&2
  echo "Other:" >&2
  echo "  inventory-* / migrate-* / parity-baseline / tooling-ci /" >&2
  echo "  plugin-manifest-design / core-types" >&2
  exit 64
fi

MODULE="$1"
BRANCH="port/${MODULE}"
WORKTREE_DIR="worktrees/port-${MODULE}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

cd "$REPO_ROOT"

if [[ -d "$WORKTREE_DIR" ]]; then
  echo "error: worktree already exists at $WORKTREE_DIR" >&2
  exit 1
fi

if git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  echo "branch $BRANCH already exists; reusing it"
  git worktree add "$WORKTREE_DIR" "$BRANCH"
else
  echo "creating branch $BRANCH off main"
  git worktree add -b "$BRANCH" "$WORKTREE_DIR" main
fi

MISSION_PATH="$WORKTREE_DIR/MISSION.md"
if [[ ! -f "$MISSION_PATH" ]]; then
  cp docs/WORKTREE_MISSION_TEMPLATE.md "$MISSION_PATH"
  # Header replacement: <module-name> → actual module
  sed -i.bak "s/<module-name>/${MODULE}/g" "$MISSION_PATH" && rm "${MISSION_PATH}.bak"
  echo "wrote $MISSION_PATH"
fi

echo ""
echo "worktree ready: $WORKTREE_DIR"
echo "branch:         $BRANCH"
echo "mission file:   $MISSION_PATH"
echo ""
echo "next steps (operator):"
echo "  1. fill in $MISSION_PATH §1 (Source) and §2 (Target)"
echo "  2. run architect + liskov to review the contract"
echo "  3. begin port work; engineer + genius panel run as configured in §4"
echo "  4. merge ONLY after every checkbox in §3 and §4 is checked"
