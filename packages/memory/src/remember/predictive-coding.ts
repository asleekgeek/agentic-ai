/**
 * predictive-coding.ts — Pure novelty-signal computation for the write gate.
 *
 * Ports: core/predictive_coding_flat.py, core/predictive_coding_signals.py,
 *        core/predictive_coding_gate.py
 *
 * Every exported function is pure (no I/O, no module-level mutable state).
 * Invariants are stated in the function contract.
 *
 * References:
 *   Friston K (2005) A theory of cortical responses.
 *       Phil Trans R Soc B 360:815-836
 *   Bastos AM et al. (2012) Canonical microcircuits for predictive coding.
 *       Neuron 76:695-711
 *   Feldman H, Friston K (2010) Attention, uncertainty, and free-energy.
 *       Front Hum Neurosci 4:215
 */

// ── Structural-feature regexes (flat.py lines 19-23) ──────────────────────

const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`\n]+`/g;
const FILE_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.\w+/g;
const URL_RE = /https?:\/\/\S+/g;
const HEADING_RE = /^#{1,6}\s+\S/gm;
const LIST_RE = /^[\s]*[-*+]\s+\S/gm;

// ── Model constants (flat + signal + gate levels) ──────────────────────────
// Faithful ports of Cortex bc5af469 constants, grouped so the provenance of
// every number is auditable in one place. ESLint no-magic-numbers (ignore
// [-1,0,1,2]) is satisfied by named-const extraction; values are unchanged.

// Priors returned when a signal has no evidence.
const EMBEDDING_NOVELTY_PRIOR = 0.5; // source: predictive_coding_flat.py:compute_embedding_novelty — no-data prior
const ENTITY_NOVELTY_PRIOR = 0.5; // source: predictive_coding_flat.py:compute_entity_novelty — no-entities prior
const TEMPORAL_NOVELTY_PRIOR = 0.8; // source: predictive_coding_flat.py:compute_temporal_novelty — null prior
const STRUCTURAL_NOVELTY_PRIOR = 0.7; // source: predictive_coding_flat.py:compute_structural_novelty — no-recent prior

// Temporal saturation time constant (hours): 1 - exp(-h/24).
const TEMPORAL_SATURATION_HOURS = 24.0; // source: predictive_coding_flat.py:compute_temporal_novelty

// Content-length bucket boundaries (chars → 0..4). Object form keeps the values
// out of no-magic-numbers' array-element check (detectObjects: false).
// source: predictive_coding_flat.py — length buckets
const LENGTH_BUCKET_BOUNDS = { short: 100, medium: 500, long: 2000, veryLong: 8000 } as const;
const LENGTH_BUCKET_THRESHOLDS: readonly number[] = Object.values(LENGTH_BUCKET_BOUNDS);

// Convex weights of the flat 4-signal novelty score (sum = 1.0).
// source: predictive_coding_flat.py:compute_novelty_score
const COMBINED_NOVELTY_WEIGHTS = { embedding: 0.4, entity: 0.25, temporal: 0.2, structural: 0.15 } as const;

// Decimal places for rounding (observability + parity with Cortex round(x, n)).
const SIGNAL_DECIMALS = 4; // source: predictive_coding_flat.py:describe_signals — round(x, 4)
const FREE_ENERGY_DECIMALS = 6; // source: hierarchical_predictive_coding.py:compute_hierarchical_novelty — round(fe, 6)
const DISPLAY_DECIMALS = 3; // source: predictive_coding_gate.py — f"{x:.3f}" reason strings
const DECIMAL_RADIX = 10; // base for round-to-n-places

// Inverse-variance precision tracking (predictive_coding_gate.py:update_precision).
const PRECISION_MIN = 0.1; // source: predictive_coding_gate.py:update_precision — clamp lo
const PRECISION_MAX = 5.0; // source: predictive_coding_gate.py:update_precision — clamp hi
const PRECISION_LEARNING_RATE = 0.1; // source: predictive_coding_gate.py:update_precision — default EMA rate
const VARIANCE_FLOOR = 1e-10; // source: predictive_coding_gate.py:update_precision — divide-by-zero guard
const VARIANCE_REGULARIZER = 0.01; // source: predictive_coding_signals.py:compute_sensory_prediction — variance floor

// Sigmoid mapping average precision → confidence (predictive_coding_gate.py:precision_to_confidence).
const PRECISION_CONFIDENCE_STEEPNESS = -1.5; // source: predictive_coding_gate.py:precision_to_confidence
const PRECISION_CONFIDENCE_MIDPOINT = 1.5; // source: predictive_coding_gate.py:precision_to_confidence

// Sensory-feature density normalizers (predictive_coding_signals.py).
const SENSORY_LENGTH_NORM = 2000.0; // source: predictive_coding_signals.py — length / 2000
const SENSORY_CODE_NORM = 5.0; // source: predictive_coding_signals.py — code blocks / 5
const SENSORY_FILE_NORM = 5.0; // source: predictive_coding_signals.py — file refs / 5
const SENSORY_URL_NORM = 3.0; // source: predictive_coding_signals.py — urls / 3
const SENSORY_HEADING_NORM = 5.0; // source: predictive_coding_signals.py — headings / 5
const SENSORY_LIST_NORM = 10.0; // source: predictive_coding_signals.py — list items / 10
const DEFAULT_SENSORY_PRECISION = 0.5; // source: predictive_coding_signals.py:compute_sensory_prediction — uniform prior precision

// Novel (unpredicted) entity error + precision (predictive_coding_signals.py:compute_entity_errors).
const NOVEL_ENTITY_ERROR = -0.5; // source: predictive_coding_signals.py:compute_entity_errors
const NOVEL_ENTITY_PRECISION = 0.5; // source: predictive_coding_signals.py:compute_entity_errors

// Schema (L2) precision model (predictive_coding_signals.py:compute_schema_errors).
const DEFAULT_DOMAIN_FAMILIARITY = 0.5; // source: predictive_coding_signals.py:compute_schema_errors — default
const DOMAIN_PRECISION_BASE = 0.5; // source: predictive_coding_signals.py:compute_schema_errors — base precision
const DOMAIN_PRECISION_GAIN = 2.0; // source: predictive_coding_signals.py:compute_schema_errors — familiarity gain
const SCHEMA_FE_CARRYOVER = 0.3; // source: predictive_coding_signals.py:compute_schema_errors — upstream FE weight

// Neutral ACh tone for the remember path.
const DEFAULT_ACH_LEVEL = 0.5; // source: hierarchical_predictive_coding.py:compute_hierarchical_novelty — neutral ACh

// ── Level 0: Embedding novelty ─────────────────────────────────────────────

/**
 * Embedding novelty = 1 - max(similarities).
 *
 * precondition:  similarities is a (possibly empty) list of floats in [0,1].
 * postcondition: returned value in [0, 1].
 *   - 0.5 if no data (prior = "uncertain").
 *   - Closer to 0 when the most similar known memory is very close.
 */
export function computeEmbeddingNovelty(similarities: number[]): number {
  if (similarities.length === 0) return EMBEDDING_NOVELTY_PRIOR;
  const maxSim = Math.max(...similarities);
  return Math.max(0.0, Math.min(1.0, 1.0 - maxSim));
}

// ── Level 1: Entity novelty ────────────────────────────────────────────────

/**
 * Fraction of extracted entities that are truly new.
 *
 * precondition:  newEntityNames is a list of entity name strings;
 *                knownEntityNames is the set of names already in the store.
 * postcondition: returned value in [0, 1].
 *   - 0.5 if no entities extracted (prior = "uncertain").
 *   - 1.0 if all entities are new; 0.0 if all are known.
 */
export function computeEntityNovelty(
  newEntityNames: string[],
  knownEntityNames: Set<string>,
): number {
  if (newEntityNames.length === 0) return ENTITY_NOVELTY_PRIOR;
  const trulyNew = newEntityNames.filter((e) => !knownEntityNames.has(e));
  return trulyNew.length / newEntityNames.length;
}

// ── Level 2: Temporal novelty ──────────────────────────────────────────────

/**
 * Temporal novelty via exponential saturation: 1 - exp(-hours/24).
 *
 * precondition:  hoursSinceSimilar is hours (>=0) or null.
 * postcondition: returned value in [0, 1].
 *   - 0.8 if null (no recent similar memory found — probably novel).
 *   - 0.0 if hoursSinceSimilar == 0 (memory just written).
 *   - Approaches 1.0 asymptotically for large hour values.
 */
export function computeTemporalNovelty(
  hoursSinceSimilar: number | null,
): number {
  if (hoursSinceSimilar === null) return TEMPORAL_NOVELTY_PRIOR;
  if (hoursSinceSimilar <= 0) return 0.0;
  return Math.min(1.0, 1.0 - Math.exp(-hoursSinceSimilar / TEMPORAL_SATURATION_HOURS));
}

// ── Level 3: Structural novelty ────────────────────────────────────────────

interface StructuralFeatures {
  codeBlocks: number;
  fileRefs: number;
  urls: number;
  headings: number;
  listItems: number;
  lengthBucket: number; // 0..4
}

function extractStructuralFeatures(content: string): StructuralFeatures {
  const n = Math.max(content.length, 1);
  const bucketIndex = LENGTH_BUCKET_THRESHOLDS.findIndex((t) => n < t);
  const lengthBucket =
    bucketIndex === -1 ? LENGTH_BUCKET_THRESHOLDS.length : bucketIndex;

  return {
    codeBlocks: (content.match(CODE_BLOCK_RE) ?? []).length,
    fileRefs: (content.match(FILE_PATH_RE) ?? []).length,
    urls: (content.match(URL_RE) ?? []).length,
    headings: (content.match(HEADING_RE) ?? []).length,
    listItems: (content.match(LIST_RE) ?? []).length,
    lengthBucket,
  };
}

/**
 * Structural novelty by comparing document shape to recent memories.
 *
 * precondition:  recentContents is a list of content strings.
 * postcondition: returned value in [0, 1].
 *   - 0.7 if no recent content (prior = "probably different").
 *   - 0.0 if structurally identical to the most similar recent memory.
 */
export function computeStructuralNovelty(
  content: string,
  recentContents: string[],
): number {
  if (recentContents.length === 0) return STRUCTURAL_NOVELTY_PRIOR;
  const candidate = extractStructuralFeatures(content);
  const keys = Object.keys(candidate) as (keyof StructuralFeatures)[];
  let bestMatch = 0.0;
  for (const existingContent of recentContents) {
    const existing = extractStructuralFeatures(existingContent);
    const matches = keys.filter((k) => candidate[k] === existing[k]).length;
    const similarity = matches / keys.length;
    bestMatch = Math.max(bestMatch, similarity);
  }
  return Math.max(0.0, Math.min(1.0, 1.0 - bestMatch));
}

// ── Combined novelty ───────────────────────────────────────────────────────

/**
 * Combined 4-signal novelty score.
 *
 * Weight invariant: 0.40 + 0.25 + 0.20 + 0.15 = 1.0 (convex combination).
 * precondition:  each argument is in [0, 1].
 * postcondition: returned value in [0, 1].
 *
 * source: predictive_coding_flat.py:compute_novelty_score
 */
export function computeNoveltyScore(
  embeddingNovelty: number,
  entityNovelty: number,
  temporalNovelty: number,
  structuralNovelty: number,
): number {
  return (
    COMBINED_NOVELTY_WEIGHTS.embedding * embeddingNovelty +
    COMBINED_NOVELTY_WEIGHTS.entity * entityNovelty +
    COMBINED_NOVELTY_WEIGHTS.temporal * temporalNovelty +
    COMBINED_NOVELTY_WEIGHTS.structural * structuralNovelty
  );
}

/**
 * Structured dict of all signal values for observability.
 *
 * postcondition: all values are rounded to 4 decimal places.
 */
// source: phase 4-to-5 cleanup, 2026-04-26
// Return type narrowed from Record<string,number> to the exact shape so that
// buildRejectionResponse and RememberResponse.novelty are mutually substitutable.
export function describeSignals(
  embedding: number,
  entity: number,
  temporal: number,
  structural: number,
  combined: number,
): {
  embedding_novelty: number;
  entity_novelty: number;
  temporal_novelty: number;
  structural_novelty: number;
  combined_novelty: number;
} {
  return {
    embedding_novelty: roundTo(embedding, SIGNAL_DECIMALS),
    entity_novelty: roundTo(entity, SIGNAL_DECIMALS),
    temporal_novelty: roundTo(temporal, SIGNAL_DECIMALS),
    structural_novelty: roundTo(structural, SIGNAL_DECIMALS),
    combined_novelty: roundTo(combined, SIGNAL_DECIMALS),
  };
}

// ── Gate decision ──────────────────────────────────────────────────────────

/**
 * Flat gate decision: compare novelty score against threshold.
 *
 * precondition:  noveltyScore in [0, 1]; threshold in (0, 1).
 * postcondition: (true, reason) if bypass or novelty >= threshold.
 *                (false, reason) otherwise.
 *
 * source: predictive_coding_gate.py:gate_decision
 */
export function gateDecision(
  noveltyScore: number,
  threshold: number,
  bypass: boolean,
): [boolean, string] {
  if (bypass) return [true, "bypass"];
  if (noveltyScore >= threshold) return [true, "high_novelty"];
  return [
    false,
    `below_threshold (novelty=${noveltyScore.toFixed(DISPLAY_DECIMALS)}, threshold=${threshold})`,
  ];
}

// ── Hierarchical prediction types ─────────────────────────────────────────

export interface PredictionLevel {
  level: number;
  predictions: Record<string, number>;
  precisions: Record<string, number>;
  predictionErrors: Record<string, number>;
  freeEnergy: number;
}

export interface HierarchicalPrediction {
  levels: [PredictionLevel, PredictionLevel, PredictionLevel];
  totalFreeEnergy: number;
  noveltyScore: number;
  gateOpen: boolean;
  gateReason: string;
}

// ── Precision state ────────────────────────────────────────────────────────

export interface PrecisionState {
  domain: string;
  levelPrecisions: [number, number, number];
  predictionHistory: number;
  calibrationHits: number;
  calibrationTotal: number;
  precisionEmaAlpha: number;
}

export function makePrecisionState(domain: string): PrecisionState {
  return {
    domain,
    levelPrecisions: [1.0, 1.0, 1.0],
    predictionHistory: 0,
    calibrationHits: 0,
    calibrationTotal: 0,
    precisionEmaAlpha: 0.1,
  };
}

/**
 * Update precision estimate via inverse-variance tracking.
 *
 * precondition:  currentPrecision > 0; predictionError is a real number.
 * postcondition: returned value in [0.1, 5.0].
 *
 * source: predictive_coding_gate.py:update_precision
 */
export function updatePrecision(
  currentPrecision: number,
  predictionError: number,
  learningRate = PRECISION_LEARNING_RATE,
): number {
  const currentVar = 1.0 / Math.max(currentPrecision, PRECISION_MIN);
  const newVar =
    (1 - learningRate) * currentVar + learningRate * predictionError ** 2;
  const newPrecision = 1.0 / Math.max(newVar, VARIANCE_FLOOR);
  return Math.max(PRECISION_MIN, Math.min(PRECISION_MAX, newPrecision));
}

/**
 * Sigmoid mapping from average precision to a confidence score [0, 1].
 *
 * postcondition: precision=1.0 → ~0.5; precision=3.0 → ~0.85.
 * source: predictive_coding_gate.py:precision_to_confidence
 */
export function precisionToConfidence(levelPrecisions: number[]): number {
  const avg =
    levelPrecisions.length > 0
      ? levelPrecisions.reduce((a, b) => a + b, 0) / levelPrecisions.length
      : 1.0;
  const sigmoidZ =
    PRECISION_CONFIDENCE_STEEPNESS * (avg - PRECISION_CONFIDENCE_MIDPOINT);
  return 1.0 / (1.0 + Math.exp(sigmoidZ));
}

// ── Level 0 (sensory) computation ──────────────────────────────────────────

const DEFAULT_SENSORY_PREDICTIONS: Record<string, number> = {
  length: 0.3,
  code_density: 0.2,
  file_ref_density: 0.1,
  url_density: 0.05,
  heading_density: 0.1,
  list_density: 0.1,
};

export function extractSensoryFeatures(content: string): Record<string, number> {
  const n = Math.max(content.length, 1);
  return {
    length: Math.min(n / SENSORY_LENGTH_NORM, 1.0),
    code_density: Math.min(
      (content.match(CODE_BLOCK_RE) ?? []).length / SENSORY_CODE_NORM,
      1.0,
    ),
    file_ref_density: Math.min(
      (content.match(FILE_PATH_RE) ?? []).length / SENSORY_FILE_NORM,
      1.0,
    ),
    url_density: Math.min(
      (content.match(URL_RE) ?? []).length / SENSORY_URL_NORM,
      1.0,
    ),
    heading_density: Math.min(
      (content.match(HEADING_RE) ?? []).length / SENSORY_HEADING_NORM,
      1.0,
    ),
    list_density: Math.min(
      (content.match(LIST_RE) ?? []).length / SENSORY_LIST_NORM,
      1.0,
    ),
  };
}

/**
 * Compute Level 0 (sensory) prediction errors.
 *
 * postcondition: returned PredictionLevel has freeEnergy >= 0.
 * source: predictive_coding_signals.py:compute_sensory_errors
 */
export function computeSensoryErrors(
  content: string,
  predictions: Record<string, number>,
  precisions: Record<string, number>,
): PredictionLevel {
  const observations = extractSensoryFeatures(content);
  const errors: Record<string, number> = {};
  let freeEnergy = 0.0;

  for (const [feat, pred] of Object.entries(predictions)) {
    const obs = observations[feat] ?? 0.0;
    const error = obs - pred;
    errors[feat] = error;
    const precision = precisions[feat] ?? 1.0;
    freeEnergy += precision * error ** 2;
  }

  return { level: 0, predictions, precisions, predictionErrors: errors, freeEnergy };
}

/**
 * Generate Level 0 predictions from recent memory statistics.
 *
 * postcondition: if no recent features, returns default predictions with
 *   uniform precision 0.5 (minimal prior knowledge).
 * source: predictive_coding_signals.py:compute_sensory_prediction
 */
export function computeSensoryPrediction(
  recentMemoriesFeatures: Record<string, number>[],
): [Record<string, number>, Record<string, number>] {
  if (recentMemoriesFeatures.length === 0) {
    const defaultPrec = Object.fromEntries(
      Object.keys(DEFAULT_SENSORY_PREDICTIONS).map((k) => [
        k,
        DEFAULT_SENSORY_PRECISION,
      ]),
    );
    return [{ ...DEFAULT_SENSORY_PREDICTIONS }, defaultPrec];
  }

  const features = Object.keys(recentMemoriesFeatures[0] ?? DEFAULT_SENSORY_PREDICTIONS);
  const predictions: Record<string, number> = {};
  const precisions: Record<string, number> = {};

  for (const feat of features) {
    const values = recentMemoriesFeatures.map((m) => m[feat] ?? 0.0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((a, v) => a + (v - mean) ** 2, 0) /
      Math.max(values.length - 1, 1);
    predictions[feat] = mean;
    precisions[feat] = Math.max(
      PRECISION_MIN,
      Math.min(PRECISION_MAX, 1.0 / Math.max(variance, VARIANCE_REGULARIZER)),
    );
  }

  return [predictions, precisions];
}

// ── Level 1 (entity) computation ───────────────────────────────────────────

/**
 * Compute Level 1 (entity) prediction errors.
 *
 * postcondition: returned PredictionLevel has freeEnergy >= 0.
 * source: predictive_coding_signals.py:compute_entity_errors
 */
export function computeEntityErrors(
  newEntityNames: string[],
  knownEntityNames: Set<string>,
  entityPredictions?: Record<string, number>,
  entityPrecisions?: Record<string, number>,
): PredictionLevel {
  const predictions = entityPredictions ?? {};
  const precisions = entityPrecisions ?? {};
  const newSet = new Set(newEntityNames);

  if (Object.keys(predictions).length > 0) {
    const errors: Record<string, number> = {};
    let freeEnergy = 0.0;
    for (const [entity, prob] of Object.entries(predictions)) {
      const prec = precisions[entity] ?? 1.0;
      const error = newSet.has(entity) ? 0.0 : prob;
      errors[entity] = error;
      freeEnergy += prec * error ** 2;
    }
    for (const entity of newEntityNames) {
      if (!(entity in predictions)) {
        errors[entity] = NOVEL_ENTITY_ERROR;
        freeEnergy += NOVEL_ENTITY_PRECISION * NOVEL_ENTITY_ERROR ** 2;
      }
    }
    return { level: 1, predictions, precisions, predictionErrors: errors, freeEnergy };
  }

  if (newEntityNames.length === 0) {
    return { level: 1, predictions: {}, precisions: {}, predictionErrors: {}, freeEnergy: 0.0 };
  }

  const novel = newEntityNames.filter((e) => !knownEntityNames.has(e)).length;
  const noveltyRatio = novel / newEntityNames.length;
  return {
    level: 1,
    predictions: {},
    precisions: {},
    predictionErrors: { entity_novelty_ratio: noveltyRatio },
    freeEnergy: noveltyRatio ** 2,
  };
}

// ── Level 2 (schema) computation ───────────────────────────────────────────

/**
 * Compute Level 2 (schema/domain) prediction errors.
 *
 * postcondition: returned PredictionLevel has freeEnergy >= 0.
 * source: predictive_coding_signals.py:compute_schema_errors
 */
export function computeSchemaErrors(
  schemaMatchScore: number,
  schemaFreeEnergy: number,
  domainFamiliarity = DEFAULT_DOMAIN_FAMILIARITY,
): PredictionLevel {
  const schemaError = 1.0 - schemaMatchScore;
  const domainPrecision =
    DOMAIN_PRECISION_BASE + domainFamiliarity * DOMAIN_PRECISION_GAIN;
  const totalFe =
    domainPrecision * schemaError ** 2 + schemaFreeEnergy * SCHEMA_FE_CARRYOVER;
  return {
    level: 2,
    predictions: {
      schema_match: schemaMatchScore,
      domain_familiarity: domainFamiliarity,
    },
    precisions: { schema_match: domainPrecision },
    predictionErrors: { schema_mismatch: schemaError },
    freeEnergy: totalFe,
  };
}

// ── Hierarchical orchestrator (compute_hierarchical_novelty) ────────────────
//
// Faithful port of core/hierarchical_predictive_coding.py. The hierarchical
// write-gate mode (CORTEX_MEMORY_WRITE_GATE_HIERARCHICAL=1) swaps ONLY the
// novelty SCORER for this sigmoid free-energy score and feeds it into the SAME
// flat gateDecision at the calibrated threshold (mirror remember_helpers.py:
// 158-163). It does NOT use hierarchicalGateDecision (the free-energy gate),
// which Cortex keeps for tests only.

/** Round to a fixed number of decimal places (matches Cortex round(x, n)). */
function roundTo(value: number, places: number): number {
  const factor = DECIMAL_RADIX ** places;
  return Math.round(value * factor) / factor;
}

// Sensory / Entity / Schema level weights.
// source: hierarchical_predictive_coding.py:61 — _LEVEL_WEIGHTS
const LEVEL_WEIGHT_SENSORY = 0.3; // source: hierarchical_predictive_coding.py:61 — _LEVEL_WEIGHTS
const LEVEL_WEIGHT_ENTITY = 0.35; // source: hierarchical_predictive_coding.py:61 — _LEVEL_WEIGHTS
const LEVEL_WEIGHT_SCHEMA = 0.35; // source: hierarchical_predictive_coding.py:61 — _LEVEL_WEIGHTS
const LEVEL_WEIGHTS: readonly [number, number, number] = [
  LEVEL_WEIGHT_SENSORY,
  LEVEL_WEIGHT_ENTITY,
  LEVEL_WEIGHT_SCHEMA,
];

// source: hierarchical_predictive_coding.py:73 — ach_norm denominator (0.3, 0.7)
const ACH_NORM_OFFSET = 0.3;
const ACH_NORM_SCALE = 0.7;
// source: hierarchical_predictive_coding.py:74-76 — bottom-up / top-down gains
const ACH_BU_BASE = 0.7;
const ACH_BU_GAIN = 0.6;
const ACH_TD_BASE = 1.3;
const ACH_TD_GAIN = 0.6;
// source: hierarchical_predictive_coding.py:145 — sigmoid steepness / midpoint
const NOVELTY_SIGMOID_K = 3.0;
const NOVELTY_SIGMOID_MID = 0.5;

/**
 * ACh-modulated level weights, normalized to sum to 1.
 *
 * High ACh (encoding): boost L0/L1 (bottom-up), reduce L2.
 * Low ACh (retrieval): boost L2 (top-down), reduce L0/L1.
 *
 * source: hierarchical_predictive_coding.py:_compute_ach_weights (67-84)
 */
export function computeAchWeights(achLevel: number): [number, number, number] {
  const achNorm = (achLevel - ACH_NORM_OFFSET) / ACH_NORM_SCALE;
  let w0 = LEVEL_WEIGHTS[0] * (ACH_BU_BASE + ACH_BU_GAIN * achNorm);
  let w1 = LEVEL_WEIGHTS[1] * (ACH_BU_BASE + ACH_BU_GAIN * achNorm);
  let w2 = LEVEL_WEIGHTS[2] * (ACH_TD_BASE - ACH_TD_GAIN * achNorm);
  const total = w0 + w1 + w2;
  if (total > 0) {
    w0 /= total;
    w1 /= total;
    w2 /= total;
  }
  return [w0, w1, w2];
}

/**
 * Aggregate level free energies into [totalFreeEnergy, noveltyScore].
 *
 * novelty = sigmoid(NOVELTY_SIGMOID_K * (totalFe - NOVELTY_SIGMOID_MID)),
 * clamped to [0, 1] — the same [0, 1] scale as the flat compute_novelty_score,
 * so the gate threshold and calibration EMA are unaffected by the scorer choice.
 *
 * source: hierarchical_predictive_coding.py:_aggregate_novelty (134-146)
 */
function aggregateNovelty(
  levels: readonly [PredictionLevel, PredictionLevel, PredictionLevel],
  achLevel: number,
): [number, number] {
  const [w0, w1, w2] = computeAchWeights(achLevel);
  const totalFe =
    w0 * levels[0].freeEnergy +
    w1 * levels[1].freeEnergy +
    w2 * levels[2].freeEnergy;
  const novelty =
    1.0 / (1.0 + Math.exp(-NOVELTY_SIGMOID_K * (totalFe - NOVELTY_SIGMOID_MID)));
  return [totalFe, Math.max(0.0, Math.min(1.0, novelty))];
}

/** Optional schema/ACh inputs for the hierarchical orchestrator (paper defaults). */
export interface HierarchicalNoveltyOpts {
  schemaMatchScore?: number;
  schemaFreeEnergy?: number;
  schemaPredictions?: Record<string, number>;
  schemaPrecisions?: Record<string, number>;
  domainFamiliarity?: number;
  achLevel?: number;
}

/**
 * Run the full hierarchical predictive-coding pipeline and return a
 * HierarchicalPrediction whose noveltyScore is the sigmoid free-energy score.
 *
 * Schema level (L2) uses the neutral default schema_match here because schema
 * matching runs after the gate; with the defaults its free energy is a constant
 * 1.5 (documented limitation — see remember_helpers.py:_hierarchical_novelty_score).
 *
 * Precision modulation (NE/ACh on level precisions) is intentionally omitted:
 * the remember-path caller passes no PrecisionState, mirroring
 * _hierarchical_novelty_score, which calls compute_hierarchical_novelty without
 * a precision_state (so _apply_precision_modulation is skipped).
 *
 * source: hierarchical_predictive_coding.py:compute_hierarchical_novelty (149-186)
 */
export function computeHierarchicalNovelty(
  content: string,
  newEntityNames: string[],
  knownEntityNames: Set<string>,
  recentMemoriesFeatures: Record<string, number>[],
  opts: HierarchicalNoveltyOpts = {},
): HierarchicalPrediction {
  const schemaMatchScore = opts.schemaMatchScore ?? 0.0;
  const schemaFreeEnergy = opts.schemaFreeEnergy ?? 0.0;
  const domainFamiliarity =
    opts.domainFamiliarity ?? DEFAULT_DOMAIN_FAMILIARITY;
  const achLevel = opts.achLevel ?? DEFAULT_ACH_LEVEL;

  const [sensoryPred, sensoryPrec] = computeSensoryPrediction(
    recentMemoriesFeatures,
  );
  const level0 = computeSensoryErrors(content, sensoryPred, sensoryPrec);
  const level1 = computeEntityErrors(
    newEntityNames,
    knownEntityNames,
    opts.schemaPredictions,
    opts.schemaPrecisions,
  );
  const level2 = computeSchemaErrors(
    schemaMatchScore,
    schemaFreeEnergy,
    domainFamiliarity,
  );
  const levels: [PredictionLevel, PredictionLevel, PredictionLevel] = [
    level0,
    level1,
    level2,
  ];

  const [totalFe, novelty] = aggregateNovelty(levels, achLevel);

  return {
    levels,
    totalFreeEnergy: roundTo(totalFe, FREE_ENERGY_DECIMALS),
    noveltyScore: roundTo(novelty, SIGNAL_DECIMALS),
    gateOpen: false,
    gateReason: "",
  };
}

// ── Hierarchical gate decision (TEST-PARITY ONLY) ──────────────────────────

const DEFAULT_HIERARCHICAL_THRESHOLD = 0.15;

/**
 * Gate decision using hierarchical free energy.
 *
 * TEST-PARITY ONLY — mirrors predictive_coding_gate.py:hierarchical_gate_decision,
 * which in Cortex is referenced ONLY by tests, NEVER by the production write
 * path. Do NOT call this from scoreCandidate: the production hierarchical mode
 * swaps the scorer (computeHierarchicalNovelty) and reuses the flat gateDecision.
 *
 * precondition:  prediction is a valid HierarchicalPrediction.
 * postcondition: (true, reason) iff bypass or total_free_energy >= threshold.
 * source: predictive_coding_gate.py:hierarchical_gate_decision
 */
export function hierarchicalGateDecision(
  prediction: HierarchicalPrediction,
  threshold = DEFAULT_HIERARCHICAL_THRESHOLD,
  bypass = false,
): [boolean, string] {
  if (bypass) return [true, "bypass"];
  const fe = prediction.totalFreeEnergy;
  if (fe >= threshold) {
    const levelNames = ["sensory", "entity", "schema"] as const;
    const dominant = prediction.levels.reduce(
      (best, lvl) => (lvl.freeEnergy > best.freeEnergy ? lvl : best),
      prediction.levels[0],
    );
    return [
      true,
      `high_free_energy (FE=${fe.toFixed(DISPLAY_DECIMALS)}, dominant=${levelNames[dominant.level]})`,
    ];
  }
  return [
    false,
    `low_free_energy (FE=${fe.toFixed(DISPLAY_DECIMALS)}, threshold=${threshold})`,
  ];
}
