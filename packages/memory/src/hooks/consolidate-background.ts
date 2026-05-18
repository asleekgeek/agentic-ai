#!/usr/bin/env node
/**
 * consolidate-background.ts — Detached worker that runs the
 * consolidate cycle (G1).
 *
 * Spawned by ``session-start.ts::maybeBackgroundConsolidate`` when
 * the stamp at ``~/.claude/methodology/.last_consolidate`` is older
 * than ``CORTEX_CONSOLIDATE_TTL_HOURS`` (default 6h). The worker:
 *
 *   1. Opens the memory store (PG or SQLite, same selection logic as
 *      the MCP server).
 *   2. Calls the consolidation handler with the autonomous defaults
 *      (decay + compress + cls + memify on, deep off).
 *   3. Runs the wiki maintenance cycle (G2: stub purge, classifier
 *      purge, backlog refresh).
 *   4. Writes the stamp file so the next SessionStart sees we just ran.
 *
 * Detached — the parent SessionStart process returns immediately;
 * this worker runs in its own event loop, writes to its own log file,
 * and exits when the cycle completes. Failure is logged but never
 * surfaces to the user — the only operator-visible signal is a stale
 * stamp.
 *
 * Cortex equivalent: mcp_server/hooks/consolidate_background.py.
 *
 * User directive 2026-05-18: "Consolidate cycle I shouldn't have to
 * run manually. It should be running without a human in the loop, and
 * wiki should be always up to date."
 *
 * source: cortex/mcp_server/hooks/consolidate_background.py
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryStoreExt } from "../remember/storage/memory-store.js";
import type { runWikiMaintenance as RunWikiMaintenanceFn } from "../wiki/maintenance.js";

const LOG_PREFIX = "[consolidate-background]";

// Stamp file written after each successful (or attempted) run. The
// parent SessionStart checks this mtime to decide whether to spawn.
// source: cortex/mcp_server/hooks/consolidate_background.py — stamp path
export const STAMP_RELATIVE_PATH = join(".claude", "methodology", ".last_consolidate");

// Default TTL between consolidate runs. Configurable via env so
// operators can dial it up/down without redeploying. 6h matches
// Cortex's default — "run a few times a day without a human."
// source: cortex@4883307+ session_start.py — CORTEX_CONSOLIDATE_TTL_HOURS
export const DEFAULT_TTL_HOURS = 6;

function logPath(): string {
  return join(homedir(), ".claude", "methodology", "consolidate_background.log");
}

function appendLog(msg: string): void {
  try {
    const dir = join(homedir(), ".claude", "methodology");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`, "utf-8");
  } catch {
    /* best effort — log failures must not crash the worker */
  }
}

function stampPath(): string {
  return join(homedir(), STAMP_RELATIVE_PATH);
}

/**
 * Touch the stamp file so the next SessionStart sees a fresh mtime.
 * Idempotent. Failure isolated (operator may have permission issues;
 * worker still ran).
 */
export function writeStamp(): void {
  try {
    const path = stampPath();
    const dir = join(homedir(), ".claude", "methodology");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, new Date().toISOString() + "\n", "utf-8");
  } catch (err) {
    appendLog(`${LOG_PREFIX} stamp write failed (non-fatal): ${String(err)}`);
  }
}

/**
 * Run one consolidate cycle end-to-end. Resolves on completion; never
 * throws. Closes G1.b: the worker no longer just touches the stamp,
 * it runs the full consolidation pipeline + wiki maintenance.
 *
 * Heavy imports are inside the function so this module stays
 * importable in environments where the consolidation handler's deps
 * (PG driver, sentence-transformers) aren't available — the worker
 * gracefully no-ops in that case.
 *
 * Backend selection mirrors packages/mcp-servers/memory/src/index.ts:
 *   - DATABASE_URL set → PostgreSQL via PgMemoryStore
 *   - otherwise          → SQLite at CORTEX_DB_PATH or ~/.cortex/cortex.db
 *
 * source: packages/memory/src/consolidation/handler.ts::handler
 * source: packages/memory/src/wiki/maintenance.ts::runWikiMaintenance
 */
async function runConsolidateCycle(): Promise<void> {
  appendLog(`${LOG_PREFIX} cycle start`);
  try {
    // Construct the memory store the same way the MCP server does.
    const databaseUrl = process.env["DATABASE_URL"];
    let store: MemoryStoreExt;
    if (databaseUrl) {
      const { PgMemoryStore } = await import("../remember/storage/pg-store.js");
      store = new PgMemoryStore(databaseUrl);
      appendLog(`${LOG_PREFIX} PG store opened (DATABASE_URL set)`);
    } else {
      const { SqliteMemoryStore } = await import("../remember/storage/sqlite-store.js");
      const dbPath = process.env["CORTEX_DB_PATH"] ??
        join(homedir(), ".cortex", "cortex.db");
      store = new SqliteMemoryStore(dbPath);
      appendLog(`${LOG_PREFIX} SQLite store opened at ${dbPath}`);
    }

    // Run the consolidation handler (decay + compress + cls + memify).
    const { handler: consolidateHandler } = await import("../consolidation/handler.js");
    const {
      DEFAULT_CONSOLIDATION_SETTINGS,
      NULL_EMBEDDING_ENGINE,
      toConsolidationStore,
    } = await import("../consolidation/defaults.js");

    const consolidationStore = toConsolidationStore(store);
    appendLog(`${LOG_PREFIX} running consolidation pipeline…`);
    const result = await consolidateHandler(
      consolidationStore,
      DEFAULT_CONSOLIDATION_SETTINGS,
      NULL_EMBEDDING_ENGINE,
      { decay: true, compress: true, cls: true, memify: true, deep: false },
    );
    appendLog(
      `${LOG_PREFIX} consolidation done: status=${result.status} duration=${result.duration_ms}ms ` +
      `failed=${result.failed_stages.length}`,
    );

    // Now run the wiki maintenance cycle (G2). Failure isolated.
    try {
      const { runWikiMaintenance } = await import("../wiki/maintenance.js");
      const wikiDeps = await buildWikiMaintenanceDeps(store);
      const wikiResult = await runWikiMaintenance(wikiDeps, {});
      appendLog(
        `${LOG_PREFIX} wiki cycle done: stub purged=${wikiResult.stub.purged} ` +
        `classifier purged=${wikiResult.classifier.purged} ` +
        `pending=${wikiResult.pending_total} status=${wikiResult.status}`,
      );
    } catch (wikiErr) {
      appendLog(
        `${LOG_PREFIX} wiki cycle failed (non-fatal): ` +
        (wikiErr instanceof Error ? wikiErr.message : String(wikiErr)),
      );
    }

    writeStamp();
    appendLog(`${LOG_PREFIX} stamp written; cycle complete`);
  } catch (err) {
    appendLog(`${LOG_PREFIX} cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    // Still write the stamp so the next session doesn't spawn another
    // doomed worker. The error is logged for inspection.
    writeStamp();
  }
}

/**
 * Build the dependency closure for runWikiMaintenance from a real
 * MemoryStoreExt + fs adapters. Mirrors the
 * ``packages/mcp-servers/memory/src/tools/consolidation-wiki-adapters.ts``
 * helper, but lives in the memory package so this worker has no
 * dependency on the mcp-servers layer.
 */
async function buildWikiMaintenanceDeps(
  store: MemoryStoreExt,
): Promise<Parameters<typeof RunWikiMaintenanceFn>[0]> {
  const fs = await import("node:fs");
  const nodeJoin = (await import("node:path")).join;
  const { defaultExtractDomain } = await import("../wiki/maintenance-stats.js");
  const { autoResolveProjectRoot } = await import("../wiki/project-roots.js");
  const { collectSourceFiles } = await import("../codebase-analysis/handlers/codebase-analyze-helpers.js");
  const { readPage: fsReadPage, listPages: fsListPages } = await import("../wiki/storage/wiki-store.js");

  const WIKI_ROOT = process.env["CORTEX_WIKI_ROOT"] ??
    join(homedir(), ".claude", "methodology", "wiki");

  // source: cortex codebase_analyze.py — max_file_size_kb default = 100
  const FILE_SIZE_KB_DEFAULT = 100;
  const BYTES_PER_KB = 1024; // source: IEC 80000-13:2008 §21-12
  // source: ECMAScript Date timestamps are ms
  const MS_PER_SECOND = 1000;
  // source: cortex@4883307 mcp_server/hooks/session_start.py:226 — LIMIT 500
  const CONSOLIDATE_MEM_POOL = 500;

  const SECONDS_DIV = (absPath: string): number | null => {
    try { return fs.statSync(absPath).mtimeMs / MS_PER_SECOND; }
    catch { return null; }
  };

  const projectFileMtime = (projectRoot: string, rel: string): number | null => {
    try { return fs.statSync(nodeJoin(projectRoot, rel)).mtimeMs / MS_PER_SECOND; }
    catch { return null; }
  };

  const listProjectSources = async (projectRoot: string, maxFiles: number): Promise<string[]> => {
    try {
      const abs = collectSourceFiles(projectRoot, null, maxFiles, FILE_SIZE_KB_DEFAULT * BYTES_PER_KB);
      return abs.map((p) => p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p);
    } catch { return []; }
  };

  // Curator-shaped memory snapshot.
  const storeExt = store as typeof store & {
    getRecentlyAccessedMemoriesAsync?: (limit: number, minAccessCount: number) => Promise<Record<string, unknown>[]>;
  };
  let memories: Record<string, unknown>[] = [];
  try {
    memories = storeExt.getRecentlyAccessedMemoriesAsync
      ? await storeExt.getRecentlyAccessedMemoriesAsync(CONSOLIDATE_MEM_POOL, 1)
      : store.getRecentlyAccessedMemories(CONSOLIDATE_MEM_POOL, 1);
  } catch { memories = []; }

  const listPageBodies = async (root: string): Promise<ReadonlyArray<{ relPath: string; content: string }>> => {
    const rels = fsListPages(root);
    const out: { relPath: string; content: string }[] = [];
    for (const rel of rels) {
      const body = fsReadPage(root, rel);
      if (body !== null) out.push({ relPath: rel, content: body });
    }
    return out;
  };

  return {
    wikiRoot: WIKI_ROOT,
    memories: memories as Parameters<typeof RunWikiMaintenanceFn>[0]["memories"],
    purgeDeps: {
      wikiRoot:             WIKI_ROOT,
      wikiRoot_string:      WIKI_ROOT,
      listAllMarkdownFiles: async (root) => [...(await listPageBodies(root))],
      deleteFile:           async (absPath) => { try { fs.unlinkSync(absPath); } catch { /* best effort */ } },
    },
    maintenanceStatsDeps: {
      wikiRoot:        WIKI_ROOT,
      listMdPages:     async (root) => fsListPages(root),
      readPage:        async (root, rel) => fsReadPage(root, rel),
      pageMtime:       SECONDS_DIV,
      projectRootFor:  autoResolveProjectRoot,
      listSourceFiles: listProjectSources,
      fileMtime:       projectFileMtime,
      extractDomain:   defaultExtractDomain,
    },
    listPageBodies,
    deleteFile: async (absPath) => { try { fs.unlinkSync(absPath); } catch { /* best effort */ } },
    joinPath:   (root, rel) => nodeJoin(root, rel),
  };
}

// ── CLI entry — when invoked directly via ``node consolidate-background.js`` ──

// import.meta.url ends with the script path when this file is the
// program entry; comparing against process.argv[1] is the standard
// Node ESM idiom for "are we the main module?".
import { fileURLToPath } from "node:url";
const isCliEntry = (() => {
  try {
    return process.argv[1] !== undefined &&
      fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  void runConsolidateCycle().then(() => process.exit(0));
}

// ── Programmatic exports for testing + manual invocation ──

export { runConsolidateCycle, stampPath, logPath };
