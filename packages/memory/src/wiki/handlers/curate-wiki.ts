/**
 * Handler: curate-wiki — emit authoring jobs the in-session LLM consumes.
 *
 * Composition root for the auto-curator (../auto-curator.ts).
 *
 * Architecture — why this returns jobs instead of authoring directly:
 *
 * The user's Claude Code session is itself the authoring LLM (Opus 4.7).
 * Rather than calling an external Anthropic API with a separate key
 * (the key is the user's session and exposing it via env is fragile),
 * this handler returns **structured authoring jobs** — clusters of PG
 * memories paired with the structured prompt the LLM should consume.
 * The in-session LLM reads the jobs, authors each page in turn, and
 * writes them via ``wiki_write``.
 *
 * That means the auto-curator's "auto" property comes from two things:
 *
 *   1. The clustering and prompt-construction work happens without a
 *      human deciding what to document — ``curate_wiki`` fetches
 *      recent high-heat clusters, derives topics, and constructs
 *      prompts that embed all the wiki conventions.
 *
 *   2. The trigger is automatic — ``consolidate`` runs the same job-
 *      enqueueing logic on its periodic cycle; ``session_start``
 *      surfaces pending curations to the in-session LLM. The user
 *      never asks for a specific page; the system notices what
 *      deserves documentation and proposes it.
 *
 * The user directive this satisfies (Cortex 2026-05-17):
 *   > "ALL ACTIONS SHOULD DOCUMENTED BY OPUS 4.7, IT'S NOT POSSIBLE THE
 *   > LLM IS NOT ABLE TO PRODUCE A DOCUMENTATION FROM AN ACCESS."
 *   > "The documentation you created now, should be auto created and
 *   > auto curated."
 *   > "the anthropic key should be using the user session"
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py
 */

import {
  buildClusters,
  buildJobs,
  filterAuthoredClusters,
  MAX_MEMORIES_PER_PROMPT,
  MIN_AVG_HEAT_FOR_PAGE,
  MIN_MEMORIES_PER_CLUSTER,
  type CuratorMemory,
  type CurationCluster,
  type CurationJob,
  type PageMtimeFn,
} from "../auto-curator.js";
import {
  auditWikiDrift,
  buildDriftRefreshPrompt,
  type DriftVerdict,
} from "../source-drift.js";
import {
  buildCoverageJobs,
  computeCoverageGap,
} from "../file-coverage.js";

// source: cortex@47b818d mcp_server/handlers/curate_wiki.py — defaults
// for limit, recent_only, memory_pool_size.
const DEFAULT_LIMIT = 3; // source: cortex@47b818d mcp_server/handlers/curate_wiki.py:91 ("limit": {"default": 3})
const DEFAULT_RECENT_ONLY = true; // source: cortex@47b818d mcp_server/handlers/curate_wiki.py:107 ("recent_only": {"default": True})
const DEFAULT_MEMORY_POOL_SIZE = 500; // source: cortex@47b818d mcp_server/handlers/curate_wiki.py:114 ("memory_pool_size": {"default": 500})

// Minimum-pool-for-recent threshold: when the recently-accessed pool is
// too thin (< 2× min_memories), the handler falls back to a broader
// recent-by-creation pool.
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py:139 (`if len(memories) < min_memories * 2`)
const RECENT_POOL_FALLBACK_FACTOR = 2;

// ── Public types ────────────────────────────────────────────────────────

export interface CurateWikiArgs {
  readonly domain?: string;
  readonly limit?: number;
  readonly min_memories?: number;
  readonly min_avg_heat?: number;
  readonly recent_only?: boolean;
  readonly memory_pool_size?: number;
  // Phase C: re-authoring of drifted pages.
  // When true, scan every wiki page for cited source files whose
  // mtimes are later than the page mtime, and emit a refresh job for
  // each. Skipped when no project_root is provided (we can't resolve
  // relative citations without it).
  // source: packages/memory/src/wiki/source-drift.ts
  readonly include_drift?: boolean;
  // Phase C: file-coverage authoring for legacy code.
  // When true, walk project_root for source files that have no wiki
  // page yet under reference/<domain>/<slug>.md and emit an authoring
  // job for each. Skipped when no project_root or no domain.
  // source: packages/memory/src/wiki/file-coverage.ts
  readonly include_file_coverage?: boolean;
  // Project root (absolute path) used by both Phase C modes to resolve
  // relative citations and walk for uncovered files. Required for
  // those modes; ignored otherwise.
  readonly project_root?: string;
  // Cap on the number of source files scanned for coverage. 0 (the
  // default) means unbounded — match codebase_analyze's contract
  // (cortex@2f42428).
  readonly max_files?: number;
}

export interface CurationJobPayload {
  readonly suggested_path: string;
  readonly suggested_kind: string;
  readonly topic: string;
  readonly domain: string;
  readonly memory_count: number;
  readonly memory_ids: readonly number[];
  readonly top_entities: readonly string[];
  readonly avg_heat: number;
  readonly earliest_memory_at: string;
  readonly latest_memory_at: string;
  readonly related_pages: readonly string[];
  readonly prompt: string;
}

// Phase C: a single drift-refresh job sent to the LLM. Distinct shape
// from CurationJobPayload because drift jobs carry the existing page
// body, not a memory cluster.
export interface DriftJobPayload {
  readonly kind: "drift";
  readonly page_path: string;
  readonly cited_sources_drifted: readonly string[];
  readonly newest_source_mtime: number | null;
  readonly page_mtime: number | null;
  readonly prompt: string;
}

// Phase C: a single coverage-gap job sent to the LLM.
export interface CoverageJobPayload {
  readonly kind: "coverage";
  readonly source_file: string;
  readonly project_name: string;
  readonly suggested_path: string;
  readonly prompt: string;
}

export interface CurateWikiResult {
  readonly jobs: readonly CurationJobPayload[];
  readonly total_clusters_eligible: number;
  readonly returned: number;
  readonly memory_pool_size: number;
  readonly domain_filter: string;
  readonly instructions: string;
  // Phase C: drift + coverage jobs. Empty arrays when the
  // corresponding include_* flag is false or the required adapter
  // isn't wired.
  readonly drift_jobs: readonly DriftJobPayload[];
  readonly coverage_jobs: readonly CoverageJobPayload[];
  // Counters for the SessionStart preamble + consolidate stats.
  readonly total_drifted: number;
  readonly total_coverage_gap: number;
}

export type CurateWikiResponse = CurateWikiResult | { readonly error: string };

/**
 * Dependencies for the curate-wiki handler.
 *
 * - ``getRecentlyAccessedMemories`` and ``getRecentMemories`` are
 *   thin adapters over the MemoryStore. ``getRecentMemories`` is the
 *   fallback when access logs are thin (fresh DB); when omitted, the
 *   handler uses ``getRecentlyAccessedMemories`` for both paths.
 * - ``listMdPages`` enumerates wiki pages (as rel paths, including
 *   ``.md``) so the handler can build a topic→[paths] index for
 *   ``[[wiki-link]]`` cross-referencing in the authoring prompt.
 */
export interface CurateWikiDeps {
  readonly wikiRoot: string;
  readonly getRecentlyAccessedMemories: (limit: number) => Promise<CuratorMemory[]>;
  readonly getRecentMemories?: (limit: number) => Promise<CuratorMemory[]>;
  readonly listMdPages: (root: string) => Promise<string[]>;
  /**
   * Filesystem mtime adapter — returns mtime in seconds for the wiki
   * page at absPath, or null when missing. When omitted, the handler
   * skips the "recently authored" filter (useful in tests).
   *
   * source: cortex@4883307 mcp_server/core/auto_curator.py — filesystem-mtime check
   */
  readonly pageMtime?: PageMtimeFn;
  /** Override for current-date injection in tests. Returns YYYY-MM-DD. */
  readonly today?: () => string;
  // ── Phase C adapters ──
  // All optional — when missing, the corresponding Phase C feature is
  // skipped and the response carries empty drift_jobs / coverage_jobs
  // with total_* = 0. Production wires real fs calls; tests wire
  // deterministic stubs.
  /**
   * Read a wiki page's full body for the drift-refresh prompt.
   * Returns null when the page can't be read.
   * source: packages/memory/src/wiki/source-drift.ts — drift uses page body
   */
  readonly readPage?: (root: string, relPath: string) => Promise<string | null>;
  /**
   * Mtime adapter scoped to PROJECT_ROOT (not wiki root). Resolves
   * relative citations like ``packages/foo/bar.ts`` against the
   * project tree. Returns seconds-since-epoch or null on ENOENT.
   * source: packages/memory/src/wiki/source-drift.ts — citation mtime check
   */
  readonly sourceFileMtime?: PageMtimeFn;
  /**
   * Walk the project tree, return relative source-file paths. Caller
   * applies the maxFiles cap; 0 / negative means unbounded.
   * source: packages/memory/src/wiki/file-coverage.ts — coverage scan
   */
  readonly listSourceFiles?: (projectRoot: string, maxFiles: number) => Promise<string[]>;
  /**
   * Read a project source file's body for the coverage-authoring
   * prompt. Returns null on read failure.
   * source: packages/memory/src/wiki/file-coverage.ts — coverage prompt body
   */
  readonly readSourceFile?: (projectRoot: string, relPath: string) => string | null;
}

// ── Existing-page topic index ───────────────────────────────────────────

// Slug-canonicalisation: drop ID prefix ("305772-"), drop kind prefix
// ("decision-", "lesson-", "convention-", "spec-", "reference-"), and
// drop the trailing "-md" that the original Cortex code happened to
// strip after extension removal.
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py::_scan_existing_pages:166-176
const ID_PREFIX_RE = /^\d+-/;
const KIND_PREFIX_RE = /^(decision|lesson|convention|spec|reference)-/;

function pageTopicKey(relPath: string): string | null {
  // Skip dot- and underscore-prefixed top-level dirs (e.g. ``.generated``).
  const parts = relPath.split("/");
  const first = parts[0] ?? "";
  if (!first || first.startsWith(".") || first.startsWith("_")) return null;
  const filename = parts[parts.length - 1] ?? "";
  const stem = filename.replace(/\.md$/, "");
  let slug = stem.replace(ID_PREFIX_RE, "");
  slug = slug.replace(KIND_PREFIX_RE, "");
  slug = slug.replace(/-md$/, "");
  return slug.toLowerCase();
}

/**
 * Build a topic→[paths] index of existing wiki pages.
 *
 * The auto-curator uses this to suggest cross-links via ``[[wiki/path]]``
 * notation in the authoring prompt. Topics are derived from the page
 * path's slug (last component, minus extension, minus ID prefix,
 * minus kind prefix).
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py::_scan_existing_pages
 */
export function scanExistingPages(relPaths: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const rel of relPaths) {
    const topic = pageTopicKey(rel);
    if (topic == null) continue;
    const pathStr = rel.replace(/\.md$/, "");
    const arr = index.get(topic) ?? [];
    arr.push(pathStr);
    index.set(topic, arr);
  }
  return index;
}

// ── Handler ────────────────────────────────────────────────────────────

function defaultToday(): string {
  return new Date().toISOString().slice(0, "YYYY-MM-DD".length);
}

async function fetchMemoryPool(
  deps: CurateWikiDeps,
  recentOnly: boolean,
  poolSize: number,
  minMemories: number,
): Promise<CuratorMemory[]> {
  if (!recentOnly && deps.getRecentMemories) {
    return await deps.getRecentMemories(poolSize);
  }
  const recent = await deps.getRecentlyAccessedMemories(poolSize);
  if (recent.length >= minMemories * RECENT_POOL_FALLBACK_FACTOR) return recent;
  // Recent-access pool too thin (fresh DB) — fall back to broader pool.
  if (deps.getRecentMemories) return await deps.getRecentMemories(poolSize);
  return recent;
}

// Top-N entities serialised per job. Matches the slice taken in the
// authoring prompt; the consumer sees a stable wire field.
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py:_serialise_job:"c.entities[:8]"
const TOP_ENTITIES_PER_JOB = 8;
// avg_heat is rounded to 3 decimals on the wire (1000 = 10^3).
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py:_serialise_job:"round(c.avg_heat, 3)"
const HEAT_ROUND_PRECISION = 1000;

function serialiseJob(job: CurationJob): CurationJobPayload {
  const c = job.cluster;
  return {
    suggested_path:       c.suggested_path,
    suggested_kind:       c.suggested_kind,
    topic:                c.topic,
    domain:               c.domain,
    memory_count:         c.memory_ids.length,
    memory_ids:           c.memory_ids,
    top_entities:         c.entities.slice(0, TOP_ENTITIES_PER_JOB),
    avg_heat:             Math.round(c.avg_heat * HEAT_ROUND_PRECISION) / HEAT_ROUND_PRECISION,
    earliest_memory_at:   c.earliest_at,
    latest_memory_at:     c.latest_at,
    related_pages:        job.related_pages,
    prompt:               job.prompt,
  };
}

function instructionsForLlm(
  nJobs: number,
  nEligible: number,
  nDrift: number = 0,
  nGap: number = 0,
): string {
  if (nJobs === 0 && nDrift === 0 && nGap === 0) {
    return (
      `No curation jobs returned. ${nEligible} clusters were eligible. ` +
      "If you expected jobs, relax min_memories or min_avg_heat, or pass " +
      "recent_only=false."
    );
  }

  const lines: string[] = [];
  if (nJobs > 0) {
    lines.push(
      `Auto-curator returned ${nJobs} cluster job(s) (of ${nEligible} eligible).`,
      "For each cluster job in order:",
      "  1. Read `prompt` — cluster's memories + authoring conventions.",
      "  2. Author the page in Markdown following the conventions " +
      "(frontmatter → lead → sections with diagrams → 'why this not " +
      "alternatives' → 'what can go wrong' → 'see also' → primary sources).",
      "  3. Write via `wiki_write(path=<job.suggested_path>, " +
      "content=<markdown>, tags=['wiki', 'llm-authored', <topic>, <domain>])`.",
    );
  }
  if (nDrift > 0) {
    lines.push(
      "",
      `Drift refresh: ${nDrift} page(s) cite source files that have ` +
      "changed since the page mtime. For each entry in `drift_jobs`:",
      "  1. Read `prompt` — it carries the existing body + the drifted ",
      "     source paths.",
      "  2. Decide per section: same code → keep; drifted code → rewrite; ",
      "     invalidated → drop.",
      "  3. Write via `wiki_write(path=<job.page_path>, ",
      "     content=<markdown>, mode='replace', tags=[…])`.",
    );
  }
  if (nGap > 0) {
    lines.push(
      "",
      `Coverage: ${nGap} source file(s) have no wiki page yet. For each ` +
      "entry in `coverage_jobs`:",
      "  1. Read `prompt` — it carries the file body + frontmatter spec.",
      "  2. Author a reference page describing what the file does.",
      "  3. Write via `wiki_write(path=<job.suggested_path>, ",
      "     content=<markdown>, tags=['wiki', 'llm-authored', 'reference', ",
      "     <project>])`.",
    );
  }
  lines.push(
    "",
    "Call `curate_wiki` again when this batch is done. The ",
    "recently-authored skip filter prevents re-suggestions of pages you ",
    "just wrote. Do not dump raw memory content; synthesise. Each page ",
    "should be 6–15 KB of substantive authored prose, not a template.",
  );
  return lines.join("\n");
}

/**
 * Build authoring jobs from PG memory clusters.
 *
 * precondition:  deps.getRecentlyAccessedMemories and deps.listMdPages
 *                are live.
 * postcondition: returns up to ``limit`` curation jobs; each carries
 *                the full prompt the in-session LLM should author from.
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py::handler
 */
export async function handler(
  args: CurateWikiArgs,
  deps: CurateWikiDeps,
): Promise<CurateWikiResponse> {
  const limit          = args.limit ?? DEFAULT_LIMIT;
  const minMemories    = args.min_memories ?? MIN_MEMORIES_PER_CLUSTER;
  const minAvgHeat     = args.min_avg_heat ?? MIN_AVG_HEAT_FOR_PAGE;
  const recentOnly     = args.recent_only ?? DEFAULT_RECENT_ONLY;
  const memoryPoolSize = args.memory_pool_size ?? DEFAULT_MEMORY_POOL_SIZE;

  const memories = await fetchMemoryPool(deps, recentOnly, memoryPoolSize, minMemories);

  // Phase C: drift + coverage are always reported (even when no
  // memories exist), since they don't need a memory pool to operate.
  const relPaths = await deps.listMdPages(deps.wikiRoot);
  const today = (deps.today ?? defaultToday)();
  const phaseC = await computePhaseCJobs(args, deps, relPaths, today, limit);

  if (memories.length === 0) {
    return {
      jobs: [],
      total_clusters_eligible: 0,
      returned: 0,
      memory_pool_size: 0,
      domain_filter: args.domain ?? "(all)",
      instructions: phaseC.totalGap + phaseC.totalDrift > 0
        ? `No memory clusters, but ${phaseC.totalDrift} drifted page(s) and ` +
          `${phaseC.totalGap} uncovered file(s) need attention.`
        : "No memories available to curate. Use `remember` to seed.",
      drift_jobs: phaseC.driftJobs,
      coverage_jobs: phaseC.coverageJobs,
      total_drifted: phaseC.totalDrift,
      total_coverage_gap: phaseC.totalGap,
    };
  }

  const rawClusters: CurationCluster[] = buildClusters(memories, {
    ...(args.domain != null ? { domain: args.domain } : {}),
    min_memories: minMemories,
    min_avg_heat: minAvgHeat,
  });

  // Skip clusters whose suggested page already exists and is fresh.
  // The filter runs only when a pageMtime adapter is wired — tests
  // typically omit it. source: cortex@4883307 mcp_server/core/auto_curator.py
  const clusters: CurationCluster[] = deps.pageMtime
    ? filterAuthoredClusters(rawClusters, deps.wikiRoot, deps.pageMtime)
    : rawClusters;

  const existingPages = scanExistingPages(relPaths);
  const jobs = buildJobs(clusters, existingPages, today);
  const selected = jobs.slice(0, limit);
  const payload = selected.map(serialiseJob);

  return {
    jobs: payload,
    total_clusters_eligible: clusters.length,
    returned: payload.length,
    memory_pool_size: memories.length,
    domain_filter: args.domain ?? "(all)",
    instructions: instructionsForLlm(
      payload.length,
      clusters.length,
      phaseC.totalDrift,
      phaseC.totalGap,
    ),
    drift_jobs: phaseC.driftJobs,
    coverage_jobs: phaseC.coverageJobs,
    total_drifted: phaseC.totalDrift,
    total_coverage_gap: phaseC.totalGap,
  };
}

// ── Phase C composition helper ──────────────────────────────────────────

/**
 * Compute Phase C jobs (drift + coverage) bounded by ``limit``.
 *
 * Returns empty arrays + zero counts when:
 *   - the corresponding include_* flag is false,
 *   - no project_root is provided,
 *   - or the required adapter (pageMtime/sourceFileMtime/readPage/
 *     listSourceFiles/readSourceFile) isn't wired.
 *
 * source: this module — Phase C composition root for source-drift +
 *   file-coverage.
 */
async function computePhaseCJobs(
  args: CurateWikiArgs,
  deps: CurateWikiDeps,
  relPaths: readonly string[],
  today: string,
  limit: number,
): Promise<{
  readonly driftJobs: readonly DriftJobPayload[];
  readonly coverageJobs: readonly CoverageJobPayload[];
  readonly totalDrift: number;
  readonly totalGap: number;
}> {
  const projectRoot = args.project_root;
  const driftJobs = await computeDriftJobs(args, deps, relPaths, projectRoot, limit);
  const coverageJobs = await computeCoverageJobs(args, deps, relPaths, projectRoot, today, limit);
  return {
    driftJobs:    driftJobs.jobs,
    coverageJobs: coverageJobs.jobs,
    totalDrift:   driftJobs.total,
    totalGap:     coverageJobs.total,
  };
}

async function computeDriftJobs(
  args: CurateWikiArgs,
  deps: CurateWikiDeps,
  relPaths: readonly string[],
  projectRoot: string | undefined,
  limit: number,
): Promise<{ readonly jobs: DriftJobPayload[]; readonly total: number }> {
  if (
    !args.include_drift ||
    !projectRoot ||
    !deps.sourceFileMtime ||
    !deps.pageMtime ||
    !deps.readPage
  ) {
    return { jobs: [], total: 0 };
  }
  // Read each page (with mtime + body) so the drift scanner has both
  // signals it needs.
  const scanPages = [];
  for (const rel of relPaths) {
    const mt = deps.pageMtime(joinWiki(deps.wikiRoot, rel));
    const body = await deps.readPage(deps.wikiRoot, rel);
    scanPages.push({ path: rel, mtimeSeconds: mt, content: body ?? "" });
  }
  const report = auditWikiDrift(scanPages, deps.sourceFileMtime);
  const jobs: DriftJobPayload[] = [];
  for (const v of report.driftedPages.slice(0, limit)) {
    const body = (await deps.readPage(deps.wikiRoot, v.pagePath)) ?? "";
    jobs.push(buildDriftJobPayload(v, body));
  }
  return { jobs, total: report.totalDrifted };
}

async function computeCoverageJobs(
  args: CurateWikiArgs,
  deps: CurateWikiDeps,
  relPaths: readonly string[],
  projectRoot: string | undefined,
  today: string,
  limit: number,
): Promise<{ readonly jobs: CoverageJobPayload[]; readonly total: number }> {
  if (
    !args.include_file_coverage ||
    !projectRoot ||
    !args.domain ||
    !deps.listSourceFiles ||
    !deps.readSourceFile
  ) {
    return { jobs: [], total: 0 };
  }
  // Narrow once so the closure below sees a non-undefined readSourceFile
  // — the deps-shape check above already proved both are wired.
  const readSourceFile = deps.readSourceFile;
  const sourceFiles = await deps.listSourceFiles(projectRoot, args.max_files ?? 0);
  const gaps = computeCoverageGap(sourceFiles, args.domain, relPaths);
  const reader = (rel: string): string | null => readSourceFile(projectRoot, rel);
  const jobs = buildCoverageJobs(gaps.slice(0, limit), reader, today);
  return {
    jobs: jobs.map((j): CoverageJobPayload => ({
      kind:           "coverage",
      source_file:    j.gap.sourceFile,
      project_name:   j.gap.projectName,
      suggested_path: j.gap.suggestedPath,
      prompt:         j.prompt,
    })),
    total: gaps.length,
  };
}

function buildDriftJobPayload(v: DriftVerdict, body: string): DriftJobPayload {
  return {
    kind:                  "drift",
    page_path:             v.pagePath,
    cited_sources_drifted: v.resolvedSources,
    newest_source_mtime:   v.newestSourceMtime,
    page_mtime:            v.pageMtimeSeconds,
    prompt:                buildDriftRefreshPrompt(v, body),
  };
}

// Local path-join for wiki root + rel — POSIX slashes only, mirrors
// the layout-relative paths the wiki uses.
function joinWiki(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// ── MCP schema (mirrors Cortex curate_wiki.schema) ─────────────────────

export const schema = {
  title: "Curate wiki",
  description: (
    "Auto-curator: returns structured authoring jobs the in-session " +
    "LLM (Opus 4.7) consumes to author curated wiki pages from PG " +
    "memory clusters. Each job carries one cluster's memories, the " +
    "suggested wiki path, a list of existing related pages for " +
    "cross-linking, and a complete structured prompt that encodes " +
    "the wiki documentation conventions (frontmatter, lead, diagrams, " +
    "'why this not the alternatives', 'what can go wrong', 'see also', " +
    "primary sources). The conversational LLM reads each job, authors " +
    "the page in Markdown, and writes it via `wiki_write`. No external " +
    "Anthropic API key required — the user's existing Claude Code " +
    "session is the authoring LLM."
  ),
  inputSchema: {
    type: "object",
    required: [] as const,
    properties: {
      domain: {
        type: "string",
        description: "Restrict curation to a single domain. Omit to curate across all domains.",
      },
      limit: {
        type: "integer",
        default: DEFAULT_LIMIT,
        minimum: 1,
        maximum: 20,
        description: "Maximum number of authoring jobs to return.",
      },
      min_memories: {
        type: "integer",
        default: MIN_MEMORIES_PER_CLUSTER,
        description: "Minimum memories per cluster to earn a page.",
      },
      min_avg_heat: {
        type: "number",
        default: MIN_AVG_HEAT_FOR_PAGE,
        description: "Minimum average effective_heat of cluster memories.",
      },
      recent_only: {
        type: "boolean",
        default: DEFAULT_RECENT_ONLY,
        description: "If true, only consider recently-accessed memories.",
      },
      memory_pool_size: {
        type: "integer",
        default: DEFAULT_MEMORY_POOL_SIZE,
        description: "Number of memories to draw from before clustering.",
      },
    },
  },
} as const;

// Re-export so MCP tool registration can pick up the canonical default
// without re-declaring them. source: cortex@47b818d (schema field defaults
// derive from auto_curator constants).
export { MAX_MEMORIES_PER_PROMPT, MIN_AVG_HEAT_FOR_PAGE, MIN_MEMORIES_PER_CLUSTER };
