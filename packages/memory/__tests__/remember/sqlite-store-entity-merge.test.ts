/**
 * sqlite-store-entity-merge.test.ts — In-memory SQLite tests for mergeEntities.
 *
 * Mirrors: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py
 *
 * Covers:
 *   1. basic alias→survivor collapse (memory_links_moved, tombstone)
 *   2. self-merge no-op (survivorId == aliasId)
 *   3. missing-entity no-op (one id absent)
 *   4. memory_entities ON CONFLICT dedup (both entities already linked to same memory)
 *   5. relationships source+target rewire
 *   6. self-loop removal (alias→survivor edge becomes survivor→survivor → deleted)
 *   7. heat/recency absorbed via MAX (bounded — not a sum)
 *   8. alias tombstoned (archived=1, heat=0)
 *
 * Composition-root cycle (runEntityMergeCycle), mirroring the oracle's two
 * cycle-level cases at cortex bc5af469 test_pg_entity_merge.py:226-261:
 *   9.  test_cycle_merges_fuzzy_duplicates — end-to-end collapse + tombstone
 *   10. test_cycle_ablated_is_noop — CORTEX_ABLATE_ENTITY_DEDUP=1 → no-op
 *
 * Note on ast_symbol test: the cortex oracle includes test_merge_refuses_ast_symbol
 * which relies on the 'origin' column to exclude code symbols. agentic-ai entities
 * has NO 'origin' column (sqlite-schema.ts:90-99), so that guard is omitted from
 * both the implementation and this test suite. See DEVIATION comment in
 * sqlite-store-entities.ts and memory-store.ts.
 *
 * source: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py
 */

import { beforeEach, afterEach, describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { getAllDdl, MIGRATIONS } from "../../src/remember/storage/sqlite-schema.js";

// ── In-memory DB setup ────────────────────────────────────────────────────────

function createTestDb(): DatabaseType {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const ddl of getAllDdl()) {
    try { db.exec(ddl); } catch { /* IF NOT EXISTS — tolerate */ }
  }
  for (const [table, col, def] of MIGRATIONS) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  }
  return db;
}

// ── Minimal store wrapper ─────────────────────────────────────────────────────
//
// We need direct access to the mergeEntities implementation without pulling in
// the full SqliteMemoryStore (which has many unrelated deps). We delegate to
// the same SQL logic by importing the mixin directly and using it as the
// implementation — then import SqliteMemoryStore for integration verification.
//
// For the store we use the real SqliteMemoryStore because (a) it is the
// production path and (b) the mixin test in sqlite-mixins.test.ts already
// covers the pure-unit path. This test is behavioral/integration.

import { SqliteMemoryStore } from "../../src/remember/storage/sqlite-store.js";
import {
  runEntityMergeCycle,
  type EntityMergePort,
} from "../../src/consolidation/stages/entity-merge.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a SqliteMemoryStore backed by an isolated :memory: DB. */
function createStore(): SqliteMemoryStore {
  const db = createTestDb();
  // SqliteMemoryStore accepts a DatabaseType directly when constructed via the
  // internal path; use the public path with ":memory:" (default constructor).
  // We construct via the DB-accepting path because the public API takes a path.
  // Use a sub-export or the internal constructor that accepts DatabaseType.
  // As SqliteMemoryStore(":memory:") creates its own DB with getAllDdl, we use that.
  void db.close(); // close the db we created above; SqliteMemoryStore creates its own
  return new SqliteMemoryStore(":memory:");
}

/** Insert an entity directly, bypassing the dedup-on-insert path so tests can hold
 *  two near-duplicate rows simultaneously (mirrors _mk_entity in the cortex oracle).
 *  source: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py::_mk_entity */
function mkEntity(
  store: SqliteMemoryStore,
  name: string,
  opts: { type?: string; heat?: number } = {},
): number {
  // Access the internal _db via a cast — acceptable in test helpers for
  // direct row insertion that bypasses the dedup-on-insert policy.
  // Invariant: _db is always set after construction (SqliteMemoryStore constructor).
  const db = (store as unknown as { _db: DatabaseType })._db;
  const result = db
    .prepare(
      "INSERT INTO entities (name, type, domain, heat) VALUES (?, ?, ?, ?)",
    )
    .run(
      name,
      opts.type ?? "technology",
      "entity-merge-test",
      opts.heat ?? 0.5,
    );
  // lastInsertRowid is a bigint or number depending on better-sqlite3 version.
  // Number() is safe for entity ids (never exceed MAX_SAFE_INTEGER in tests).
  return Number(result.lastInsertRowid);
}

/** Insert a memory and return its id.
 *  source: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py::_mem */
function mkMemory(store: SqliteMemoryStore, content: string): number {
  return store.insertMemory({
    content,
    source: "user",
    domain: "entity-merge-test",
    heat: 0.5,
  });
}

/** Count rows matching a WHERE clause in the given table.
 *  source: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py::_count */
function countRows(store: SqliteMemoryStore, table: string, where: string, params: unknown[]): number {
  const db = (store as unknown as { _db: DatabaseType })._db;
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`)
    .get(...params) as { c: number };
  return row.c;
}

/** Insert a relationship directly.
 *  source: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py::_mk_rel */
function mkRel(
  store: SqliteMemoryStore,
  src: number,
  tgt: number,
  rtype = "related_to",
): void {
  const db = (store as unknown as { _db: DatabaseType })._db;
  db
    .prepare(
      "INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type) VALUES (?, ?, ?)",
    )
    .run(src, tgt, rtype);
}

/** Fetch a raw entity row by id.
 *  source: cortex bc5af469 tests_py/infrastructure/test_pg_entity_merge.py::store.get_entity_by_id */
function getEntityById(
  store: SqliteMemoryStore,
  id: number,
): Record<string, unknown> | null {
  const db = (store as unknown as { _db: DatabaseType })._db;
  const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("mergeEntities — store-level mutation (sqlite :memory:)", () => {
  let store: SqliteMemoryStore;

  beforeEach(() => { store = createStore(); });
  afterEach(() => { store.close(); });

  // ── 1. basic alias→survivor collapse ───────────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_rewires_memory_links

  it("rewires memory_entities from alias to survivor and tombstones alias", () => {
    const surv = mkEntity(store, "Survivor");
    const alias = mkEntity(store, "Alias");
    const mem = mkMemory(store, "mentions the alias concept");

    // Link the memory to the alias only.
    store.linkMemoryEntity(mem, alias);

    const out = store.mergeEntities(surv, alias);

    expect(out.merged).toBe(true);
    expect(out.memory_links_moved).toBe(1);

    // The memory must now be linked to the survivor.
    expect(countRows(store, "memory_entities", "entity_id = ?", [surv])).toBe(1);
    // The alias link must be gone.
    expect(countRows(store, "memory_entities", "entity_id = ?", [alias])).toBe(0);

    // Alias must be tombstoned.
    const aliasRow = getEntityById(store, alias);
    expect(aliasRow?.archived).toBeTruthy(); // SQLite stores as 1
    expect(aliasRow?.heat).toBe(0);
  });

  // ── 2. self-merge no-op ──────────────────────────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_noop_same_id

  it("returns merged=false when survivorId === aliasId (no-op)", () => {
    const e = mkEntity(store, "Solo");
    const out = store.mergeEntities(e, e);
    expect(out.merged).toBe(false);
  });

  // ── 3. missing-entity no-op ─────────────────────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_noop_missing_entity

  it("returns merged=false when alias id does not exist", () => {
    const surv = mkEntity(store, "Survivor");
    // 999_999_999 — intentionally absent id; source: cortex oracle test constant
    const out = store.mergeEntities(surv, 999_999_999); // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_noop_missing_entity
    expect(out.merged).toBe(false);
  });

  // ── 4. memory_entities ON CONFLICT dedup ────────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_dedupes_shared_memory_link
  // A memory linked to BOTH entities must not violate the (memory_id,entity_id) PK.

  it("deduplicates memory_entities when memory is linked to both entities", () => {
    const surv = mkEntity(store, "Survivor");
    const alias = mkEntity(store, "Alias");
    const mem = mkMemory(store, "mentions both");

    store.linkMemoryEntity(mem, surv);
    store.linkMemoryEntity(mem, alias);

    const out = store.mergeEntities(surv, alias);

    expect(out.merged).toBe(true);
    // After merge: exactly one memory_entities row for the survivor (not two).
    expect(countRows(store, "memory_entities", "entity_id = ?", [surv])).toBe(1);
  });

  // ── 5. relationships source+target rewire ────────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_rewires_relationships

  it("rewires relationship source and target from alias to survivor", () => {
    const surv = mkEntity(store, "Survivor");
    const alias = mkEntity(store, "Alias");
    const other = mkEntity(store, "Other");

    // alias → other
    mkRel(store, alias, other);

    const out = store.mergeEntities(surv, alias);

    expect(out.relationships_rewired).toBe(1);
    // The relationship now originates from the survivor.
    expect(countRows(store, "relationships", "source_entity_id = ?", [surv])).toBe(1);
    expect(countRows(store, "relationships", "source_entity_id = ?", [alias])).toBe(0);
  });

  it("rewires relationship target from alias to survivor", () => {
    const surv = mkEntity(store, "Survivor");
    const alias = mkEntity(store, "Alias");
    const other = mkEntity(store, "Other");

    // other → alias
    mkRel(store, other, alias);

    const out = store.mergeEntities(surv, alias);

    expect(out.relationships_rewired).toBe(1);
    expect(countRows(store, "relationships", "target_entity_id = ?", [surv])).toBe(1);
    expect(countRows(store, "relationships", "target_entity_id = ?", [alias])).toBe(0);
  });

  // ── 6. self-loop removed ─────────────────────────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_drops_self_loop
  // alias → survivor becomes survivor → survivor after rewire → must be deleted.

  it("deletes the self-loop created when alias→survivor edge is rewired", () => {
    const surv = mkEntity(store, "Survivor");
    const alias = mkEntity(store, "Alias");

    // alias → surv: after rewire this becomes surv → surv (self-loop).
    mkRel(store, alias, surv);

    store.mergeEntities(surv, alias);

    // No self-loop must exist after merge.
    expect(
      countRows(
        store,
        "relationships",
        "source_entity_id = target_entity_id",
        [],
      ),
    ).toBe(0);
  });

  // ── 7. heat/recency absorbed via MAX (bounded) ───────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py::test_merge_absorbs_heat_bounded
  // GREATEST / MAX — not a sum. The heat invariant [0,1] must be preserved.

  it("absorbs alias heat into survivor via MAX — not a naive sum", () => {
    const surv = mkEntity(store, "Survivor", { heat: 0.3 });
    const alias = mkEntity(store, "Alias", { heat: 0.9 });

    store.mergeEntities(surv, alias);

    const survRow = getEntityById(store, surv);
    // MAX(0.3, 0.9) = 0.9 — heat stays within [0,1] invariant.
    expect(survRow?.heat).toBeCloseTo(0.9);
  });

  it("keeps survivor heat when survivor heat is already higher than alias", () => {
    const surv = mkEntity(store, "Survivor", { heat: 0.9 });
    const alias = mkEntity(store, "Alias", { heat: 0.2 });

    store.mergeEntities(surv, alias);

    const survRow = getEntityById(store, surv);
    // MAX(0.9, 0.2) = 0.9 — survivor heat unchanged.
    expect(survRow?.heat).toBeCloseTo(0.9);
  });

  // ── 8. alias tombstoned (archived=1, heat=0) ────────────────────────────
  //
  // source: cortex bc5af469 test_pg_entity_merge.py — alias archived=True in all merge tests

  it("tombstones alias with archived=1 and heat=0 after successful merge", () => {
    const surv = mkEntity(store, "Survivor");
    const alias = mkEntity(store, "Alias", { heat: 0.7 });

    const out = store.mergeEntities(surv, alias);

    expect(out.merged).toBe(true);

    const aliasRow = getEntityById(store, alias);
    expect(Number(aliasRow?.archived)).toBe(1); // SQLite stores INTEGER 1
    expect(aliasRow?.heat).toBe(0);
  });

  it("does NOT tombstone alias when merge is a no-op (same id)", () => {
    const e = mkEntity(store, "Solo", { heat: 0.5 });
    store.mergeEntities(e, e);
    const row = getEntityById(store, e);
    expect(Number(row?.archived)).toBe(0); // must remain non-archived
  });
});

// ── 9–10. composition-root cycle (runEntityMergeCycle) ──────────────────────────
//
// Mirrors the oracle's two cycle-level cases at
// cortex bc5af469 test_pg_entity_merge.py:226-261 (test_cycle_merges_fuzzy_duplicates,
// test_cycle_ablated_is_noop). We seed two distinct raw names that collide under
// normalizeLabel ("Machine Learning" / "Machine-Learning" → "machine learning"),
// so Pass 1 (exactNormPass) of the pure dedup engine deterministically pairs them —
// avoiding any fuzzy-threshold flakiness while respecting the entities.name UNIQUE
// constraint. The merge key is the row id (entity-dedup.ts mergeKey → String(id)),
// so the cycle's digit-key filter fires.

describe("runEntityMergeCycle — composition-root cycle (sqlite :memory:)", () => {
  let store: SqliteMemoryStore;

  beforeEach(() => { store = createStore(); });
  afterEach(() => {
    // Always clear the ablation env so it cannot leak into other tests/files.
    delete process.env.CORTEX_ABLATE_ENTITY_DEDUP;
    store.close();
  });

  /** Build the narrow EntityMergePort the cycle needs from the real store,
   *  mirroring the inline port constructed in consolidation/handler.ts. */
  function portFor(s: SqliteMemoryStore): EntityMergePort {
    return {
      getAllEntities: (opts) =>
        Promise.resolve(s.getAllEntities(opts) as Record<string, unknown>[]),
      mergeEntities: (survivorId, aliasId) =>
        Promise.resolve(s.mergeEntities(survivorId, aliasId)),
    };
  }

  /** Count how many of the given entity ids are tombstoned (archived=1). */
  function archivedCount(ids: number[]): number {
    return ids
      .map((id) => getEntityById(store, id))
      .filter((r) => Number(r?.archived) === 1).length;
  }

  // source: cortex bc5af469 test_pg_entity_merge.py::test_cycle_merges_fuzzy_duplicates
  it("collapses normalize-colliding variant entities end-to-end and tombstones one alias", async () => {
    // Distinct raw names (entities.name is UNIQUE) that collide under
    // normalizeLabel("machine learning") → exactNormPass unions them.
    const a = mkEntity(store, "Machine Learning", { type: "technology" });
    const b = mkEntity(store, "Machine-Learning", { type: "technology" });

    const out = await runEntityMergeCycle(portFor(store));

    expect(out.merges_applied).toBe(1);
    expect(out.pairs_planned).toBeGreaterThanOrEqual(1);
    expect(out.ablated).toBeUndefined();
    // Tombstone, not delete: exactly one of the two duplicates is archived.
    expect(archivedCount([a, b])).toBe(1);
  });

  // source: cortex bc5af469 test_pg_entity_merge.py::test_cycle_ablated_is_noop
  it("is a no-op when ENTITY_DEDUP is ablated (CORTEX_ABLATE_ENTITY_DEDUP=1)", async () => {
    // Distinct raw names (entities.name is UNIQUE) that collide under
    // normalizeLabel("machine learning") → exactNormPass unions them.
    const a = mkEntity(store, "Machine Learning", { type: "technology" });
    const b = mkEntity(store, "Machine-Learning", { type: "technology" });

    // source: cortex bc5af469 mcp_server/core/ablation.py:25 — is_mechanism_disabled
    process.env.CORTEX_ABLATE_ENTITY_DEDUP = "1";

    const out = await runEntityMergeCycle(portFor(store));

    expect(out).toEqual({ merges_applied: 0, pairs_planned: 0, ablated: true });
    // No mutation: neither duplicate is tombstoned.
    expect(archivedCount([a, b])).toBe(0);
  });
});
