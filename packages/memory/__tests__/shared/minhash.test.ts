/**
 * Tests for packages/memory/src/shared/minhash.ts
 *
 * Port of: tests_py/shared/test_minhash.py (Cortex bc5af469)
 *
 * The oracle only requires determinism + Jaccard thresholds — NOT
 * bit-identical sketches to the Python numpy implementation (coefficients
 * diverge due to MT19937 vs splitmix64; see minhash.ts module docstring).
 */

import { describe, it, expect } from "vitest";
import { MinHash, MinHashLSH, optimalLshParams } from "../../src/shared/minhash.js";

// ---------------------------------------------------------------------------
// Helper — mirrors _sketch() in tests_py/shared/test_minhash.py
// ---------------------------------------------------------------------------

/**
 * MinHash over space-stripped k-gram shingles (mirrors entity_dedup).
 *
 * Port of: tests_py/shared/test_minhash.py _sketch()
 */
function sketch(text: string, k = 3, numPerm = 128): MinHash {
  const s = text.replace(/ /g, "");
  const shingles = new Set<string>();
  const count = Math.max(1, s.length - k + 1);
  for (let i = 0; i < count; i++) {
    shingles.add(s.slice(i, i + k));
  }
  const m = new MinHash(numPerm);
  for (const sh of shingles) {
    m.update(sh);
  }
  return m;
}

// ---------------------------------------------------------------------------
// TestMinHash
// ---------------------------------------------------------------------------

describe("MinHash", () => {
  it("identical sets estimate one", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHash.test_identical_sets_estimate_one
    const a = sketch("embeddingengine");
    const b = sketch("embeddingengine");
    expect(a.jaccard(b)).toBe(1.0);
  });

  it("disjoint sets estimate zero", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHash.test_disjoint_sets_estimate_zero
    const a = sketch("postgresql");
    const b = sketch("xyzqwklmn");
    expect(a.jaccard(b)).toBe(0.0);
  });

  it("near-duplicate has high Jaccard estimate", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHash.test_near_duplicate_high_estimate
    // "embedingengine" = one missing char vs "embeddingengine"
    const a = sketch("embeddingengine");
    const b = sketch("embedingengine");
    expect(a.jaccard(b)).toBeGreaterThanOrEqual(0.7);
  });

  it("is deterministic across instances for identical input", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHash.test_deterministic_across_instances
    // Fixed splitmix64 seed → identical sketches for identical input.
    const hvA = sketch("cortex").hashValues.slice();
    const hvB = sketch("cortex").hashValues.slice();
    expect(hvA).toEqual(hvB);
  });

  it("jaccard throws on mismatched numPerm", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHash.test_jaccard_mismatched_perm_raises
    const a = new MinHash(64);
    const b = new MinHash(128);
    expect(() => a.jaccard(b)).toThrow(/numPerm/);
  });
});

// ---------------------------------------------------------------------------
// TestLshParams
// ---------------------------------------------------------------------------

describe("optimalLshParams", () => {
  it("bands * rows <= numPerm and both >= 1", () => {
    // Port of: tests_py/shared/test_minhash.py TestLshParams.test_bands_times_rows_within_perm
    const [b, r] = optimalLshParams(0.7, 128);
    expect(b * r).toBeLessThanOrEqual(128);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(r).toBeGreaterThanOrEqual(1);
  });

  it("is cached and returns the same result on repeated calls", () => {
    // Port of: tests_py/shared/test_minhash.py TestLshParams.test_cached_stable
    expect(optimalLshParams(0.7, 128)).toEqual(optimalLshParams(0.7, 128));
  });
});

// ---------------------------------------------------------------------------
// TestMinHashLSH
// ---------------------------------------------------------------------------

describe("MinHashLSH", () => {
  it("blocks near-duplicate pairs", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHashLSH.test_blocks_near_duplicate
    const lsh = new MinHashLSH(0.7, 128);
    const a = sketch("embeddingengine");
    lsh.insert("a", a);
    const probe = sketch("embedingengine");
    expect(lsh.query(probe)).toContain("a");
  });

  it("does not block unrelated strings", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHashLSH.test_does_not_block_unrelated
    const lsh = new MinHashLSH(0.7, 128);
    lsh.insert("a", sketch("postgresql"));
    expect(lsh.query(sketch("completelyunrelated"))).toEqual([]);
  });

  it("throws on duplicate key insert", () => {
    // Port of: tests_py/shared/test_minhash.py TestMinHashLSH.test_duplicate_key_raises
    const lsh = new MinHashLSH(0.7, 128);
    const m = sketch("cortex");
    lsh.insert("k", m);
    expect(() => lsh.insert("k", m)).toThrow(/already inserted/);
  });
});
