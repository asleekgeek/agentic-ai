/**
 * MinHash sketches + band-LSH blocking — dependency-free.
 *
 * Used by the entity-graph fuzzy deduplicator (consolidation/entity-merge)
 * to block candidate near-duplicate entity labels in sub-quadratic time
 * before the exact Jaro-Winkler verification pass.
 *
 * Port of: mcp_server/shared/minhash.py (Cortex bc5af469)
 *
 * Sources:
 *   - MinHash (Jaccard estimation via min-wise permutations):
 *     Broder, A. (1997). "On the resemblance and containment of documents."
 *     Compression and Complexity of Sequences (SEQUENCES '97).
 *   - Band-LSH banding trades false-positive/negative rate against the Jaccard
 *     threshold: Indyk & Motwani (1998), and Leskovec, Rajaraman & Ullman,
 *     Mining of Massive Datasets, 3rd ed., Ch. 3.
 *
 * COEFFICIENT DIVERGENCE NOTE (faithfulness boundary):
 *   Python uses numpy.random.RandomState(1) (MT19937) to generate (a, b)
 *   coefficient pairs. MT19937 is not available in JS without a third-party
 *   library, which the contract forbids. Instead, this port uses splitmix64
 *   (Steele & Vigna 2014) seeded with the same fixed value (1) to produce
 *   deterministic but NOT bit-identical coefficients. The algorithm-level
 *   properties (Mersenne-prime affine permutations, band-LSH recall at the
 *   configured threshold, Jaccard estimation convergence) are preserved, and
 *   entity-merge decisions are determined by exact Jaro-Winkler score against
 *   MERGE_THRESHOLD — not by which coefficient set blocks a candidate pair.
 *   The divergence is therefore semantically neutral for the dedup engine.
 *
 * Pure utility — no I/O, no domain knowledge. Shared layer.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// source: cortex main mcp_server/shared/minhash.py:21  (Broder 1997 hash family)
const _MERSENNE_PRIME = (1n << 61n) - 1n;

// source: cortex main mcp_server/shared/minhash.py:22
const _HASH_MASK = 0xFFFF_FFFFn; // mask permuted values to 32 bits

// ---------------------------------------------------------------------------
// splitmix64 PRNG — Steele & Vigna (2014), "Fast Splittable Pseudorandom
// Number Generators", OOPSLA '14.  Used to generate (a, b) coefficients with
// the same FIXED SEED as Python's RandomState(1), producing a deterministic
// sequence that is NOT identical to MT19937 output (see module docstring).
// ---------------------------------------------------------------------------

function splitmix64Step(state: bigint): [bigint, bigint] {
  // The state counter advances by the 64-bit golden-ratio Fibonacci constant and
  // wraps at 2^64 (uint64 wrap-around — mask to keep BigInt bounded).
  // source: Steele & Vigna 2014 "Fast Splittable Pseudorandom Number Generators" OOPSLA §4.3
  const nextState = (state + 0x9e3779b97f4a7c15n) & 0xFFFF_FFFF_FFFF_FFFFn; // source: Steele & Vigna 2014 §4.3 golden-ratio increment
  let z = nextState;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xFFFF_FFFF_FFFF_FFFFn; // source: Steele & Vigna 2014 §4.3 mix constant 1
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xFFFF_FFFF_FFFF_FFFFn; // source: Steele & Vigna 2014 §4.3 mix constant 2
  const out = (z ^ (z >> 31n)) & 0xFFFF_FFFF_FFFF_FFFFn;
  return [nextState, out];
}

/**
 * Generate `count` uniform random BigInt values in [lo, hi) using splitmix64.
 * Returns [nextState, values].
 */
function splitmix64Range(
  state: bigint,
  lo: bigint,
  hi: bigint,
  count: number,
): [bigint, bigint[]] {
  const range = hi - lo;
  const values: bigint[] = [];
  for (let i = 0; i < count; i++) {
    let out: bigint;
    [state, out] = splitmix64Step(state);
    values.push(lo + (out % range));
  }
  return [state, values];
}

// ---------------------------------------------------------------------------
// Coefficient cache
// ---------------------------------------------------------------------------

interface CoeffPair {
  a: bigint[];
  b: bigint[];
}

const _COEFFS_CACHE = new Map<number, CoeffPair>();

/**
 * Return cached (a, b) BigInt coefficient arrays for `numPerm` permutations.
 *
 * a[i] in [1, MERSENNE_PRIME), b[i] in [0, MERSENNE_PRIME).
 *
 * Deterministic across runs via splitmix64 seeded with 1n (fixed seed mirrors
 * Python RandomState(1) intent; values differ — see module docstring).
 *
 * source: cortex main mcp_server/shared/minhash.py:27-31
 */
function getCoeffs(numPerm: number): CoeffPair {
  const cached = _COEFFS_CACHE.get(numPerm);
  if (cached !== undefined) {
    return cached;
  }
  // Fixed seed 1n mirrors Python RandomState(1)
  let state = 1n;
  let aVals: bigint[];
  let bVals: bigint[];
  [state, aVals] = splitmix64Range(state, 1n, _MERSENNE_PRIME, numPerm);
  [, bVals] = splitmix64Range(state, 0n, _MERSENNE_PRIME, numPerm);
  const pair: CoeffPair = { a: aVals, b: bVals };
  _COEFFS_CACHE.set(numPerm, pair);
  return pair;
}

// ---------------------------------------------------------------------------
// MinHash
// ---------------------------------------------------------------------------

/**
 * A MinHash sketch estimating Jaccard similarity between shingle sets.
 *
 * Precondition:  numPerm >= 1
 * Postcondition: hashValues[i] is the minimum permuted hash seen so far
 *                across all update() calls, for permutation i.
 *                jaccard(other) returns a value in [0, 1].
 *
 * source: cortex main mcp_server/shared/minhash.py:39-60
 */
export class MinHash {
  readonly numPerm: number;
  /** 32-bit unsigned hash values; initialized to 0xFFFFFFFF (identity element for min). */
  readonly hashValues: number[];

  private readonly _a: bigint[];
  private readonly _b: bigint[];

  // source: cortex main mcp_server/shared/minhash.py:54 (num_perm default = 128, datasketch standard)
  constructor(numPerm = 128) {
    this.numPerm = numPerm;
    // source: cortex main mcp_server/shared/minhash.py:44  (init to _HASH_MASK = 0xFFFFFFFF)
    this.hashValues = new Array<number>(numPerm).fill(0xFFFF_FFFF);
    const coeffs = getCoeffs(numPerm);
    this._a = coeffs.a;
    this._b = coeffs.b;
  }

  /**
   * Fold one shingle into the sketch (keeps the per-permutation minimum).
   *
   * Precondition:  value is a UTF-8 string; we encode it internally.
   * Postcondition: for each i, hashValues[i] = min(previous, permuted[i]).
   *
   * source: cortex main mcp_server/shared/minhash.py:46-52
   */
  update(value: string): void {
    // SHA-1 first 4 bytes, little-endian uint32.
    // source: cortex main mcp_server/shared/minhash.py:48
    const digest = createHash("sha1")
      .update(Buffer.from(value, "utf8"))
      .digest();
    const hv = BigInt(digest.readUInt32LE(0));

    const a = this._a;
    const b = this._b;
    const hv32 = this.hashValues;

    for (let i = 0; i < this.numPerm; i++) {
      // Affine permutation in Z / MERSENNE_PRIME, masked to 32 bits.
      // _a, _b, hashValues are all length numPerm (constructor) and i < numPerm,
      // so every index is in-bounds — assert to drop noUncheckedIndexedAccess's
      // `undefined`. Python has no skip path; an out-of-range i is a real bug.
      // source: cortex main mcp_server/shared/minhash.py:50-51
      const permuted = Number(
        ((a[i]! * hv + b[i]!) % _MERSENNE_PRIME) & _HASH_MASK,
      );
      // min() tracking — equivalent to hashvalues[i] = min(hashvalues[i], permuted)
      if (permuted < hv32[i]!) {
        hv32[i] = permuted;
      }
    }
  }

  /**
   * Estimate Jaccard similarity as the fraction of agreeing permutations.
   *
   * Precondition:  this.numPerm === other.numPerm
   * Postcondition: result in [0, 1]
   *
   * source: cortex main mcp_server/shared/minhash.py:54-59
   */
  jaccard(other: MinHash): number {
    if (this.numPerm !== other.numPerm) {
      throw new Error("MinHash.jaccard: sketches have different numPerm");
    }
    let matches = 0;
    const hA = this.hashValues;
    const hB = other.hashValues;
    for (let i = 0; i < this.numPerm; i++) {
      // Both sketches are length numPerm (equal, checked above) and i < numPerm,
      // so the indices are in-bounds — assert away the index `undefined`.
      if (hA[i]! === hB[i]!) {
        matches++;
      }
    }
    return matches / this.numPerm;
  }
}

// ---------------------------------------------------------------------------
// optimalLshParams
// ---------------------------------------------------------------------------

/**
 * Left-Riemann numerical integration with n=128 steps.
 * Replaces scipy.integrate.quad (which the Python avoids for EDR/platform
 * reasons; we avoid it to keep this module dependency-free).
 *
 * source: cortex main mcp_server/shared/minhash.py:63-66
 */
function integrate(
  f: (s: number) => number,
  lo: number,
  hi: number,
): number {
  // source: cortex main mcp_server/shared/minhash.py:64  (n=128 Riemann grid)
  const n = 128;
  const h = (hi - lo) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += f(lo + i * h);
  }
  return h * sum;
}

const _LSH_PARAMS_CACHE = new Map<string, [number, number]>();

/**
 * Find (bands, rows) minimising the weighted false-positive/negative error.
 *
 * The S-curve probability that two sets with Jaccard s collide in at least
 * one band is 1 - (1 - s^rows)^bands. We pick the (bands, rows) split with
 * bands*rows <= numPerm that minimises the symmetric error around `threshold`
 * (Leskovec/Rajaraman/Ullman, MMDS Ch. 3.4.2).
 *
 * Precondition:  0 < threshold < 1, numPerm >= 1
 * Postcondition: bands >= 1, rows >= 1, bands * rows <= numPerm
 *
 * source: cortex main mcp_server/shared/minhash.py:69-90
 */
export function optimalLshParams(
  threshold: number,
  numPerm: number,
): [number, number] {
  const key = `${threshold},${numPerm}`;
  const cached = _LSH_PARAMS_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let bestErr = Infinity;
  let best: [number, number] = [1, 1];

  for (let b = 1; b <= numPerm; b++) {
    for (let r = 1; r <= Math.floor(numPerm / b); r++) {
      const fp = integrate(
        (s) => 1 - Math.pow(1 - Math.pow(s, r), b),
        0.0,
        threshold,
      );
      const fn = integrate(
        (s) => 1 - (1 - Math.pow(1 - Math.pow(s, r), b)),
        threshold,
        1.0,
      );
      // source: cortex main mcp_server/shared/minhash.py:85-87  (symmetric 0.5/0.5 weighting)
      const err = 0.5 * fp + 0.5 * fn;
      if (err < bestErr) {
        bestErr = err;
        best = [b, r];
      }
    }
  }

  _LSH_PARAMS_CACHE.set(key, best);
  return best;
}

// ---------------------------------------------------------------------------
// MinHashLSH
// ---------------------------------------------------------------------------

/**
 * Band-hashing locality-sensitive index over MinHash sketches.
 *
 * insert() buckets a sketch by each of its `bands` band-signatures;
 * query() returns every key sharing at least one band with the probe — the
 * candidate set for exact verification.
 *
 * Precondition (insert):  key has not been inserted before.
 * Postcondition (query):  result contains all keys that share ≥1 band
 *                         with the probe MinHash.
 *
 * source: cortex main mcp_server/shared/minhash.py:93-118
 */
export class MinHashLSH {
  private readonly _b: number;
  private readonly _r: number;
  /** One Map<bandKey, keys[]> per band. */
  private readonly _tables: Map<string, string[]>[];
  private readonly _keys = new Set<string>();

  // source: cortex main mcp_server/shared/minhash.py:124 (defaults: threshold 0.5, num_perm 128)
  constructor(threshold = 0.5, numPerm = 128) {
    [this._b, this._r] = optimalLshParams(threshold, numPerm);
    this._tables = Array.from({ length: this._b }, () => new Map<string, string[]>());
  }

  /**
   * Insert a key and its MinHash sketch into the index.
   *
   * source: cortex main mcp_server/shared/minhash.py:106-112
   */
  insert(key: string, mh: MinHash): void {
    if (this._keys.has(key)) {
      throw new Error(`MinHashLSH: key ${JSON.stringify(key)} already inserted`);
    }
    this._keys.add(key);
    const hv = mh.hashValues;
    for (let i = 0; i < this._b; i++) {
      // Serialize the r hash values for band i as a comma-joined string.
      // Python uses .tobytes() on a uint64 slice; we use a string serialization
      // of the same 32-bit values — unambiguous and deterministic.
      // source: cortex main mcp_server/shared/minhash.py:109-111
      const bandKey = hv.slice(i * this._r, (i + 1) * this._r).join(",");
      const table = this._tables[i];
      if (table === undefined) continue;
      const bucket = table.get(bandKey);
      if (bucket !== undefined) {
        bucket.push(key);
      } else {
        table.set(bandKey, [key]);
      }
    }
  }

  /**
   * Return all keys sharing at least one band with the probe sketch.
   *
   * source: cortex main mcp_server/shared/minhash.py:114-118
   */
  query(mh: MinHash): string[] {
    const hv = mh.hashValues;
    const candidates = new Set<string>();
    for (let i = 0; i < this._b; i++) {
      const bandKey = hv.slice(i * this._r, (i + 1) * this._r).join(",");
      const table = this._tables[i];
      if (table === undefined) continue;
      const bucket = table.get(bandKey);
      if (bucket !== undefined) {
        for (const k of bucket) {
          candidates.add(k);
        }
      }
    }
    return Array.from(candidates);
  }
}
