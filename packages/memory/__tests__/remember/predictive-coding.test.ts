/**
 * predictive-coding.test.ts — Unit tests for pure novelty functions.
 *
 * These are the primary correctness argument for the write gate —
 * pure functions with deterministic outputs.
 *
 * Each test is a local proof of the function's contract:
 * "given these inputs, the invariant holds."
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeEmbeddingNovelty,
  computeEntityNovelty,
  computeNoveltyScore,
  computeStructuralNovelty,
  computeTemporalNovelty,
  describeSignals,
  gateDecision,
} from "../../src/remember/predictive-coding.js";
import {
  isHierarchicalGateEnabled,
  scoreCandidate,
} from "../../src/remember/write-gate.js";

describe("computeEmbeddingNovelty", () => {
  it("returns 0.5 for empty similarities (prior: uncertain)", () => {
    expect(computeEmbeddingNovelty([])).toBe(0.5);
  });

  it("returns 0.0 when the most similar memory is identical", () => {
    // postcondition: 1 - max([1.0]) = 0.0
    expect(computeEmbeddingNovelty([1.0])).toBe(0.0);
  });

  it("returns close to 1.0 when no similar memory exists", () => {
    // postcondition: 1 - max([0.01]) = 0.99
    expect(computeEmbeddingNovelty([0.01])).toBeCloseTo(0.99);
  });

  it("uses max of multiple similarities", () => {
    expect(computeEmbeddingNovelty([0.2, 0.8, 0.5])).toBeCloseTo(0.2);
  });

  it("clamps output to [0, 1]", () => {
    const v = computeEmbeddingNovelty([1.5]); // over-similarity
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("computeEntityNovelty", () => {
  it("returns 0.5 for empty entity list (prior: uncertain)", () => {
    expect(computeEntityNovelty([], new Set())).toBe(0.5);
  });

  it("returns 1.0 when all entities are new", () => {
    expect(computeEntityNovelty(["X", "Y"], new Set())).toBe(1.0);
  });

  it("returns 0.0 when all entities are known", () => {
    expect(computeEntityNovelty(["X", "Y"], new Set(["X", "Y"]))).toBe(0.0);
  });

  it("returns 0.5 when half are new", () => {
    expect(computeEntityNovelty(["X", "Y"], new Set(["X"]))).toBe(0.5);
  });
});

describe("computeTemporalNovelty", () => {
  it("returns 0.8 for null (no similar memory found)", () => {
    expect(computeTemporalNovelty(null)).toBe(0.8);
  });

  it("returns 0.0 for 0 hours (memory just written)", () => {
    expect(computeTemporalNovelty(0)).toBe(0.0);
  });

  it("returns exactly 1-exp(-1) for 24 hours", () => {
    const expected = 1 - Math.exp(-1);
    expect(computeTemporalNovelty(24)).toBeCloseTo(expected, 5);
  });

  it("approaches 1.0 for very long intervals", () => {
    expect(computeTemporalNovelty(10000)).toBeCloseTo(1.0, 3);
  });

  it("clamps to [0, 1]", () => {
    const v = computeTemporalNovelty(-1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("computeStructuralNovelty", () => {
  it("returns 0.7 for empty recent contents (prior)", () => {
    expect(computeStructuralNovelty("some content", [])).toBe(0.7);
  });

  it("returns 0.0 for structurally identical content", () => {
    const c = "short";
    expect(computeStructuralNovelty(c, [c])).toBe(0.0);
  });

  it("returns > 0 for structurally different content", () => {
    const candidate = "# Heading\n```\ncode\n```\n- list item";
    const recent = ["short text without structure"];
    expect(computeStructuralNovelty(candidate, recent)).toBeGreaterThan(0);
  });
});

describe("computeNoveltyScore", () => {
  it("satisfies the weight invariant: weights sum to 1.0", () => {
    // 0.4 + 0.25 + 0.2 + 0.15 = 1.0 (convex combination)
    // A uniform input of x should produce score = x.
    const x = 0.6;
    expect(computeNoveltyScore(x, x, x, x)).toBeCloseTo(x, 5);
  });

  it("returns 0.0 for all-zero inputs", () => {
    expect(computeNoveltyScore(0, 0, 0, 0)).toBe(0.0);
  });

  it("returns 1.0 for all-one inputs", () => {
    expect(computeNoveltyScore(1, 1, 1, 1)).toBe(1.0);
  });

  it("weights embedding novelty most heavily (0.40)", () => {
    // Only embedding novelty = 1, rest = 0 → score = 0.40
    expect(computeNoveltyScore(1, 0, 0, 0)).toBeCloseTo(0.40, 5);
  });
});

describe("gateDecision", () => {
  it("returns (true, 'bypass') when bypass=true regardless of score", () => {
    const [ok, reason] = gateDecision(0, 0.9, true);
    expect(ok).toBe(true);
    expect(reason).toBe("bypass");
  });

  it("returns (true, 'high_novelty') when score >= threshold", () => {
    const [ok, reason] = gateDecision(0.5, 0.4, false);
    expect(ok).toBe(true);
    expect(reason).toBe("high_novelty");
  });

  it("returns (false, ...) when score < threshold", () => {
    const [ok, reason] = gateDecision(0.3, 0.4, false);
    expect(ok).toBe(false);
    expect(reason).toContain("below_threshold");
  });

  it("includes threshold in rejection reason", () => {
    const [, reason] = gateDecision(0.1, 0.4, false);
    expect(reason).toContain("0.4");
  });
});

describe("describeSignals", () => {
  it("rounds all values to 4 decimal places", () => {
    const result = describeSignals(0.12345, 0.6789, 0.33333, 0.11111, 0.55555);
    expect(result["embedding_novelty"]).toBe(0.1235);
    expect(result["combined_novelty"]).toBe(0.5556);
  });

  it("includes all five keys", () => {
    const result = describeSignals(0.1, 0.2, 0.3, 0.4, 0.5);
    expect(Object.keys(result)).toHaveLength(5);
  });
});

// ── MEM-G5: gate dispatch parity tests ─────────────────────────────────────
//
// These tests verify that:
// 1. isHierarchicalGateEnabled() reads the env flag correctly.
// 2. With flag absent, scoreCandidate produces the flat gate decision.
// 3. With flag present, scoreCandidate routes to the hierarchical gate
//    and produces a distinct decision on a case that differs between the two.
//
// source: MEM-G5 task specification, PARITY_PLAN §3

describe("isHierarchicalGateEnabled (MEM-G5)", () => {
  afterEach(() => {
    delete process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"];
  });

  it("returns false when env var is absent", () => {
    delete process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"];
    expect(isHierarchicalGateEnabled()).toBe(false);
  });

  it("returns true for '1'", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "1";
    expect(isHierarchicalGateEnabled()).toBe(true);
  });

  it("returns true for 'true'", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "true";
    expect(isHierarchicalGateEnabled()).toBe(true);
  });

  it("returns true for 'yes'", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "yes";
    expect(isHierarchicalGateEnabled()).toBe(true);
  });

  it("returns true for 'on'", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "on";
    expect(isHierarchicalGateEnabled()).toBe(true);
  });

  it("returns false for empty string", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "";
    expect(isHierarchicalGateEnabled()).toBe(false);
  });

  it("returns false for '0'", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "0";
    expect(isHierarchicalGateEnabled()).toBe(false);
  });
});

describe("scoreCandidate gate dispatch (MEM-G5)", () => {
  // A low-novelty input that the flat gate (threshold=0.4) will REJECT
  // because combinedNovelty will be low (high similarities → low embeddingNovelty,
  // all entities known → entityNovelty=0, recently written → temporalNovelty=0,
  // structurally identical → structuralNovelty=0).
  // Combined = 0.4*0 + 0.25*0 + 0.2*0 + 0.15*0 = 0.0 < 0.4 → flat rejects.
  //
  // The hierarchical gate uses free-energy (DEFAULT_HIERARCHICAL_THRESHOLD=0.15).
  // With all-zero novelty, sensory FE will be non-trivial (sensory features
  // against default prior), potentially above 0.15, so the two gates may
  // diverge — confirming independent paths.
  //
  // source: predictive_coding_gate.py:hierarchical_gate_decision (threshold=0.15)
  // source: write_gate.py:DEFAULT_HIERARCHICAL_THRESHOLD
  const lowNoveltyInput = {
    content: "short",
    tags: [],
    force: false,
    similarities: [0.99, 0.98, 0.97], // very similar to existing memories
    newEntityNames: ["Known"],
    knownEntityNames: new Set(["Known"]),
    recentContents: ["short"],          // structurally identical
    hoursSinceSimilar: 0,               // just written
    threshold: 0.4,
  };

  beforeEach(() => {
    delete process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"];
  });
  afterEach(() => {
    delete process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"];
  });

  it("flat gate (flag absent): rejects low-novelty candidate", () => {
    const score = scoreCandidate(lowNoveltyInput);
    // combinedNovelty = 0.4*(1-0.99) + 0.25*0 + 0.2*0 + 0.15*0 = 0.004 < 0.4
    expect(score.combinedNovelty).toBeLessThan(0.4);
    expect(score.shouldStore).toBe(false);
    expect(score.gateReason).toContain("below_threshold");
  });

  it("flat gate (flag absent): byte-identical result with flag explicitly absent", () => {
    delete process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"];
    const score1 = scoreCandidate(lowNoveltyInput);
    // Run again to confirm determinism (pure function invariant)
    const score2 = scoreCandidate(lowNoveltyInput);
    expect(score1.shouldStore).toBe(score2.shouldStore);
    expect(score1.gateReason).toBe(score2.gateReason);
    expect(score1.combinedNovelty).toBe(score2.combinedNovelty);
  });

  it("hierarchical gate (flag set): routes to hierarchical path, gateReason is distinct", () => {
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "1";
    const score = scoreCandidate(lowNoveltyInput);
    // The hierarchical gate reason always starts with 'high_free_energy' or
    // 'low_free_energy' — never 'below_threshold' or 'high_novelty'.
    expect(score.gateReason).not.toContain("below_threshold");
    expect(score.gateReason).not.toBe("high_novelty");
    expect(
      score.gateReason.startsWith("high_free_energy") ||
      score.gateReason.startsWith("low_free_energy") ||
      score.gateReason === "bypass",
    ).toBe(true);
  });

  it("bypass=true forces shouldStore=true on both gates", () => {
    const forced = { ...lowNoveltyInput, force: true };

    // Flat gate
    delete process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"];
    const flatScore = scoreCandidate(forced);
    expect(flatScore.shouldStore).toBe(true);
    expect(flatScore.gateReason).toBe("bypass");

    // Hierarchical gate
    process.env["CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL"] = "1";
    const hierScore = scoreCandidate(forced);
    expect(hierScore.shouldStore).toBe(true);
    expect(hierScore.gateReason).toBe("bypass");
  });
});
