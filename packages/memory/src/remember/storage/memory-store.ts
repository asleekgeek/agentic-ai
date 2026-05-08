/**
 * memory-store.ts — Abstract MemoryStore interface.
 *
 * Ports: infrastructure/memory_store.py (~100 LOC)
 *
 * This interface is the contract every storage adapter must satisfy.
 * All methods are synchronous to match better-sqlite3's synchronous API.
 * PostgreSQL adapters wrap async operations in a sync thread pool
 * (see pg-store.ts).
 *
 * ADR-0003 applies: adapter preconditions must NOT be stronger than
 * this interface's preconditions. Every concrete adapter must accept
 * the same range of inputs.
 *
 * Atomicity guarantees (required by task spec):
 *   - insertMemory: MUST be atomic. A partial insert (row written but
 *     FTS/vec tables not updated) must be rolled back.
 *   - deleteMemory: MUST be atomic. FTS and vec rows deleted in the
 *     same transaction as the main row.
 *   - bumpHeatRaw: read-your-writes — a subsequent getMemory call on
 *     the same connection sees the updated heat.
 *   - No duplicate inserts on retry: callers are responsible for
 *     idempotency; the interface does not deduplicate. (The write gate
 *     is the dedup layer.)
 *
 * Source: infrastructure/memory_store.py, infrastructure/pg_store.py,
 *         infrastructure/sqlite_store.py
 */

import type { MemoryInsertData, MemoryItem } from "../types.js";

// ── Entity and relationship types ───────────────────────────────────────────

export interface EntityRecord {
  id: number;
  name: string;
  type: string;
  domain: string;
  heat: number;
  archived: boolean;
  created_at: string;
  last_accessed: string;
}

export interface RelationshipRecord {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relationship_type: string;
  weight: number;
  is_causal: boolean;
  confidence: number;
  created_at: string;
}

// ── VecSearchResult ─────────────────────────────────────────────────────────

/** A (memory_id, distance) pair from vector similarity search. */
export type VecHit = [number, number];

// ── BatchHeatUpdate ─────────────────────────────────────────────────────────

/** Input type for updateMemoriesHeatBatch. */
export type HeatUpdate = [number, number]; // [memory_id, new_heat_base]

// ── MemoryStore interface ───────────────────────────────────────────────────

/**
 * MemoryStore — storage backend contract.
 *
 * Invariants:
 *   I1. insertMemory is atomic: either the full row (incl. FTS, vec) is
 *       written or nothing is. Returns a positive integer ID.
 *   I2. getMemory(id) returns null iff no row with that id exists.
 *   I3. deleteMemory(id) removes the main row AND associated FTS/vec rows
 *       atomically. Returns true iff a row was actually deleted.
 *   I4. bumpHeatRaw(id, h) writes heat_base ∈ [0,1]; a subsequent
 *       getMemory on the same connection sees the new heat (read-your-writes).
 *   I5. All methods accept the widest reasonable range (ADR-0003): numeric
 *       ids are positive integers; heat values are clamped to [0,1]
 *       internally (not preconditions).
 */
export interface MemoryStore {
  // ── Memory CRUD ────────────────────────────────────────────────────────

  /**
   * Insert a memory and return its integer ID.
   * precondition:  data.content is non-empty.
   * postcondition: returned id > 0; row exists in memories table.
   * Atomicity: row + FTS + vec in one transaction (invariant I1).
   */
  insertMemory(data: MemoryInsertData): number;

  /**
   * Retrieve a memory by id.
   * postcondition: returns null iff id not found (invariant I2).
   */
  getMemory(memoryId: number): MemoryItem | null;

  /**
   * Hard-delete a memory row and all associated index rows.
   * postcondition: returns true iff a row was deleted (invariant I3).
   * Atomicity: main + FTS + vec in one transaction.
   */
  deleteMemory(memoryId: number): boolean;

  /**
   * Canonical A3 heat writer. Writes heat_base AND refreshes heat_base_set_at.
   * precondition:  heat ∈ [0, 1] (clamped internally — not a hard precondition).
   * postcondition: memories.heat_base = clamp(heat, 0, 1) for the given id.
   * source: docs/program/phase-3-a3-migration-design.md §3.1
   */
  bumpHeatRaw(memoryId: number, newHeatBase: number): void;

  /**
   * Async variant of bumpHeatRaw for PG backend.
   * Optional: present on PgMemoryStore, absent on SqliteMemoryStore.
   * Callers use: store.bumpHeatRawAsync ? await store.bumpHeatRawAsync(id, h) : store.bumpHeatRaw(id, h)
   * source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
   */
  bumpHeatRawAsync?(memoryId: number, newHeatBase: number): Promise<void>;

  /**
   * Async variant of getMemory for PG backend.
   * Optional: present on PgMemoryStore, absent on SqliteMemoryStore.
   * source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
   */
  getMemoryAsync?(memoryId: number): Promise<MemoryItem | null>;

  /**
   * Async variant of deleteMemory for PG backend.
   * Optional: present on PgMemoryStore, absent on SqliteMemoryStore.
   * source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
   */
  deleteMemoryAsync?(memoryId: number): Promise<boolean>;

  /** Thin wrapper: calls bumpHeatRaw. Kept for backward compat. */
  updateMemoryHeat(memoryId: number, heat: number): void;

  /**
   * Batch heat writer. Single commit for up to N rows.
   * postcondition: returns the number of rows updated.
   * source: issue #13; phase-3-a3-migration-design.md §3.2
   */
  updateMemoriesHeatBatch(updates: HeatUpdate[]): number;

  /** Update importance for a single memory row. */
  updateMemoryImportance(memoryId: number, importance: number): void;

  /** Increment access_count and refresh last_accessed. */
  updateMemoryAccess(memoryId: number): void;

  /**
   * Update metamemory fields: access_count, useful_count, confidence.
   * postcondition: all three fields are written in a single UPDATE.
   */
  updateMemoryMetamemory(
    memoryId: number,
    accessCount: number,
    usefulCount: number,
    confidence: number,
  ): void;

  /** Set is_protected flag. */
  setMemoryProtected(memoryId: number, protected_: boolean): void;

  /** Set is_stale flag (soft-delete marker). */
  markMemoryStale(memoryId: number, stale: boolean): void;

  /**
   * Update content and tags for a single memory row.
   *
   * precondition:  memoryId > 0; content is non-empty.
   * postcondition: memories.content = content AND memories.tags = tags for
   *   the given id; no other columns are modified.
   *
   * Used by the anchor handler to write the `[ANCHOR: <reason>]` prefix
   * and the `_anchor` tag set atomically.
   *
   * source: cortex@f2b9f99 mcp_server/handlers/anchor.py:141-146
   */
  updateMemoryContent(memoryId: number, content: string, tags: string[]): void;

  // ── Homeostatic state ──────────────────────────────────────────────────

  /** Fetch per-domain homeostatic scaling factor, defaulting to 1.0. */
  getHomeostaticFactor(domain: string): number;

  /** Upsert per-domain homeostatic factor. Clamped to (0, 10). */
  setHomeostaticFactor(domain: string, factor: number): void;

  // ── Vector / FTS search ────────────────────────────────────────────────

  /**
   * Return top-k nearest memories by embedding cosine distance.
   * precondition:  embedding is a valid float32 buffer; topK > 0.
   * postcondition: returned array length <= topK.
   */
  searchVectors(
    embedding: Buffer,
    topK: number,
    minHeat?: number,
  ): VecHit[];

  // ── Entity graph ───────────────────────────────────────────────────────

  /** Lookup an entity by name. Returns null if not found. */
  getEntityByName(name: string): EntityRecord | null;

  /** Upsert an entity; return its id. */
  upsertEntity(name: string, type: string, domain: string): number;

  /** Link a memory to an entity. Idempotent (ON CONFLICT DO NOTHING). */
  linkMemoryEntity(memoryId: number, entityId: number): void;

  /** Upsert a typed relationship between two entities. */
  upsertRelationship(
    sourceEntityId: number,
    targetEntityId: number,
    relationshipType: string,
    weight?: number,
  ): void;

  // ── Schema matching (for write gate) ──────────────────────────────────

  /** Return all schema records for a domain. */
  getSchemasForDomain(domain: string): Array<Record<string, unknown>>;

  // ── Oscillatory state (for write gate phase gating) ───────────────────

  /** Load oscillatory clock state JSON string. Returns null if none. */
  loadOscillatoryState(): string | null;

  /** Persist oscillatory clock state JSON string. */
  saveOscillatoryState(stateJson: string): void;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Close the underlying connection / pool. */
  close(): void;

  // ── Entity async variants ─────────────────────────────────────────────────
  //
  // Required by codebase-analyze-helpers.ts which persists entities from an
  // async context. PgMemoryStore._runSync() throws unconditionally, so sync
  // entity methods cannot be called from async tool handlers on PG.
  //
  // SQLite provides thin Promise.resolve() wrappers (no semantic change).
  // PG provides full async implementations using runAsync().
  //
  // source: ADR-0042 — async-only constraint for PG entity writes.
  // source: root-cause analysis — PgMemoryStore.upsertEntity() → _runSync() →
  //   throws "requires async execution"; persistEntities() catches silently
  //   and returns [0, 0]; 960-file run produces entities=0, relationships=0.
  // source: liskov@24cb6e2 — *Async-when-available, sync-fallback pattern.

  /** Async insertMemory — required on PG; absent on SQLite (use sync insertMemory instead).
   *  source: ADR-0042 — PgMemoryStore.insertMemory() calls _runSync() which throws.
   */
  insertMemoryAsync?(data: MemoryInsertData): Promise<number>;

  /** Async upsert entity — safe on both backends. */
  upsertEntityAsync?(name: string, type: string, domain: string): Promise<number>;

  /** Async getEntityByName — safe on both backends. */
  getEntityByNameAsync?(name: string): Promise<EntityRecord | null>;

  /** Async insertRelationship — safe on both backends. */
  insertRelationshipAsync?(rel: Record<string, unknown>): Promise<void>;

  /** Async linkMemoryEntity — safe on both backends. */
  linkMemoryEntityAsync?(memoryId: number, entityId: number): Promise<void>;
}

// ── MemoryStoreExt — behavioral-subtyping extension ──────────────────────────
//
// All methods below were previously accessed via escape-hatch casts in the
// composition root (index.ts) and consolidation handler using the pattern:
//   const ext = store as unknown as Record<string, (...a) => unknown>;
//   ext["method"]?.(args) ?? []
//
// That pattern is an LSP violation: `PgMemoryStore` silently returns [] for
// every call because none of these methods existed on it. By lifting them onto
// a named interface and requiring both backends to implement them, the compiler
// enforces behavioral parity and optional-chaining escape hatches are removed.
//
// source: Liskov, B. H. & Wing, J. M. (1994). "A Behavioral Notion of
//   Subtyping." ACM TOPLAS, 16(6) — the history constraint requires that the
//   set of observable state histories of S must be a subset of those of T.
//   A subtype returning [] for methods the supertype populates is a history
//   constraint violation.
//
// Preconditions on every method in this extension are NOT stronger than the
// SQLite implementations (ADR-0003): parameters are the same.
// Postconditions on every PG method are NOT weaker: the returned data is
// semantically equivalent to what SQLite returns for the same state.

export interface MemoryStoreExt extends MemoryStore {
  // ── Decay / stats ──────────────────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_queries.py:108-112
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:107-109

  /**
   * Return all non-stale memories for the decay pipeline.
   *
   * postcondition: returns every row where is_stale = false.
   *   Neither backend returns [] unconditionally.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_queries.py:161
   * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:78
   */
  getAllMemoriesForDecay(): Record<string, unknown>[];

  /**
   * Return all non-stale memories for validation audit.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_queries.py:116
   * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:56
   */
  getAllMemoriesForValidation(limit?: number): Record<string, unknown>[];

  // ── Domain / directory / hot queries ──────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_queries.py:19-86
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:8-41

  /** Return memories for a domain ordered by heat descending. */
  getMemoriesForDomain(domain: string, minHeat?: number, limit?: number): Record<string, unknown>[];

  /** Return memories for a directory ordered by heat descending. */
  getMemoriesForDirectory(directory: string, minHeat?: number): Record<string, unknown>[];

  /** Return hot memories (heat_base >= minHeat). */
  getHotMemories(minHeat?: number, limit?: number, includeBenchmarks?: boolean): Record<string, unknown>[];

  // ── Recall (full-text search) ──────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_search.py:232-242
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py (FTS via tsvector)

  /**
   * Full-text search. Returns (memory_id, score) pairs ordered by relevance.
   *
   * SQLite: uses FTS5 MATCH.
   * PG: uses websearch_to_tsquery() against content_tsv tsvector column.
   *
   * postcondition: returns [] if no matches; never throws for empty query.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_search.py:232
   * source: PostgreSQL 11+ websearch_to_tsquery — https://www.postgresql.org/docs/current/textsearch-controls.html#TEXTSEARCH-PARSING-QUERIES
   */
  searchFts(query: string, limit?: number): Array<[number, number]>;

  // ── Consolidation stage queries ────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py:157-178
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_stats.py:79-96

  /** Return memories in a given consolidation stage. */
  getMemoriesByStage(stage: string, limit?: number): Record<string, unknown>[];

  /** Update consolidation fields for a memory row. */
  updateMemoryConsolidation(
    memoryId: number,
    stage: string,
    hoursInStage: number,
    replayCount: number,
    hippocampalDependency: number,
  ): void;

  /** Batch-insert stage transition records. */
  insertStageTransitionsBatch(rows: Record<string, unknown>[]): number;

  /** Update stage_entered_at timestamp. */
  updateStageEnteredAt(memoryId: number, enteredAt: string): void;

  // ── CLS queries ────────────────────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py:183-217
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_stats.py:136-162

  /** Return episodic memories, optionally filtered by domain/directory. */
  getEpisodicMemories(domain?: string, directory?: string, limit?: number): Record<string, unknown>[];

  /** Return semantic memories, optionally filtered by domain. */
  getSemanticMemories(domain?: string, limit?: number): Record<string, unknown>[];

  /** Update store_type for a memory row. */
  updateMemoryStoreType(memoryId: number, storeType: string): void;

  // ── Entity queries for consolidation ──────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_entities.py
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_entities.py

  /** Return all entities, optionally filtered by minHeat. */
  getAllEntities(opts?: { minHeat?: number; includeArchived?: boolean }): Record<string, unknown>[];

  /** Batch-update entity heat. */
  updateEntitiesHeatBatch(updates: Array<[number, number]>): void;

  /** Archive entities by setting heat to 0. */
  archiveEntitiesBatch(entityIds: number[]): number;

  // ── Relationship queries ───────────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_relationships.py
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_relationships.py

  /** Return all relationships. */
  getAllRelationships(): Record<string, unknown>[];

  /** Find co-accessed entity pairs for a set of memory IDs. */
  findCoAccessedPairs(memoryIds: number[]): Array<[number, number]>;

  /** Batch-update relationship weights. */
  updateRelationshipsWeightBatch(updates: Array<[number, number]>): void;

  /** Delete relationships by IDs. */
  deleteRelationshipsBatch(ids: number[]): number;

  /** Insert a raw relationship record. */
  insertRelationship(rel: Record<string, unknown>): void;

  /** Reinforce or create a relationship between two entity names. */
  reinforceOrCreateRelationship(entityA: string, entityB: string, learningRate: number): void;

  // ── Plasticity / hippocampal transfer ─────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_stats.py

  /** Return memories that are candidates for hippocampal transfer. */
  getTransferCandidates(limit?: number): Record<string, unknown>[];

  /** Update hippocampal dependency fraction for a memory row. */
  updateHippocampalDependency(memoryId: number, dependency: number): void;

  // ── Hot memories (recently accessed) ──────────────────────────────────

  /**
   * Return recently accessed memories.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py:90-101
   * source: cortex@ed33435 mcp_server/infrastructure/pg_store_stats.py:48-52
   */
  getRecentlyAccessedMemories(limit?: number, minAccessCount?: number): Record<string, unknown>[];

  // ── Agent context query (for codebase-analyze incremental hashing) ────
  //
  // source: packages/memory/src/codebase-analysis/handlers/codebase-analyze-helpers.ts:142-160

  /**
   * Return memories for a given agent_context (used by codebase-analyze).
   *
   * postcondition: returns rows where agent_context = agentContext AND NOT is_stale.
   *   Returns [] if none exist (not an error).
   *
   * source: packages/memory/src/codebase-analysis/handlers/codebase-analyze-helpers.ts:142-160
   *   Uses SELECT id, tags FROM memories WHERE agent_context = ? AND NOT is_stale
   */
  getMemoriesByAgentContext(agentContext: string): Array<{ id: number; tags: string }>;

  // ── Prospective memories ───────────────────────────────────────────────

  /** Return all active prospective memories. */
  getActiveProspectiveMemories(): Record<string, unknown>[];

  // ── Replay / access ────────────────────────────────────────────────────

  /** Increment replay_count for a memory. */
  incrementReplayCount(memoryId: number): void;

  // ── Archive / compression ──────────────────────────────────────────────

  /** Insert a record into the memory_archives table. */
  insertArchive(row: Record<string, unknown>): void;

  /**
   * Update memory content (compressed form) and optionally store embedding.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py (compression)
   */
  updateMemoryCompression(
    memoryId: number,
    content: string,
    embedding: Buffer | null,
    compressionLevel: number,
    opts?: Record<string, unknown>,
  ): void;

  // ── By-IDs batch fetch ─────────────────────────────────────────────────

  /**
   * Fetch multiple memories by ID in one round-trip.
   *
   * postcondition: returns MemoryItem for each ID that exists; missing IDs are omitted.
   */
  getByIds(ids: number[]): Record<string, unknown>[];

  // ── Consolidation log ──────────────────────────────────────────────────

  /** Log a consolidation run. */
  logConsolidation(data: Record<string, unknown>): void;

  // ── Prospective memory write ───────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_auxiliary.py:21-37
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_auxiliary.py:29-36

  /**
   * Insert a prospective memory record and return its id.
   *
   * postcondition: new row in prospective_memories with is_active = true.
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_auxiliary.py:insertProspectiveMemory
   */
  insertProspectiveMemory(data: Record<string, unknown>): number;

  /**
   * Return the count of currently active prospective memory triggers.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py:countActiveTriggers
   */
  countActiveTriggers(): number;

  // ── Rules ─────────────────────────────────────────────────────────────
  //
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_rules.py
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_rules.py

  /**
   * Insert a memory rule and return its id.
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_rules.py:insertRule
   */
  insertRule(data: Record<string, unknown>): number;

  /**
   * Return all active rules, optionally filtered by scope.
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_rules.py:getAllActiveRules
   */
  getAllActiveRules(): Record<string, unknown>[];

  /**
   * Return all active rules for a given scope.
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_rules.py:getRulesForScope
   */
  getRulesForScope(scope: string): Record<string, unknown>[];

  /**
   * Return all rules including inactive ones (for admin/audit).
   * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_rules.py:getAllRulesIncludingInactive
   */
  getAllRulesIncludingInactive(): Record<string, unknown>[];

  // ── PG-only async variants (optional on SQLite backend) ────────────���───
  //
  // These are declared as optional because SqliteMemoryStore uses synchronous
  // better-sqlite3 and does not need async variants. PgMemoryStore provides
  // them to avoid the _runSync() throw path.
  // source: ADR-0042 — async-when-available pattern.

  /** Async variant of insertProspectiveMemory (PG only). */
  insertProspectiveMemoryAsync?(data: Record<string, unknown>): Promise<number>;

  /** Async variant of countActiveTriggers (PG only). */
  countActiveTriggersAsync?(): Promise<number>;

  /** Async variant of insertRule (PG only). */
  insertRuleAsync?(data: Record<string, unknown>): Promise<number>;

  /** Async variant of getAllActiveRules (PG only). */
  getAllActiveRulesAsync?(): Promise<Record<string, unknown>[]>;

  /** Async variant of getRulesForScope (PG only). */
  getRulesForScopeAsync?(scope: string): Promise<Record<string, unknown>[]>;

  /** Async variant of getAllRulesIncludingInactive (PG only). */
  getAllRulesIncludingInactiveAsync?(): Promise<Record<string, unknown>[]>;
}
