/**
 * Tests for the letta-style two-tier memory model (C1-C4).
 *
 * C1 — hot-memory injection must not surface auto-captures or block replicas.
 * C3 — block-replica upsert by vpath identity (one row per block file).
 * C4 — CLS promotion excludes auto-captured and memory-replica memories.
 *
 * Uses in-process fakes (no PostgreSQL required).
 * contract: zetetic-team-subagents memory/contract.md §8b
 *
 * Ports: tests_py/handlers/test_memory_tier_model.py
 */

import { describe, it, expect } from "vitest";

// ── C1: isTierNoise ───────────────────────────────────────────────────────────

describe("C1: isTierNoise", () => {
  it("flags auto-captured and memory-replica, not curated entries", async () => {
    const { isTierNoise } = await import("../../src/remember/tier-model.js");

    expect(
      isTierNoise({ id: 1, tags: ["auto-captured", "tool:edit"] }),
    ).toBe(true);
    expect(
      isTierNoise({
        id: 10,
        tags: [
          "memory-replica",
          "scope:engineer",
          "vpath:/memories/engineer/notes.md",
        ],
      }),
    ).toBe(true);
    expect(isTierNoise({ id: 2, tags: ["lesson"] })).toBe(false);
    expect(isTierNoise({ id: 3, tags: ["_anchor", "decision"] })).toBe(false);
  });

  it("handles JSON-string tags in isTierNoise", async () => {
    const { isTierNoise } = await import("../../src/remember/tier-model.js");
    const mem: Record<string, unknown> = {
      id: 1,
      tags: JSON.stringify(["auto-captured", "tool:bash"]),
    };
    expect(isTierNoise(mem)).toBe(true);
  });

  it("handles null/absent tags in isTierNoise", async () => {
    const { isTierNoise } = await import("../../src/remember/tier-model.js");
    expect(isTierNoise({ id: 1, tags: null })).toBe(false);
    expect(isTierNoise({ id: 1 })).toBe(false);
  });
});

// ── C3: tryBlockReplicaUpsert ─────────────────────────────────────────────────

/** Minimal BlockReplicaStore fake that records UPDATE calls. */
class FakeBlockReplicaStore {
  readonly updates: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly existingId: number | null = null) {}

  async runAsync<T>(
    fn: (client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<T>,
  ): Promise<T> {
    const existingId = this.existingId;
    const updates = this.updates;
    const fakeClient = {
      async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
        if (sql.includes("SELECT id FROM memories")) {
          if (existingId !== null) {
            return { rows: [{ id: existingId }] };
          }
          return { rows: [] };
        }
        if (sql.includes("UPDATE memories")) {
          updates.push({ sql, params: params ?? [] });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    return fn(fakeClient);
  }
}

describe("C3: tryBlockReplicaUpsert", () => {
  it("updates existing row when same vpath: tag found", async () => {
    const { tryBlockReplicaUpsert } = await import(
      "../../src/remember/handlers/block-replica-upsert.js"
    );

    const store = new FakeBlockReplicaStore(42);
    const tags = [
      "memory-replica",
      "scope:engineer",
      "vpath:/memories/engineer/notes.md",
    ];

    const [upserted, uid] = await tryBlockReplicaUpsert(
      "updated block content",
      null,
      tags,
      "post_tool_capture",
      store,
    );

    expect(upserted).toBe(true);
    expect(uid).toBe(42);
    expect(store.updates).toHaveLength(1); // exactly one UPDATE executed
  });

  it("returns (false, null) when no existing row", async () => {
    const { tryBlockReplicaUpsert } = await import(
      "../../src/remember/handlers/block-replica-upsert.js"
    );

    const store = new FakeBlockReplicaStore(null);
    const tags = ["memory-replica", "vpath:/memories/engineer/new.md"];

    const [upserted, uid] = await tryBlockReplicaUpsert(
      "new block",
      null,
      tags,
      "post_tool_capture",
      store,
    );

    expect(upserted).toBe(false);
    expect(uid).toBeNull();
    expect(store.updates).toHaveLength(0);
  });

  it("ignores non-replica writes (no memory-replica tag)", async () => {
    const { tryBlockReplicaUpsert } = await import(
      "../../src/remember/handlers/block-replica-upsert.js"
    );

    const store = new FakeBlockReplicaStore(99);
    const tags = ["lesson", "decision"];

    const [upserted, uid] = await tryBlockReplicaUpsert(
      "curated lesson",
      null,
      tags,
      "user",
      store,
    );

    expect(upserted).toBe(false);
    expect(uid).toBeNull();
    expect(store.updates).toHaveLength(0); // normal writes must never reach upsert path
  });

  it("ignores memory-replica without vpath: tag", async () => {
    const { tryBlockReplicaUpsert } = await import(
      "../../src/remember/handlers/block-replica-upsert.js"
    );

    const store = new FakeBlockReplicaStore(99);
    const tags = ["memory-replica", "scope:engineer"]; // missing vpath:

    const [upserted, uid] = await tryBlockReplicaUpsert(
      "replica without vpath",
      null,
      tags,
      "post_tool_capture",
      store,
    );

    expect(upserted).toBe(false);
    expect(uid).toBeNull();
  });
});

// ── C4: CLS promotion exclusion ───────────────────────────────────────────────

function makeEpisodic(
  id: number,
  content: string,
  tags: string[] = [],
): Record<string, unknown> {
  return {
    id,
    embedding: Array.from({ length: 4 }, () => 0.5), // dummy fixed embedding
    content,
    tags,
  };
}

/** Fake CLS store. */
class FakeClsStore {
  readonly insertedMemories: Record<string, unknown>[] = [];
  readonly insertedRelationships: Record<string, unknown>[] = [];

  constructor(
    private readonly episodic: Record<string, unknown>[],
    private readonly semantic: Record<string, unknown>[] = [],
  ) {}

  async getEpisodicMemories(limit: number): Promise<Record<string, unknown>[]> {
    return this.episodic.slice(0, limit);
  }

  async getSemanticMemories(limit: number): Promise<Record<string, unknown>[]> {
    return this.semantic.slice(0, limit);
  }

  async getAllEntities(_opts: { minHeat: number }): Promise<Record<string, unknown>[]> {
    return [];
  }

  async insertMemory(mem: Record<string, unknown>): Promise<number> {
    this.insertedMemories.push(mem);
    return this.insertedMemories.length;
  }

  async insertRelationship(rel: Record<string, unknown>): Promise<void> {
    this.insertedRelationships.push(rel);
  }
}

/** Fake embedding engine — identical content → similarity 1.0. */
const fakeEmbeddings = {
  async encode(_text: string): Promise<number[]> {
    return [0.5, 0.5, 0.5, 0.5];
  },
  similarity(a: number[], b: number[]): number {
    return a[0] === b[0] ? 1.0 : 0.0;
  },
};

describe("C4: CLS promotion exclusion", () => {
  it("excludes auto-captured from episodic scan — episodic_scanned = 2", async () => {
    const { runClsCycle } = await import(
      "../../src/consolidation/stages/cls.js"
    );

    // Disable env var to ensure cycle runs
    delete process.env["CORTEX_CONSOLIDATION_DISABLED"];

    const curatedA = makeEpisodic(1, "same content");
    const curatedB = makeEpisodic(2, "same content", ["lesson"]);
    const autoCap = makeEpisodic(3, "same content", ["auto-captured", "tool:edit"]);

    const store = new FakeClsStore([curatedA, curatedB, autoCap]);
    const result = await runClsCycle(store, null, fakeEmbeddings);

    expect(result).toHaveProperty("episodic_scanned");
    // Only the 2 curated memories should have been scanned.
    expect(result.episodic_scanned).toBe(2);
  });

  it("excludes memory-replica — empty_episodic_scan when replica is the only entry", async () => {
    const { runClsCycle } = await import(
      "../../src/consolidation/stages/cls.js"
    );

    delete process.env["CORTEX_CONSOLIDATION_DISABLED"];

    const replica = makeEpisodic(10, "block content", [
      "memory-replica",
      "vpath:/memories/engineer/notes.md",
    ]);

    const store = new FakeClsStore([replica]);
    const result = await runClsCycle(store, null, fakeEmbeddings);

    // After excluding the replica, episodic is empty.
    expect(result.reason_for_zero).toBe("empty_episodic_scan");
    expect(result.episodic_scanned).toBe(0);
  });

  it("isPromotionNoise correctly identifies tier noise", async () => {
    const { isPromotionNoise } = await import(
      "../../src/remember/tier-model.js"
    );

    expect(isPromotionNoise({ tags: ["auto-captured"] })).toBe(true);
    expect(isPromotionNoise({ tags: ["memory-replica", "scope:x"] })).toBe(true);
    expect(isPromotionNoise({ tags: ["lesson", "decision"] })).toBe(false);
    expect(isPromotionNoise({ tags: null })).toBe(false);
    expect(
      isPromotionNoise({ tags: JSON.stringify(["auto-captured"]) }),
    ).toBe(true);
  });
});
