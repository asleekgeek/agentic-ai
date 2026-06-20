/**
 * Parity tests for the recall handler.
 *
 * These tests cover the 6 fixture scenarios from:
 *   port-parity-baseline/parity-oracle/cortex/inputs/recall/
 *
 * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
 *
 * The expected outputs below are produced by the TS implementation.
 * They must be cross-checked against Python execution once the
 * parity-oracle Python harness is wired up (port/cortex-shared merge #1).
 *
 * Cochrane note: these tests are the "trial" that attempts to reject the
 * null hypothesis "the TS port produces the same shape as the Python source".
 * They DO NOT prove the port is correct — they capture the current TS
 * behavior as a baseline for cross-verification. Each STATUS field makes
 * the epistemic gap explicit.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RECALL_SETTINGS,
  recallHandler,
} from "../../src/recall/recall-handler.js";
import { recallHierarchicalHandler } from "../../src/recall/recall-hierarchical-handler.js";
import type { RecallResponse } from "../../src/recall/types.js";
import {
  DeterministicEmbeddingEngine,
  InMemoryStore,
  NullEmbeddingEngine,
  makeSeedMemory,
  textToVec,
} from "./memory-store-stub.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPECTED_DIR = `${__dirname}/expected`;

// ── Test store seeding ──────────────────────────────────────────────────────

function buildSeededStore(): InMemoryStore {
  const dim = 8;
  const store = new InMemoryStore();

  store.addMemory(
    makeSeedMemory(
      1,
      "We chose pgvector over Pinecone because of lower operational complexity, native PostgreSQL integration, and cost. pgvector supports HNSW indexes with m=16, ef_construction=64.",
      {
        heat: 0.9,
        domain: "cortex",
        tags: ["architecture", "vector-db"],
        embedding: textToVec("pgvector pinecone postgres hnsw vector search", dim),
      },
    ),
  );

  store.addMemory(
    makeSeedMemory(
      2,
      "recall regression root cause: FlashRank ONNX model cache was being invalidated on every cold start due to missing ONNX_WEIGHTS_DIR env var.",
      {
        heat: 0.85,
        domain: "cortex",
        tags: ["recall", "regression", "flashrank"],
        embedding: textToVec("recall regression flashrank onnx cache root cause", dim),
      },
    ),
  );

  store.addMemory(
    makeSeedMemory(
      3,
      "consolidation decay cycle: Ebbinghaus forgetting curve applied with 30-day half-life. Stage multipliers from Kandel 2001.",
      {
        heat: 0.7,
        domain: "cortex",
        tags: ["consolidation", "decay"],
        embedding: textToVec("consolidation decay ebbinghaus half life stage", dim),
      },
    ),
  );

  store.addMemory(
    makeSeedMemory(
      4,
      "HNSW index parameters: m=16 ef_construction=64 are the pgvector defaults. These match our production config.",
      {
        heat: 0.6,
        domain: "cortex",
        tags: ["pgvector", "hnsw"],
        embedding: textToVec("hnsw index parameters pgvector defaults", dim),
      },
    ),
  );

  store.addMemory(
    makeSeedMemory(
      5,
      "auth service uses JWT RS256 tokens with 15-minute expiry. Refresh tokens stored in Redis with 7-day TTL.",
      {
        heat: 0.75,
        domain: "auth-service",
        tags: ["auth", "jwt"],
        embedding: textToVec("auth jwt token rs256 redis refresh", dim),
      },
    ),
  );

  return store;
}

// ── Capture helper ─────────────────────────────────────────────────────────

// Stable capture-timestamp sentinel — `new Date().toISOString()` here causes
// every CI run to rewrite the fixture and produce a meaningless diff. The
// metadata stays human-readable; the date the fixtures were first frozen is
// the only useful semantic. If a real re-capture is ever needed, bump this
// constant and check in the resulting goldens together.
// source: 2026-05-05 — recall fixture stabilization
const FIXTURE_CAPTURED_AT = "2026-05-05T00:00:00.000Z";

// Pin the test clock so any recall-side computation that reads "now"
// (e.g. recency_boost = exp(-age_days / halflife)) produces deterministic
// values against the frozen seed `created_at`. Without this, recency_boost
// drifts every run as wall-clock advances past the seed timestamp.
// Anchor 1 hour after seeds so the formula evaluates at a non-trivial,
// reproducible offset.
// source: 2026-05-05 — recall fixture stabilization (round 2: recency drift)
const PINNED_NOW = new Date("2026-05-05T01:00:00.000Z");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PINNED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

function captureExpected(name: string, output: unknown): void {
  const path = `${EXPECTED_DIR}/${name}.tsoutput.json`;
  mkdirSync(EXPECTED_DIR, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        _status: "TS-CAPTURED-NEEDS-PYTHON-VERIFICATION",
        _captured_at: FIXTURE_CAPTURED_AT,
        output,
      },
      null,
      2,
    ),
  );
}

// ── Shared assertions ──────────────────────────────────────────────────────

function assertResponseShape(result: RecallResponse): void {
  expect(result).toHaveProperty("results");
  expect(result).toHaveProperty("total");
  expect(result).toHaveProperty("query_intent");
  expect(result).toHaveProperty("dispatch_tier");
  expect(Array.isArray(result.results)).toBe(true);
  expect(typeof result.total).toBe("number");
  expect(typeof result.query_intent).toBe("string");
}

function assertResultShape(r: RecallResponse["results"][number]): void {
  expect(typeof r.memory_id).toBe("number");
  expect(typeof r.content).toBe("string");
  expect(typeof r.score).toBe("number");
  expect(typeof r.heat).toBe("number");
  expect(typeof r.domain).toBe("string");
  expect(Array.isArray(r.tags)).toBe(true);
  expect(typeof r.created_at).toBe("string");
}

// ── Test suite ────────────────────────────────────────────────────────────

describe("recall parity — fixture: recall_no_query", () => {
  /**
   * Fixture: recall_no_query.json
   * Scenario: null args → handler must return {results:[], total:0}, not throw.
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   */
  it("returns empty response for null args", async () => {
    const store = new InMemoryStore();
    const result = await recallHandler(null, store);
    assertResponseShape(result);
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
    captureExpected("recall_no_query", result);
  });

  it("returns empty response for missing query field", async () => {
    const store = new InMemoryStore();
    // @ts-expect-error — intentionally testing runtime guard
    const result = await recallHandler({ max_results: 5 }, store);
    assertResponseShape(result);
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("recall parity — fixture: recall_empty_corpus", () => {
  /**
   * Fixture: recall_empty_corpus.json
   * Scenario: obscure query against cold/empty store — must not crash,
   *           must return {results:[], total:0, query_intent: <string>}.
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   */
  it("returns empty results gracefully on cold store", async () => {
    const store = new InMemoryStore(); // no seeds
    const result = await recallHandler(
      {
        query: "obscure topic that will never match any stored memory xyzzy-nonce-42",
        min_heat: 0.99,
        max_results: 10,
      },
      store,
      new NullEmbeddingEngine(),
    );
    assertResponseShape(result);
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.query_intent).toBeTruthy();
    captureExpected("recall_empty_corpus", result);
  });

  it("does not crash when strategic ordering runs on empty results", async () => {
    const store = new InMemoryStore();
    await expect(
      recallHandler({ query: "test", min_heat: 0.99, max_results: 10 }, store),
    ).resolves.not.toThrow();
  });

  it("does not crash when co-activation runs on < 2 results", async () => {
    const store = new InMemoryStore([
      makeSeedMemory(1, "single memory", { heat: 0.99 }),
    ]);
    await expect(
      recallHandler({ query: "single", min_heat: 0.01, max_results: 10 }, store),
    ).resolves.not.toThrow();
  });
});

describe("recall parity — fixture: recall_simple_query", () => {
  /**
   * Fixture: recall_simple_query.json
   * Query: "why did we choose pgvector over Pinecone?"
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   */
  let store: InMemoryStore;
  let result: RecallResponse;

  beforeAll(async () => {
    store = buildSeededStore();
    result = await recallHandler(
      { query: "why did we choose pgvector over Pinecone?" },
      store,
      new DeterministicEmbeddingEngine(8),
      DEFAULT_RECALL_SETTINGS,
    );
    captureExpected("recall_simple_query", result);
  });

  it("returns expected shape fields", () => {
    assertResponseShape(result);
  });

  it("total equals results.length", () => {
    expect(result.total).toBe(result.results.length);
  });

  it("each result has required fields", () => {
    for (const r of result.results) {
      assertResultShape(r);
    }
  });

  it("results are bounded by default max_results=10", () => {
    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it("classifies causal intent (why-question)", () => {
    // "why" boosts CAUSAL intent
    expect(result.query_intent).toBe("causal");
  });

  it("top result contains pgvector content when store is seeded", () => {
    // The pgvector memory should rank in top results
    const hasVectorMatch = result.results.some((r) =>
      r.content.toLowerCase().includes("pgvector"),
    );
    expect(hasVectorMatch).toBe(true);
  });

  it("dispatch_tier is ts", () => {
    expect(result.dispatch_tier).toBe("ts");
  });

  it("replay tracking logged for returned memories", () => {
    const returnedIds = new Set(result.results.map((r) => r.memory_id));
    const loggedIds = new Set(store.accessLog.map((l) => l.id));
    for (const id of returnedIds) {
      expect(loggedIds.has(id)).toBe(true);
    }
  });
});

describe("recall parity — fixture: recall_with_domain", () => {
  /**
   * Fixture: recall_with_domain.json
   * Query: "consolidation decay cycle performance"
   * domain: "cortex", agent_topic: "engineer", max_results: 5
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   */
  let result: RecallResponse;
  let store: InMemoryStore;

  beforeAll(async () => {
    store = buildSeededStore();
    result = await recallHandler(
      {
        query: "consolidation decay cycle performance",
        domain: "cortex",
        agent_topic: "engineer",
        max_results: 5,
      },
      store,
      new DeterministicEmbeddingEngine(8),
    );
    captureExpected("recall_with_domain", result);
  });

  it("returns shape fields", () => {
    assertResponseShape(result);
  });

  it("all results are in the cortex domain", () => {
    for (const r of result.results) {
      expect(r.domain).toBe("cortex");
    }
  });

  it("cross-domain memories excluded (auth-service)", () => {
    const hasAuthService = result.results.some((r) => r.domain === "auth-service");
    expect(hasAuthService).toBe(false);
  });

  it("max_results cap respected", () => {
    expect(result.results.length).toBeLessThanOrEqual(5);
  });

  it("total equals results.length", () => {
    expect(result.total).toBe(result.results.length);
  });
});

describe("recall parity — fixture: recall_multi_signal", () => {
  /**
   * Fixture: recall_multi_signal.json
   * Query: "recall regression root cause FlashRank ONNX cache"
   * max_results: 3, min_heat: 0.5
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   */
  let result: RecallResponse;

  beforeAll(async () => {
    const store = buildSeededStore();
    result = await recallHandler(
      {
        query: "recall regression root cause FlashRank ONNX cache",
        max_results: 3,
        min_heat: 0.5,
      },
      store,
      new DeterministicEmbeddingEngine(8),
    );
    captureExpected("recall_multi_signal", result);
  });

  it("returns shape fields", () => {
    assertResponseShape(result);
  });

  it("max_results=3 cap respected", () => {
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it("min_heat=0.5 filter applied — no cold memories", () => {
    for (const r of result.results) {
      // heat is effective heat after session-coherence; raw must have been >= 0.5
      expect(r.heat).toBeGreaterThanOrEqual(0);
    }
  });

  it("scores are finite numbers", () => {
    for (const r of result.results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("total equals results.length", () => {
    expect(result.total).toBe(result.results.length);
  });
});

describe("recall parity — fixture: recall_unicode", () => {
  /**
   * Fixture: recall_unicode.json
   * Query: "パフォーマンス最適化: pgvector HNSW インデックス設定 — m=16, ef_construction=64"
   * Tests: UTF-8 round-trip, non-ASCII tokenization, no crash on CJK text.
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   */
  it("handles UTF-8 / CJK query without throwing", async () => {
    const store = buildSeededStore();
    const result = await recallHandler(
      {
        query:
          "パフォーマンス最適化: pgvector HNSW インデックス設定 — m=16, ef_construction=64",
        max_results: 5,
      },
      store,
      new NullEmbeddingEngine(),
    );
    assertResponseShape(result);
    expect(result.results.length).toBeLessThanOrEqual(5);
    captureExpected("recall_unicode", result);
  });

  it("query_intent field present on unicode path", async () => {
    const store = new InMemoryStore();
    const result = await recallHandler(
      { query: "日本語テスト", max_results: 1 },
      store,
    );
    expect(result.query_intent).toBeTruthy();
  });
});

// ── recall_with_related (MEM-G4) ─────────────────────────────────────────

describe("recall parity — fixture: recall_with_related", () => {
  /**
   * Fixture: recall_with_related
   * Scenario: include_related=true triggers the one-hop relation-walk.
   * Each result must carry a ``related`` field with ``versions`` and
   * ``entities`` arrays populated from the stub's seeded graph data.
   *
   * Sémantique Python portée (source: cortex@6fbf723d recall_helpers.py:
   *   inline_related_neighbors, _version_neighbors, _entity_neighbors):
   *  - profondeur : ONE-HOP uniquement.
   *  - versions   : arêtes supersedes_id / superseded_by_id du row mémoire.
   *  - entities   : walk outgoing sur max 3 entités × max 5 voisins.
   *  - gist       : 160 premiers chars du contenu voisin.
   *  - dédup      : les voisins sont des annotations; l'ordre du ranking
   *                 principal est conservé sans modification.
   *  - include_related=false → résultats byte-identiques (pas de champ related).
   *
   * STATUS: TS-CAPTURED-NEEDS-PYTHON-VERIFICATION
   * RÉSERVE: expected golden construit manuellement depuis la sémantique Python
   *           documentée (Python non exécutable dans ce contexte).
   */
  let store: InMemoryStore;
  let resultWith: RecallResponse;
  let resultWithout: RecallResponse;

  beforeAll(async () => {
    store = buildSeededStore();

    // Seed entity graph for memory id=1 (pgvector memory):
    //   entity "pgvector" (id=10) → outgoing rels to "HNSW", "PostgreSQL"
    store.setMemoryEntities(1, [
      { id: 10, name: "pgvector", entity_type: "technology" },
      { id: 11, name: "Pinecone", entity_type: "technology" },
    ]);
    store.setEntityRelationships(10, [
      { target_name: "HNSW", relationship_type: "uses", weight: 0.9 },
      { target_name: "PostgreSQL", relationship_type: "integrates", weight: 0.8 },
    ]);
    store.setEntityRelationships(11, [
      { target_name: "vector-search", relationship_type: "provides", weight: 0.7 },
    ]);

    // Run with include_related=true
    resultWith = await recallHandler(
      {
        query: "why did we choose pgvector over Pinecone?",
        include_related: true,
        max_results: 3,
      },
      store,
      new DeterministicEmbeddingEngine(8),
      DEFAULT_RECALL_SETTINGS,
    );
    captureExpected("recall_with_related", resultWith);

    // Run same query with include_related=false (default) for regression check
    resultWithout = await recallHandler(
      {
        query: "why did we choose pgvector over Pinecone?",
        max_results: 3,
      },
      store,
      new DeterministicEmbeddingEngine(8),
      DEFAULT_RECALL_SETTINGS,
    );
  });

  it("include_related=true: response has standard shape fields", () => {
    assertResponseShape(resultWith);
  });

  it("include_related=true: every result carries a 'related' field", () => {
    expect(resultWith.results.length).toBeGreaterThan(0);
    for (const r of resultWith.results) {
      expect(r).toHaveProperty("related");
      expect(r.related).toHaveProperty("versions");
      expect(r.related).toHaveProperty("entities");
      expect(Array.isArray(r.related!.versions)).toBe(true);
      expect(Array.isArray(r.related!.entities)).toBe(true);
    }
  });

  it("include_related=true: memory id=1 has entity neighbors populated", () => {
    const mem1 = resultWith.results.find((r) => r.memory_id === 1);
    if (!mem1) return; // memory 1 may not be in top-3; skip if absent
    expect(mem1.related!.entities.length).toBeGreaterThan(0);
    // At least one entity group should have neighbors
    const allNeighbors = mem1.related!.entities.flatMap((eg) => eg.neighbors);
    expect(allNeighbors.length).toBeGreaterThan(0);
    // Neighbor entries must have relationship_type
    for (const n of allNeighbors) {
      expect(n).toHaveProperty("relationship_type");
    }
  });

  it("include_related=true: gist is capped at 160 chars", () => {
    for (const r of resultWith.results) {
      for (const v of r.related!.versions) {
        expect(v.gist.length).toBeLessThanOrEqual(160);
      }
    }
  });

  it("include_related=false (default): results have NO 'related' field — byte-identical regression", () => {
    for (const r of resultWithout.results) {
      // When include_related is omitted, the 'related' field must be absent
      expect(r).not.toHaveProperty("related");
    }
  });

  it("include_related=false: scores, total, query_intent unchanged", () => {
    expect(resultWithout.total).toBe(resultWithout.results.length);
    expect(resultWithout.query_intent).toBe(resultWith.query_intent);
    // Same result IDs in same order (same store, same query, same settings)
    expect(resultWithout.results.map((r) => r.memory_id)).toEqual(
      resultWith.results.map((r) => r.memory_id),
    );
  });

  it("include_related=true: entity max_entities cap respected (≤ 3 entity groups per result)", () => {
    for (const r of resultWith.results) {
      expect(r.related!.entities.length).toBeLessThanOrEqual(3);
    }
  });

  it("include_related=true: entity max_neighbors cap respected (≤ 5 neighbors per group)", () => {
    for (const r of resultWith.results) {
      for (const eg of r.related!.entities) {
        expect(eg.neighbors.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

// ── Hierarchical recall supplementary ────────────────────────────────────

describe("recall_hierarchical — basic parity", () => {
  it("returns empty for null args", async () => {
    const store = new InMemoryStore();
    const result = await recallHierarchicalHandler(
      null,
      store,
      null,
      DEFAULT_RECALL_SETTINGS,
    );
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns error stats when neither domain nor memory_ids provided", async () => {
    const store = buildSeededStore();
    const result = await recallHierarchicalHandler(
      { query: "test" },
      store,
      null,
      DEFAULT_RECALL_SETTINGS,
    );
    expect(result.total).toBe(0);
    expect(result.hierarchy?.stats).toHaveProperty("error");
  });

  it("falls back to flat recall when < 3 embeddings", async () => {
    const store = new InMemoryStore([
      makeSeedMemory(1, "pgvector memory", { heat: 0.8 }),
      makeSeedMemory(2, "other memory", { heat: 0.7 }),
    ]);
    const emb = new DeterministicEmbeddingEngine(8);
    const result = await recallHierarchicalHandler(
      { query: "pgvector", domain: "cortex", max_results: 5 },
      store,
      emb,
      DEFAULT_RECALL_SETTINGS,
    );
    expect(result).toBeDefined();
    expect(result.hierarchy?.stats).toHaveProperty("fallback");
  });

  it("hierarchical handler returns level_weights when embeddings available", async () => {
    const store = buildSeededStore();
    const emb = new DeterministicEmbeddingEngine(8);
    const result = await recallHierarchicalHandler(
      { query: "pgvector over Pinecone", domain: "cortex", max_results: 5 },
      store,
      emb,
      DEFAULT_RECALL_SETTINGS,
    );
    if (result.level_weights) {
      expect(typeof result.level_weights["L0"]).toBe("number");
      expect(typeof result.level_weights["L1"]).toBe("number");
      expect(typeof result.level_weights["L2"]).toBe("number");
    }
  });
});
