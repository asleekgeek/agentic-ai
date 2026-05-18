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
`For kind = \`reference\` / \`explanation\` / other: the body should follow this conventional shape:

1. **# <title>** — H1 matching frontmatter title.
2. **Lead paragraph** — one paragraph saying what the page is and why a reader should care.
3. **Sections explaining the topic**:
   - Use \`\`\`mermaid\`\`\` fences for flowcharts, sequence diagrams, state diagrams when the topic involves dataflow or state transitions.
   - Use tables for taxonomies, parameter lists, comparisons.
   - Use \`\`\` fences with language for code snippets.
   - Cite specific source files with full paths (e.g. \`\`packages/memory/src/wiki/predictive-coding-gate.ts\`\`).
4. **## Why this design and not the alternatives** — explain the architectural choice. What was considered, what was rejected, why.
5. **## What can go wrong** — failure modes the next reader should know about, with concrete symptoms.
6. **## See also** — cross-links to related pages using \`[[wiki/path]]\` notation, plus specific source files.
7. **## Primary sources** — if the topic touches research literature, cite the actual papers with full citations.
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
