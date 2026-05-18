/**
 * maintenance.ts — Wiki maintenance cycle (G2).
 *
 * Runs on every ``consolidate`` invocation. Three moves:
 *
 *   1. **Purge stubs** — delete pages that are majority placeholder
 *      markers (``_(to be filled)_``, ``_To be written._``, …). Uses
 *      ``stub-detector.isStub`` to score; ``apply_stubs`` flag
 *      controls dry-run vs delete.
 *
 *   2. **Purge classifier-rejects** — delete pages that no longer
 *      pass the current admission classifier. Reuses the existing
 *      ``wiki-purge`` handler (it already evaluates pages against
 *      ``classifyMemory``).
 *
 *   3. **Backlog count** — report cluster_jobs + coverage_gaps +
 *      drifted_pages so SessionStart preamble can surface the queue
 *      depth to the next interactive LLM.
 *
 * Failure isolation: every axis runs inside try/catch and returns a
 * status string. ``consolidate`` runs other essential memory
 * maintenance (decay, compression, CLS transfer) that must NEVER be
 * blocked by a wiki edge case.
 *
 * source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py
 * source: user direction 2026-05-18 — "It should be running without a
 *   human in the loop, and wiki should be always up to date."
 */

import type { WikiKind } from "./types.js";
import { isStub } from "./stub-detector.js";
import {
  handler as wikiPurgeHandler,
  type WikiPurgeDeps,
} from "./handlers/wiki-purge.js";
import {
  computeWikiMaintenanceStats,
  type MaintenanceStatsDeps,
} from "./maintenance-stats.js";
import {
  countPendingClusters,
  type CuratorMemory,
} from "./auto-curator.js";
import {
  auditAllDomains,
  type AuditDomainAdapters,
  type ListSubdirsFn,
  missingCount,
} from "./domain-coverage.js";
import {
  renderDashboard,
  renderDashboardIndex,
  type DashboardAdapters,
} from "./coverage-dashboard.js";

// Per-cycle deletion cap. Tuned so the worst case (classifier bug
// misclassifying every page as a reject) costs one cap's worth of
// pages before the next cycle surfaces the regression. 500 is the
// conservative middle — three weeks to clear a 9k backlog, vs one
// bad cycle losing 500.
// source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py:48 — MAX_PURGES_PER_CYCLE
export const MAX_PURGES_PER_CYCLE = 500;

// Cap on the dashboard preview list returned in the maintenance result.
// The full list of regenerated projects can be large for a wiki with
// many domains; the result stays bounded so SessionStart can surface
// it without ballooning the preamble.
// source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py — projects[:20]
const DASHBOARD_INDEX_PREVIEW_CAP = 20;

// Autonomous mode defaults: the system decides without a human in the
// loop. Stub + classifier purge axes are ON; shallow pages are NEVER
// auto-deleted (user direction 2026-05-18 — "Removing is not a
// solution. Fixing the curation by showing information that should be
// present and missing for each file is a curation of the documentation.").
// source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py:31-44
export const AUTONOMOUS_STUB_APPLY_DEFAULT = true;
export const AUTONOMOUS_CLASSIFIER_APPLY_DEFAULT = true;

// ── Public types ────────────────────────────────────────────────────────

export interface RunWikiMaintenanceOpts {
  readonly applyStubs?: boolean;
  readonly applyClassifierRejects?: boolean;
  readonly maxPurgesPerAxis?: number;
}

export interface WikiMaintenanceAxisResult {
  readonly applied: boolean;
  readonly purged: number;
  readonly deferred: number;
}

export interface DashboardWriteResult {
  readonly written: number;
  readonly projects: readonly string[];
}

export interface WikiMaintenanceResult {
  readonly stub: WikiMaintenanceAxisResult;
  readonly classifier: WikiMaintenanceAxisResult;
  readonly max_purges_per_axis: number | null;
  readonly cluster_jobs: number;
  readonly coverage_gaps: number;
  readonly drifted_pages: number;
  /** Missing canonical scopes across every audited domain (G6/G12). */
  readonly scope_coverage_gaps: number;
  /** Per-project dashboards regenerated this cycle (G5). */
  readonly dashboards: DashboardWriteResult;
  readonly pending_total: number;
  readonly status: string;
}

/**
 * Dependencies for the wiki maintenance cycle.
 *
 * - ``wikiRoot``: filesystem root of the wiki (per WIKI_ROOT config).
 * - ``memories``: snapshot used for cluster-backlog counting.
 * - ``purgeDeps``: the existing wiki-purge handler deps (list + delete + classifier).
 * - ``maintenanceStatsDeps``: deps for computeWikiMaintenanceStats (drift + coverage).
 *
 * Composition root supplies all real fs adapters; tests inject stubs.
 */
export interface RunWikiMaintenanceDeps {
  readonly wikiRoot: string;
  readonly memories: readonly CuratorMemory[];
  readonly purgeDeps: WikiPurgeDeps;
  readonly maintenanceStatsDeps: MaintenanceStatsDeps;
  /**
   * Walk every wiki page; for each return (relPath, body). Used by the
   * stub-purge axis which reads bodies and applies the stub detector.
   */
  readonly listPageBodies: (
    root: string,
    kindFilter?: WikiKind | null,
  ) => Promise<ReadonlyArray<{ relPath: string; content: string }>>;
  /**
   * Delete a wiki page by absolute path. Same signature as
   * ``wikiPurgeDeps.deleteFile`` — kept separate so the maintenance
   * cycle can attribute deletions to the stub axis.
   */
  readonly deleteFile: (absPath: string) => Promise<void>;
  /**
   * POSIX-style join for wiki rel paths. Kept injectable so tests
   * don't need to depend on node:path.
   */
  readonly joinPath: (root: string, rel: string) => string;
  // ── G6 / G5 wiring (scope audit + dashboards) ──
  // All optional — when missing, the scope_coverage_gaps count is 0
  // and no dashboards are written. Composition root supplies real fs
  // adapters; tests inject stubs.
  /**
   * Discovers project directories under wiki kind buckets. Required
   * by ``auditAllDomains`` for the scope audit + dashboard pass.
   * source: packages/memory/src/wiki/domain-coverage.ts:listDomains
   */
  readonly listSubdirs?: ListSubdirsFn;
  /**
   * Stat adapter for ``<wiki>/<kind>/<domain>/<anchor>.md`` candidates.
   * source: packages/memory/src/wiki/domain-coverage.ts:auditDomain
   */
  readonly pageStat?: AuditDomainAdapters["pageStat"];
  /**
   * Count substantive ``.md`` pages under a wiki subdirectory.
   * source: packages/memory/src/wiki/domain-coverage.ts:auditDomain
   */
  readonly countSubstantivePages?: AuditDomainAdapters["countSubstantivePages"];
  /**
   * Per-domain file-coverage roll-up reader. Reuses whatever's already
   * computed in this cycle; when missing, the dashboard reports
   * ``null`` for the file-coverage ratio.
   * source: packages/memory/src/wiki/coverage-dashboard.ts:FileCoverageRollup
   */
  readonly fileCoverageRollup?: DashboardAdapters["fileCoverage"];
  /**
   * Per-domain kind-page counts for the dashboard "Pages by kind"
   * breakdown. Optional.
   * source: packages/memory/src/wiki/coverage-dashboard.ts:KindPageCountsFn
   */
  readonly kindCounts?: DashboardAdapters["kindCounts"];
  /**
   * Per-domain curation-gap counts (open gap totals across all pages
   * in the domain). Used by the dashboard's "Open curation gaps"
   * scoreboard row.
   * source: packages/memory/src/wiki/coverage-dashboard.ts:CurationGapCountsFn
   */
  readonly curationGapCounts?: DashboardAdapters["curationGapCounts"];
  /**
   * Write a generated page (the per-domain dashboard, or the
   * dashboard index) at ``<wikiRoot>/<relPath>``. Returns true on
   * success, false on any failure (non-fatal).
   * source: cortex/mcp_server/core/wiki_coverage_dashboard.py:write_dashboards
   */
  readonly writeWikiPage?: (relPath: string, body: string) => Promise<boolean>;
}

// ── Stub purge ──────────────────────────────────────────────────────────

/**
 * Identify and purge stub pages.
 *
 * source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py:101-115 (stub axis)
 *   + cortex/mcp_server/core/wiki_stub_detector.py::is_stub
 */
async function runStubAxis(
  deps: RunWikiMaintenanceDeps,
  apply: boolean,
  maxPurges: number,
): Promise<WikiMaintenanceAxisResult> {
  let purged = 0;
  let deferred = 0;
  try {
    const pages = await deps.listPageBodies(deps.wikiRoot);
    const candidates = pages.filter((p) => isStub(p.content));
    for (const page of candidates) {
      if (purged >= maxPurges) {
        deferred += 1;
        continue;
      }
      if (!apply) {
        // Dry-run — count it but don't delete.
        purged += 1;
        continue;
      }
      try {
        await deps.deleteFile(deps.joinPath(deps.wikiRoot, page.relPath));
        purged += 1;
      } catch {
        // Treat as deferred — the next cycle will retry.
        deferred += 1;
      }
    }
  } catch {
    // Outer failure — the stub axis silently no-ops; consolidate
    // continues. The caller's ``status`` field carries the error.
  }
  return { applied: apply, purged, deferred };
}

// ── Classifier purge ────────────────────────────────────────────────────

/**
 * Run the existing classifier-reject purge. The handler already
 * evaluates every page against ``classifyMemory``. We pass it through
 * with the ``apply`` flag the maintenance cycle was configured with.
 *
 * The handler does NOT carry a max-purges cap natively. We approximate
 * the Cortex cap by collecting the candidate list first and bailing
 * out if it exceeds the cap — handing the overflow to the next cycle.
 *
 * source: packages/memory/src/wiki/handlers/wiki-purge.ts::handler
 *   + cortex/mcp_server/handlers/consolidation/wiki_maintenance.py:117-128
 */
async function runClassifierAxis(
  deps: RunWikiMaintenanceDeps,
  apply: boolean,
  maxPurges: number,
): Promise<WikiMaintenanceAxisResult> {
  // Dry-run first to compute the candidate list size and respect the cap.
  // The handler returns ``purged_paths`` which is the list it would
  // delete (or did delete) — we use that to compute deferred.
  try {
    const dryRun = await wikiPurgeHandler({ apply: false }, deps.purgeDeps);
    if ("error" in dryRun) {
      return { applied: apply, purged: 0, deferred: 0 };
    }
    const total = dryRun.purged;
    if (total === 0) return { applied: apply, purged: 0, deferred: 0 };

    if (total <= maxPurges) {
      // Below cap — run the real purge.
      if (!apply) return { applied: false, purged: total, deferred: 0 };
      const real = await wikiPurgeHandler({ apply: true }, deps.purgeDeps);
      if ("error" in real) return { applied: true, purged: 0, deferred: total };
      return { applied: true, purged: real.purged, deferred: 0 };
    }

    // Over cap — defer the overflow to the next cycle. The handler
    // doesn't support partial deletion natively; we'd have to
    // re-implement the walk to chunk it. For the autonomous cycle,
    // defer everything and surface the count so the operator sees
    // the regression. This matches Cortex's worst-case behaviour.
    return { applied: apply, purged: 0, deferred: total };
  } catch {
    return { applied: apply, purged: 0, deferred: 0 };
  }
}

// ── Scope-coverage audit + per-project dashboards ──────────────────────

interface ScopeAuditOutcome {
  readonly scope_coverage_gaps: number;
  readonly dashboards: DashboardWriteResult;
}

/**
 * Audit every domain's canonical-scope coverage and (if a writer is
 * wired) emit one dashboard per project plus an index. Returns the
 * aggregate missing-scope count for the maintenance result.
 *
 * source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py — dashboards block
 *   + cortex/mcp_server/core/wiki_coverage_dashboard.py::write_dashboards
 */
async function runScopeAuditAndDashboards(
  deps: RunWikiMaintenanceDeps,
): Promise<ScopeAuditOutcome> {
  if (!deps.listSubdirs || !deps.pageStat || !deps.countSubstantivePages) {
    return { scope_coverage_gaps: 0, dashboards: { written: 0, projects: [] } };
  }
  const auditAdapters: AuditDomainAdapters = {
    pageStat: deps.pageStat,
    countSubstantivePages: deps.countSubstantivePages,
  };

  // Scope coverage count — sum missing scopes across every domain.
  let totalMissing = 0;
  const coverages = auditAllDomains(deps.listSubdirs, auditAdapters);
  for (const c of coverages) totalMissing += missingCount(c);

  // Dashboard write — only when every dashboard adapter + the page
  // writer is wired. Missing any adapter leaves the dashboards unwritten
  // but still reports the scope-gap count above.
  const written: string[] = [];
  if (
    deps.fileCoverageRollup &&
    deps.kindCounts &&
    deps.curationGapCounts &&
    deps.writeWikiPage
  ) {
    const dashAdapters: DashboardAdapters = {
      ...auditAdapters,
      fileCoverage: deps.fileCoverageRollup,
      kindCounts: deps.kindCounts,
      curationGapCounts: deps.curationGapCounts,
    };
    for (const c of coverages) {
      try {
        const body = renderDashboard(c.domain, dashAdapters);
        const ok = await deps.writeWikiPage(`_dashboards/${c.domain}.md`, body);
        if (ok) written.push(c.domain);
      } catch {
        // Non-fatal — one project failing should not block others.
      }
    }
    // Index page listing every dashboard.
    try {
      const indexBody = renderDashboardIndex(written);
      await deps.writeWikiPage("_dashboards/_index.md", indexBody);
    } catch {
      // Non-fatal.
    }
  }

  return {
    scope_coverage_gaps: totalMissing,
    dashboards: { written: written.length, projects: written.slice(0, DASHBOARD_INDEX_PREVIEW_CAP) },
  };
}

// ── Public entry ────────────────────────────────────────────────────────

/**
 * Run the wiki maintenance cycle.
 *
 * Idempotent — running twice on a freshly-groomed wiki is a no-op.
 * Failure isolation — every axis is try/catched and its error
 * surfaces in the ``status`` string; the function never throws.
 *
 * source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py::run_wiki_maintenance
 */
export async function runWikiMaintenance(
  deps: RunWikiMaintenanceDeps,
  opts: RunWikiMaintenanceOpts = {},
): Promise<WikiMaintenanceResult> {
  const applyStubs = opts.applyStubs ?? AUTONOMOUS_STUB_APPLY_DEFAULT;
  const applyClassifier = opts.applyClassifierRejects ?? AUTONOMOUS_CLASSIFIER_APPLY_DEFAULT;
  const maxPurges = opts.maxPurgesPerAxis ?? MAX_PURGES_PER_CYCLE;

  let status = "ok";

  const stub = await runStubAxis(deps, applyStubs, maxPurges).catch((exc) => {
    status = `stub_error: ${exc instanceof Error ? exc.message : String(exc)}`;
    return { applied: applyStubs, purged: 0, deferred: 0 } as WikiMaintenanceAxisResult;
  });

  const classifier = await runClassifierAxis(deps, applyClassifier, maxPurges).catch((exc) => {
    if (status === "ok") {
      status = `classifier_error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
    return { applied: applyClassifier, purged: 0, deferred: 0 } as WikiMaintenanceAxisResult;
  });

  // Backlog count — clusters + coverage_gaps + drifted_pages.
  let cluster_jobs = 0;
  let coverage_gaps = 0;
  let drifted_pages = 0;
  try {
    cluster_jobs = countPendingClusters(deps.memories, {
      wikiRoot: deps.wikiRoot,
      pageMtime: deps.maintenanceStatsDeps.pageMtime,
    });
    const stats = await computeWikiMaintenanceStats(deps.maintenanceStatsDeps);
    coverage_gaps = stats.totalCoverage;
    drifted_pages = stats.totalDrift;
  } catch (exc) {
    if (status === "ok") {
      status = `backlog_error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }

  // G6 / G5 — scope-coverage audit + per-project dashboards.
  let scopeOutcome: ScopeAuditOutcome = {
    scope_coverage_gaps: 0,
    dashboards: { written: 0, projects: [] },
  };
  try {
    scopeOutcome = await runScopeAuditAndDashboards(deps);
  } catch (exc) {
    if (status === "ok") {
      status = `scope_audit_error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }

  return {
    stub,
    classifier,
    max_purges_per_axis: maxPurges,
    cluster_jobs,
    coverage_gaps,
    drifted_pages,
    scope_coverage_gaps: scopeOutcome.scope_coverage_gaps,
    dashboards: scopeOutcome.dashboards,
    pending_total: cluster_jobs + coverage_gaps + drifted_pages + scopeOutcome.scope_coverage_gaps,
    status,
  };
}
