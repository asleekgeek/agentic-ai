/**
 * curate-wiki-scope.ts — Scope-coverage + drift-reauthor branches for
 * the curate-wiki handler (G12 wiring).
 *
 * The handler in curate-wiki.ts already drives:
 *   - cluster_jobs       — heat-driven topic pages (auto-curator)
 *   - coverage_jobs      — per-source-file pages (file-coverage.ts)
 *   - drift_jobs         — per-source-file drift refresh (source-drift.ts)
 *
 * This module adds the two Cortex-2026-05-18 axes:
 *   - scope_coverage_jobs — per-canonical-scope anchor pages
 *                           (architecture, services, api, data-flow,
 *                            operations, decisions; G6)
 *   - reauthor_jobs       — structured re-author for any drifted page,
 *                           using the WIKI_REAUTHOR_PROMPT template with
 *                           kind-specific sections (G12)
 *
 * Both branches are optional and gated by the corresponding
 * ``include_*`` arg + the required adapters being wired. When
 * unavailable, the branch returns empty arrays + zero counts.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py (2026-05-18)
 */

import {
  auditAllDomains,
  type DomainCoverage,
  type ListSubdirsFn,
  type AuditDomainAdapters,
} from "../domain-coverage.js";
import {
  buildCoverageJobs as buildScopeCoverageJobs,
  sortCoverageJobs as sortScopeCoverageJobs,
  type CoverageJob as ScopeCoverageJob,
  type SupportingMemory,
} from "../coverage-jobs.js";
import {
  buildReauthorJobs,
  type DriftRecord,
  type ReauthorJob,
  type ReadWikiPageBodyFn,
  type SourceRootResolverFn,
} from "../reauthor-jobs.js";
import { auditWikiDrift, type ScanPage } from "../source-drift.js";
import type { CuratorMemory, PageMtimeFn } from "../auto-curator.js";

// ── Wire-shape payloads ────────────────────────────────────────────────

/**
 * Scope-coverage authoring job on the MCP wire. The shape mirrors
 * Cortex's ``_serialise_coverage_job`` so consumers can branch on
 * ``job_type === "scope-coverage"``.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py:_serialise_coverage_job
 */
export interface ScopeCoverageJobPayload {
  readonly job_type: "scope-coverage";
  readonly suggested_path: string;
  readonly suggested_kind: string;
  readonly scope_name: string;
  readonly scope_title: string;
  readonly domain: string;
  readonly supporting_memory_ids: readonly number[];
  readonly related_pages: readonly string[];
  readonly prompt: string;
}

/**
 * Drift-driven structured re-author job on the wire.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py:_serialise_reauthor_job
 */
export interface ReauthorJobPayload {
  readonly job_type: "reauthor";
  readonly suggested_path: string; // rewrite in place
  readonly suggested_kind: string;
  readonly domain: string;
  readonly reasons: readonly string[];
  readonly cited_source_files: readonly string[];
  readonly missing_source_files: readonly string[];
  readonly prompt: string;
}

/**
 * Per-domain summary attached to the response so a dashboard or the
 * SessionStart preamble can show coverage at a glance.
 */
export interface DomainCoverageSummary {
  readonly domain: string;
  readonly covered: number;
  readonly missing: number;
  readonly coverage_ratio: number;
  readonly missing_scopes: readonly string[];
}

// ── Adapter bundle ─────────────────────────────────────────────────────

export interface ScopeCoverageDeps {
  readonly wikiRoot: string;
  /** Discovers project directories under wiki kind buckets. */
  readonly listSubdirs: ListSubdirsFn;
  /** Stat adapter for ``<kind>/<domain>/<anchor>.md``. */
  readonly auditAdapters: AuditDomainAdapters;
  /** Adapter the reauthor branch uses to read the existing page body. */
  readonly readWikiPageBody?: ReadWikiPageBodyFn;
  /** Adapter to resolve a domain to its source-tree root. */
  readonly sourceRootResolver?: SourceRootResolverFn;
}

// ── Scope-coverage branch ─────────────────────────────────────────────

const COVERAGE_RATIO_PRECISION = 1000; // source: cortex curate_wiki.py — round(c.coverage_ratio, 3)

export interface ScopeCoverageBranchArgs {
  readonly domain?: string;
  readonly include_scope_coverage?: boolean;
  readonly scope_coverage_jobs_max?: number;
  readonly today?: string;
}

export interface ScopeCoverageBranchResult {
  readonly jobs: readonly ScopeCoverageJobPayload[];
  readonly summary: readonly DomainCoverageSummary[];
}

/**
 * Compute scope-coverage authoring jobs across every (or the filtered)
 * domain plus a per-domain summary suitable for the wire response.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py (2026-05-18 coverage branch)
 */
export function computeScopeCoverageJobs(
  args: ScopeCoverageBranchArgs,
  deps: ScopeCoverageDeps,
  memories: readonly CuratorMemory[],
  existingPagesByTopic: ReadonlyMap<string, readonly string[]>,
): ScopeCoverageBranchResult {
  const maxJobs = args.scope_coverage_jobs_max ?? 0;
  if (args.include_scope_coverage === false || maxJobs <= 0) {
    return { jobs: [], summary: [] };
  }
  let coverages: DomainCoverage[] = auditAllDomains(deps.listSubdirs, deps.auditAdapters);
  if (args.domain != null) coverages = coverages.filter((c) => c.domain === args.domain);

  // Group recent memories by domain so each scope job has supporting context.
  const memsByDomain = new Map<string, SupportingMemory[]>();
  for (const m of memories) {
    const d = (m.domain ?? "").toLowerCase();
    if (!d) continue;
    const arr = memsByDomain.get(d) ?? [];
    arr.push({ id: typeof m.id === "number" ? m.id : undefined, content: m.content, tags: m.tags });
    memsByDomain.set(d, arr);
  }

  const built = buildScopeCoverageJobs(coverages, {
    existingPagesByTopic,
    supportingMemoriesByDomain: memsByDomain,
    today: args.today ?? "",
  });
  const sorted = sortScopeCoverageJobs(built).slice(0, maxJobs);
  const jobs: ScopeCoverageJobPayload[] = sorted.map((j: ScopeCoverageJob) => ({
    job_type: "scope-coverage",
    suggested_path: j.suggested_path,
    suggested_kind: j.suggested_kind,
    scope_name: j.scope_name,
    scope_title: j.scope_title,
    domain: j.domain,
    supporting_memory_ids: j.supporting_memory_ids,
    related_pages: j.related_pages,
    prompt: j.prompt,
  }));

  const summary: DomainCoverageSummary[] = coverages.map((c) => {
    const covered = c.scopes.filter((s) => s.covered).length;
    const missing = c.scopes.length - covered;
    const ratio =
      c.scopes.length === 0
        ? 0
        : Math.round((covered / c.scopes.length) * COVERAGE_RATIO_PRECISION) / COVERAGE_RATIO_PRECISION;
    return {
      domain: c.domain,
      covered,
      missing,
      coverage_ratio: ratio,
      missing_scopes: c.scopes.filter((s) => !s.covered).map((s) => s.scope.name),
    };
  });

  return { jobs, summary };
}

// ── Reauthor branch ───────────────────────────────────────────────────

export interface ReauthorBranchArgs {
  readonly domain?: string;
  readonly include_reauthor?: boolean;
  readonly reauthor_jobs_max?: number;
  readonly today?: string;
  readonly project_root?: string;
}

export interface ReauthorBranchDeps extends ScopeCoverageDeps {
  /** mtime adapter for project-relative citation file paths. */
  readonly sourceFileMtime?: PageMtimeFn;
  /** mtime adapter for wiki pages. */
  readonly pageMtime?: PageMtimeFn;
  /** Read a wiki page body (rel path → full text or null). */
  readonly readPage?: (root: string, rel: string) => Promise<string | null>;
  /** List all wiki .md relative paths. */
  readonly listMdPages?: (root: string) => Promise<string[]>;
}

/**
 * Compute drift-driven structured re-author jobs. Wraps the existing
 * source-drift audit but emits the Cortex 2026-05-18 wire shape with
 * the structured WIKI_REAUTHOR_PROMPT instead of the older
 * buildDriftRefreshPrompt template.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py (2026-05-18 reauthor branch)
 */
export async function computeReauthorJobs(
  args: ReauthorBranchArgs,
  deps: ReauthorBranchDeps,
): Promise<readonly ReauthorJobPayload[]> {
  const maxJobs = args.reauthor_jobs_max ?? 0;
  if (
    args.include_reauthor === false ||
    maxJobs <= 0 ||
    !args.project_root ||
    !deps.sourceFileMtime ||
    !deps.pageMtime ||
    !deps.readPage ||
    !deps.listMdPages ||
    !deps.readWikiPageBody ||
    !deps.sourceRootResolver
  ) {
    return [];
  }

  const relPaths = await deps.listMdPages(deps.wikiRoot);
  const scanPages: ScanPage[] = [];
  for (const rel of relPaths) {
    const mt = deps.pageMtime(joinWikiPath(deps.wikiRoot, rel));
    const body = await deps.readPage(deps.wikiRoot, rel);
    scanPages.push({ path: rel, mtimeSeconds: mt, content: body ?? "" });
  }
  const report = auditWikiDrift(scanPages, deps.sourceFileMtime);
  if (report.driftedPages.length === 0) return [];

  // Map each drift verdict → DriftRecord shape the reauthor builder expects.
  // The age_days is derived from the page mtime relative to "now".
  // source: cortex@HEAD~ mcp_server/core/wiki_drift.py:DriftRecord
  const nowSec = Date.now() / MS_PER_SECOND;
  const driftRecords: DriftRecord[] = [];
  for (const v of report.driftedPages.slice(0, maxJobs)) {
    const ageDays = v.pageMtimeSeconds == null ? 0 : (nowSec - v.pageMtimeSeconds) / SECONDS_PER_DAY;
    const domain = extractDomainFromWikiPath(v.pagePath);
    if (args.domain != null && domain !== args.domain) continue;
    driftRecords.push({
      wiki_path: v.pagePath,
      domain,
      kind: extractKindFromWikiPath(v.pagePath),
      reasons: ["stale_content"],
      cited_source_files: v.resolvedSources,
      missing_source_files: [],
      age_days: ageDays,
      last_updated: v.pageMtimeSeconds == null ? null : new Date(v.pageMtimeSeconds * MS_PER_SECOND).toISOString().slice(0, "YYYY-MM-DD".length),
    });
  }

  const jobs = buildReauthorJobs(
    driftRecords,
    deps.readWikiPageBody,
    deps.sourceRootResolver,
    args.today ?? "",
  );
  return jobs.map((j: ReauthorJob) => ({
    job_type: "reauthor" as const,
    suggested_path: j.wiki_path,
    suggested_kind: j.kind || "explanation",
    domain: j.domain,
    reasons: j.reasons,
    cited_source_files: j.cited_source_files,
    missing_source_files: j.missing_source_files,
    prompt: j.prompt,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────

// source: ECMAScript Date timestamps are milliseconds
const MS_PER_SECOND = 1000;
// source: 24 h × 3600 s/h — UTC-anchored day length
const SECONDS_PER_DAY = 86400;

/**
 * Extract the domain segment from a wiki rel path. Layout is
 * ``<kind>/<domain>/<...>.md``; returns the empty string when the path
 * doesn't have a domain segment (top-level pages).
 */
function extractDomainFromWikiPath(rel: string): string {
  const parts = rel.split("/");
  const MIN_PARTS_FOR_DOMAIN = 3; // source: <kind>/<domain>/<file>.md
  if (parts.length < MIN_PARTS_FOR_DOMAIN) return "";
  return parts[1] ?? "";
}

/**
 * Extract the kind segment (path's top-level directory).
 */
function extractKindFromWikiPath(rel: string): string {
  return rel.split("/")[0] ?? "explanation";
}

function joinWikiPath(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// ── G12 composition helper (used by curate-wiki.ts handler) ───────────

/**
 * Bundle of arg fields the G12 branches read. Pulled out so the
 * handler can forward a slice of its CurateWikiArgs without depending
 * on the handler's full shape.
 */
export interface G12ComposeArgs {
  readonly domain?: string;
  readonly include_scope_coverage?: boolean;
  readonly scope_coverage_jobs_max?: number;
  readonly include_reauthor?: boolean;
  readonly reauthor_jobs_max?: number;
  readonly project_root?: string;
  readonly today: string;
}

/**
 * Bundle of dep fields the G12 branches read. Optional everywhere —
 * a missing required adapter just short-circuits the branch to empty
 * arrays.
 */
export interface G12ComposeDeps {
  readonly wikiRoot: string;
  readonly listSubdirs?: ScopeCoverageDeps["listSubdirs"];
  readonly pageStat?: ScopeCoverageDeps["auditAdapters"]["pageStat"];
  readonly countSubstantivePages?: ScopeCoverageDeps["auditAdapters"]["countSubstantivePages"];
  readonly readWikiPageBody?: ScopeCoverageDeps["readWikiPageBody"];
  readonly sourceRootResolver?: ScopeCoverageDeps["sourceRootResolver"];
  readonly readPage?: ReauthorBranchDeps["readPage"];
  readonly pageMtime?: ReauthorBranchDeps["pageMtime"];
  readonly sourceFileMtime?: ReauthorBranchDeps["sourceFileMtime"];
  readonly listMdPages?: ReauthorBranchDeps["listMdPages"];
}

export interface G12BranchResult {
  readonly scopeJobs: readonly ScopeCoverageJobPayload[];
  readonly reauthorJobs: readonly ReauthorJobPayload[];
  readonly summary: readonly DomainCoverageSummary[];
}

/**
 * Compute the G12 scope-coverage + reauthor branches.
 *
 * Both short-circuit when their include_* flag is false or the
 * required adapters aren't wired. The handler picks the right deps
 * shape from its unified CurateWikiDeps and forwards.
 *
 * source: cortex@HEAD~ mcp_server/handlers/curate_wiki.py (2026-05-18)
 */
export async function computeG12Branches(
  args: G12ComposeArgs,
  deps: G12ComposeDeps,
  memories: readonly CuratorMemory[],
  existingPagesByTopic: ReadonlyMap<string, readonly string[]>,
): Promise<G12BranchResult> {
  let scopeJobs: readonly ScopeCoverageJobPayload[] = [];
  let summary: readonly DomainCoverageSummary[] = [];
  if (deps.listSubdirs && deps.pageStat && deps.countSubstantivePages) {
    const scopeDeps: ScopeCoverageDeps = {
      wikiRoot: deps.wikiRoot,
      listSubdirs: deps.listSubdirs,
      auditAdapters: {
        pageStat: deps.pageStat,
        countSubstantivePages: deps.countSubstantivePages,
      },
      ...(deps.readWikiPageBody ? { readWikiPageBody: deps.readWikiPageBody } : {}),
      ...(deps.sourceRootResolver ? { sourceRootResolver: deps.sourceRootResolver } : {}),
    };
    const scopeResult = computeScopeCoverageJobs(
      {
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.include_scope_coverage !== undefined ? { include_scope_coverage: args.include_scope_coverage } : {}),
        ...(args.scope_coverage_jobs_max !== undefined ? { scope_coverage_jobs_max: args.scope_coverage_jobs_max } : {}),
        today: args.today,
      },
      scopeDeps,
      memories,
      existingPagesByTopic,
    );
    scopeJobs = scopeResult.jobs;
    summary = scopeResult.summary;
  }

  let reauthorJobs: readonly ReauthorJobPayload[] = [];
  if (
    deps.listSubdirs && deps.pageStat && deps.countSubstantivePages &&
    deps.readPage && deps.pageMtime && deps.sourceFileMtime &&
    deps.listMdPages && deps.readWikiPageBody && deps.sourceRootResolver
  ) {
    const reauthorDeps: ReauthorBranchDeps = {
      wikiRoot: deps.wikiRoot,
      listSubdirs: deps.listSubdirs,
      auditAdapters: {
        pageStat: deps.pageStat,
        countSubstantivePages: deps.countSubstantivePages,
      },
      readWikiPageBody: deps.readWikiPageBody,
      sourceRootResolver: deps.sourceRootResolver,
      pageMtime: deps.pageMtime,
      sourceFileMtime: deps.sourceFileMtime,
      readPage: deps.readPage,
      listMdPages: deps.listMdPages,
    };
    reauthorJobs = await computeReauthorJobs(
      {
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.include_reauthor !== undefined ? { include_reauthor: args.include_reauthor } : {}),
        ...(args.reauthor_jobs_max !== undefined ? { reauthor_jobs_max: args.reauthor_jobs_max } : {}),
        ...(args.project_root !== undefined ? { project_root: args.project_root } : {}),
        today: args.today,
      },
      reauthorDeps,
    );
  }

  return { scopeJobs, reauthorJobs, summary };
}
