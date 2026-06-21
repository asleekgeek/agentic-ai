/**
 * Flat 4-signal novelty computation for the write gate.
 *
 * Embedding, entity, temporal, and structural novelty signals used by
 * the remember handler and predictive coding gate.
 *
 * Pure business logic — no I/O.
 *
 * Port of: cortex main mcp_server/core/predictive_coding_flat.py
 *
 * References:
 *   Friston K (2005) A theory of cortical responses.
 *     Phil Trans R Soc B 360:815-836
 */

// ── Shared regex patterns ─────────────────────────────────────────────────
// source: cortex main mcp_server/core/predictive_coding_flat.py:19-23

const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`\n]+`/g;
const FILE_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.\w+/g;
const URL_RE = /https?:\/\/\S+/g;
const HEADING_RE = /^#{1,6}\s+\S/gm;
const LIST_RE = /^[\s]*[-*+]\s+\S/gm;

// ── Constants ─────────────────────────────────────────────────────────────

// Default novelty when no embedding similarities are available.
// source: parity with mcp_server/core/predictive_coding_flat.py:32
const EMBEDDING_NOVELTY_DEFAULT = 0.5;

// Default novelty when no entities are extracted.
// source: parity with mcp_server/core/predictive_coding_flat.py:45
const ENTITY_NOVELTY_DEFAULT = 0.5;

// Default novelty when recency is unknown (null hours) — treat as likely novel.
// source: parity with mcp_server/core/predictive_coding_flat.py:56
const TEMPORAL_NOVELTY_NULL_DEFAULT = 0.8;

// Exponential decay time constant for temporal novelty (hours).
// source: parity with mcp_server/core/predictive_coding_flat.py:59
const TEMPORAL_NOVELTY_TIME_CONSTANT_HOURS = 24.0;

// Length bucket boundaries for structural feature extraction (character counts).
// source: parity with mcp_server/core/predictive_coding_flat.py:68-76
const LENGTH_BUCKET_TINY_MAX = 100;
const LENGTH_BUCKET_SMALL_MAX = 500; // source: parity with mcp_server/core/predictive_coding_flat.py:70 — elif n < 500
// source: parity with mcp_server/core/predictive_coding_flat.py:71
const LENGTH_BUCKET_MEDIUM_MAX = 2000;
const LENGTH_BUCKET_LARGE_MAX = 8000; // source: parity with mcp_server/core/predictive_coding_flat.py:74 — elif n < 8000

// Ordinal bucket indices for content length classification (0–4).
// source: parity with mcp_server/core/predictive_coding_flat.py:69-77
const LENGTH_BUCKET_LARGE = 3;
const LENGTH_BUCKET_XLARGE = 4;

// Default novelty when no recent content is available for structural comparison.
// source: parity with mcp_server/core/predictive_coding_flat.py:92
const STRUCTURAL_NOVELTY_DEFAULT = 0.7;

// 4-signal novelty weights; must sum to 1.0.
// source: parity with mcp_server/core/predictive_coding_flat.py:115
const NOVELTY_WEIGHT_EMBEDDING = 0.40;
// source: parity with mcp_server/core/predictive_coding_flat.py:116
const NOVELTY_WEIGHT_ENTITY = 0.25;
// source: parity with mcp_server/core/predictive_coding_flat.py:117
const NOVELTY_WEIGHT_TEMPORAL = 0.20;
// source: parity with mcp_server/core/predictive_coding_flat.py:118
const NOVELTY_WEIGHT_STRUCTURAL = 0.15;

// Rounding scale factor for 4-decimal-place output in describeSignals.
// source: parity with mcp_server/core/predictive_coding_flat.py:131-135 (round(x, 4))
const SIGNAL_ROUND_SCALE = 1e4;

// ── Embedding novelty ─────────────────────────────────────────────────────

/**
 * Embedding novelty = 1 - max(similarities). 0.5 if no data.
 *
 * precondition:  similarities is an array of floats in [0, 1].
 * postcondition: result ∈ [0, 1]. Returns 0.5 when similarities is empty.
 *
 * source: cortex main mcp_server/core/predictive_coding_flat.py:29-33
 */
export function computeEmbeddingNovelty(similarities: number[]): number {
  if (similarities.length === 0) return EMBEDDING_NOVELTY_DEFAULT;
  const maxSim = Math.max(...similarities);
  return Math.max(0.0, Math.min(1.0, 1.0 - maxSim));
}

// ── Entity novelty ────────────────────────────────────────────────────────

/**
 * Fraction of entities that are truly new. 0.5 if none extracted.
 *
 * precondition:  newEntityNames is an iterable of strings.
 * postcondition: result ∈ [0, 1]. Returns 0.5 when newEntityNames is empty.
 *
 * source: cortex main mcp_server/core/predictive_coding_flat.py:39-47
 */
export function computeEntityNovelty(
  newEntityNames: string[] | Set<string>,
  knownEntityNames: Set<string>,
): number {
  const names = Array.isArray(newEntityNames)
    ? newEntityNames
    : Array.from(newEntityNames);
  if (names.length === 0) return ENTITY_NOVELTY_DEFAULT;
  const trulyNew = names.filter((e) => !knownEntityNames.has(e)).length;
  return trulyNew / names.length;
}

// ── Temporal novelty ──────────────────────────────────────────────────────

/**
 * Temporal novelty via exponential saturation: 1 - exp(-hours/24).
 *
 * precondition:  hoursSinceSimilar >= 0 or null.
 * postcondition: result ∈ [0, 1]. Returns 0.8 when hours is null (unknown = likely novel).
 *
 * source: cortex main mcp_server/core/predictive_coding_flat.py:53-59
 *   Formula: 1 - exp(-hours / 24.0); time constant = 24 hours
 */
export function computeTemporalNovelty(
  hoursSinceSimilar: number | null,
): number {
  if (hoursSinceSimilar === null) return TEMPORAL_NOVELTY_NULL_DEFAULT;
  if (hoursSinceSimilar <= 0) return 0.0;
  return Math.min(1.0, 1.0 - Math.exp(-hoursSinceSimilar / TEMPORAL_NOVELTY_TIME_CONSTANT_HOURS));
}

// ── Structural novelty ────────────────────────────────────────────────────

/**
 * Extract structural shape features from content.
 *
 * source: cortex main mcp_server/core/predictive_coding_flat.py:65-86
 */
function structuralFeatures(content: string): Record<string, number> {
  const n = Math.max(content.length, 1);
  let lengthBucket: number;
  if (n < LENGTH_BUCKET_TINY_MAX) lengthBucket = 0;
  else if (n < LENGTH_BUCKET_SMALL_MAX) lengthBucket = 1;
  else if (n < LENGTH_BUCKET_MEDIUM_MAX) lengthBucket = 2;
  else if (n < LENGTH_BUCKET_LARGE_MAX) lengthBucket = LENGTH_BUCKET_LARGE;
  else lengthBucket = LENGTH_BUCKET_XLARGE;

  return {
    code_blocks: (content.match(CODE_BLOCK_RE) ?? []).length,
    file_refs: (content.match(FILE_PATH_RE) ?? []).length,
    urls: (content.match(URL_RE) ?? []).length,
    headings: (content.match(HEADING_RE) ?? []).length,
    list_items: (content.match(LIST_RE) ?? []).length,
    length_bucket: lengthBucket,
  };
}

/**
 * Structural novelty by comparing document shape to recent memories.
 *
 * precondition:  recentContents is an array of strings.
 * postcondition: result ∈ [0, 1]. Returns 0.7 when recentContents is empty.
 *
 * source: cortex main mcp_server/core/predictive_coding_flat.py:89-101
 */
export function computeStructuralNovelty(
  content: string,
  recentContents: string[],
): number {
  if (recentContents.length === 0) return STRUCTURAL_NOVELTY_DEFAULT;
  const candidate = structuralFeatures(content);
  const keys = Object.keys(candidate);
  let bestMatch = 0.0;
  for (const existingContent of recentContents) {
    const existing = structuralFeatures(existingContent);
    const matches = keys.filter((k) => candidate[k] === existing[k]).length;
    const similarity = matches / keys.length;
    bestMatch = Math.max(bestMatch, similarity);
  }
  return Math.max(0.0, Math.min(1.0, 1.0 - bestMatch));
}

// ── Combined novelty ──────────────────────────────────────────────────────

/**
 * Combined novelty score from the 4-signal gate. Returns [0, 1].
 *
 * precondition:  all inputs ∈ [0, 1].
 * postcondition: result ∈ [0, 1].
 *
 * source: cortex main mcp_server/core/predictive_coding_flat.py:107-119
 *   Weights: embedding=0.40, entity=0.25, temporal=0.20, structural=0.15
 */
export function computeNoveltyScore(
  embeddingNovelty: number,
  entityNovelty: number,
  temporalNovelty: number,
  structuralNovelty: number,
): number {
  return (
    NOVELTY_WEIGHT_EMBEDDING * embeddingNovelty
    + NOVELTY_WEIGHT_ENTITY * entityNovelty
    + NOVELTY_WEIGHT_TEMPORAL * temporalNovelty
    + NOVELTY_WEIGHT_STRUCTURAL * structuralNovelty
  );
}

// ── Signal description ────────────────────────────────────────────────────

/**
 * Structured dict of all signal values for observability.
 *
 * postcondition: returned object has all five signal keys, values rounded to 4dp.
 * source: cortex main mcp_server/core/predictive_coding_flat.py:122-136
 */
export function describeSignals(
  embedding: number,
  entity: number,
  temporal: number,
  structural: number,
  combined: number,
): Record<string, number> {
  const r = (v: number) => Math.round(v * SIGNAL_ROUND_SCALE) / SIGNAL_ROUND_SCALE;
  return {
    embedding_novelty: r(embedding),
    entity_novelty: r(entity),
    temporal_novelty: r(temporal),
    structural_novelty: r(structural),
    combined_novelty: r(combined),
  };
}
