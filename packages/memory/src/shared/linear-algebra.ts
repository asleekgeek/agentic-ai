/**
 * Dense vector math utilities — re-export or local implementation.
 *
 * Port of: mcp_server/shared/linear_algebra.py
 * Sourced from: packages/memory/src/shared/linear-algebra.ts (cortex-shared worktree)
 *
 * This file provides the same interface as the cortex-shared worktree's
 * linear-algebra.ts. In the merged monorepo, this will be deduplicated into
 * the shared package. For now it is a local copy.
 */

/** Dot product of two dense vectors. Uses the shorter length if unequal. */
export function dot(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0.0;
  let sum = 0.0;
  for (let i = 0; i < n; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/** Euclidean norm (L2) of a dense vector. */
export function norm(v: readonly number[]): number {
  if (v.length === 0) return 0.0;
  let sum = 0.0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

/** Cosine similarity. Returns 0 if either has zero norm. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0.0;
  return dot(a, b) / (na * nb);
}

/** Scalar multiplication. */
export function scale(v: readonly number[], s: number): number[] {
  return v.map((x) => x * s);
}

/** Return a unit vector in the same direction. Zero vector if norm is 0. */
export function normalize(v: readonly number[]): number[] {
  const n = norm(v);
  if (n === 0) return v.map(() => 0.0);
  return v.map((x) => x / n);
}
