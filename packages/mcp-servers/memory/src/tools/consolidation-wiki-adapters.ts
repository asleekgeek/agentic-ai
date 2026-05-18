/**
 * consolidation-wiki-adapters.ts — fs adapters + glue that the
 * consolidate MCP tool uses to drive the wiki maintenance cycle.
 *
 * Extracted from consolidation.ts (which crossed the 500-LOC file
 * size cap defined in §4.1 of the coding standards) to keep that
 * file focused on tool registration + memory-only maintenance.
 *
 * Three responsibilities, all failure-isolated by their callers:
 *
 *   - countPendingCurationsSafe(store) — backlog count for the
 *     pending_curations field in the consolidate response.
 *   - countPendingMaintenance() — drift + coverage counts via the
 *     maintenance-stats engine (Phase C). Same numbers the dashboard
 *     project cards show.
 *   - runConsolidateWikiCycle(store, applyStubs, applyClassifierRejects)
 *     — invokes runWikiMaintenance (G2) with real fs adapters,
 *     returning the wiki stanza for the consolidate response.
 *
 * source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py
 * source: packages/memory/src/wiki/maintenance.ts
 */

import { readdirSync, readFileSync as nodeReadFileSync, statSync, unlinkSync as nodeUnlink } from "node:fs";
import { homedir } from "node:os";
import { join, join as nodeJoin } from "node:path";

import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import { countPendingClusters, type CuratorMemory, type PageMtimeFn } from "@agentic/memory/wiki/auto-curator.js";
import {
  computeWikiMaintenanceStats,
  defaultExtractDomain,
} from "@agentic/memory/wiki/maintenance-stats.js";
import { autoResolveProjectRoot } from "@agentic/memory/wiki/project-roots.js";
import { collectSourceFiles as codebaseCollectSourceFiles } from "@agentic/memory/codebase-analysis/handlers/codebase-analyze-helpers.js";
import { runWikiMaintenance, type WikiMaintenanceResult } from "@agentic/memory/wiki/maintenance.js";
import { readPage as fsReadPage, listPages as fsListPages } from "@agentic/memory/wiki/storage/wiki-store.js";

// ── Configuration constants ─────────────────────────────────────────────

// source: cortex@ed33435 mcp_server/infrastructure/config.py — WIKI_ROOT default
export const CONSOLIDATE_WIKI_ROOT: string =
  process.env["CORTEX_WIKI_ROOT"] ??
  join(homedir(), ".claude", "methodology", "wiki");

// Memory pool size used by the SessionStart helper in Cortex. Matches
// the curator's default pool so the count is consistent with what
// curate_wiki returns on a full invocation.
// source: cortex@4883307 mcp_server/hooks/session_start.py:226 ("LIMIT 500")
const CONSOLIDATE_MEM_POOL = 500;

// Per-source-file size cap during walk — matches codebase_analyze's
// default so the wiki coverage scan and the analyze tool see the same
// file set.
// source: cortex codebase_analyze.py — max_file_size_kb default = 100
const FILE_SIZE_KB_DEFAULT = 100;
const BYTES_PER_KB = 1024; // source: IEC 80000-13:2008 §21-12

// ── Filesystem adapters ────────────────────────────────────────────────

// Filesystem-mtime adapter. Returns seconds-since-epoch or null when
// the file doesn't exist. statSync throws on missing — catch and
// return null so the curator can treat it as "page absent, eligible".
// source: cortex@4883307 mcp_server/core/auto_curator.py::is_path_recently_authored
export const SECONDS_DIV: PageMtimeFn = (absPath: string): number | null => {
  try {
    const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
    return statSync(absPath).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
};

// POSIX-style join for wiki rel paths — keeps slash-shaped paths regardless of OS.
function joinWiki(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// Walk a wiki directory and return rel-paths of every ``.md`` file.
// Decoupled from the dashboard package so consolidate doesn't depend on it.
// source: this module — wiki-listing for maintenance scan
function listMdRelPaths(root: string): string[] {
  const out: string[] = [];
  function walk(absDir: string, prefix: string): void {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const next = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(nodeJoin(absDir, e.name), next);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(next);
    }
  }
  walk(root, "");
  return out;
}

// Page-body reader for the drift scan; failure returns null.
function readPageBody(root: string, rel: string): string | null {
  try { return nodeReadFileSync(joinWiki(root, rel), "utf-8"); } catch { return null; }
}

// Project-rooted file mtime adapter.
function projectFileMtime(projectRoot: string, rel: string): number | null {
  try {
    const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
    return statSync(nodeJoin(projectRoot, rel)).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
}

// Source-file walker bounded to a sensible coverage cap.
async function listProjectSources(projectRoot: string, maxFiles: number): Promise<string[]> {
  try {
    const abs = codebaseCollectSourceFiles(
      projectRoot,
      null,
      maxFiles,
      FILE_SIZE_KB_DEFAULT * BYTES_PER_KB,
    );
    return abs.map((p) => p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p);
  } catch {
    return [];
  }
}

// ── Public adapters used by the consolidate MCP tool ───────────────────

/**
 * Drift + coverage counts for the consolidate response payload.
 * Same engine as the dashboard's /api/wiki/maintenance and the
 * SessionStart preamble.
 *
 * source: packages/memory/src/wiki/maintenance-stats.ts
 */
export interface MaintenanceCounts {
  readonly drift: number | null;
  readonly coverage: number | null;
}

export async function countPendingMaintenance(): Promise<MaintenanceCounts> {
  try {
    const stats = await computeWikiMaintenanceStats({
      wikiRoot:        CONSOLIDATE_WIKI_ROOT,
      listMdPages:     async (root) => listMdRelPaths(root),
      readPage:        async (root, rel) => readPageBody(root, rel),
      pageMtime:       SECONDS_DIV,
      projectRootFor:  autoResolveProjectRoot,
      listSourceFiles: listProjectSources,
      fileMtime:       projectFileMtime,
      extractDomain:   defaultExtractDomain,
    });
    return { drift: stats.totalDrift, coverage: stats.totalCoverage };
  } catch {
    return { drift: null, coverage: null };
  }
}

/**
 * Backlog count for the pending_curations field. Fetches the same
 * 500-memory pool the SessionStart helper uses so the numbers match.
 *
 * source: cortex@4883307 mcp_server/handlers/consolidate.py:153-172
 */
export async function countPendingCurationsSafe(store: MemoryStoreExt): Promise<number | null> {
  try {
    const storeExt = store as MemoryStoreExt & {
      getRecentlyAccessedMemoriesAsync?: (limit: number, minAccessCount: number) => Promise<Record<string, unknown>[]>;
    };
    const rows = storeExt.getRecentlyAccessedMemoriesAsync
      ? await storeExt.getRecentlyAccessedMemoriesAsync(CONSOLIDATE_MEM_POOL, 1)
      : store.getRecentlyAccessedMemories(CONSOLIDATE_MEM_POOL, 1);
    if (rows.length === 0) return 0;
    return countPendingClusters(rows as CuratorMemory[], {
      wikiRoot: CONSOLIDATE_WIKI_ROOT,
      pageMtime: SECONDS_DIV,
    });
  } catch {
    return null;
  }
}

/**
 * Compose runWikiMaintenance with real fs + store adapters. Returns
 * the wiki stanza for the consolidate response. Failure-isolated by
 * the caller (try/catch at the call site).
 *
 * source: packages/memory/src/wiki/maintenance.ts::runWikiMaintenance
 */
export async function runConsolidateWikiCycle(
  store: MemoryStoreExt,
  applyStubs: boolean,
  applyClassifierRejects: boolean,
): Promise<WikiMaintenanceResult> {
  const storeExt = store as MemoryStoreExt & {
    getRecentlyAccessedMemoriesAsync?: (limit: number, minAccessCount: number) => Promise<Record<string, unknown>[]>;
  };
  let memories: Record<string, unknown>[] = [];
  try {
    memories = storeExt.getRecentlyAccessedMemoriesAsync
      ? await storeExt.getRecentlyAccessedMemoriesAsync(CONSOLIDATE_MEM_POOL, 1)
      : store.getRecentlyAccessedMemories(CONSOLIDATE_MEM_POOL, 1);
  } catch {
    memories = [];
  }

  // Adapter: list every wiki page with body. The maintenance cycle's
  // stub-purge axis reads each body and applies isStub(); the
  // classifier axis goes through the existing wikiPurgeHandler which
  // takes a different listAllMarkdownFiles adapter.
  const listPageBodies = async (
    root: string,
  ): Promise<ReadonlyArray<{ relPath: string; content: string }>> => {
    const rels = fsListPages(root);
    const out: { relPath: string; content: string }[] = [];
    for (const rel of rels) {
      const body = fsReadPage(root, rel);
      if (body !== null) out.push({ relPath: rel, content: body });
    }
    return out;
  };

  return runWikiMaintenance({
    wikiRoot: CONSOLIDATE_WIKI_ROOT,
    memories: memories as Parameters<typeof runWikiMaintenance>[0]["memories"],
    purgeDeps: {
      wikiRoot:             CONSOLIDATE_WIKI_ROOT,
      wikiRoot_string:      CONSOLIDATE_WIKI_ROOT,
      // wikiPurgeDeps.listAllMarkdownFiles expects a mutable PageEntry[];
      // our listPageBodies returns readonly. Spread copies to a mutable array.
      listAllMarkdownFiles: async (root) => [...(await listPageBodies(root))],
      deleteFile:           async (absPath) => { try { nodeUnlink(absPath); } catch { /* best effort */ } },
    },
    maintenanceStatsDeps: {
      wikiRoot:        CONSOLIDATE_WIKI_ROOT,
      listMdPages:     async (root) => fsListPages(root),
      readPage:        async (root, rel) => fsReadPage(root, rel),
      pageMtime:       SECONDS_DIV,
      projectRootFor:  autoResolveProjectRoot,
      listSourceFiles: listProjectSources,
      fileMtime:       projectFileMtime,
      extractDomain:   defaultExtractDomain,
    },
    listPageBodies,
    deleteFile: async (absPath) => { try { nodeUnlink(absPath); } catch { /* best effort */ } },
    joinPath:   (root, rel) => nodeJoin(root, rel),
  }, {
    applyStubs,
    applyClassifierRejects,
  });
}

export type { WikiMaintenanceResult };
