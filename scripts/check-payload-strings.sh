#!/usr/bin/env bash
# check-payload-strings.sh — block payload-shaped strings from re-entering the codebase.
#
# Background: a previous draft of packages/memory-dashboard/__tests__/file-diff-
# security.test.ts created an isolated git fixture inside vitest worker
# processes using a fixed identity and a fixed-content tracked file. Combined
# with `process.chdir()` (since removed) the fixture's repo state leaked into
# peer tests in the same vitest worker, producing stray commits in the
# agentic-ai worktree authored under the fixture identity. GitHub's email
# attribution then auto-linked those commits to a dormant 2011 account that
# happened to have registered the fixture email. A subsequent squash-merge
# picked the rogue tip and replaced 1640 files of legitimate work with the
# 6-byte fixture file.
#
# This script enforces a permanent firewall: the payload-shaped strings must
# never reappear in the codebase. If a future test, fixture, or doc legitimately
# needs git fixture commits, use:
#   - argv-form per-call identity:  git -c user.email=anonymous@local
#                                       -c user.name=anonymous   <subcmd>
#   - non-payload-shaped values:    different filename, non-"init" message
#   - never call process.chdir() in a vitest test that runs in shared worker
#
# Exit codes: 0 clean; 1 payload string detected.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCAN_PATHS=(
  "packages"
  "plugins"
  "scripts"
  "install"
)

declare -a FORBIDDEN_STRINGS=(
  't@t\.t'
  'tracked\.txt'
)

declare -a FORBIDDEN_CODE_PATTERNS=(
  'commit.*-m.*"init"'
  'commit.*-m.*'\''init'\'''
)

declare -i fail=0

# Files allowed to mention the strings (this script itself + incident notes).
ALLOWLIST_PATTERN='^(scripts/check-payload-strings\.sh|docs/SECURITY_FINDINGS\.md|docs/incidents/.*|CHANGELOG\.md)$'

scan_string() {
  local needle="$1"
  local label="$2"
  local files
  files=$(grep -rlE "$needle" "${SCAN_PATHS[@]}" \
            --include='*.ts' --include='*.tsx' \
            --include='*.js'  --include='*.jsx' \
            --include='*.mjs' --include='*.cjs' \
            --include='*.sh'  --include='*.py' \
            --include='*.rs' \
            2>/dev/null || true)
  if [[ -z "$files" ]]; then
    return 0
  fi
  while IFS= read -r f; do
    if echo "$f" | grep -qE "$ALLOWLIST_PATTERN"; then
      continue
    fi
    echo "[payload-lint] FAIL — '$label' found in $f" >&2
    grep -nE "$needle" "$f" | head -3 >&2
    fail+=1
  done <<< "$files"
}

for s in "${FORBIDDEN_STRINGS[@]}"; do
  scan_string "$s" "$s"
done

for p in "${FORBIDDEN_CODE_PATTERNS[@]}"; do
  scan_string "$p" "$p"
done

if (( fail > 0 )); then
  echo "" >&2
  echo "[payload-lint] $fail violation(s). See incident notes." >&2
  echo "[payload-lint] To fix: rename fixture file, change commit message," >&2
  echo "[payload-lint] use 'git -c user.email=anonymous@local ...' per-call." >&2
  exit 1
fi

echo "[payload-lint] no payload strings present in source"
