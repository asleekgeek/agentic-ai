/**
 * curate-wiki-instructions.ts — Render the LLM-facing instructions
 * block returned by the curate_wiki MCP tool.
 *
 * Extracted from curate-wiki.ts so the handler stays under §4.1.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py:_instructions_for_llm
 */

export interface InstructionCounts {
  readonly nJobs: number;
  readonly nEligible: number;
  readonly nDrift: number;
  readonly nGap: number;
  readonly nScopeCoverage: number;
  readonly nReauthor: number;
}

export function instructionsForLlm(c: InstructionCounts): string {
  const totalWork = c.nJobs + c.nDrift + c.nGap + c.nScopeCoverage + c.nReauthor;
  if (totalWork === 0) {
    return (
      `No curation jobs returned. ${c.nEligible} clusters were eligible. ` +
      "If you expected jobs, relax min_memories or min_avg_heat, or pass " +
      "recent_only=false."
    );
  }

  const lines: string[] = [];
  if (c.nJobs > 0) {
    lines.push(
      `Auto-curator returned ${c.nJobs} cluster job(s) (of ${c.nEligible} eligible).`,
      "For each cluster job in order:",
      "  1. Read `prompt` — cluster's memories + authoring conventions.",
      "  2. Author the page in Markdown following the conventions " +
      "(frontmatter → lead → sections with diagrams → 'why this not " +
      "alternatives' → 'what can go wrong' → 'see also' → primary sources).",
      "  3. Write via `wiki_write(path=<job.suggested_path>, " +
      "content=<markdown>, tags=['wiki', 'llm-authored', <topic>, <domain>])`.",
    );
  }
  if (c.nDrift > 0) {
    lines.push(
      "",
      `Drift refresh: ${c.nDrift} page(s) cite source files that have ` +
      "changed since the page mtime. For each entry in `drift_jobs`:",
      "  1. Read `prompt` — it carries the existing body + the drifted ",
      "     source paths.",
      "  2. Decide per section: same code → keep; drifted code → rewrite; ",
      "     invalidated → drop.",
      "  3. Write via `wiki_write(path=<job.page_path>, ",
      "     content=<markdown>, mode='replace', tags=[…])`.",
    );
  }
  if (c.nGap > 0) {
    lines.push(
      "",
      `Coverage: ${c.nGap} source file(s) have no wiki page yet. For each ` +
      "entry in `coverage_jobs`:",
      "  1. Read `prompt` — it carries the file body + frontmatter spec.",
      "  2. Author a reference page describing what the file does.",
      "  3. Write via `wiki_write(path=<job.suggested_path>, ",
      "     content=<markdown>, tags=['wiki', 'llm-authored', 'reference', ",
      "     <project>])`.",
    );
  }
  if (c.nScopeCoverage > 0) {
    lines.push(
      "",
      `Scope coverage: ${c.nScopeCoverage} canonical scope page(s) missing ` +
      "for some project. For each entry in `scope_coverage_jobs` (in order — " +
      "sorted by structural primacy):",
      "  1. Read `prompt` — it carries the scope description + supporting memories.",
      "  2. Walk the project source tree to ground the page in the actual code.",
      "  3. Write the scope anchor page via `wiki_write(path=<job.suggested_path>, ...)`.",
    );
  }
  if (c.nReauthor > 0) {
    lines.push(
      "",
      `Re-author: ${c.nReauthor} existing page(s) drifted from the source tree. ` +
      "For each entry in `reauthor_jobs`:",
      "  1. Read `prompt` — it carries the existing body + drift reasons.",
      "  2. Preserve every accurate claim, replace stale ones, fill template gaps.",
      "  3. Rewrite via `wiki_write(path=<job.suggested_path>, ` " +
      "`content=<markdown>, mode='replace')` — same path as the original.",
    );
  }
  lines.push(
    "",
    "Call `curate_wiki` again when this batch is done. The " +
    "recently-authored skip filter prevents re-suggestions of pages you " +
    "just wrote. Do not dump raw memory content; synthesise. Each page " +
    "should be 6–15 KB of substantive authored prose, not a template.",
  );
  return lines.join("\n");
}
