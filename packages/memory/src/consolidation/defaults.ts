/**
 * consolidation/defaults.ts — shared defaults + the MemoryStoreExt →
 * ConsolidationStore adapter used by every entry point that runs the
 * consolidation pipeline.
 *
 * Two callers today:
 *
 *   - packages/mcp-servers/memory/src/tools/consolidation.ts — the
 *     ``consolidate`` MCP tool wrapper.
 *   - packages/memory/src/hooks/consolidate-background.ts — the
 *     detached worker spawned by SessionStart when the consolidate
 *     stamp is older than CORTEX_CONSOLIDATE_TTL_HOURS.
 *
 * Extracting these here breaks a layer cycle: the worker lives in the
 * memory package, but the defaults previously lived in the mcp-servers
 * package, so the worker couldn't import them. With this module both
 * consumers depend on the same source of truth.
 *
 * source: cortex main mcp_server/infrastructure/config.py — settings
 * source: cortex/mcp_server/handlers/consolidation/ — handler defaults
 */

import type { MemoryStoreExt } from "../remember/storage/memory-store.js";
import type {
  ConsolidationEmbeddingEngine,
  ConsolidationSettings,
  ConsolidationStore,
} from "./handler.js";

// ── Default settings (heat decay, compression, CLS) ────────────────────

// Cold-memory threshold: heat below this value is candidate for
// compression/deletion. Tuned on the 2026-04 audit so half-life ~14d
// at default decay factor 0.95 places ``cold'' at ~0.2.
// source: cortex main config.py COLD_THRESHOLD default
const DEFAULT_COLD_THRESHOLD = 0.2;

// Per-cycle decay multiplier. 0.95 = ~14-day half-life over the
// daily-consolidate cadence. Below 0.9 caused thrashing in the audit
// because hot pages cooled below the cold-threshold within a week.
// source: cortex main config.py DECAY_FACTOR default
const DEFAULT_DECAY_FACTOR = 0.95;

// Compression cadence: gist after 48h, tag after 7d. Mirrors Cortex's
// production settings. Hours are the consolidation pipeline's unit.
// source: cortex main config.py COMPRESSION_GIST_AGE_HOURS default
const DEFAULT_COMPRESSION_GIST_AGE_HOURS = 48;
// source: cortex main config.py COMPRESSION_TAG_AGE_HOURS default (7 days)
const DEFAULT_COMPRESSION_TAG_AGE_HOURS = 168;

export const DEFAULT_CONSOLIDATION_SETTINGS: ConsolidationSettings = {
  COLD_THRESHOLD:              DEFAULT_COLD_THRESHOLD,
  DECAY_FACTOR:                DEFAULT_DECAY_FACTOR,
  COMPRESSION_GIST_AGE_HOURS:  DEFAULT_COMPRESSION_GIST_AGE_HOURS,
  COMPRESSION_TAG_AGE_HOURS:   DEFAULT_COMPRESSION_TAG_AGE_HOURS,
};

// ── Null embedding engine (no semantic compression) ───────────────────

/**
 * No-op embedding engine. Used when the consolidation pipeline runs
 * without semantic-compression dependencies — the background worker
 * defaults to this so it can run on installs without
 * sentence-transformers / onnxruntime.
 *
 * The compression cycle silently skips semantic merging when encode
 * returns ``[]``; the rest of the pipeline (decay, plasticity,
 * pruning, CLS, memify) is unaffected.
 *
 * source: cortex main mcp_server/handlers/consolidation/ —
 *         null-engine pattern used when embeddings are absent
 */
export const NULL_EMBEDDING_ENGINE: ConsolidationEmbeddingEngine = {
  encode: async (_text: string): Promise<number[]> => [],
  similarity: (_a: number[], _b: number[]): number => 0,
};

// ── MemoryStoreExt → ConsolidationStore adapter ────────────────────────

/**
 * Adapt a MemoryStoreExt to the ConsolidationStore contract.
 *
 * The consolidation pipeline expects every store method to be async
 * (Promise<T>). MemoryStoreExt is mostly sync (SQLite) with optional
 * ``*Async`` variants on PG. This adapter prefers the async variant
 * when present, falls back to the sync variant otherwise.
 *
 * source: ADR-0042 — async-when-available pattern for PG/SQLite parity
 */
export function toConsolidationStore(store: MemoryStoreExt): ConsolidationStore {
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
    mergeEntitiesAsync?(survivorId: number, aliasId: number): Promise<{ merged: boolean; [k: string]: unknown }>;
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
    acquireBatch: () => ({
      execute: async (sql: string, params?: unknown[]) => {
        void sql; void params;
        return { rows: [], rowcount: 0 };
      },
    }),
    // ── entity merge ─────────────────────────────────────────────────────────
    mergeEntities: (survivorId, aliasId) =>
      typeof pg.mergeEntitiesAsync === "function"
        ? pg.mergeEntitiesAsync(survivorId, aliasId)
        : Promise.resolve(store.mergeEntities(survivorId, aliasId)),
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
