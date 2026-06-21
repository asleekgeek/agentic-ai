/**
 * file-coverage.ts — Phase C of the auto-curation system.
 *
 * The cluster-driven curator (cortex main) emits authoring jobs
 * for memory clusters. That covers what the session has TOUCHED — but
 * legacy files never touched in a session have no cluster, so they
 * stay invisible to the curator forever.
 *
 * This module closes that gap. Given a list of source-file paths and
 * the set of existing wiki pages, it derives the wiki path each file
 * SHOULD have, drops files whose page already exists, and emits a
 * coverage-driven curation job for each missing page.
 *
 * Pure logic — no I/O. Caller supplies the file list and the page
 * existence map.
 *
 * User directive (2026-05-17, generalised):
 *   > "Every new task, new bug, new feature, as well as all legacy
 *   > existing element of a project should have the same level of
 *   > importance and should be treated with the same detailed
 *   > approach."
 */

// Slug length cap for derived wiki paths. Matches auto-curator's slug
// length so coverage-driven and cluster-driven paths sit side-by-side
// in the same kind directory.
// source: auto-curator.ts — SLUG_MAX_LEN paired constant
const SLUG_MAX_LEN = 60;
// Maximum file-content bytes embedded in the authoring prompt. Same
// cap as the per-memory body in the cluster prompt; pages above this
// get truncated with a note.
// source: auto-curator.ts — MEMORY_BODY_PROMPT_CAP paired constant
const FILE_BODY_PROMPT_CAP = 4_000;

// ── Path → slug derivation ──────────────────────────────────────────────

/**
 * Derive a wiki-path slug for a source file.
 *
 * ``packages/memory/src/wiki/auto-curator.ts`` → ``auto-curator``
 * ``mcp_server/core/predictive_coding_gate.py`` → ``predictive-coding-gate``
 *
 * Strips the directory prefix, drops the extension, replaces
 * non-alphanumerics with ``-``, caps at SLUG_MAX_LEN. Matches the
 * auto-curator's _slugify() so both sources of coverage land in the
 * same naming space.
 */
export function slugifyFilePath(absOrRelPath: string): string {
  const basename = absOrRelPath.split("/").pop() ?? absOrRelPath;
  const stem = basename.replace(/\.[^.]+$/, "");
  const s = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, SLUG_MAX_LEN).replace(/-+$/, "") || "untitled";
}

/**
 * Build the suggested wiki path for a source file under a project.
 *
 * ``reference/<project>/<slug>.md`` mirrors the auto-curator's
 * ``_kindDir(kind="reference")`` output so coverage and cluster jobs
 * write to the same tree.
 */
export function fileToWikiPath(filePath: string, projectName: string): string {
  return `reference/${projectName}/${slugifyFilePath(filePath)}.md`;
}

// ── Coverage gap ────────────────────────────────────────────────────────

export interface CoverageGap {
  /** Relative source-file path (caller-supplied). */
  readonly sourceFile: string;
  /** Project the file belongs to (caller-supplied). */
  readonly projectName: string;
  /** Wiki path the page SHOULD have. */
  readonly suggestedPath: string;
}

/**
 * Compute the coverage gap: source files that have no wiki page.
 *
 * ``existingPages`` is the set of currently-authored page rel-paths
 * (with or without ``.md`` — both forms are tolerated). A source file
 * whose ``fileToWikiPath`` matches an existing page is considered
 * covered.
 *
 * Pure: no I/O. The caller is responsible for walking the project
 * tree (typically via collectSourceFiles with maxFiles=0 — unbounded
 * — to respect the user's "no legacy left uncovered" ambition).
 */
export function computeCoverageGap(
  sourceFiles: readonly string[],
  projectName: string,
  existingPages: readonly string[],
): CoverageGap[] {
  // Normalise existing page set: strip ``.md`` suffix so both stored
  // forms collide on the same key.
  const existing = new Set<string>();
  for (const p of existingPages) existing.add(p.replace(/\.md$/, ""));

  const gaps: CoverageGap[] = [];
  const seenSlugs = new Set<string>();
  for (const f of sourceFiles) {
    const wikiPath = fileToWikiPath(f, projectName);
    const wikiKey = wikiPath.replace(/\.md$/, "");
    if (existing.has(wikiKey)) continue;
    // Two source files with the same basename would derive the same
    // slug and clobber each other. Skip duplicates after the first;
    // the LLM authoring that page can decide how to disambiguate
    // (typically by appending a directory hint to the title).
    if (seenSlugs.has(wikiKey)) continue;
    seenSlugs.add(wikiKey);
    gaps.push({ sourceFile: f, projectName, suggestedPath: wikiPath });
  }
  return gaps;
}

// ── Authoring prompt for an uncovered file ──────────────────────────────

const FILE_COVERAGE_PROMPT_TEMPLATE = `You are Opus 4.7 authoring a reference wiki page for an undocumented source file.

The project has many memory-cluster-driven pages (authored from session
activity), but this file has never been touched in a session and has
no page yet. Per the project's documentation ambition — "every legacy
existing element should be treated with the same detailed approach as
new work" — we want a curated reference page that reads the file and
explains it.

# File

**Path**: {sourceFile}
**Project**: {projectName}
**Suggested wiki path**: {suggestedPath}

# Existing file content (read carefully before authoring)

{fileBody}

# Your task

Author **one** reference wiki page in Markdown describing this file.

# Output format

Output **only** the wiki page body — YAML frontmatter, then the
markdown. No preamble, no fences around the output, no explanation.

# Frontmatter (required)

\`\`\`yaml
---
title: <short specific title — the file's role, not the path>
kind: reference
domain: {projectName}
status: living
authored_by: Opus 4.7
created: {today}
last_reviewed: {today}
audience: [developer]
source_files:
  - {sourceFile}
---
\`\`\`

# Required sections (in this order)

1. **# <title>** — H1 matching frontmatter title.
2. **Lead paragraph** — what this file is, why a reader would open it.
3. **What it exports / what it does** — the public surface; for each
   exported function/class/constant give a one-line description.
4. **How it works** — the internal logic. Use mermaid for non-trivial
   control flow. Quote short representative snippets; cite line
   numbers when relevant.
5. **Dependencies** — what it imports, what depends on it (only the
   non-obvious ones; standard library imports don't need calling out).
6. **What can go wrong** — failure modes with symptoms. Cite the
   error paths in code.
7. **See also** — cross-links to related pages via \`[[wiki/path]]\` and
   to specific source-file paths.

# Conventions

- Declarative prose. No filler.
- When a number is named, say where it came from.
- No mechanical paraphrase of variable names — the reader wants the
  WHY, not the WHAT.
- Page target size 6–12 KB.

---

Author the page now.
`;

export interface CoverageJob {
  readonly gap: CoverageGap;
  readonly prompt: string;
}

/**
 * Construct the authoring prompt for a coverage gap.
 *
 * ``fileBody`` is the (possibly-truncated) source content. We cap at
 * FILE_BODY_PROMPT_CAP bytes — larger files get a truncation marker
 * so the LLM knows to keep its scope to what it actually saw.
 */
export function buildCoveragePrompt(
  gap: CoverageGap,
  fileBody: string,
  today: string = "",
): string {
  const todayStr = today || new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  let body = fileBody.slice(0, FILE_BODY_PROMPT_CAP);
  if (fileBody.length > FILE_BODY_PROMPT_CAP) {
    body += "\n\n... [file truncated — original is " +
      String(fileBody.length) + " bytes]";
  }
  return FILE_COVERAGE_PROMPT_TEMPLATE
    .replace(/\{sourceFile\}/g,    gap.sourceFile)
    .replace(/\{projectName\}/g,   gap.projectName)
    .replace(/\{suggestedPath\}/g, gap.suggestedPath)
    .replace(/\{fileBody\}/g,      body)
    .replace(/\{today\}/g,         todayStr);
}

/**
 * Build coverage jobs from gaps + a file-body reader.
 *
 * ``readFileBody`` is a sync adapter the caller supplies (real fs in
 * production, deterministic stub in tests). Files that fail to read
 * are skipped silently — coverage is best-effort.
 *
 * source: this module — composition of computeCoverageGap with the
 *   per-file prompt builder
 */
export function buildCoverageJobs(
  gaps: readonly CoverageGap[],
  readFileBody: (relPath: string) => string | null,
  today: string = "",
): CoverageJob[] {
  const jobs: CoverageJob[] = [];
  for (const gap of gaps) {
    const body = readFileBody(gap.sourceFile);
    if (body == null) continue;
    jobs.push({ gap, prompt: buildCoveragePrompt(gap, body, today) });
  }
  return jobs;
}
