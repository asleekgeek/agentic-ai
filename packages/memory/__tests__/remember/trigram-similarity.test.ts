/**
 * Tests for trigram-similarity.ts
 *
 * source: PostgreSQL pg_trgm (show_trgm + similarity).
 *
 * Invariants tested:
 *   1. trigramSet('cat') == {"  c"," ca","cat","at "} (exact pg_trgm padding)
 *   2. trigramSimilarity(x, x) == 1 for non-empty x (Jaccard identity)
 *   3. disjoint trigram sets → 0
 *   4. partial overlap (night/nacht) → strictly between 0 and 1
 *   5. word-order insensitivity — set union ignores order, similarity high
 *   6. empty/empty → 0
 */

import { describe, it, expect } from "vitest";
import {
  trigramSet,
  trigramSimilarity,
} from "../../src/remember/storage/trigram-similarity.js";

describe("trigramSet", () => {
  it("produces the exact pg_trgm trigram set for a single word", () => {
    const set = trigramSet("cat");
    expect([...set].sort()).toEqual(["  c", " ca", "at ", "cat"].sort());
  });

  it("returns an empty set for whitespace/punctuation-only input", () => {
    expect(trigramSet("   ").size).toBe(0);
    expect(trigramSet("!?,.").size).toBe(0);
  });
});

describe("trigramSimilarity", () => {
  it("returns 1 for identical non-empty strings", () => {
    expect(trigramSimilarity("cat", "cat")).toBe(1);
  });

  it("returns 0 for fully disjoint trigram sets", () => {
    expect(trigramSimilarity("cat", "dog")).toBe(0);
  });

  it("returns a value strictly between 0 and 1 for partial overlap", () => {
    const sim = trigramSimilarity("night", "nacht");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("is word-order insensitive (set union ignores order)", () => {
    const sim = trigramSimilarity("foo bar", "bar foo");
    expect(sim).toBeGreaterThan(0.5);
  });

  it("returns 0 when both inputs have no trigrams", () => {
    expect(trigramSimilarity("", "")).toBe(0);
    expect(trigramSimilarity("  ", "!?")).toBe(0);
  });
});
