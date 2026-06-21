/**
 * Tests for the entity deduplication engine.
 *
 * Port of: cortex bc5af469 tests_py/core/test_entity_dedup.py
 *
 * Tests assert merge DECISIONS (pass/fail), not exact numeric coefficient
 * values (which differ because the TS port uses splitmix64, not numpy MT19937).
 * Jaro-Winkler scores from the Python oracle are reproduced faithfully because
 * both sides use the same JW algorithm.
 */

import { describe, it, expect } from "vitest";
import {
  deduplicateEntities,
  type DedupResult,
  type EntityInput,
} from "../../../src/consolidation/entity-merge/entity-dedup.js";
import {
  affixesSandwichDifference,
  isAffixExtension,
  isStructuralIdentifier,
  isVariantPair,
  normalizeLabel,
  sharedPrefixMasksDifference,
} from "../../../src/consolidation/entity-merge/entity-dedup-filters.js";

// ── helper ────────────────────────────────────────────────────────────────────

function ent(
  name: string,
  type: string = "technology",
  extra: Partial<EntityInput> = {},
): EntityInput {
  return { name, type, ...extra };
}

// ── TestPassthrough ───────────────────────────────────────────────────────────

describe("TestPassthrough", () => {
  it("test_empty", () => {
    const r: DedupResult = deduplicateEntities([]);
    expect(r.remap).toEqual({});
    expect(r.survivors).toEqual([]);
  });

  it("test_single", () => {
    const r = deduplicateEntities([ent("PostgreSQL")]);
    expect(r.remap).toEqual({});
    expect(r.survivors).toHaveLength(1);
  });

  it("test_no_duplicates", () => {
    const r = deduplicateEntities([ent("PostgreSQL"), ent("Redis"), ent("Kafka")]);
    expect(r.remap).toEqual({});
    expect(r.survivors).toHaveLength(3);
  });
});

// ── TestExactNormPass ─────────────────────────────────────────────────────────

describe("TestExactNormPass", () => {
  it("test_punctuation_and_space_variants_merge", () => {
    const ents = [
      ent("Embedding Engine"),
      ent("embedding-engine"),
      ent("EMBEDDING_ENGINE"),
    ];
    const r = deduplicateEntities(ents);
    // All three normalize to "embedding engine" → one survivor.
    expect(r.survivors).toHaveLength(1);
    expect(Object.keys(r.remap)).toHaveLength(2);
  });

  it("test_distinct_normals_not_merged", () => {
    const r = deduplicateEntities([ent("Embedding Engine"), ent("Vector Store")]);
    expect(r.remap).toEqual({});
  });
});

// ── TestFuzzyPass ─────────────────────────────────────────────────────────────

describe("TestFuzzyPass", () => {
  it("test_spacing_variant_merges_across_norm_boundary", () => {
    // "EmbeddingEngine" (no space) and "Embedding Engine" have different
    // exact-norms but share all space-stripped shingles → fuzzy merge.
    const ents = [ent("EmbeddingEngine"), ent("Embedding Engine")];
    const r = deduplicateEntities(ents);
    expect(r.survivors).toHaveLength(1);
    expect(r.merges.length).toBeGreaterThanOrEqual(1);
    expect(r.merges.some((m) => m.reason === "jaro-winkler")).toBe(true);
  });

  it("test_merge_score_is_float_in_unit_interval", () => {
    const r = deduplicateEntities([ent("EmbeddingEngine"), ent("Embedding Engine")]);
    for (const m of r.merges) {
      expect(typeof m.score).toBe("number");
      expect(m.score).toBeGreaterThanOrEqual(0.0);
      expect(m.score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ── TestBlockers ──────────────────────────────────────────────────────────────

describe("TestBlockers", () => {
  it("test_affix_extension_not_merged", () => {
    // parseConfig vs parseConfigFile — strict prefix-extension, never merged.
    const ents = [ent("parseConfigStage"), ent("parseConfigStageFile")];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });

  it("test_affix_extension_predicate", () => {
    // Prefix containment.
    expect(isAffixExtension("parseconfig", "parseconfigfile")).toBe(true);
    // Suffix containment (the benchmark's PgMemoryStore ~ MemoryStore FP).
    expect(isAffixExtension("memorystore", "pgmemorystore")).toBe(true);
    expect(isAffixExtension("parseconfig", "parseconfar")).toBe(false);
  });

  it("test_suffix_containment_not_merged", () => {
    // Regression: concrete class vs its abstraction must not merge.
    const ents = [ent("PgMemoryStore"), ent("MemoryStore")];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });

  it("test_variant_pair_predicate", () => {
    // SKU/version siblings: same stem, different trailing version token.
    expect(isVariantPair("asr1603", "asr1604")).toBe(true);
    expect(isVariantPair("m1", "m2")).toBe(true);
    expect(isVariantPair("cranel", "cranel")).toBe(false);
    // Prefix-extensions are NOT variants (caught by the suffix blocker).
    expect(isVariantPair("cranel", "cranelr")).toBe(false);
  });
});

// ── TestStructuralIdentifierExemption ─────────────────────────────────────────

describe("TestStructuralIdentifierExemption", () => {
  it("test_predicate", () => {
    expect(isStructuralIdentifier("mcp_server.core.engram")).toBe(true);
    expect(isStructuralIdentifier("benchmarks/lib/bench_db")).toBe(true);
    expect(isStructuralIdentifier("Node.js")).toBe(false); // single dot = concept
    expect(isStructuralIdentifier("EmbeddingEngine")).toBe(false);
  });

  it("test_distinct_module_paths_not_merged", () => {
    // mcp_server.core.engram ~ mcp_server.core.replay scored 0.935 on JW;
    // they are distinct modules and must never merge.
    const ents = [
      ent("mcp_server.core.engram"),
      ent("mcp_server.core.replay"),
      ent("mcp_server.core.codebase_graph"),
    ];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });
});

// ── TestAffixSandwichGuard ────────────────────────────────────────────────────

describe("TestAffixSandwichGuard", () => {
  it("test_blocks_glued_camelcase_middle", () => {
    // The benchmark's residual FP: distinct test classes (glued CamelCase),
    // shared prefix "test" + suffix "classification", middle store/core.
    expect(
      affixesSandwichDifference(
        "teststoreclassification",
        "testcoreclassification",
      ),
    ).toBe(true);
  });

  it("test_allows_empty_middle", () => {
    // One middle empty (affix-only difference) → not blocked.
    expect(
      affixesSandwichDifference("embeddingengine", "embedding engine"),
    ).toBe(false);
  });

  it("test_allows_similar_middle", () => {
    // Middles themselves similar (typo) → not blocked.
    expect(affixesSandwichDifference("xx stor yy", "xx store yy")).toBe(false);
  });

  it("test_distinct_test_classes_not_merged", () => {
    const ents = [ent("TestStoreClassification"), ent("TestCoreClassification")];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });
});

// ── TestSharedPrefixGuard ─────────────────────────────────────────────────────

describe("TestSharedPrefixGuard", () => {
  it("test_predicate_blocks_dominant_prefix_with_different_tails", () => {
    // Long shared prefix, dissimilar remainders → masked difference.
    expect(
      sharedPrefixMasksDifference(
        "mcp server core engram",
        "mcp server core replay",
      ),
    ).toBe(true);
  });

  it("test_predicate_allows_similar_tails", () => {
    // Shared prefix but near-identical tails → not masked.
    expect(
      sharedPrefixMasksDifference("embedding engine", "embedding engin"),
    ).toBe(false);
  });

  it("test_predicate_ignores_short_common_prefix", () => {
    expect(sharedPrefixMasksDifference("alpha", "beta")).toBe(false);
  });
});

// ── TestTypeScoping ───────────────────────────────────────────────────────────

describe("TestTypeScoping", () => {
  it("test_different_types_not_merged", () => {
    // Same name, different type → different buckets → never compared.
    const ents = [
      ent("TensorFlowKit", "technology"),
      ent("TensorFlowKit", "dependency"),
    ];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });

  it("test_code_symbols_exempt", () => {
    // function/class types are not fuzzy-eligible.
    const ents = [
      ent("renderFrame", "function"),
      ent("render Frame", "function"),
    ];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });

  it("test_ast_origin_exempt", () => {
    // origin='ast_symbol' is exempt even for a fuzzy-eligible type + name.
    const ents = [
      ent("Embedding Engine", "technology", { origin: "ast_symbol" }),
      ent("EmbeddingEngine", "technology", { origin: "ast_symbol" }),
    ];
    const r = deduplicateEntities(ents);
    expect(r.remap).toEqual({});
  });

  it("test_text_origin_merges", () => {
    // Same pair with origin='text_concept' merges as before.
    const ents = [
      ent("Embedding Engine", "technology", { origin: "text_concept" }),
      ent("EmbeddingEngine", "technology", { origin: "text_concept" }),
    ];
    const r = deduplicateEntities(ents);
    expect(r.survivors).toHaveLength(1);
  });
});

// ── TestWinnerSelection ───────────────────────────────────────────────────────

describe("TestWinnerSelection", () => {
  it("test_most_mentioned_survives", () => {
    const ents = [
      ent("Embedding Engine", "technology", { mention_count: 2, heat: 0.3 }),
      ent("embedding engine", "technology", { mention_count: 9, heat: 0.1 }),
    ];
    const r = deduplicateEntities(ents);
    expect(r.survivors).toHaveLength(1);
    expect(r.survivors[0]?.mention_count).toBe(9);
  });

  it("test_remap_points_alias_to_winner", () => {
    const ents = [
      ent("Embedding Engine", "technology", { id: 1, mention_count: 2 }),
      ent("embedding-engine", "technology", { id: 2, mention_count: 9 }),
    ];
    const r = deduplicateEntities(ents);
    // id=2 is the more-mentioned winner; id=1 remaps to it.
    expect(r.remap).toEqual({ "1": "2" });
  });
});

// ── TestNormalize ─────────────────────────────────────────────────────────────

describe("TestNormalize", () => {
  it("test_normalize_label", () => {
    expect(normalizeLabel("Embedding-Engine")).toBe("embedding engine");
    expect(normalizeLabel("  HTTP_Client  ")).toBe("http client");
    expect(normalizeLabel(null)).toBe("");
  });
});
