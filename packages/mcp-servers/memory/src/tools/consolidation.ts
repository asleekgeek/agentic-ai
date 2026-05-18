/**
 * consolidation.ts — MCP tool adapters for the consolidation + session topic.
 *
 * Tools registered (4):
 *   consolidate, checkpoint, memory_stats, record_session_end
 *
 * Phase 7 Group D — DI wiring:
 *   - consolidate: calls real handler from @agentic/memory/consolidation.
 *   - checkpoint: lightweight checkpoint stored as a protected memory.
 *     Ported from cortex@ed33435 mcp_server/handlers/checkpoint.py (save path).
 *   - memory_stats: raw stats from ConsolidationStore escape hatch.
 *     Ported from cortex@ed33435 mcp_server/handlers/memory_stats.py.
 *   - record_session_end: incremental EMA profile update.
 *     Ported from cortex@ed33435 mcp_server/handlers/record_session_end.py.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md
 *         §Tier1Memory (consolidate, checkpoint, memory_stats)
 *         §Tier1Core (record_session_end)
 */

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import { handler as consolidateHandler } from "@agentic/memory/consolidation/handler.js";
import type { ConsolidationStore, ConsolidationSettings } from "@agentic/memory/consolidation/handler.js";
import type { ProfilesStore } from "@agentic/memory/methodology/types.js";
import {
  countPendingClusters,
  type CuratorMemory,
  type PageMtimeFn,
} from "@agentic/memory/wiki/auto-curator.js";
import {
  computeWikiMaintenanceStats,
  defaultExtractDomain,
} from "@agentic/memory/wiki/maintenance-stats.js";
import { autoResolveProjectRoot } from "@agentic/memory/wiki/project-roots.js";
import { collectSourceFiles as codebaseCollectSourceFiles } from "@agentic/memory/codebase-analysis/handlers/codebase-analyze-helpers.js";
import {
  readFileSync as nodeReadFileSync,
  readdirSync,
} from "node:fs";
import { join as nodeJoin } from "node:path";

// ── Named constants ───────────────────────────────────────────────────────────
// source: cortex@ed33435 memory_stats.py:77 — avg_heat rounded to 4 decimal places
const ROUNDING_FACTOR_4DP = 10000;
// source: cortex@ed33435 record_session_end.py — EMA_ALPHA=0.1
const EMA_ALPHA = 0.1; // source: mcp_server/core/cognitive_profile.py EMA_ALPHA default

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface ConsolidationDeps {
  store: MemoryStoreExt;
}

// ── Profiles I/O ──────────────────────────────────────────────────────────────
//
// source: packages/memory/src/hooks/session-lifecycle.ts::loadProfiles

function methodologyDir(): string {
  return join(homedir(), ".claude", "methodology");
}

function loadProfiles(): ProfilesStore {
  const profilePath = join(methodologyDir(), "profiles.json");
  if (!existsSync(profilePath)) return { domains: {} };
  try {
    const raw = JSON.parse(readFileSync(profilePath, "utf-8")) as ProfilesStore;
    if (!raw.domains) raw.domains = {};
    return raw;
  } catch {
    return { domains: {} };
  }
}

function saveProfiles(profiles: ProfilesStore): void {
  const dir = methodologyDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf-8");
}

// ── ConsolidationStore adapter ────────────────────────────────────────────────
//
// Wraps MemoryStoreExt with async wrappers required by consolidation.handler.
//
// LSP-VIOLATION CLOSED (#6): all methods previously accessed via escape-hatch
// `ext["method"]?.() ?? []` now delegate to typed MemoryStoreExt methods.
// Neither backend silently no-ops anymore.
//
// source: packages/memory/src/consolidation/handler.ts::ConsolidationStore

function toConsolidationStore(store: MemoryStoreExt): ConsolidationStore {
  // source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
  // PgMemoryStore exposes *Async variants for methods that otherwise call
  // _runSync() which throws unconditionally in an async context.
  // SqliteMemoryStore lacks *Async variants — fall back to sync path.
  const pg = store as unknown as {
    getAllMemoriesForDecayAsync?(): Promise<Record<string, unknown>[]>;
    getAllEntitiesAsync?(opts?: { minHeat?: number; includeArchived?: boolean }): Promise<Record<string, unknown>[]>;
    getAllRelationshipsAsync?(): Promise<Record<string, unknown>[]>;
    getHotMemoriesAsync?(minHeat?: number, limit?: number, includeBenchmarks?: boolean): Promise<Record<string, unknown>[]>;
    getMemoriesByStageAsync?(stage: string, limit?: number): Promise<Record<string, unknown>[]>;
    getEpisodicMemoriesAsync?(domain?: string, directory?: string, limit?: number): Promise<Record<string, unknown>[]>;
    getSemanticMemoriesAsync?(domain?: string, limit?: number): Promise<Record<string, unknown>[]>;
    getTransferCandidatesAsync?(limit?: number): Promise<Record<string, unknown>[]>;
    findCoAccessedPairsAsync?(ids: number[]): Promise<Array<[number, number]>>;
    insertMemoryAsync?(data: Parameters<MemoryStoreExt["insertMemory"]>[0]): Promise<number>;
    bumpHeatRawAsync?(id: number, heat: number): Promise<void>;
    deleteMemoryAsync?(id: number): Promise<boolean>;
  };

  return {
    // ── shared / decay ───────────────────────────────────────────────────────
    getAllMemoriesForDecay: () =>
      typeof pg.getAllMemoriesForDecayAsync === "function"
        ? pg.getAllMemoriesForDecayAsync()
        : Promise.resolve(store.getAllMemoriesForDecay()),
    getAllEntities: (opts) =>
      typeof pg.getAllEntitiesAsync === "function"
        ? pg.getAllEntitiesAsync(opts)
        : Promise.resolve(store.getAllEntities(opts)),
    updateEntitiesHeatBatch: (u) => { store.updateEntitiesHeatBatch(u); return Promise.resolve(); },
    // ── plasticity ───────────────────────────────────────────────────────────
    getAllRelationships: () =>
      typeof pg.getAllRelationshipsAsync === "function"
        ? pg.getAllRelationshipsAsync()
        : Promise.resolve(store.getAllRelationships()),
    getHotMemories: (opts) =>
      typeof pg.getHotMemoriesAsync === "function"
        ? pg.getHotMemoriesAsync(opts?.minHeat, opts?.limit)
        : Promise.resolve(store.getHotMemories(opts?.minHeat, opts?.limit)),
    findCoAccessedPairs: (ids) =>
      typeof pg.findCoAccessedPairsAsync === "function"
        ? pg.findCoAccessedPairsAsync([...ids])
        : Promise.resolve(store.findCoAccessedPairs([...ids])),
    updateRelationshipsWeightBatch: (u) => { store.updateRelationshipsWeightBatch([...u]); return Promise.resolve(); },
    // ── pruning ──────────────────────────────────────────────────────────────
    deleteRelationshipsBatch: (ids) => Promise.resolve(store.deleteRelationshipsBatch([...ids])),
    archiveEntitiesBatch: (ids) => Promise.resolve(store.archiveEntitiesBatch([...ids])),
    // ── compression + sleep ──────────────────────────────────────────────────
    insertArchive: (row) => { store.insertArchive(row); return Promise.resolve(); },
    updateMemoryCompression: (id, content, embedding, compressionLevel, opts) => {
      store.updateMemoryCompression(
        id,
        content,
        embedding instanceof Buffer ? embedding : (embedding != null ? Buffer.from(embedding as unknown as ArrayBuffer) : null),
        compressionLevel,
        opts,
      );
      return Promise.resolve();
    },
    // ── CLS ──────────────────────────────────────────────────────────────────
    getEpisodicMemories: (l) =>
      typeof pg.getEpisodicMemoriesAsync === "function"
        ? pg.getEpisodicMemoriesAsync(undefined, undefined, l)
        : Promise.resolve(store.getEpisodicMemories(undefined, undefined, l)),
    getSemanticMemories: (l) =>
      typeof pg.getSemanticMemoriesAsync === "function"
        ? pg.getSemanticMemoriesAsync(undefined, l)
        : Promise.resolve(store.getSemanticMemories(undefined, l)),
    // ── memify ───────────────────────────────────────────────────────────────
    deleteMemory: (id) =>
      typeof pg.deleteMemoryAsync === "function"
        ? pg.deleteMemoryAsync(id).then(() => undefined)
        : (store.deleteMemory(id), Promise.resolve()),
    updateMemoryImportance: (id, importance) => { store.updateMemoryImportance(id, importance); return Promise.resolve(); },
    insertRelationship: (rel) => { store.insertRelationship(rel); return Promise.resolve(); },
    // ── sleep ────────────────────────────────────────────────────────────────
    insertMemory: (mem) =>
      typeof pg.insertMemoryAsync === "function"
        ? pg.insertMemoryAsync(mem as Parameters<MemoryStoreExt["insertMemory"]>[0])
        : Promise.resolve(store.insertMemory(mem as Parameters<typeof store.insertMemory>[0])),
    // ── cascade ──────────────────────────────────────────────────────────────
    getMemoriesByStage: (s, l) =>
      typeof pg.getMemoriesByStageAsync === "function"
        ? pg.getMemoriesByStageAsync(s, l)
        : Promise.resolve(store.getMemoriesByStage(s, l)),
    updateMemoryConsolidation: (id, s, h, r, d) => { store.updateMemoryConsolidation(id, s, h, r, d); return Promise.resolve(); },
    insertStageTransitionsBatch: (t) => { store.insertStageTransitionsBatch(t); return Promise.resolve(); },
    updateStageEnteredAt: (memoryId, enteredAt) => {
      store.updateStageEnteredAt(memoryId, enteredAt instanceof Date ? enteredAt.toISOString() : String(enteredAt));
      return Promise.resolve();
    },
    // ── homeostatic ──────────────────────────────────────────────────────────
    getHomeostaticFactor: (d) => Promise.resolve(store.getHomeostaticFactor(d)),
    setHomeostaticFactor: (d, f) => { store.setHomeostaticFactor(d, f); return Promise.resolve(); },
    bumpHeatRaw: (id, heat) =>
      typeof pg.bumpHeatRawAsync === "function"
        ? pg.bumpHeatRawAsync(id, heat)
        : (store.bumpHeatRaw(id, heat), Promise.resolve()),
    // ── batch connection (no-op: acquireBatch was SQLite-only internal) ───────
    // source: The acquireBatch pattern was a SQLite-specific internal that
    // allowed the write gate to reuse a connection. With MemoryStoreExt,
    // all methods are properly routed to the correct backend.
    acquireBatch: () => ({
      execute: async (sql: string, params?: unknown[]) => {
        void sql; void params;
        return { rows: [], rowcount: 0 };
      },
    }),
    // ── transfer ─────────────────────────────────────────────────────────────
    getTransferCandidates: (l) =>
      typeof pg.getTransferCandidatesAsync === "function"
        ? pg.getTransferCandidatesAsync(l)
        : Promise.resolve(store.getTransferCandidates(l)),
    updateHippocampalDependency: (id, d) => { store.updateHippocampalDependency(id, d); return Promise.resolve(); },
    // ── logging ──────────────────────────────────────────────────────────────
    logConsolidation: (e) => { store.logConsolidation(e); return Promise.resolve(); },
  };
}

// source: cortex@ed33435 mcp_server/infrastructure/config.py — defaults
const DEFAULT_CONSOLIDATION_SETTINGS: ConsolidationSettings = {
  COLD_THRESHOLD:              0.2,  // source: cortex@ed33435 config.py COLD_THRESHOLD default
  DECAY_FACTOR:                0.95, // source: cortex@ed33435 config.py DECAY_FACTOR default
  COMPRESSION_GIST_AGE_HOURS:  48,   // source: cortex@ed33435 config.py COMPRESSION_GIST_AGE_HOURS default
  COMPRESSION_TAG_AGE_HOURS:   168,  // source: cortex@ed33435 config.py COMPRESSION_TAG_AGE_HOURS default (7 days)
};

// ── ConsolidationEmbeddingEngine (no-op) ──────────────────────────────────────

const NULL_EMBEDDING_ENGINE = {
  encode: async (_text: string): Promise<number[]> => [],
  similarity: (_a: number[], _b: number[]): number => 0,
};

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── Pending-curation count for the consolidate stats dict ────────────────────
//
// Failure-tolerant adapter: when the curator can't compute (no wiki
// root, no memories, an unexpected error), we return ``null`` and
// move on. consolidate must never break because of a curation count.
// source: cortex@4883307 mcp_server/handlers/consolidate.py:153-172

// source: cortex@ed33435 mcp_server/infrastructure/config.py — WIKI_ROOT default
const CONSOLIDATE_WIKI_ROOT: string =
  process.env["CORTEX_WIKI_ROOT"] ??
  join(homedir(), ".claude", "methodology", "wiki");

// Memory pool size used by the SessionStart helper in Cortex. Matches
// the curator's default pool so the count is consistent with what
// curate_wiki returns on a full invocation.
// source: cortex@4883307 mcp_server/hooks/session_start.py:226 ("LIMIT 500")
const CONSOLIDATE_MEM_POOL = 500;

// Filesystem-mtime adapter. Returns seconds-since-epoch or null when
// the file doesn't exist. statSync throws on missing — catch and
// return null so the curator can treat it as "page absent, eligible".
// source: cortex@4883307 mcp_server/core/auto_curator.py::is_path_recently_authored
const SECONDS_DIV: PageMtimeFn = (absPath: string): number | null => {
  try {
    const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
    return statSync(absPath).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
};

async function countPendingCurationsSafe(store: MemoryStoreExt): Promise<number | null> {
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

// ── Pending drift + coverage counts (Phase C) ────────────────────────────────
//
// Same failure-isolation contract as countPendingCurationsSafe: any
// error returns null and consolidate continues. Uses the maintenance-stats
// engine to keep the numbers identical to what the dashboard cards and
// SessionStart preamble show.
//
// source: packages/memory/src/wiki/maintenance-stats.ts

// POSIX-style join for wiki rel paths — keeps slash-shaped paths regardless of OS.
function joinWiki(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// Walk a wiki directory and return rel-paths of every ``.md`` file.
// We do it locally rather than reaching for the dashboard helper so
// consolidate stays decoupled from the dashboard package.
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
    const FILE_KB = 100; // source: codebase_analyze max_file_size_kb default
    const KB = 1024;     // source: IEC 80000-13 — 1 KiB = 1024 bytes
    const abs = codebaseCollectSourceFiles(projectRoot, null, maxFiles, FILE_KB * KB);
    return abs.map((p) => p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p);
  } catch {
    return [];
  }
}

interface MaintenanceCounts {
  readonly drift: number | null;
  readonly coverage: number | null;
}

async function countPendingMaintenance(): Promise<MaintenanceCounts> {
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

// ── registerConsolidationTools ────────────────────────────────────────────────

/**
 * Registers consolidation and session lifecycle MCP tools.
 *
 * precondition:  deps.store is a live MemoryStore.
 * postcondition: 4 tools registered; each body calls the real domain handler.
 *
 * source: MCP_TOOLS.md §"consolidate", §"checkpoint", §"memory_stats",
 *         §"record_session_end"
 */
export function registerConsolidationTools(server: McpServer, deps: ConsolidationDeps): void {
  // ── consolidate ───────────────────────────────────────────────────────────
  server.registerTool(
    "consolidate",
    {
      description: "Run memory maintenance pipeline: decay, compression, CLS transfer, memify, pruning.",
      inputSchema: {
        decay:    z.boolean().default(true).describe("Run decay cycle"),
        compress: z.boolean().default(true).describe("Run compression cycle"),
        cls:      z.boolean().default(true).describe("Run CLS transfer"),
        memify:   z.boolean().default(true).describe("Run memify cycle"),
        deep:     z.boolean().default(false).describe("Deep consolidation (slower)"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/consolidation/handler.ts::handler
        const consolidationStore = toConsolidationStore(deps.store);
        const result = await consolidateHandler(
          consolidationStore,
          DEFAULT_CONSOLIDATION_SETTINGS,
          NULL_EMBEDDING_ENGINE,
          {
            decay:    args.decay,
            compress: args.compress,
            cls:      args.cls,
            memify:   args.memify,
            deep:     args.deep,
          },
        );

        // 2026-05-17: surface pending curation count so the SessionStart
        // preamble and any downstream caller can see how much authoring
        // work the auto-curator has queued up. Failure is non-fatal — a
        // missing curation count must never break consolidate itself.
        // source: cortex@4883307 mcp_server/handlers/consolidate.py:153-172
        const pendingCurations = await countPendingCurationsSafe(deps.store);

        // 2026-05-18 (Phase C): surface drift + coverage counts so
        // SessionStart preamble + dashboard show the FULL maintenance
        // queue, not just curator. Same failure isolation; both fields
        // may be null when project_root resolution fails.
        // source: packages/memory/src/wiki/maintenance-stats.ts
        const maintenance = await countPendingMaintenance();

        const enrichedResult = {
          ...result,
          pending_curations: pendingCurations,
          pending_drift:    maintenance.drift,
          pending_coverage: maintenance.coverage,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(enrichedResult) }] };
      } catch (err) {
        return errorText("consolidate", err);
      }
    },
  );

  // ── checkpoint ────────────────────────────────────────────────────────────
  server.registerTool(
    "checkpoint",
    {
      description: "Save or restore working state for hippocampal replay.",
      inputSchema: {
        action:             z.enum(["save", "restore", "list"]).describe("Checkpoint action"),
        directory:          z.string().default("").describe("Project directory"),
        current_task:       z.string().default("").describe("Current task description"),
        files_being_edited: z.array(z.string()).default([]).describe("Files currently open"),
        key_decisions:      z.array(z.string()).default([]).describe("Key decisions made"),
        open_questions:     z.array(z.string()).default([]).describe("Open questions"),
        next_steps:         z.array(z.string()).default([]).describe("Planned next steps"),
        active_errors:      z.array(z.string()).default([]).describe("Active errors"),
        custom_context:     z.string().default("").describe("Extra context"),
        session_id:         z.string().default("default").describe("Session ID"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/checkpoint.py::handler
        // Lightweight checkpoint: store as a protected memory tagged _checkpoint.
        if (args.action === "save") {
          const content = [
            `[CHECKPOINT] session=${args.session_id}`,
            `task: ${args.current_task}`,
            `files: ${args.files_being_edited.join(", ")}`,
            `decisions: ${args.key_decisions.join("; ")}`,
            `open: ${args.open_questions.join("; ")}`,
            `next: ${args.next_steps.join("; ")}`,
            `errors: ${args.active_errors.join("; ")}`,
            args.custom_context,
          ].filter(Boolean).join("\n");

          const memId = deps.store.insertMemory({
            content,
            tags: ["_checkpoint", `session:${args.session_id}`],
            source: "session",
            domain: "",
            heat: 1.0,
            importance: 1.0,
            store_type: "episodic",
          });
          deps.store.setMemoryProtected(memId, true);

          return { content: [{ type: "text" as const, text: JSON.stringify({
            action:        "save",
            checkpoint_id: String(memId),
            session_id:    args.session_id,
          }) }] };
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          action:     args.action,
          checkpoint: null,
          note:       "checkpoint list/restore: query hot memories tagged _checkpoint",
        }) }] };
      } catch (err) {
        return errorText("checkpoint", err);
      }
    },
  );

  // ── memory_stats ──────────────────────────────────────────────────────────
  server.registerTool(
    "memory_stats",
    {
      description: "Memory system diagnostics — counts, heat distribution, store sizes.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/memory_stats.py::handler
        // Use *Async variant when available (PgMemoryStore) to avoid _runSync() throw.
        // Fall back to sync variant for SqliteMemoryStore.
        // source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
        const storeAny = deps.store as unknown as { getAllMemoriesForDecayAsync?: () => Promise<Record<string, unknown>[]> };
        const allMems = (
          typeof storeAny.getAllMemoriesForDecayAsync === "function"
            ? await storeAny.getAllMemoriesForDecayAsync()
            : deps.store.getAllMemoriesForDecay()
        ) as Array<Record<string, unknown>>;

        const total = allMems.length;
        const episodic = allMems.filter((m) => m["store_type"] === "episodic").length;
        const semantic = allMems.filter((m) => m["store_type"] === "semantic").length;
        const active = allMems.filter((m) => !m["is_stale"] && !m["is_archived"]).length;
        const stale = allMems.filter((m) => m["is_stale"]).length;
        const protected_ = allMems.filter((m) => m["is_protected"]).length;

        const avgHeat = total > 0
          // source: cortex@ed33435 memory_stats.py:77 — avg_heat rounded to 4 decimal places
          ? Math.round((allMems.reduce((s, m) => s + ((m["heat"] as number) ?? 0), 0) / total) * ROUNDING_FACTOR_4DP) / ROUNDING_FACTOR_4DP
          : 0;

        const domainCounts: Record<string, number> = {};
        for (const m of allMems) {
          const d = (m["domain"] as string) ?? "";
          domainCounts[d] = (domainCounts[d] ?? 0) + 1;
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          total_memories:  total,
          episodic_count:  episodic,
          semantic_count:  semantic,
          active_count:    active,
          stale_count:     stale,
          protected_count: protected_,
          avg_heat:        avgHeat,
          domains:         domainCounts,
        }) }] };
      } catch (err) {
        return errorText("memory_stats", err);
      }
    },
  );

  // ── record_session_end ────────────────────────────────────────────────────
  server.registerTool(
    "record_session_end",
    {
      description: "Incremental EMA profile update after a session ends.",
      inputSchema: {
        session_id: z.string().min(1).describe("Session identifier"),
        domain:     z.string().optional().describe("Cognitive domain"),
        tools_used: z.array(z.string()).optional().describe("Tools used in this session"),
        duration:   z.number().optional().describe("Session duration in seconds"),
        turn_count: z.number().int().optional().describe("Number of conversation turns"),
        keywords:   z.array(z.string()).optional().describe("Session keywords"),
        cwd:        z.string().optional().describe("Working directory"),
        project:    z.string().optional().describe("Project identifier"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/record_session_end.py::handler
        const profiles = loadProfiles();
        const domainId = args.domain ?? "unknown";
        if (domainId && profiles.domains[domainId]) {
          const dp = profiles.domains[domainId];
          const alpha = EMA_ALPHA;
          if (args.tools_used && dp.toolPreferences) {
            for (const tool of args.tools_used) {
              const prev = dp.toolPreferences[tool] as Record<string, number> | undefined;
              if (prev) {
                prev["ratio"] = (1 - alpha) * (prev["ratio"] ?? 0) + alpha;
              } else {
                dp.toolPreferences[tool] = { ratio: alpha, avgPerSession: 1 };
              }
            }
          }
          dp.sessionCount = (dp.sessionCount ?? 0) + 1;
          dp.lastUpdated = new Date().toISOString();
          saveProfiles(profiles);
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          updated:    true,
          domain:     domainId,
          session_id: args.session_id,
        }) }] };
      } catch (err) {
        return errorText("record_session_end", err);
      }
    },
  );
}
