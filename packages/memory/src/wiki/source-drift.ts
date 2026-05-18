/**
 * source-drift.ts — Phase C of the auto-curation system.
 *
 * Detects wiki pages whose cited source files have been modified
 * **since the page was authored**. Complements wiki-staleness.ts:
 *
 *   wiki-staleness.ts → "cite-rot" — the cited file no longer exists.
 *                       Page is misleading because it points at vapour.
 *   source-drift.ts   → "mtime-drift" — the cited file exists but has
 *                       changed since the page mtime. Page may still be
 *                       correct, but probably isn't; the curator
 *                       should re-author against the new code.
 *
 * The curator's recently-authored filter (cortex@4883307) protects
 * fresh pages from being re-suggested by mtime alone. It does NOT
 * detect drift: a page authored 2 weeks ago whose cited source was
 * rewritten yesterday is still "fresh by mtime" but its content no
 * longer matches reality. This module closes that gap.
 *
 * Pure logic — no I/O. Adapters are injected (``fileMtime``) so tests
 * can run deterministically and production wires real fs calls.
 *
 * User directive (2026-05-17, generalised to all projects):
 *   > "All legacy or preexisting documentation should be refined and
 *   > verified and updated accordingly."
 */

import type { PageMtimeFn } from "./auto-curator.js";

// Citation patterns scanned in page bodies and frontmatter.
//
// Three forms recognised:
//   1. ``source: <path>``       — frontmatter key OR YAML-style body line
//   2. ``// source: <path>``    — inline citation comment
//   3. ``source_files: [a, b]`` — explicit frontmatter list
//
// Match on the line, then extract path-shaped tokens from inside. This
// keeps prose like "source: cortex@deadbeef mcp_server/foo.py" from
// matching "cortex@deadbeef" as a path; we only want the file tokens.
//
// source: project coding-standards.md §8 "Zetetic Source Discipline"
//   — every algorithm/constant carries a "// source: <citation>" marker
const CITATION_LINE_RE = /(?:^|\n)\s*(?:\/\/\s*)?source:\s*([^\n]+)/gi;
const FRONTMATTER_LIST_RE = /^\s*source_files\s*:\s*\[([^\]]+)\]/im;
// Path-token shape: word chars / dots / slashes / dashes / underscores
// ending in a known source-extension. Picks "packages/foo/bar.ts" out of
// "source: cortex@deadbeef packages/foo/bar.ts — explanation".
const PATH_TOKEN_RE =
  /([\w./_-]+\.(?:py|ts|js|tsx|jsx|md|sql|yml|yaml|toml|rs|go|rb|cpp|c|h|cs|swift|java|kt|scala|ex|exs|sh|css))(?=\b|$)/g;

/**
 * Extract citation file paths from a page's markdown content.
 *
 * Returns canonicalised relative paths (no leading ``./``); duplicates
 * are removed; absolute paths and protocol URLs are dropped (we only
 * stat repo-relative files).
 *
 * source: this module — citation extraction is pure-string logic
 */
export function parseCitations(content: string): string[] {
  if (!content) return [];
  const seen = new Set<string>();

  function pushIfRelative(raw: string): void {
    const trimmed = raw.trim().replace(/^\.\//, "").replace(/[,;]+$/, "");
    if (!trimmed) return;
    if (trimmed.startsWith("/")) return; // absolute path
    if (trimmed.includes("://")) return; // URL
    if (!trimmed.includes(".")) return;  // bare directory
    seen.add(trimmed);
  }

  CITATION_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_LINE_RE.exec(content)) !== null) {
    const line = m[1] ?? "";
    PATH_TOKEN_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PATH_TOKEN_RE.exec(line)) !== null) {
      pushIfRelative(pm[1] ?? "");
    }
  }

  const fmMatch = FRONTMATTER_LIST_RE.exec(content);
  if (fmMatch) {
    const items = (fmMatch[1] ?? "").split(",");
    for (const item of items) pushIfRelative(item.trim().replace(/^["']|["']$/g, ""));
  }

  return Array.from(seen);
}

// ── Drift verdict ───────────────────────────────────────────────────────

/**
 * A single drift verdict for one page.
 *
 * - ``citations``: paths the scanner extracted from the page.
 * - ``resolvedSources``: subset whose mtimes resolved to real files.
 * - ``newestSourceMtime``: latest source mtime in seconds; null when
 *   no citation resolved (can't decide — page stays "fresh").
 * - ``hasDrift``: true iff the newest source mtime is later than the
 *   page mtime (the page was authored before the latest source change).
 */
export interface DriftVerdict {
  readonly pagePath: string;
  readonly pageMtimeSeconds: number | null;
  readonly citations: readonly string[];
  readonly resolvedSources: readonly string[];
  readonly newestSourceMtime: number | null;
  readonly hasDrift: boolean;
}

/**
 * Decide drift for a single page given its content + an mtime adapter
 * for the citation files.
 *
 * Contract:
 *   - When the page has no mtime (pageMtimeSeconds null), hasDrift=false;
 *     a missing page is not drift, it's absence.
 *   - When no citation resolves to a real file, hasDrift=false; no
 *     evidence → no flag.
 *   - When newest cited mtime > page mtime, hasDrift=true.
 */
export function auditPageDrift(
  pagePath: string,
  content: string,
  pageMtimeSeconds: number | null,
  fileMtime: PageMtimeFn,
): DriftVerdict {
  const citations = parseCitations(content);
  const resolved: string[] = [];
  let newest: number | null = null;
  for (const c of citations) {
    const mt = fileMtime(c);
    if (mt == null) continue;
    resolved.push(c);
    if (newest == null || mt > newest) newest = mt;
  }
  const hasDrift =
    pageMtimeSeconds != null && newest != null && newest > pageMtimeSeconds;
  return {
    pagePath,
    pageMtimeSeconds,
    citations,
    resolvedSources: resolved,
    newestSourceMtime: newest,
    hasDrift,
  };
}

// ── Aggregate scan ──────────────────────────────────────────────────────

export interface DriftReport {
  readonly verdicts: readonly DriftVerdict[];
  readonly driftedPages: readonly DriftVerdict[];
  readonly totalScanned: number;
  readonly totalDrifted: number;
}

export interface ScanPage {
  readonly path: string;
  readonly mtimeSeconds: number | null;
  readonly content: string;
}

/**
 * Audit every supplied page against the supplied citation-mtime adapter.
 *
 * Production wires ``fileMtime = (path) => statSync(join(projectRoot,
 * path)).mtimeMs / 1000`` returning null on ENOENT. Tests inject a
 * deterministic stub.
 */
export function auditWikiDrift(
  pages: readonly ScanPage[],
  fileMtime: PageMtimeFn,
): DriftReport {
  const verdicts: DriftVerdict[] = pages.map((p) =>
    auditPageDrift(p.path, p.content, p.mtimeSeconds, fileMtime),
  );
  const drifted = verdicts.filter((v) => v.hasDrift);
  return {
    verdicts,
    driftedPages: drifted,
    totalScanned: verdicts.length,
    totalDrifted: drifted.length,
  };
}

// ── Re-authoring prompt for drifted pages ───────────────────────────────

// Cap the existing-body section in the prompt to keep the request
// within Opus 4.7's reasonable budget for one tool call. Same order of
// magnitude as auto-curator's MAX_MEMORIES_PER_PROMPT × MEMORY_BODY_PROMPT_CAP
// (25 × 1200 ≈ 30 KB). Pages above this get truncated, which is rare:
// the curator targets 8–15 KB pages.
// source: this module — paired with auto-curator's memory-body cap
const EXISTING_BODY_PROMPT_CAP = 30_000;

const DRIFT_PROMPT_TEMPLATE = `You are Opus 4.7 refreshing a drifted wiki page.

The page below was authored earlier, but at least one of its cited
source files has been modified since the page mtime. Re-author the
page so it reflects the current state of the cited sources.

# Page path

{pagePath}

# Cited sources newer than the page

{driftedSourcesBlock}

# Existing page body (read carefully before re-authoring)

{existingBody}

# Your task

1. Read each cited source file (the paths above are real and accessible).
2. For each section of the existing page, decide:
   - Same claim, same code → keep the section, only refresh the
     citation line if its line number drifted.
   - Same claim, code changed → rewrite the section to match the new
     behaviour. Name what changed.
   - Claim invalidated by the code change → drop the section.
3. Preserve the original frontmatter except:
   - bump ` + "``last_reviewed``" + ` to today
   - record the previous body's ` + "``authored_by``" + ` in
     ` + "``previously_authored_by``" + ` if not already preset.

# Output format

Output **only** the new wiki page body — frontmatter first, then
markdown. No preamble, no fences around the output, no explanation.

Conventions
-----------

Match the documentation style the page already uses (declarative prose,
no filler, mermaid diagrams for state/flow). Don't repeat content
linked from other pages — link to it.
`;

function formatTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/**
 * Construct the re-authoring prompt for a drifted page.
 *
 * Keeps the existing body in the prompt so the LLM can preserve
 * unaffected sections — partial rewrite rather than from-scratch
 * regeneration. The drifted-sources block names what changed so the LLM
 * knows where to focus.
 */
export function buildDriftRefreshPrompt(
  verdict: DriftVerdict,
  existingBody: string,
): string {
  const block = verdict.resolvedSources.length
    ? verdict.resolvedSources.map((s) => `- ${s}`).join("\n")
    : "(none — synthetic drift flag, no resolvable citation)";
  return formatTemplate(DRIFT_PROMPT_TEMPLATE, {
    pagePath:            verdict.pagePath,
    driftedSourcesBlock: block,
    existingBody:        existingBody.slice(0, EXISTING_BODY_PROMPT_CAP).trim(),
  });
}
