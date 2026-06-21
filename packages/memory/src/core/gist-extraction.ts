/**
 * Deterministic gist extraction for oversized auto-captured tool output.
 *
 * Pure logic, zero I/O. The hook (post_tool_capture) and the import/backfill
 * handlers store full raw output to a filesystem artifact and keep only a
 * bounded *gist* in the memory body, plus a pointer line to the artifact.
 * Nothing is dropped — the raw output is one `Read` away — so this satisfies
 * the "no truncation of available information" directive while removing the
 * ts_rank_cd length-frequency bias that makes a 120 KB Bash dump outrank a
 * curated lesson (M2 root cause, write side — see
 * docs/provenance/bounded-io-phase2-design.md F3).
 *
 * Gist composition is deterministic (no LLM): a head slice + the high-value
 * signal lines + a tail slice, filled sequentially within the budget. The
 * 40/60/100 fill boundaries are structural (readability of the helper), not
 * tuned — any monotone split keeps the same retrieval hooks (error/traceback/
 * failed/pass lines) inside the gist regardless of where they sit in the dump.
 *
 * source: cortex main mcp_server/core/gist_extraction.py
 */

// source: measured p90 curated memory length, production DB 2026-06-10
// (3,041 chars, n=68) — see docs/provenance/bounded-io-phase2-design.md. Makes
// auto-captures size-comparable to curated content, removing the
// ts_rank_cd length-frequency bias (M2/H5).
export const GIST_BUDGET = 3000;

// Sequential-fill boundaries as fractions of the budget. Structural
// (readability), not tuned: head fills to HEAD_FRACTION, signal lines fill
// to SIGNAL_FRACTION, tail fills the remainder. Any monotone split keeps
// the signal lines (the retrieval hooks) inside the gist.
// source: cortex main mcp_server/core/gist_extraction.py — _HEAD_FRACTION
const HEAD_FRACTION = 0.4;
// source: cortex main mcp_server/core/gist_extraction.py — _SIGNAL_FRACTION
const SIGNAL_FRACTION = 0.6;

// Keywords that signal high-value content. Canonical home: this list was
// moved here from post_tool_capture._HIGH_VALUE_PATTERNS so the hook imports
// it from core (hooks → core is the legal direction) and the gist signal
// lines stay consistent with what the hook treats as high-value.
// source: cortex main mcp_server/core/gist_extraction.py — HIGH_VALUE_PATTERNS
export const HIGH_VALUE_PATTERNS: readonly string[] = [
  "error",
  "exception",
  "traceback",
  "failed",
  "failure",
  "fixed",
  "resolved",
  "success",
  "deployed",
  "migrated",
  "decided",
  "chose",
  "switched",
  "selected",
  "created",
  "deleted",
  "moved",
  "refactored",
  "test",
  "assert",
  "pass",
  "fail",
  "warning",
  "deprecated",
];

/**
 * True when output exceeds the gist budget and should be artifact-backed.
 *
 * Pre: output is a string.
 * Post: returns `output.length > GIST_BUDGET`.
 *
 * source: cortex main mcp_server/core/gist_extraction.py:needs_gist
 */
export function needsGist(output: string): boolean {
  return output.length > GIST_BUDGET;
}

/** Elision marker line recording how much of the output the gist kept. */
function elision(kept: number, total: number): string {
  return `… [gist: ${kept} of ${total} chars — full output in artifact] …`;
}

/** True when a line contains any high-value pattern (case-insensitive). */
function isSignalLine(line: string): boolean {
  const lower = line.toLowerCase();
  return HIGH_VALUE_PATTERNS.some((kw) => lower.includes(kw));
}

/**
 * Deterministic head + signal + tail gist of `output` within `budget`.
 *
 * Pre: output is a string; budget is a positive int.
 * Post: never throws; returns a string whose length is ≤
 * `budget` + a small fixed overhead (one elision marker line). When
 * `output` already fits the budget it is returned unchanged. Signal lines
 * (matching HIGH_VALUE_PATTERNS) that fall outside the head/tail windows are
 * retained as long as the signal budget allows — an error line buried in the
 * middle of a long dump survives.
 *
 * Composition (sequential fill, structural boundaries):
 *   1. head lines until cumulative length reaches HEAD_FRACTION · budget
 *   2. signal lines not already taken, until SIGNAL_FRACTION · budget
 *   3. tail lines (from the end) until the remaining budget is exhausted
 * Order in the result is head → signal → tail with an elision marker at the
 * gap so the reader knows content was elided.
 *
 * source: cortex main mcp_server/core/gist_extraction.py:extract_gist
 */
export function extractGist(output: string, budget: number = GIST_BUDGET): string {
  if (output.length <= budget) {
    return output;
  }

  const lines = splitLines(output);
  const taken = new Set<number>();

  const head = fillHead(lines, Math.trunc(budget * HEAD_FRACTION), taken);
  const signal = fillSignal(
    lines,
    head.headEnd,
    Math.trunc(budget * SIGNAL_FRACTION),
    head.used,
    taken,
  );
  const tail = fillTail(lines, head.headEnd, budget, signal.used, taken);

  const segments: string[] = [];
  if (head.parts.length > 0) {
    segments.push(head.parts.join("\n"));
  }
  if (signal.parts.length > 0) {
    segments.push(signal.parts.join("\n"));
  }
  // One elision marker before the tail records what the gist dropped.
  segments.push(elision(tail.used, output.length));
  if (tail.parts.length > 0) {
    segments.push(tail.parts.join("\n"));
  }
  return segments.join("\n");
}

/**
 * Split into lines the way Python's str.splitlines() does for the cases that
 * matter here: split on \n, dropping a single trailing newline's empty tail.
 * Mirrors CPython splitlines (keepends=False) for \n/\r\n input.
 */
function splitLines(output: string): string[] {
  const normalized = output.split(/\r\n|\r|\n/);
  if (normalized.length > 0 && normalized[normalized.length - 1] === "") {
    normalized.pop();
  }
  return normalized;
}

interface HeadFill {
  parts: string[];
  headEnd: number;
  used: number;
}

interface Fill {
  parts: string[];
  used: number;
}

/**
 * Take leading lines until cumulative length reaches `limit`.
 *
 * Returns parts, head-end index, and used chars. Mutates `taken`.
 *
 * source: cortex main mcp_server/core/gist_extraction.py:_fill_head
 */
function fillHead(lines: string[], limit: number, taken: Set<number>): HeadFill {
  const parts: string[] = [];
  let used = 0;
  let headEnd = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    if (used + line.length + 1 > limit) {
      break;
    }
    parts.push(line);
    taken.add(idx);
    used += line.length + 1;
    headEnd = idx + 1;
  }
  return { parts, headEnd, used };
}

/**
 * Take signal lines after the head window until `limit`. Mutates `taken`.
 *
 * source: cortex main mcp_server/core/gist_extraction.py:_fill_signal
 */
function fillSignal(
  lines: string[],
  start: number,
  limit: number,
  usedIn: number,
  taken: Set<number>,
): Fill {
  const parts: string[] = [];
  let used = usedIn;
  for (let idx = start; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    if (taken.has(idx) || !isSignalLine(line)) {
      continue;
    }
    if (used + line.length + 1 > limit) {
      break;
    }
    parts.push(line);
    taken.add(idx);
    used += line.length + 1;
  }
  return { parts, used };
}

/**
 * Take trailing lines (from the end) until `budget`. Mutates `taken`.
 *
 * source: cortex main mcp_server/core/gist_extraction.py:_fill_tail
 */
function fillTail(
  lines: string[],
  start: number,
  budget: number,
  usedIn: number,
  taken: Set<number>,
): Fill {
  const parts: string[] = [];
  let used = usedIn;
  for (let idx = lines.length - 1; idx >= start; idx--) {
    const line = lines[idx] ?? "";
    if (taken.has(idx)) {
      continue;
    }
    if (used + line.length + 1 > budget) {
      break;
    }
    parts.push(line);
    taken.add(idx);
    used += line.length + 1;
  }
  parts.reverse();
  return { parts, used };
}
