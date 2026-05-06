#!/usr/bin/env bash
# check-source-citations.sh — Pre-commit hook that scans staged .ts files for
# numeric literals with 3+ significant digits that lack an adjacent // source: comment.
#
# Rationale: coding-standards.md §3.1 — "No magic numbers. Every numeric constant
# has a name or a source comment."
# coding-standards.md §8 — "Every hardcoded number must come from paper equations,
# paper experimental results, or measured ablation data from own benchmarks."
#
# Pattern lifted from: zetetic-team-subagents/hooks/pre-commit-zetetic.sh
# (staged-file scanning approach and graceful-degradation pattern).
#
# What "3+ significant digits" means:
#   - Integers: 100, 500, 1000, 0.001, 3.14, 30000 → require // source:
#   - Single/double digit integers: 0, 1, 2, 10, 99 → exempt
#   - Common programming constants by exemption list (see EXEMPT_NUMBERS below).
#
# Detection strategy:
#   1. Get staged .ts files via `git diff --cached --name-only`.
#   2. For each file, get only the NEWLY ADDED lines via
#      `git diff --cached --unified=0`. Pre-existing lines that the same
#      diff happens to touch around (context) are NOT inspected — old
#      magic numbers are grandfathered, only new ones are flagged.
#   3. For each added line, check for numeric literals and a // source:
#      comment on the same line OR the line immediately above (in the
#      working file, since multi-line diffs may not include the prev line).
#   4. If a violation is found, print it and exit 2 (blocks commit).
#
# Rationale for diff-scope rather than file-scope:
#   The repo predates this gate by months — many files have legitimate
#   pre-existing constants without inline citations. A file-scope check
#   would block ANY edit to those files, even unrelated lint cleanups,
#   forcing developers to retroactively cite work they didn't author.
#   That violates the gate's stated purpose ("every NEW number ≥3 sig-
#   digits needs an adjacent // source: comment") — citation is a
#   forward-going contract, not a retroactive enforcement.
#
# Exit codes:
#   0 — no violations
#   1 — internal error (git unavailable, etc.)
#   2 — violations found (blocks commit)
#
# source: pre-commit-zetetic.sh — staged-file scanning pattern.
# source: coding-standards.md §8 — numeric constant citation rule.

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

# Minimum significant-digit threshold.
# source: coding-standards.md §3.1 — "≥3 significant digits has a // source: comment"
# source: MISSION.md §3.6
MIN_DIGITS=3  # source: coding-standards.md §3.1 — threshold is 3

# Numbers exempt from citation even if they have 3+ significant digits.
# These are standard programming constants whose semantics are universally known.
# source: zetetic-team-subagents/rules/coding-standards.md §3.1 note — "name or source comment"
#         (-1, 0, 1, 2 are already excluded by the regex; these are additional exemptions)
EXEMPT_PATTERN='(100|255|256|360|365|1000|1024|2048|4096|8080|3000|8000|8443)'

# Regex: numeric literal with 3+ significant digits.
# Matches: integers 100+, decimals with 3+ sig-fig (e.g., 3.14, 0.001, 1.23e-4),
#          hex literals with 3+ hex digits (0x1FF etc.).
# Does NOT match: 0, 1, 2, single-digit floats (0.5), two-digit integers (10–99).
#
# Pattern breakdown:
#   ([0-9]{3,})           — integer with 3+ digits (100, 500, 3000, …)
#   ([0-9]+\.[0-9]{2,})   — decimal with 2+ fractional digits (3.14, 0.001, …)
#   ([0-9]{2,}\.[0-9]+)   — decimal with 2+ integer digits (10.5, 30.0, …)
#   (0x[0-9a-fA-F]{3,})   — hex literal with 3+ hex digits (0x1FF, 0xDEAD, …)
#   (1e[0-9]+|[0-9]+e[+-]?[0-9]+) — scientific notation
#
# source: GNU grep extended regex — POSIX ERE.
NUMERIC_REGEX='([0-9]{3,}|[0-9]+\.[0-9]{2,}|[0-9]{2,}\.[0-9]+|0x[0-9a-fA-F]{3,}|[0-9]+[eE][+-]?[0-9]+)'

# Source-citation comment pattern (on the same line or the line above).
# source: coding-standards.md §8 — "// source: <citation>" form.
SOURCE_COMMENT_PATTERN='//\s*source:'

# ── Dependency guard ───────────────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  echo "check-source-citations: git not found — skipping." >&2
  exit 0
fi

# ── Get staged TypeScript files ────────────────────────────────────────────────

STAGED_TS_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null \
  | grep '\.ts$' \
  | grep -v '\.d\.ts$' \
  || true)

if [[ -z "$STAGED_TS_FILES" ]]; then
  exit 0
fi

# ── Scan each file's NEWLY ADDED lines only ────────────────────────────────────
#
# We use `git diff --cached --unified=0 -- <file>` to get only the additions,
# then walk the +<line> entries. Each addition is paired with its target line
# number in the staged file (parsed from the @@ hunk header). For prev-line
# lookup we also peek at the line above in the on-disk staged file.

VIOLATIONS=()

# Skip predicate (test files, generated dirs).
should_skip_file() {
  local f=$1
  if echo "$f" | grep -qE '(\.test\.ts$|\.spec\.ts$|__tests__|\.parity\.test\.ts$)'; then return 0; fi
  if echo "$f" | grep -qE '(^|/)dist/|(^|/)node_modules/'; then return 0; fi
  return 1
}

# Check a single (file, line_number, line_text) tuple for a violation.
check_added_line() {
  local file=$1
  local line_number=$2
  local line=$3

  # Numeric literal of interest?
  echo "$line" | grep -qE "$NUMERIC_REGEX" || return 0

  # Comment / type annotation line — skip.
  local trimmed="${line#"${line%%[! ]*}"}"
  if echo "$trimmed" | grep -qE '^(//|/\*|\*|import type|export type)'; then
    return 0
  fi

  # Only exempt numbers on this line — skip.
  local line_without_exempt
  line_without_exempt=$(echo "$line" | sed -E "s/\b$EXEMPT_PATTERN\b//g")
  if ! echo "$line_without_exempt" | grep -qE "$NUMERIC_REGEX"; then
    return 0
  fi

  # Same-line // source: comment — skip.
  if echo "$line" | grep -qE "$SOURCE_COMMENT_PATTERN"; then
    return 0
  fi

  # Line-above // source: comment — skip.
  if [[ -f "$file" ]] && [[ "$line_number" -gt 1 ]]; then
    local prev_line
    prev_line=$(sed -n "$((line_number - 1))p" "$file" 2>/dev/null)
    if echo "$prev_line" | grep -qE "$SOURCE_COMMENT_PATTERN"; then
      return 0
    fi
  fi

  VIOLATIONS+=("$file:$line_number: $line")
  return 0
}

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  should_skip_file "$file" && continue
  [[ -f "$file" ]] || continue

  # Walk the diff. Format we expect from `git diff --cached -U0 -- <file>`:
  #   @@ -<old_start>[,<old_count>] +<new_start>[,<new_count>] @@ ...
  #   +<added line content>
  #   ...
  current_new_line=0
  while IFS= read -r diff_line; do
    if [[ "$diff_line" =~ ^@@\ -[0-9]+(,[0-9]+)?\ \+([0-9]+)(,[0-9]+)?\ @@ ]]; then
      current_new_line="${BASH_REMATCH[2]}"
      continue
    fi
    # Skip diff file headers (+++ / ---).
    if [[ "$diff_line" =~ ^(\+\+\+|---) ]]; then
      continue
    fi
    if [[ "${diff_line:0:1}" == "+" ]]; then
      added="${diff_line:1}"
      check_added_line "$file" "$current_new_line" "$added"
      current_new_line=$((current_new_line + 1))
    fi
  done < <(git diff --cached --unified=0 -- "$file" 2>/dev/null)

done <<< "$STAGED_TS_FILES"

# ── Report ─────────────────────────────────────────────────────────────────────

if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  exit 0
fi

echo "" >&2
echo "╔══════════════════════════════════════════════════════════════════════╗" >&2
echo "║  SOURCE CITATION VIOLATION — commit blocked                         ║" >&2
echo "║  coding-standards.md §8: every number ≥3 sig-digits needs          ║" >&2
echo "║  an adjacent '// source: <citation>' comment.                       ║" >&2
echo "╚══════════════════════════════════════════════════════════════════════╝" >&2
echo "" >&2
echo "Violations found in staged files:" >&2
echo "" >&2

for v in "${VIOLATIONS[@]}"; do
  echo "  CITATION-REQUIRED: $v" >&2
done

echo "" >&2
echo "Fix: add '// source: <paper, benchmark, or empirical measurement>' on" >&2
echo "     the same line or the line immediately before the numeric constant." >&2
echo "     Example: const TIMEOUT_MS = 30_000; // source: measured p99 latency, 2026-04-26" >&2
echo "" >&2

exit 2
