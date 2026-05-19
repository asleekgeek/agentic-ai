/**
 * prompt-sections.ts — Shared prompt fragments for wiki authoring jobs.
 *
 * Three authoring flavours all feed the same LLM:
 *   - Cluster-driven (auto-curator)         → ``buildAuthoringPrompt``
 *   - Coverage-driven (coverage-jobs)        → ``buildCoveragePrompt``
 *   - Drift re-authoring (reauthor-jobs)     → ``buildReauthorPrompt``
 *
 * The three prompts share the same memory-rendering rules, the same
 * related-pages cross-link rules, and the same kind-specific section
 * requirements (ADR task-record vs Diátaxis-shaped explanation). This
 * module centralises those fragments so the three prompts cannot
 * drift apart silently.
 *
 * Pure strings + helpers. No I/O.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py (2026-05-18)
 */

// ── Memory-block budget ───────────────────────────────────────────────

// Maximum memories injected into any one prompt. Calibrated on Cortex's
// 2026-05 token-budget audit: 25 memories × 1200 chars ≈ 30 KB body,
// well within Opus 4.7's working memory.
// source: cortex/mcp_server/core/auto_curator.py:MAX_MEMORIES_PER_PROMPT
export const MAX_MEMORIES_PER_PROMPT = 25;

// Per-memory body truncation. Same source.
// source: cortex/mcp_server/core/auto_curator.py:1200 (memory truncation cap)
export const MEMORY_BODY_PROMPT_CAP = 1200;

// ── Kind-specific section blocks ──────────────────────────────────────

/**
 * Mandatory section block for ``kind: adr`` task-records.
 *
 * ADRs now double as task-records — every completed task gets one,
 * structured so a future reader can reconstruct what triggered the
 * work, what constraints applied, how it was solved, what was
 * delivered, and what it enables.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:_ADR_TASK_RECORD_SECTIONS (2026-05-18)
 */
export const ADR_TASK_RECORD_SECTIONS =
`For kind = \`adr\` (task-record): the body MUST carry these sections in this exact order. They are mandatory — no skipping:

1. **## Status** — \`proposed\` / \`accepted\` / \`rejected\` / \`superseded\`. New task-records default to \`accepted\` (the work is done).
2. **## Entry** — the problem, task, or trigger as it stood before the work began. State the symptom or the request; do not speculate about root cause yet.
3. **## Mandatory elements** — constraints that had to be respected: Clean Architecture / SOLID rules, layer dependency rule, project invariants (no SQLite, source-citation discipline, file-size limits), compatibility windows, security gates, paper-grounded equations, contracts with upstream/downstream systems. Be specific. List, not prose.
4. **## How** — the approach taken: implementation steps, technical choices, the sequence of moves. Reference specific source files with full paths. Name alternatives that were tried and abandoned.
5. **## Result** — what was actually delivered. Cite the commit hash, the benchmark run, or the artifact that proves the outcome. If partial, state precisely what is and is not done.
6. **## Serves** — what this enables downstream. Which subsystem depends on it, which invariant it upholds, which user-visible behaviour it supports. The "why it stays in the codebase" answer.
7. **## Alternatives considered** — formally-considered-and-rejected designs (distinct from "things we tried"; those go in How).
8. **## References** — paper citations, ADR cross-refs as \`[[adr/...]]\`, related task-records.
`;

/**
 * Generic Diátaxis-shaped section block for ``kind: reference`` /
 * ``kind: explanation`` / others.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:_GENERIC_STRUCTURE_SECTIONS (2026-05-18)
 */
export const GENERIC_STRUCTURE_SECTIONS =
`For kind = \`reference\` / \`explanation\` / other: the body MUST carry every section below. A wiki page is only useful if it covers everything a reader could need; missing sections create stale documentation nobody maintains.

1. **# <title>** — H1 matching frontmatter title.
2. **Lead paragraph** — one paragraph saying what the page is and why a reader should care.
3. **## Architecture** — where this fits in the layer model. Cite the directories that map to each layer.
4. **## Sequence diagram** — a \`\`\`mermaid sequenceDiagram\`\`\` showing the typical call flow (caller → this subject → callees → return). MANDATORY — write "Not applicable — this is a pure data type, no sequence flow exists" and explain why when the subject really has no sequence. Do not skip the heading.
5. **## Flow diagram** — a \`\`\`mermaid flowchart\`\`\` (TB or LR) for any branching logic, lifecycle, or state machine. For tree-shaped data, render the tree as a flowchart. MANDATORY — same fallback rule as sequence diagram.
6. **## Public surface** — every exported symbol / endpoint / CLI flag with semantic + stability flag. Use a table.
7. **## Parameters** — exhaustive table (name | type | required | default | description) for every public entry point. Write "Not applicable" only when the subject exposes no parameter surface.
8. **## Request example** — concrete example: curl + headers for HTTP, JSON-RPC envelope for MCP, call site for library. Show headers explicitly; never elide.
9. **## Response example** — every field annotated; include both success and the most common error shape.
10. **## How it works** — walk-through of the internal logic. Quote short representative source snippets with full paths (e.g. \`\`packages/memory/src/wiki/predictive-coding-gate.ts:42\`\`).
11. **## Invariants** — what must always be true. Layer-boundary contracts, thread-safety, idempotency.
12. **## What can go wrong** — failure modes with concrete symptoms the reader will recognise in a stack trace or log.
13. **## Why this design and not the alternatives** — what was considered, what was rejected, why.
14. **## Performance characteristics** — latency / throughput / memory footprint where measured. Cite the benchmark file or measurement date.
15. **## Tests** — which test files exercise this and what each covers.
16. **## See also** — cross-links to related pages using \`[[wiki/path]]\` notation, plus specific source files. Use the actual canonical paths the wiki tree contains.
17. **## Primary sources** — paper citations, RFCs, upstream documentation. Cite the full reference, not "the docs."

Conventions, non-negotiable:
- Every section heading appears even when the content is "Not applicable" — empty sections are the curation surface that lets the autonomous loop fill them in. Hiding a heading hides the gap.
- Tables and diagrams beat prose for anything enumerable or structural.
- Cite source paths with line numbers for any specific behaviour. "It's in the code" is not a citation.
- \`\`\`mermaid\`\`\` fences must specify a diagram type (sequenceDiagram / flowchart / classDiagram / stateDiagram / erDiagram).
`;

/**
 * Return the structural-sections instructions for the given kind.
 *
 * ADR / task-record pages get the Entry/Mandatory/How/Result/Serves
 * requirement; everything else gets the generic Diátaxis-shaped
 * explanation/reference structure.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:_kind_specific_sections
 */
export function kindSpecificSections(kind: string): string {
  if (kind === "adr") return ADR_TASK_RECORD_SECTIONS;
  return GENERIC_STRUCTURE_SECTIONS;
}

// ── Block-rendering helpers ───────────────────────────────────────────

/**
 * Render a list of memory contents as labelled markdown sub-sections.
 *
 * Each memory is capped at MEMORY_BODY_PROMPT_CAP chars to keep the
 * prompt within budget while preserving enough context for the LLM to
 * synthesise. The full content remains retrievable via the recall tool.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:_memories_block
 */
export function memoriesBlock(
  contents: readonly string[],
  tags: readonly (readonly string[])[],
  cap: number = MAX_MEMORIES_PER_PROMPT,
): string {
  const capped = contents.slice(0, cap);
  const blocks: string[] = [];
  capped.forEach((content, i) => {
    const t = tags[i] ?? [];
    let head = content.slice(0, MEMORY_BODY_PROMPT_CAP).trimEnd();
    if (content.length > MEMORY_BODY_PROMPT_CAP) {
      head += "\n...[memory truncated, full content available via recall]";
    }
    const tagStr = t.length > 0 ? t.join(", ") : "(no tags)";
    blocks.push(`### Memory ${i + 1} (tags: ${tagStr})\n\n${head}`);
  });
  return blocks.length > 0 ? blocks.join("\n\n") : "(none — cluster filtered out)";
}

/**
 * Render a list of related wiki page paths as a bulleted [[link]] block.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:_related_block
 */
export function relatedBlock(relatedPages: readonly string[]): string {
  if (relatedPages.length === 0) return "(none yet — this is a fresh topic)";
  return relatedPages.map((p) => `- [[${p}]]`).join("\n");
}

// ── Simple template formatter ─────────────────────────────────────────

/**
 * Replace ``{key}`` tokens in a template with values from ``vars``.
 *
 * Unknown keys are preserved verbatim (``{unknown_key}``) so a missing
 * substitution is visible in the prompt rather than silently elided.
 *
 * source: cortex@47b818d auto_curator.py — Python uses str.format, mirrored
 */
export function formatPrompt(
  template: string,
  vars: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined ? `{${k}}` : String(v);
  });
}
