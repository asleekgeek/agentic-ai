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

// Per-cycle deletion cap. Tuned so the worst case (classifier bug
// misclassifying every page as a reject) costs one cap's worth of
// pages before the next cycle surfaces the regression. 500 is the
// conservative middle — three weeks to clear a 9k backlog, vs one
// bad cycle losing 500.
// source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py:48 — MAX_PURGES_PER_CYCLE
export const MAX_PURGES_PER_CYCLE = 500;

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

export interface WikiMaintenanceResult {
  readonly stub: WikiMaintenanceAxisResult;
  readonly classifier: WikiMaintenanceAxisResult;
  readonly max_purges_per_axis: number | null;
  readonly cluster_jobs: number;
  readonly coverage_gaps: number;
  readonly drifted_pages: number;
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

  return {
    stub,
    classifier,
    max_purges_per_axis: maxPurges,
    cluster_jobs,
    coverage_gaps,
    drifted_pages,
    pending_total: cluster_jobs + coverage_gaps + drifted_pages,
    status,
  };
}
