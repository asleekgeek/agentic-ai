/**
 * maintenance-stats.ts — single source of truth for drift + coverage
 * counts across every project in the wiki.
 *
 * Consumed by:
 *   - the consolidate MCP tool (emits pending_drift / pending_coverage
 *     alongside pending_curations)
 *   - the SessionStart hook (preamble shows the queue depth)
 *   - the memory-dashboard project cards (per-project maintenance badges)
 *
 * Same engine for all three so the numbers always agree.
 *
 * Pure-logic composition over the auto-curator's source-drift + file-
 * coverage modules. All I/O comes through injected adapters; tests run
 * deterministically without touching the filesystem.
 *
 * source: packages/memory/src/wiki/source-drift.ts
 * source: packages/memory/src/wiki/file-coverage.ts
 * source: packages/memory/src/wiki/project-roots.ts
 *
 * User feedback 2026-05-18: "No deferral acceptable" — drift +
 * coverage must surface in every entry point, not just curate_wiki.
 */

import type { PageMtimeFn } from "./auto-curator.js";
import { auditWikiDrift } from "./source-drift.js";
import { computeCoverageGap } from "./file-coverage.js";

/**
 * Maximum source files walked per project for the coverage count.
 * Past this cap the count is an underestimate, but the SessionStart
 * preamble + project-card badges stay snappy on huge monorepos.
 */
// source: this module — balance between accuracy and SessionStart latency budget; matches codebase_analyze's pre-2f42428 cap.
const COVERAGE_MAX_FILES_DEFAULT = 5000;

/**
 * Maximum wiki pages scanned for drift. Past this cap drift is an
 * underestimate. Set high enough to cover even large wikis.
 */
// source: this module — empirical wiki size ceiling × 2 (production wikis 1k-5k pages)
const DRIFT_MAX_PAGES_DEFAULT = 10_000;

// ── Public types ───────────────────────────────────────────────────────

/** Per-project drift + coverage counts. */
export interface ProjectMaintenance {
  readonly drift: number;
  readonly coverage: number;
  readonly projectRoot: string | null;
}

/** Aggregate maintenance report. */
export interface MaintenanceStats {
  readonly totalDrift: number;
  readonly totalCoverage: number;
  readonly totalPages: number;
  readonly perProject: ReadonlyMap<string, ProjectMaintenance>;
}

/**
 * Dependencies for the stats engine. Every adapter is injected so the
 * pure-logic core (computeWikiMaintenanceStats) is testable.
 *
 * - ``listMdPages`` / ``readPage`` / ``pageMtime``: wiki-side I/O.
 * - ``projectRootFor(domain)``: resolves a domain → project root, or
 *   null when nothing matches (drift/coverage skip that domain).
 * - ``listSourceFiles(projectRoot, maxFiles)``: walks the project
 *   tree; bounded by ``maxFiles`` (0 = unbounded; we always pass a
 *   positive cap here).
 * - ``fileMtime(projectRoot, relPath)``: source-file mtime in seconds
 *   relative to the project, null on ENOENT.
 * - ``extractDomain(relPath)``: page path → project name. Matches the
 *   front-end's extractDomain so back-end counts line up with
 *   per-project cards.
 */
export interface MaintenanceStatsDeps {
  readonly wikiRoot: string;
  readonly listMdPages: (root: string) => Promise<string[]>;
  readonly readPage: (root: string, rel: string) => Promise<string | null>;
  readonly pageMtime: PageMtimeFn;
  readonly projectRootFor: (domain: string) => string | null;
  readonly listSourceFiles: (projectRoot: string, maxFiles: number) => Promise<string[]>;
  readonly fileMtime: (projectRoot: string, relPath: string) => number | null;
  readonly extractDomain: (pagePath: string) => string | null;
}

export interface MaintenanceStatsOpts {
  /** Hard cap on source files walked per project. Default 5000. */
  readonly maxCoverageFiles?: number;
  /** Hard cap on wiki pages scanned. Default 10_000. */
  readonly maxDriftPages?: number;
}

// ── Composition ────────────────────────────────────────────────────────

/**
 * Compute drift + coverage counts across every domain in the wiki.
 *
 * Algorithm:
 *   1. List wiki pages; partition by domain via ``extractDomain``.
 *   2. For each domain whose ``projectRootFor`` returns non-null:
 *      a. Read pages + mtimes; call ``auditWikiDrift`` over them.
 *      b. Walk source files; call ``computeCoverageGap`` against the
 *         existing-pages set scoped to this domain.
 *   3. Sum the per-project counts; return totals + the per-project map.
 *
 * Best-effort — adapters that throw are caught and treated as
 * empty/zero results; consolidate must never break because of a
 * maintenance count.
 *
 * source: this module — drift + coverage aggregation
 */
export async function computeWikiMaintenanceStats(
  deps: MaintenanceStatsDeps,
  opts: MaintenanceStatsOpts = {},
): Promise<MaintenanceStats> {
  const maxCoverage = opts.maxCoverageFiles ?? COVERAGE_MAX_FILES_DEFAULT;
  const maxDrift    = opts.maxDriftPages    ?? DRIFT_MAX_PAGES_DEFAULT;

  let relPaths: string[] = [];
  try {
    relPaths = (await deps.listMdPages(deps.wikiRoot)).slice(0, maxDrift);
  } catch {
    return emptyReport();
  }
  if (relPaths.length === 0) return emptyReport();

  // Partition by domain.
  const byDomain = new Map<string, string[]>();
  for (const rel of relPaths) {
    const domain = deps.extractDomain(rel);
    if (!domain) continue;
    const arr = byDomain.get(domain) ?? [];
    arr.push(rel);
    byDomain.set(domain, arr);
  }

  const perProject = new Map<string, ProjectMaintenance>();
  let totalDrift = 0;
  let totalCoverage = 0;

  for (const [domain, pages] of byDomain) {
    const projectRoot = deps.projectRootFor(domain);
    const drift = projectRoot
      ? await countDriftForProject(deps, pages, projectRoot)
      : 0;
    const coverage = projectRoot
      ? await countCoverageForProject(deps, domain, pages, projectRoot, maxCoverage)
      : 0;
    perProject.set(domain, { drift, coverage, projectRoot });
    totalDrift += drift;
    totalCoverage += coverage;
  }

  return {
    totalDrift,
    totalCoverage,
    totalPages: relPaths.length,
    perProject,
  };
}

function emptyReport(): MaintenanceStats {
  return {
    totalDrift: 0,
    totalCoverage: 0,
    totalPages: 0,
    perProject: new Map(),
  };
}

async function countDriftForProject(
  deps: MaintenanceStatsDeps,
  pages: readonly string[],
  projectRoot: string,
): Promise<number> {
  const scanPages = [];
  for (const rel of pages) {
    let mt: number | null = null;
    let body: string | null = null;
    try { mt = deps.pageMtime(joinPath(deps.wikiRoot, rel)); } catch { /* keep null */ }
    try { body = await deps.readPage(deps.wikiRoot, rel); } catch { /* keep null */ }
    scanPages.push({ path: rel, mtimeSeconds: mt, content: body ?? "" });
  }
  const fileMtime: PageMtimeFn = (p) => {
    try { return deps.fileMtime(projectRoot, p); } catch { return null; }
  };
  try {
    return auditWikiDrift(scanPages, fileMtime).totalDrifted;
  } catch {
    return 0;
  }
}

async function countCoverageForProject(
  deps: MaintenanceStatsDeps,
  domain: string,
  pages: readonly string[],
  projectRoot: string,
  maxFiles: number,
): Promise<number> {
  let sourceFiles: string[] = [];
  try {
    sourceFiles = await deps.listSourceFiles(projectRoot, maxFiles);
  } catch {
    return 0;
  }
  try {
    return computeCoverageGap(sourceFiles, domain, pages).length;
  } catch {
    return 0;
  }
}

// POSIX-style join — keeps wiki paths slash-shaped regardless of OS.
function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// ── Page-path → domain helper for callers ──────────────────────────────

/**
 * Default page-path → domain extractor matching the dashboard's
 * frontend extractDomain logic (``parts[1]`` from the page path,
 * dropping placeholder buckets).
 *
 * source: packages/memory-dashboard/src/static/js/wiki.js — extractDomain
 */
// Minimum path segment count for a page to carry a project segment.
// Wiki paths are ``<kind>/<domain>/<slug>.md`` (3 segments); shorter
// paths (e.g. ``INDEX.md``) belong to no project.
// source: packages/memory/src/wiki/layout.ts — three-segment shape
const MIN_PROJECT_PATH_SEGMENTS = 3;

export function defaultExtractDomain(pagePath: string): string | null {
  const parts = pagePath.split("/").filter(Boolean);
  if (parts.length < MIN_PROJECT_PATH_SEGMENTS) return null;
  const domain = parts[1];
  if (!domain || domain.startsWith("_")) return null;
  return domain;
}
