/**
 * session-start-maintenance.ts — wiki backlog counts surfaced by the
 * SessionStart preamble (curation + drift + coverage).
 *
 * Extracted from session-start.ts to keep that file under the §4.1
 * file-size cap. Same engine + failure-isolation contract as the
 * MCP-tool layer's consolidation-wiki-adapters.ts — the numbers the
 * preamble shows, the dashboard cards show, and the consolidate
 * response carries are all derived from this code.
 *
 * source: cortex@4883307 mcp_server/hooks/session_start.py:206-263
 * source: packages/memory/src/wiki/maintenance-stats.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { fetchRecentMemoriesForCuration } from "./curation-fetch.js";
import { countPendingClusters, type PageMtimeFn } from "../wiki/auto-curator.js";
import {
  computeWikiMaintenanceStats,
  defaultExtractDomain,
} from "../wiki/maintenance-stats.js";
import { autoResolveProjectRoot } from "../wiki/project-roots.js";
import { collectSourceFiles } from "../codebase-analysis/handlers/codebase-analyze-helpers.js";

// ── Configuration constants ──────────────────────────────────────────────

// source: cortex@4883307 mcp_server/hooks/session_start.py:226 ("LIMIT 500")
const CURATION_MEM_POOL = 500;

// source: cortex@ed33435 mcp_server/infrastructure/config.py — WIKI_ROOT default
const SESSION_START_WIKI_ROOT: string =
  process.env["CORTEX_WIKI_ROOT"] ?? pathJoin(homedir(), ".claude", "methodology", "wiki");

// Cap source files walked per project at SessionStart. Past this the
// coverage count is an underestimate; the preamble nudge still fires
// when the queue is non-empty, which is the load-bearing property.
// source: this module — SessionStart latency budget
const SESSION_START_COVERAGE_MAX_FILES = 5000;

// File-size cap during the coverage walk. Matches codebase_analyze's
// default so the wiki coverage scan and the analyze tool see the same
// file set.
// source: cortex codebase_analyze.py — max_file_size_kb default = 100
const FILE_SIZE_KB_DEFAULT = 100;
const BYTES_PER_KB = 1024; // source: IEC 80000-13:2008 §21-12
// source: ECMAScript spec — Date timestamps are milliseconds
const MS_PER_SECOND = 1000;

// ── Filesystem adapters ─────────────────────────────────────────────────

// Filesystem-mtime adapter for the curator's skip-already-authored filter.
// Returns seconds-since-epoch or null when the page is absent. statSync
// throws on missing — catch and return null so the curator treats the
// page as eligible.
// source: cortex@4883307 mcp_server/core/auto_curator.py::is_path_recently_authored
const SESSION_START_PAGE_MTIME: PageMtimeFn = (absPath: string): number | null => {
  try {
    return statSync(absPath).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
};

// POSIX-style join for wiki rel paths.
function joinWikiPath(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// Walk a wiki directory and return rel-paths of every ``.md`` file.
function listMdRelPaths(root: string): string[] {
  const out: string[] = [];
  function walk(absDir: string, prefix: string): void {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const next = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(pathJoin(absDir, e.name), next);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(next);
    }
  }
  walk(root, "");
  return out;
}

function readWikiPageBody(root: string, rel: string): string | null {
  try { return readFileSync(joinWikiPath(root, rel), "utf-8"); } catch { return null; }
}

function projectFileMtimeFn(projectRoot: string, rel: string): number | null {
  try {
    return statSync(pathJoin(projectRoot, rel)).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
}

// ── Public entry points ─────────────────────────────────────────────────

/**
 * Backlog count for the SessionStart preamble's pending_curations
 * field. Same failure-tolerant contract as the consolidate tool's
 * adapter; returns 0 on any error.
 *
 * source: cortex@4883307 mcp_server/hooks/session_start.py:_count_pending_curations
 */
export async function countPendingCurationsSafe(databaseUrl: string): Promise<number> {
  try {
    const memories = await fetchRecentMemoriesForCuration(databaseUrl, CURATION_MEM_POOL);
    if (memories.length === 0) return 0;
    // CuratorMemorySnapshot is a strict structural subset of
    // CuratorMemory — missing only the open-ended index signature for
    // arbitrary extra fields. The two-step ``unknown`` cast is the
    // canonical TS escape when the strict-mode mismatch is purely
    // about index signatures.
    return countPendingClusters(
      memories as unknown as readonly Record<string, unknown>[],
      {
        wikiRoot: SESSION_START_WIKI_ROOT,
        pageMtime: SESSION_START_PAGE_MTIME,
      },
    );
  } catch {
    return 0;
  }
}

export interface MaintenanceCountsLocal {
  readonly drift: number;
  readonly coverage: number;
}

/**
 * Drift + coverage counts for the SessionStart preamble. Same engine
 * as the consolidate tool's response payload and the dashboard's
 * /api/wiki/maintenance endpoint, so all three surfaces report
 * identical numbers.
 *
 * source: packages/memory/src/wiki/maintenance-stats.ts
 */
export async function countPendingMaintenanceSafe(): Promise<MaintenanceCountsLocal> {
  try {
    const stats = await computeWikiMaintenanceStats(
      {
        wikiRoot:        SESSION_START_WIKI_ROOT,
        listMdPages:     async (root) => listMdRelPaths(root),
        readPage:        async (root, rel) => readWikiPageBody(root, rel),
        pageMtime:       SESSION_START_PAGE_MTIME,
        projectRootFor:  autoResolveProjectRoot,
        listSourceFiles: async (root, maxFiles) =>
          collectSourceFiles(root, null, maxFiles, FILE_SIZE_KB_DEFAULT * BYTES_PER_KB)
            .map((p) => p.startsWith(root) ? p.slice(root.length + 1) : p),
        fileMtime:       projectFileMtimeFn,
        extractDomain:   defaultExtractDomain,
      },
      { maxCoverageFiles: SESSION_START_COVERAGE_MAX_FILES },
    );
    return { drift: stats.totalDrift, coverage: stats.totalCoverage };
  } catch {
    return { drift: 0, coverage: 0 };
  }
}
