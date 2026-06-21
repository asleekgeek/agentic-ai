/**
 * db-relationship-upsert.test.ts — Integration test for the B1#1/A4#5 parity fix.
 *
 * insertRelationship must be idempotent on the directed tuple
 * (source_entity_id, target_entity_id, relationship_type): a re-ingest (e.g.
 * incremental codebase re-analysis) replays the same structural edges and must
 * NOT duplicate them. On conflict the edge is refreshed, keeping the strongest
 * weight/confidence (GREATEST), never doubling and never lowering.
 *
 * Two distinct mechanisms are proven here, and their difference is the point:
 *   1. Going forward, insertRelationship MAX-MERGES via ON CONFLICT DO UPDATE.
 *   2. The one-time dedup migration that creates uq_relationships_directed
 *      DELETES all but MIN(id) — it keeps the oldest row VERBATIM, it does not
 *      merge. (Max-merge only applies to subsequent inserts.)
 *
 * source: cortex@bc5af469 mcp_server/infrastructure/pg_store_relationships.py:52-81
 *         + mcp_server/infrastructure/pg_schema.py:1442-1469
 *         (mirrors the seeded-PG smoke style of db-effective-heat.test.ts).
 *
 * Gated on a reachable local PostgreSQL (pgvector + pg_trgm). Skips otherwise,
 * so CI without a database is unaffected. Set PG_ADMIN_URL to override.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { getAllDdl } from "../../../src/remember/storage/pg-schema-functions.js";
import { MIGRATIONS_DDL } from "../../../src/remember/storage/pg-schema-indexes.js";
import {
  insertRelationship,
  countRelationships,
  getAllRelationships,
} from "../../../src/remember/storage/pg-store-relationships.js";

const ADMIN_URL =
  process.env.PG_ADMIN_URL ?? "postgres://localhost:5432/postgres";
const TEST_DB = "cortex_b1upsert_test";
const TEST_URL = `postgres://localhost:5432/${TEST_DB}`;

interface Pg {
  query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  end: () => Promise<void>;
}

async function connect(url: string): Promise<Pg | null> {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client as unknown as Pg;
  } catch {
    return null;
  }
}

// Probe once at module load so the whole suite can skip when PG is absent.
const probe = await connect(ADMIN_URL);
const pgReachable = probe !== null;
if (probe) await probe.end();

async function seedTwoEntities(db: Pg): Promise<[number, number, number]> {
  const ids: number[] = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    const r = await db.query(
      "INSERT INTO entities (name, type) VALUES ($1, 'function') RETURNING id",
      [name],
    );
    ids.push(Number((r.rows[0] as { id: number }).id));
  }
  return [ids[0]!, ids[1]!, ids[2]!];
}

describe.skipIf(!pgReachable)("relationship upsert idempotency (B1#1/A4#5)", () => {
  beforeAll(async () => {
    const admin = await connect(ADMIN_URL);
    if (!admin) throw new Error("admin connection failed");
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    const db = await connect(TEST_URL);
    if (!db) throw new Error("test-db connection failed");
    for (const stmt of getAllDdl()) await db.query(stmt);
    await db.end();
  }, 60000);

  afterAll(async () => {
    const admin = await connect(ADMIN_URL);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await admin.end();
    }
  });

  it("getAllDdl creates the uq_relationships_directed UNIQUE index", async () => {
    const db = await connect(TEST_URL);
    if (!db) throw new Error("connect failed");
    try {
      const r = await db.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_relationships_directed'",
      );
      expect(r.rows.length).toBe(1);
      expect(String((r.rows[0] as { indexdef: string }).indexdef)).toContain("UNIQUE");
    } finally {
      await db.end();
    }
  });

  it("re-ingest keeps one edge and GREATEST-merges weight/confidence (not doubled, not lowered)", async () => {
    const db = await connect(TEST_URL);
    if (!db) throw new Error("connect failed");
    try {
      const [src, tgt] = await seedTwoEntities(db);
      const client = db as unknown as PoolClient;
      const tuple = { source_entity_id: src, target_entity_id: tgt, relationship_type: "calls" };

      // #1 establish the edge.
      await insertRelationship(client, { ...tuple, weight: 0.3, confidence: 0.4 });
      // #2 re-ingest with a STRONGER weight/confidence → GREATEST takes the new.
      await insertRelationship(client, { ...tuple, weight: 0.7, confidence: 0.9 });
      // #3 re-ingest with a WEAKER weight/confidence → GREATEST keeps the held max.
      await insertRelationship(client, { ...tuple, weight: 0.2, confidence: 0.5 });

      // Row-count stable: exactly one directed edge survives all three ingests.
      // (COUNT(*) is bigint → node-postgres returns it as a string; coerce.)
      expect(Number(await countRelationships(client))).toBe(1);

      const rows = await getAllRelationships(client);
      expect(rows.length).toBe(1);
      const edge = rows[0]!;
      // 0.7, not 0.3 (overwrite-down), not 1.2 (additive doubling), not 0.2.
      expect(Number(edge.weight)).toBeCloseTo(0.7, 5);
      expect(Number(edge.confidence)).toBeCloseTo(0.9, 5);
      expect(edge.last_reinforced).not.toBeNull();
    } finally {
      await db.end();
    }
  });

  it("a different directed tuple inserts a second edge (upsert collapses only same-tuple)", async () => {
    const db = await connect(TEST_URL);
    if (!db) throw new Error("connect failed");
    try {
      // Fresh entities to isolate from the previous test's surviving edge.
      const [src, tgt, other] = await seedTwoEntities(db);
      const client = db as unknown as PoolClient;
      const before = Number(await countRelationships(client));
      await insertRelationship(client, { source_entity_id: src, target_entity_id: tgt, relationship_type: "calls" });
      // Same endpoints, DIFFERENT type → distinct tuple → new row.
      await insertRelationship(client, { source_entity_id: src, target_entity_id: tgt, relationship_type: "contains" });
      // Different target → distinct tuple → new row.
      await insertRelationship(client, { source_entity_id: src, target_entity_id: other, relationship_type: "calls" });
      expect(Number(await countRelationships(client))).toBe(before + 3);
    } finally {
      await db.end();
    }
  });
});

describe.skipIf(!pgReachable)("directed-unique migration dedup (keeps MIN(id) verbatim)", () => {
  const DEDUP_DB = "cortex_b1dedup_test";
  const DEDUP_URL = `postgres://localhost:5432/${DEDUP_DB}`;

  beforeAll(async () => {
    const admin = await connect(ADMIN_URL);
    if (!admin) throw new Error("admin connection failed");
    await admin.query(`DROP DATABASE IF EXISTS ${DEDUP_DB}`);
    await admin.query(`CREATE DATABASE ${DEDUP_DB}`);
    await admin.end();

    const db = await connect(DEDUP_URL);
    if (!db) throw new Error("dedup-db connection failed");
    for (const stmt of getAllDdl()) await db.query(stmt);
    await db.end();
  }, 60000);

  afterAll(async () => {
    const admin = await connect(ADMIN_URL);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DEDUP_DB}`);
      await admin.end();
    }
  });

  it("re-running MIGRATIONS_DDL after duplicates collapses to MIN(id) and rebuilds the index", async () => {
    const db = await connect(DEDUP_URL);
    if (!db) throw new Error("connect failed");
    try {
      // Drop the index so duplicates can be inserted (simulates a pre-fix DB
      // whose re-ingest already duplicated edges before the unique index existed).
      await db.query("DROP INDEX IF EXISTS uq_relationships_directed");
      const [src, tgt, other] = await seedTwoEntities(db);

      // Three duplicates of the SAME tuple; first inserted (weight 0.3) gets the
      // smallest SERIAL id → it must be the survivor after MIN(id) dedup.
      for (const w of [0.3, 0.7, 0.2]) {
        await db.query(
          "INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, weight) VALUES ($1, $2, 'calls', $3)",
          [src, tgt, w],
        );
      }
      // A distinct tuple that must survive untouched.
      await db.query(
        "INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, weight) VALUES ($1, $2, 'contains', 0.5)",
        [src, other],
      );

      const client = db as unknown as PoolClient;
      expect(Number(await countRelationships(client))).toBe(4); // 3 dups + 1 distinct

      // Re-run the full migration string: every other guard is a no-op (columns/
      // indexes already exist), the directed-index guard fires (we dropped it),
      // deduping then recreating the UNIQUE index.
      await db.query(MIGRATIONS_DDL);

      expect(Number(await countRelationships(client))).toBe(2); // one per distinct tuple

      const rows = await getAllRelationships(client);
      const callsEdge = rows.find((r) => r.relationship_type === "calls");
      expect(callsEdge).toBeDefined();
      // MIN(id) row kept VERBATIM → 0.3 (the first), NOT 0.7 (a max-merge would
      // give 0.7 — proving dedup deletes rather than merges).
      expect(Number(callsEdge!.weight)).toBeCloseTo(0.3, 5);

      const idx = await db.query(
        "SELECT 1 FROM pg_indexes WHERE indexname = 'uq_relationships_directed'",
      );
      expect(idx.rows.length).toBe(1);
    } finally {
      await db.end();
    }
  });
});
