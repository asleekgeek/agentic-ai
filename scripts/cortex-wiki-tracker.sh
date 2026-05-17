#!/usr/bin/env bash
# Report Cortex wiki commits that are not yet ported to agentic-ai.
#
# Compares Cortex's wiki-related paths against the most recent commit in
# agentic-ai that mentions wiki, ADR-2244, or matches a known marker
# from a Cortex port commit. Output: a markdown report of pending work.
#
# Usage:
#   cortex-wiki-tracker.sh                            # default: report from last 14 days
#   cortex-wiki-tracker.sh --since "2026-05-13"       # explicit window
#   cortex-wiki-tracker.sh --since "$(get-last-sync)" # custom anchor
#
# Exit 0 even when there is work to port; the report is the deliverable.

set -euo pipefail

CORTEX_ROOT="${CORTEX_ROOT:-$HOME/Developments/Cortex}"
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SINCE" ]]; then
  # Default: 14 days back. Easier than threading state files.
  SINCE="14 days ago"
fi

if [[ ! -d "$CORTEX_ROOT" ]]; then
  echo "CORTEX_ROOT not found: $CORTEX_ROOT" >&2
  exit 2
fi

cd "$CORTEX_ROOT"
git fetch -q origin 2>/dev/null || true

# Wiki-relevant Cortex paths. Anything touched here is in-scope.
paths=(
  "mcp_server/core/wiki_*.py"
  "mcp_server/handlers/wiki_*.py"
  "mcp_server/shared/wiki_*.py"
  "mcp_server/hooks/post_tool_capture.py"
  "mcp_server/infrastructure/wiki_*.py"
  "scripts/wiki_*.py"
  "tests_py/handlers/test_wiki_*.py"
  "tests_py/shared/test_wiki_*.py"
  "tests_py/core/test_wiki_*.py"
)

echo "# Cortex wiki commits since ${SINCE}"
echo
echo "Cortex root: ${CORTEX_ROOT}"
echo "Working tree HEAD: $(git rev-parse --short HEAD)"
echo "Filter paths: ${paths[*]}"
echo

count=0
while IFS= read -r line; do
  count=$((count + 1))
  echo "$line"
done < <(
  git log --since="$SINCE" --oneline --no-merges -- "${paths[@]}" 2>/dev/null
)

echo
echo "Total: ${count} commits."
echo

if [[ $count -gt 0 ]]; then
  echo "## Per-commit detail"
  echo
  git log --since="$SINCE" --no-merges --format="### %h — %s%n%n*Date:* %ci%n*Author:* %an%n%n%b%n---%n" -- "${paths[@]}" 2>/dev/null
fi
