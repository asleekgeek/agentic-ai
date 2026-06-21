/**
 * Tests for packages/memory/src/shared/string-distance.ts
 *
 * Port of: cortex bc5af469 tests_py/shared/test_string_distance.py
 *
 * Reference values for Jaro / Jaro-Winkler are the canonical literature
 * examples (Winkler 1990 and the standard record-linkage test set).
 * toBeCloseTo(value, 4) mirrors Python math.isclose(abs_tol=1e-4).
 */

import { describe, it, expect } from "vitest";
import {
  jaroSimilarity,
  jaroWinklerSimilarity,
  osaDistance,
} from "../../src/shared/string-distance.js";

describe("jaroSimilarity", () => {
  it("canonical values", () => {
    // 0.9444, 0.8222, 0.7667 — Winkler 1990 standard record-linkage test set
    expect(jaroSimilarity("MARTHA", "MARHTA")).toBeCloseTo(0.9444, 4);
    expect(jaroSimilarity("DWAYNE", "DUANE")).toBeCloseTo(0.8222, 4);
    expect(jaroSimilarity("DIXON", "DICKSONX")).toBeCloseTo(0.7667, 4);
  });

  it("identical strings", () => {
    expect(jaroSimilarity("postgres", "postgres")).toBe(1.0);
  });

  it("disjoint strings", () => {
    expect(jaroSimilarity("abc", "xyz")).toBe(0.0);
  });

  it("empty strings", () => {
    expect(jaroSimilarity("", "x")).toBe(0.0);
    expect(jaroSimilarity("", "")).toBe(1.0);
  });
});

describe("jaroWinklerSimilarity", () => {
  it("canonical values (Winkler prefix boost)", () => {
    // 0.9611, 0.84, 0.8133 — Winkler 1990
    expect(jaroWinklerSimilarity("MARTHA", "MARHTA")).toBeCloseTo(0.9611, 4);
    expect(jaroWinklerSimilarity("DWAYNE", "DUANE")).toBeCloseTo(0.84, 4);
    expect(jaroWinklerSimilarity("DIXON", "DICKSONX")).toBeCloseTo(0.8133, 4);
  });

  it("prefix capped at four", () => {
    // Identical 8-char prefix counts only 4 toward the boost.
    const s1 = "abcdefXX";
    const s2 = "abcdefYY";
    const jaro = jaroSimilarity(s1, s2);
    const jw = jaroWinklerSimilarity(s1, s2);
    // prefix = 4 (not 6), p = 0.1
    expect(jw).toBeCloseTo(jaro + 4 * 0.1 * (1 - jaro), 9);
  });

  it("at least jaro", () => {
    expect(jaroWinklerSimilarity("foo", "bar")).toBeGreaterThanOrEqual(
      jaroSimilarity("foo", "bar"),
    );
  });

  it("in unit interval", () => {
    for (const [a, b] of [
      ["EmbeddingEngine", "EmbedingEngine"],
      ["x", "y"],
      ["ab", "abc"],
    ] as [string, string][]) {
      const v = jaroWinklerSimilarity(a, b);
      expect(v).toBeGreaterThanOrEqual(0.0);
      expect(v).toBeLessThanOrEqual(1.0);
    }
  });
});

describe("osaDistance", () => {
  it("identical strings", () => {
    expect(osaDistance("crane", "crane")).toBe(0);
  });

  it("single substitution", () => {
    expect(osaDistance("extractor", "extractar")).toBe(1);
  });

  it("adjacent transposition", () => {
    expect(osaDistance("ab", "ba")).toBe(1);
    expect(osaDistance("converter", "converetr")).toBe(1);
  });

  it("classic Levenshtein example", () => {
    expect(osaDistance("kitten", "sitting")).toBe(3);
  });

  it("empty strings", () => {
    expect(osaDistance("", "abc")).toBe(3);
    expect(osaDistance("abc", "")).toBe(3);
    expect(osaDistance("", "")).toBe(0);
  });
});
