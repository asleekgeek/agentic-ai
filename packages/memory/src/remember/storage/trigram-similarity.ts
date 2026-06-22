/**
 * trigram-similarity.ts — pg_trgm-faithful trigram Jaccard similarity.
 *
 * Reproduces PostgreSQL's pg_trgm show_trgm + similarity exactly: the whole
 * string is normalized, split into words, and each word is padded with two
 * leading spaces and one trailing space before sliding-window length-three
 * substrings are collected into a single distinct set (union across words).
 * Similarity is the Jaccard index of the two trigram sets.
 *
 * source: PostgreSQL pg_trgm (show_trgm + similarity).
 */

// Trigram window length used by pg_trgm.
// source: PostgreSQL pg_trgm (show_trgm + similarity).
const TRIGRAM_LEN = 3;

/**
 * Compute the distinct trigram set of a string, pg_trgm-faithfully.
 *
 * Steps: lowercase; collapse every run of non-[a-z0-9] to a single space;
 * trim; split on spaces; pad each word as ("  " + word + " ") and collect
 * every length-three sliding-window substring into a set (union across words).
 *
 * source: PostgreSQL pg_trgm (show_trgm + similarity).
 */
export function trigramSet(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const trigrams = new Set<string>();
  if (normalized.length === 0) return trigrams;
  for (const word of normalized.split(" ")) {
    if (word.length === 0) continue;
    const padded = "  " + word + " ";
    for (let i = 0; i + TRIGRAM_LEN <= padded.length; i++) {
      trigrams.add(padded.slice(i, i + TRIGRAM_LEN));
    }
  }
  return trigrams;
}

/**
 * Jaccard similarity of the trigram sets of two strings.
 *
 * similarity = |trigrams(a) ∩ trigrams(b)| / |trigrams(a) ∪ trigrams(b)|.
 * Two empty trigram sets yield zero.
 *
 * source: PostgreSQL pg_trgm (show_trgm + similarity).
 */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigramSet(a);
  const setB = trigramSet(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const trigram of setA) {
    if (setB.has(trigram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Rank candidate rows by trigram similarity to the query: score each row's
 * content, keep those strictly above the floor, return the top `limit` ids in
 * descending-similarity order. Mirrors PG recall_memories' ngram CTE (scan all
 * candidates, ORDER BY similarity DESC LIMIT pool).
 *
 * source: PostgreSQL pg_trgm (similarity) + cortex main recall_memories ngram CTE.
 */
export function rankByTrigramSimilarity(
  rows: ReadonlyArray<{ id: number; content: string }>,
  queryText: string,
  floor: number,
  limit: number,
): number[] {
  return rows
    .map((r) => ({ id: r.id, sim: trigramSimilarity(r.content ?? "", queryText) }))
    .filter((r) => r.sim > floor)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((r) => r.id);
}
