/**
 * stub-detector.ts — Pure logic, no I/O.
 *
 * A "stub page" is one whose body is mostly placeholder markers:
 * ``_(to be filled)_``, ``_To be written._``, ``_(none identified)_``,
 * ``(TBD)``. These are typically produced by:
 *
 *   - The groomer adding canonical template sections with placeholder
 *     text when the source memory had no content for that section.
 *   - Template-based synthesizers that expanded a thin memory into a
 *     multi-section skeleton.
 *
 * Stub pages are noise. A reader opening the wiki sees them and
 * concludes the documentation is untrustworthy. They must be purged,
 * and the producers that emit them must be changed to leave sections
 * short rather than padded with placeholders.
 *
 * This module defines:
 *
 *   - ``PLACEHOLDER_PATTERNS`` — the recognised marker variants.
 *   - ``stubScore(body)`` — fraction of body content lines that are
 *     placeholder-only. Returns 0.0 for a substantive page, approaches
 *     1.0 as the body becomes pure placeholders.
 *   - ``isStub(body, threshold=0.5)`` — boolean shorthand: true iff
 *     ``stubScore`` exceeds the threshold.
 *
 * Source for the threshold: hand-inspected the 14 stub Lessons and 50
 * stub Specs from the 2026-05-18 audit. Pages with ``stubScore >= 0.5``
 * were 100% noise; pages with score in (0.0, 0.5) were mixed — some
 * real content, some placeholders. Default 0.5 is the conservative bar
 * that removes the obvious noise without touching mixed pages.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py
 */

// ── Recognised placeholder markers ────────────────────────────────────

/**
 * Anchored regexes for the placeholder marker variants the groomer
 * and template synthesizers emit. Anchored at start/end so a
 * placeholder embedded inside a sentence isn't matched — only a line
 * that IS a placeholder marker matches.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py:41-54
 */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  // Groomer placeholders.
  /^_\(none identified\)_\s*$/,
  /^_\(to be filled\)_\s*$/,
  /^_To be written\._\s*$/,
  /^_TBD_\s*$/i,
  // Looser variants (no surrounding underscores).
  /^\(none identified\)\s*$/,
  /^\(to be filled\)\s*$/,
  /^To be written\.?\s*$/,
  /^TBD\s*$/,
  // Boilerplate "(to be filled)" embedded in headings — entire line
  // ends in the marker.
  /.*\(to be filled\)\s*$/i,
];

const HEADING_RE = /^#{1,6}\s+\S/;
const BLANK_RE = /^\s*$/;

function isPlaceholderLine(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(stripped)) return true;
  }
  return false;
}

/**
 * A content line is one that contributes meaning — not a heading,
 * not blank, not a horizontal rule, not a fence marker.
 *
 * Headings are excluded because they belong to the template structure,
 * not the authored prose; a page consisting of headings + placeholders
 * is a stub.
 */
function isContentLine(line: string): boolean {
  if (BLANK_RE.test(line)) return false;
  const stripped = line.trim();
  if (HEADING_RE.test(stripped)) return false;
  if (stripped === "---" || stripped === "***" || stripped === "```") return false;
  if (stripped.startsWith("```")) return false;
  return true;
}

/**
 * Fraction of content lines that are placeholder markers.
 *
 * Returns 0.0 when the body has no placeholder content (or no content
 * at all — see ``isStub`` for the empty-body case). 1.0 when every
 * non-heading non-blank line is a placeholder marker.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py:91-104
 */
export function stubScore(body: string): number {
  if (!body) return 0.0;
  const contentLines = body.split("\n").filter(isContentLine);
  if (contentLines.length === 0) return 0.0;
  const placeholderLines = contentLines.filter(isPlaceholderLine);
  return placeholderLines.length / contentLines.length;
}

// Default threshold — see module docstring for calibration.
// source: cortex/mcp_server/core/wiki_stub_detector.py:108 — DEFAULT_STUB_THRESHOLD = 0.5
export const DEFAULT_STUB_THRESHOLD = 0.5;

/**
 * True iff the body's stub score meets or exceeds ``threshold``.
 *
 * Also returns true for a body that contains *any* content lines and
 * *all* of them are placeholder markers, regardless of threshold — a
 * page whose entire authored content is placeholders is unambiguously
 * a stub.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py:111-122
 */
export function isStub(body: string, threshold: number = DEFAULT_STUB_THRESHOLD): boolean {
  const score = stubScore(body);
  if (score >= 1.0) return true;
  return score >= threshold;
}

/**
 * Total placeholder marker lines in the body. Useful for reporting
 * aggregate noise across the wiki without re-deriving the score.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py:125-131
 */
export function placeholderCount(body: string): number {
  if (!body) return 0;
  return body.split("\n").filter(isPlaceholderLine).length;
}

// ── Shallow-content detector ──────────────────────────────────────────
//
// A page is *shallow* when its body has very little actual prose — it's
// mostly headings, lists, metadata key-value lines, and code fences.
// These pages occur en masse from auto-generators (``codebase_analyze``,
// template synthesizers) that produced one file-doc per source file
// with body shape:
//
//     # File: foo.py
//     Language: python
//     Purpose: foo.py — one-liner.
//     ## Imports
//     - bar
//     - baz
//     N lines
//
// Such pages aren't *wrong*, but they aren't *explanations* either.
// They take space in the tree, mislead readers into thinking the
// project is documented when it isn't, and the curator can't tell
// them apart from real reference pages without this signal.
//
// source: cortex/mcp_server/core/wiki_stub_detector.py:134-204

// 30 = max metadata-key length matched ("Language", "Last reviewed",
// "Last reconsolidated" etc.). Tracked in cortex's pattern.
// source: cortex/mcp_server/core/wiki_stub_detector.py:155-157
const KV_METADATA_LINE = /^[A-Z][a-zA-Z _\-]{0,30}:\s*\S/;
const LIST_BULLET = /^(?:[-*+]\s|\d+\.\s)/;

/**
 * Count characters of actual prose in ``body``.
 *
 * Excludes: headings (lines starting with ``#``), list items, code
 * fences and their contents, blank lines, and key-value metadata
 * lines. What remains is what a reader would call "the explanation".
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py:161-188
 */
export function proseCharCount(body: string): number {
  if (!body) return 0;
  let total = 0;
  let inFence = false;
  for (const ln of body.split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    if (s.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (s.startsWith("#")) continue;
    if (LIST_BULLET.test(s)) continue;
    if (KV_METADATA_LINE.test(s)) continue;
    total += s.length;
  }
  return total;
}

// Default threshold below which a page is considered shallow. Calibrated
// on the 2026-05-18 audit: 96% of surviving auto-gen pages had under
// 500 chars of real prose; hand-authored pages typically have 2000+.
// source: cortex/mcp_server/core/wiki_stub_detector.py:194 — DEFAULT_SHALLOW_THRESHOLD = 500
export const DEFAULT_SHALLOW_THRESHOLD = 500;

/**
 * True when the body has fewer than ``threshold`` prose chars.
 *
 * A shallow page isn't a stub (it doesn't have placeholder markers),
 * isn't a classifier-reject (the content is on-topic), but it isn't
 * an *explanation* either — it's metadata dressed up as a page.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py:197-204
 */
export function isShallow(body: string, threshold: number = DEFAULT_SHALLOW_THRESHOLD): boolean {
  return proseCharCount(body) < threshold;
}
