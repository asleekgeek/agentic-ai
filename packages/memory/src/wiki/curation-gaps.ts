/**
 * curation-gaps.ts — Curation-gap detector for file-doc pages (G4).
 *
 * User direction 2026-05-18: "Removing is not a solution, fixing the
 * curation by showing information that should be present and missing
 * for each file is a curation of the documentation."
 *
 * This module operationalises that policy. Given a wiki page (typically
 * a per-source-file reference), it identifies which sections SHOULD be
 * present for a real curated explanation and which are absent. The
 * list of missing sections is:
 *
 *   1. Embedded in the page frontmatter as ``curation_gaps: [...]``.
 *   2. Rendered prominently at the top of the page by the wiki view.
 *   3. Queued as re-author jobs by the auto-curator so the in-session
 *      LLM fills the gaps over time.
 *
 * Nothing here deletes content. Pages with gaps stay on disk; the gaps
 * are surfaced so the reader knows what's coming and the author knows
 * what to write.
 *
 * Pure logic — no I/O. Callers pass body text.
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py
 */

// ── Section catalogue for a file-doc page ──────────────────────────
//
// Every file-doc page should answer these questions. Each entry has:
//   - name:      slug used in frontmatter ``curation_gaps``.
//   - heading:   the H2 the LLM should write under.
//   - probes:    patterns that, if present in the body, signal the
//                section is covered. A page satisfies the section
//                when at least one probe hits — usually the heading
//                itself plus content under it.
//   - minCharsUnderHeading: extra signal — a heading present but
//                with under N chars of prose under it doesn't count
//                as covered (it's a placeholder skeleton).
//   - description: what the LLM should write under this heading.

export interface CurationSection {
  readonly name: string;
  readonly heading: string;
  readonly probes: readonly string[];
  readonly minCharsUnderHeading: number;
  readonly description: string;
}

// Per-section minimum-prose thresholds. Calibrated on Cortex's 2026-05
// audit — a section with fewer than N chars of real prose under it
// reads as a placeholder skeleton, not a curated section.
// source: cortex/mcp_server/core/wiki_curation_gaps.py:54-149 — FILE_DOC_SECTIONS
const MIN_PURPOSE       = 200; // source: cortex wiki_curation_gaps.py:62 (CurationSection.purpose)
const MIN_PUBLIC_API    = 150; // source: cortex wiki_curation_gaps.py:72 (CurationSection.public-api)
const MIN_DEPENDENCIES  = 80;  // source: cortex wiki_curation_gaps.py:82 (CurationSection.dependencies)
const MIN_CALLERS       = 100; // source: cortex wiki_curation_gaps.py:92 (CurationSection.callers)
const MIN_BEHAVIOUR     = 400; // source: cortex wiki_curation_gaps.py:102 (CurationSection.behaviour)
const MIN_INVARIANTS    = 80;  // source: cortex wiki_curation_gaps.py:112 (CurationSection.invariants)
const MIN_FAILURE_MODES = 120; // source: cortex wiki_curation_gaps.py:122 (CurationSection.failure-modes)
const MIN_TESTS         = 80;  // source: cortex wiki_curation_gaps.py:132 (CurationSection.tests)
// New 2026-05-18 sections — the four below need higher-substance content
// because they're the surfaces a reader leans on most when integrating.
const MIN_SEQUENCE_DIAGRAM = 120; // source: cortex wiki_curation_gaps.py:155 (sequence-diagram)
const MIN_PARAMETERS       = 120; // source: cortex wiki_curation_gaps.py:170 (parameters)
const MIN_REQUEST_EXAMPLE  = 120; // source: cortex wiki_curation_gaps.py:189 (request-example)
const MIN_RESPONSE_EXAMPLE = 120; // source: cortex wiki_curation_gaps.py:211 (response-example)

/**
 * Sections every file-doc must cover. The list is deliberately stable —
 * adding/removing a section is a deliberate policy edit, not an
 * emergent property of the audit.
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py:54-149 (FILE_DOC_SECTIONS)
 */
export const FILE_DOC_SECTIONS: readonly CurationSection[] = [
  {
    name: "purpose",
    heading: "## Purpose",
    probes: ["## Purpose", "## What this file does"],
    minCharsUnderHeading: MIN_PURPOSE,
    description:
      "What this file is responsible for, in two to four sentences. " +
      "Not a restatement of the filename — what behaviour it owns, " +
      "what it must NOT do, where its boundary lies.",
  },
  {
    name: "public-api",
    heading: "## Public API",
    probes: ["## Public API", "## API", "## Exports"],
    minCharsUnderHeading: MIN_PUBLIC_API,
    description:
      "Each exported symbol (function, class, constant) with a " +
      "one-line semantic — what it does, what it returns, when " +
      "to call it. NOT a bare list of names.",
  },
  {
    name: "dependencies",
    heading: "## Dependencies",
    probes: ["## Dependencies", "## Imports", "## Uses"],
    minCharsUnderHeading: MIN_DEPENDENCIES,
    description:
      "Why each import is here. 'json' is uninteresting; " +
      "'sentence_transformers' (the embedding model) is. " +
      "Group standard-library imports separately.",
  },
  {
    name: "callers",
    heading: "## Callers",
    probes: ["## Callers", "## Used by", "## Consumers"],
    minCharsUnderHeading: MIN_CALLERS,
    description:
      "Which files in the project depend on this one. The author " +
      "should grep the repo for imports of this module and list " +
      "the top callers with one-line context.",
  },
  {
    name: "behaviour",
    heading: "## How it works",
    probes: ["## How it works", "## Behaviour", "## Behavior", "## Implementation"],
    minCharsUnderHeading: MIN_BEHAVIOUR,
    description:
      "Walk through the file's main flow: entry point, key " +
      "branches, state transitions. Diagram (mermaid) preferred " +
      "for anything sequence-shaped.",
  },
  {
    name: "invariants",
    heading: "## Invariants",
    probes: ["## Invariants", "## Constraints", "## Contracts"],
    minCharsUnderHeading: MIN_INVARIANTS,
    description:
      "What must always be true about this file's outputs / " +
      "internal state. Layer-boundary contracts, type guarantees, " +
      "thread-safety, idempotency. Empty 'none' is fine when " +
      "truly none — say so explicitly.",
  },
  {
    name: "failure-modes",
    heading: "## What can go wrong",
    probes: ["## What can go wrong", "## Failure modes", "## Errors"],
    minCharsUnderHeading: MIN_FAILURE_MODES,
    description:
      "How this file can fail in production and what the symptom " +
      "looks like. The reader should be able to recognise the " +
      "failure from a stack trace or log line.",
  },
  {
    name: "tests",
    heading: "## Tests",
    probes: ["## Tests", "## Test coverage", "## Testing"],
    minCharsUnderHeading: MIN_TESTS,
    description:
      "Which test files exercise this file. Path + brief on what " +
      "each test covers.",
  },
  // ── 2026-05-18 expansion ──────────────────────────────────────────
  {
    name: "sequence-diagram",
    heading: "## Sequence diagram",
    probes: [
      "## Sequence diagram",
      "## Flow diagram",
      "## Sequence",
      "```mermaid\nsequenceDiagram",
    ],
    minCharsUnderHeading: MIN_SEQUENCE_DIAGRAM,
    description:
      "A `mermaid` sequence diagram of the typical call flow involving " +
      "this file — caller → this file → callees → return. Render with " +
      "```mermaid sequenceDiagram fences. For files that participate in " +
      "no sequence (pure data types, constants), explicitly write " +
      "\"Not applicable — this file participates in no sequence flow\" " +
      "and explain why.",
  },
  {
    name: "parameters",
    heading: "## Parameters",
    probes: ["## Parameters", "## Arguments", "## Options"],
    minCharsUnderHeading: MIN_PARAMETERS,
    description:
      "Exhaustive table of every parameter exposed by this file's " +
      "public entry points. Columns: name | type | required | default | " +
      "description. For files with no external parameter surface " +
      "(internal helpers, pure data), write \"Not applicable — this " +
      "file exposes no external parameters.\"",
  },
  {
    name: "request-example",
    heading: "## Request example",
    probes: [
      "## Request example",
      "## Example request",
      "## Request",
      "## Invocation example",
    ],
    minCharsUnderHeading: MIN_REQUEST_EXAMPLE,
    description:
      "A concrete request example — for HTTP handlers, the full curl " +
      "command including headers (Content-Type, Authorization, custom " +
      "headers); for MCP tools, the JSON-RPC envelope with `method` and " +
      "`params`; for library functions, the call site as it would appear " +
      "in client code. Show headers explicitly — never omit them. For " +
      "files that don't sit on a request boundary, write \"Not applicable " +
      "— this file is not invoked directly by callers; see [[Callers]] " +
      "for the call chain.\"",
  },
  {
    name: "response-example",
    heading: "## Response example",
    probes: [
      "## Response example",
      "## Example response",
      "## Response",
      "## Return value",
    ],
    minCharsUnderHeading: MIN_RESPONSE_EXAMPLE,
    description:
      "A concrete response example showing every field the caller " +
      "receives — JSON for HTTP / MCP, return-value structure for " +
      "library functions. Each non-obvious field annotated with one " +
      "line explaining what it means. Include both success and the " +
      "most common error shape if applicable. For files that produce " +
      "no response surface, write \"Not applicable — this file does " +
      "not produce a response artifact.\"",
  },
];

// ── Heading + body extraction ──────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Return the prose under ``heading`` (up to the next H2+) or null when
 * the heading is absent.
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py:_section_body:152-175
 */
function sectionBody(body: string, heading: string): string | null {
  const target = heading.trim();
  const lines = body.split("\n");
  let inSection = false;
  let targetDepth: number | null = null;
  const out: string[] = [];
  for (const ln of lines) {
    const m = HEADING_RE.exec(ln);
    if (m) {
      const hashes = m[1] ?? "";
      const headingText = (m[2] ?? "").trim();
      const depth = hashes.length;
      const text = "#".repeat(depth) + " " + headingText;
      if (text === target) {
        inSection = true;
        targetDepth = depth;
        continue;
      }
      if (inSection && depth <= (targetDepth ?? Number.MAX_SAFE_INTEGER)) {
        break;
      }
    }
    if (inSection) out.push(ln);
  }
  if (!inSection) return null;
  return out.join("\n").trim();
}

// Bullet markers excluded from prose count.
// source: cortex/mcp_server/core/wiki_curation_gaps.py:_meaningful_chars
const BULLET_PREFIXES = ["#", "-", "*", "+"];

/**
 * Count chars of real prose in ``text``. Skips:
 *   - blank lines
 *   - heading lines (anything starting with ``#``)
 *   - bullet markers (``-``, ``*``, ``+``)
 *   - code fence boundaries (``` ``` ```) and their contents
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py:_meaningful_chars:178-194
 */
function meaningfulChars(text: string): number {
  let count = 0;
  let inFence = false;
  for (const ln of text.split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    if (s.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (BULLET_PREFIXES.some((p) => s.startsWith(p))) continue;
    count += s.length;
  }
  return count;
}

// ── Missing-section detection ──────────────────────────────────────

/**
 * Return the canonical sections this file-doc is missing.
 *
 * A section is considered missing when EITHER:
 *   - No probe heading appears in the body, OR
 *   - A probe heading appears but has fewer than its
 *     ``minCharsUnderHeading`` of prose under it.
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py:missing_sections
 */
export function missingSections(body: string): CurationSection[] {
  const out: CurationSection[] = [];
  for (const section of FILE_DOC_SECTIONS) {
    let found = false;
    for (const probe of section.probes) {
      const secBody = sectionBody(body, probe);
      if (secBody == null) continue;
      if (meaningfulChars(secBody) >= section.minCharsUnderHeading) {
        found = true;
        break;
      }
      // Heading exists but body is too thin — keep iterating other
      // probes; if no probe matches with substance, the section is
      // marked missing.
    }
    if (!found) out.push(section);
  }
  return out;
}

// ── Structured gap report ──────────────────────────────────────────

export interface GapReport {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly missing_titles: readonly string[];
  readonly missing_descriptions: readonly string[];
  readonly completion_pct: number;
  readonly total_sections: number;
  readonly covered_sections: number;
}

// Round completion_pct to two decimals for wire stability.
// source: cortex/mcp_server/core/wiki_curation_gaps.py:gap_report — round(..., 2)
const PCT_ROUND_PRECISION = 100;

/**
 * Return a structured gap report for embedding in frontmatter and UI.
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py:gap_report
 */
export function gapReport(body: string): GapReport {
  const missing = missingSections(body);
  const total = FILE_DOC_SECTIONS.length;
  const covered = total - missing.length;
  const pct = total === 0
    ? 1.0
    : Math.round((covered / total) * PCT_ROUND_PRECISION) / PCT_ROUND_PRECISION;
  return {
    complete: missing.length === 0,
    missing: missing.map((s) => s.name),
    missing_titles: missing.map((s) => s.heading),
    missing_descriptions: missing.map((s) => s.description),
    completion_pct: pct,
    total_sections: total,
    covered_sections: covered,
  };
}

// ── Banner rendering ───────────────────────────────────────────────

/**
 * Render a Markdown banner the wiki view shows above the page body.
 *
 * The banner lists every missing section with its description so the
 * reader sees concretely what's not yet written and the LLM (or human
 * author) knows exactly what to add next. Empty string when the page
 * is complete.
 *
 * source: cortex/mcp_server/core/wiki_curation_gaps.py:render_gap_banner
 */
export function renderGapBanner(gap: GapReport): string {
  if (gap.complete) return "";
  const missing = gap.missing;
  if (missing.length === 0) return "";
  const titles = gap.missing_titles;
  const descs = gap.missing_descriptions;
  const lines: string[] = [];
  // source: cortex/mcp_server/core/wiki_curation_gaps.py:render_gap_banner — int(... * 100)
  const PCT_DISPLAY_SCALE = 100;
  const pct = Math.floor(gap.completion_pct * PCT_DISPLAY_SCALE);
  lines.push(
    `> ⚠ **This page is ${pct}% curated.** ${missing.length} section` +
    `${missing.length === 1 ? "" : "s are"} missing or too thin to count. ` +
    "The autonomous re-author loop will fill them, or you can author " +
    "them now — what's needed:",
  );
  lines.push(">");
  for (let i = 0; i < missing.length; i++) {
    const name = missing[i] ?? `section-${i}`;
    const title = (titles[i] ?? `## ${name}`).replace(/^#+\s*/, "").trim();
    const desc = descs[i] ?? "";
    lines.push(`> * **${title}** — ${desc}`);
  }
  return lines.join("\n") + "\n";
}
