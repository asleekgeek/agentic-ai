/**
 * curation-supersede.test.ts — End-to-end DoD test for MEM-G1 curation-on-write.
 *
 * Verifies that rememberAsync, when wired with a real embedder (as the MCP
 * composition root now does), reproduces Cortex remember.py's curation-on-write
 * behaviour exactly:
 *   - a contradicting near-duplicate is SUPERSEDED (both rows retained, forward
 *     edge supersedes_id on the new row + back-pointer superseded_by_id on the
 *     old row) — NOT destructively merged;
 *   - a non-contradicting near-duplicate is MERGED in place (no new row);
 *   - novel content is CREATED;
 *   - with no embedder the curation path is a no-op (byte-identical writes).
 *
 * The store is a controllable fake: searchVectorsAsync returns the seeded
 * candidate at distance 0 (cosine sim 1.0 ≥ MERGE_THRESHOLD 0.85), so the test
 * is independent of whether sqlite-vec is loaded in the test env. The "important"
 * tag bypasses the predictive-coding gate (determineBypass → bypass_important_tag)
 * WITHOUT setting force, so curation still runs — mirroring how Cortex's gate
 * lets a flagged write through to try_curation.
 *
 * source: cortex@ed33435 mcp_server/handlers/remember.py:299,359-368 (encode once → try_curation)
 * source: cortex@ed33435 mcp_server/handlers/remember_helpers.py:try_curation:351-360 (merge→supersede on contradiction)
 * source: cortex@ed33435 mcp_server/handlers/remember_helpers.py:insert_and_post_process:528,534-539 (supersedes_id + set_superseded_by)
 * source: cortex@ed33435 mcp_server/core/curation.py:decide_curation_action,detect_contradictions
 */

import { describe, it, expect } from "vitest";
import { rememberAsync, type WriteEmbedder } from "../../src/remember/handlers/remember.js";
import type { MemoryStore } from "../../src/remember/storage/memory-store.js";

// ── Controllable fake store ────────────────────────────────────────────────

interface FakeCalls {
  inserts: Array<Record<string, unknown>>;
  embeddingUpserts: Array<[number, Buffer]>;
  supersededBy: Array<[number, number]>;
  mergedContent: Array<[number, string]>;
  mergedHeat: Array<[number, number]>;
}

interface SeedMemory {
  id: number;
  content: string;
  tags?: string[];
  heat_base?: number;
  created_at?: string;
}

/**
 * Build a fake MemoryStore whose vector search returns `candidates` (id, distance)
 * and whose getMemoryAsync resolves the seeded rows. New inserts get sequential
 * ids starting at `nextId`.
 */
function makeFakeStore(opts: {
  candidates: Array<[number, number]>;
  seed: SeedMemory[];
  nextId: number;
}): { store: MemoryStore; calls: FakeCalls } {
  const calls: FakeCalls = {
    inserts: [],
    embeddingUpserts: [],
    supersededBy: [],
    mergedContent: [],
    mergedHeat: [],
  };
  const byId = new Map<number, SeedMemory>(opts.seed.map((m) => [m.id, m]));
  let nextId = opts.nextId;

  const fake = {
    // Vector search — gate (top_k=5) and curation (top_k=3) both call this.
    searchVectorsAsync: async (_buf: Buffer, _k: number, _t: number) => opts.candidates,
    searchVectors: (_buf: Buffer, _k: number, _t: number) => opts.candidates,

    getMemoryAsync: async (id: number) => {
      const m = byId.get(id);
      return m ? { id: m.id, content: m.content, tags: m.tags ?? [], heat_base: m.heat_base ?? 1.0, created_at: m.created_at } : null;
    },
    getMemory: (id: number) => {
      const m = byId.get(id);
      return m ? { id: m.id, content: m.content, tags: m.tags ?? [], heat_base: m.heat_base ?? 1.0, created_at: m.created_at } : null;
    },

    getEntityByName: () => null,

    insertMemoryAsync: async (payload: Record<string, unknown>) => {
      calls.inserts.push(payload);
      return nextId++;
    },

    upsertEmbedding: (id: number, emb: Buffer) => {
      calls.embeddingUpserts.push([id, emb]);
    },

    setSupersededByAsync: async (oldId: number, newId: number) => {
      calls.supersededBy.push([oldId, newId]);
    },

    // Merge branch writers (used only when curation returns "merge"). The merge
    // path now mirrors Cortex _do_merge: updateMemoryCompression rewrites content
    // + re-encoded embedding + compression flags (NOT tags), then updateMemoryHeat.
    updateMemoryCompression: (id: number, content: string, emb: Buffer | null, _level: number) => {
      calls.mergedContent.push([id, content]);
      if (emb) calls.embeddingUpserts.push([id, emb]);
    },
    updateMemoryHeatAsync: async (id: number, heat: number) => {
      calls.mergedHeat.push([id, heat]);
    },

    // Entity upsert returns 0 → no linking (keeps the test focused on curation).
    upsertEntityAsync: async () => 0,
  };

  return { store: fake as unknown as MemoryStore, calls };
}

// Mock embedder: any fixed non-empty vector. The fake store's searchVectorsAsync
// controls the distance, so the vector content is irrelevant to the assertions.
const mockEmbedder: WriteEmbedder = {
  encode: async () => [0.5, 0.5, 0.5],
};

// High-overlap base content; the "no longer" variant adds a negation → contradiction.
const BASE = "We use PostgreSQL with pgvector for the memory store and vector search";
const CONTRADICTION = "We no longer use PostgreSQL with pgvector for the memory store and vector search";
const DUPLICATE = "We use PostgreSQL with pgvector for the memory store and vector search backend";

describe("MEM-G1 curation-on-write (rememberAsync)", () => {
  it("supersedes a contradicting near-duplicate (both rows retained, edges stamped)", async () => {
    const { store, calls } = makeFakeStore({
      candidates: [[1, 0.0]], // dist 0 → cosine sim 1.0 ≥ MERGE_THRESHOLD
      seed: [{ id: 1, content: BASE, created_at: "2026-06-01T00:00:00.000Z" }],
      nextId: 2,
    });

    const res = await rememberAsync(
      { content: CONTRADICTION, tags: ["important"] }, // important → gate bypass, force stays false
      store,
      mockEmbedder,
    );

    // Action + response edges
    expect(res.action).toBe("superseded");
    expect(res.memory_id).toBe(2);
    expect(res.merged_with).toBe(1);

    // Forward edge on the NEW row
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]?.["supersedes_id"]).toBe(1);

    // Back-pointer on the OLD row: set_superseded_by(old=1, new=2)
    expect(calls.supersededBy).toEqual([[1, 2]]);

    // Non-destructive: the old content was NOT merged away
    expect(calls.mergedContent).toHaveLength(0);

    // Embedding persisted for the new row so it becomes a future candidate
    expect(calls.embeddingUpserts.map(([id]) => id)).toContain(2);
  });

  it("merges a non-contradicting near-duplicate in place (no new row)", async () => {
    const { store, calls } = makeFakeStore({
      candidates: [[1, 0.0]],
      seed: [{ id: 1, content: BASE, created_at: "2026-06-01T00:00:00.000Z" }],
      nextId: 2,
    });

    const res = await rememberAsync(
      { content: DUPLICATE, tags: ["important"] },
      store,
      mockEmbedder,
    );

    expect(res.action).toBe("merged");
    expect(res.memory_id).toBe(1);
    expect(res.merged_with).toBe(1);
    // Merge folds into the existing row — no insert, no supersede edge.
    expect(calls.inserts).toHaveLength(0);
    expect(calls.supersededBy).toHaveLength(0);
    expect(calls.mergedContent.map(([id]) => id)).toEqual([1]);
    // Faithful _do_merge: the merged content is re-encoded and persisted (the
    // candidate's vector is refreshed, not left stale), and heat is bumped.
    expect(calls.embeddingUpserts.map(([id]) => id)).toContain(1);
    expect(calls.mergedHeat).toHaveLength(1);
  });

  it("creates a new row when there is no near-neighbour", async () => {
    const { store, calls } = makeFakeStore({
      candidates: [], // no candidates → curation returns create
      seed: [],
      nextId: 5,
    });

    const res = await rememberAsync(
      { content: "An entirely novel fact about quantum error correction thresholds", tags: ["important"] },
      store,
      mockEmbedder,
    );

    expect(res.action).toBe("stored");
    expect(res.memory_id).toBe(5);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]?.["supersedes_id"]).toBeUndefined();
    expect(calls.supersededBy).toHaveLength(0);
  });

  it("is a no-op (plain create) when no embedder is wired — byte-identical write", async () => {
    const { store, calls } = makeFakeStore({
      candidates: [[1, 0.0]], // a candidate exists, but no embedder → curation never runs
      seed: [{ id: 1, content: BASE }],
      nextId: 2,
    });

    const res = await rememberAsync(
      { content: CONTRADICTION, tags: ["important"] },
      store,
      // no embedder
    );

    expect(res.action).toBe("stored");
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]?.["supersedes_id"]).toBeUndefined();
    expect(calls.supersededBy).toHaveLength(0);
    expect(calls.embeddingUpserts).toHaveLength(0); // nothing to persist without an embedding
  });
});
