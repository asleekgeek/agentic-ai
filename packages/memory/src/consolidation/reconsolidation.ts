/**
 * Memory reconsolidation — memories become labile on retrieval and may be rewritten.
 *
 * Based on Nader et al. (Nature, 2000) and Osan-Tort-Amaral (PLoS ONE, 2011).
 *
 * Three outcomes based on mismatch between stored memory and current context:
 *   - mismatch < low_threshold: Passive retrieval, no change
 *   - low <= mismatch < high: RECONSOLIDATE — update memory with current context
 *   - mismatch >= high: EXTINCTION — archive old memory, create new one
 *
 * Emotional modulation:
 *   // source: Yonelinas & Ritchey (2015) — decay ratio b_neutral/b_emotional = 2.0
 *   // source: Lee (2009, Trends Neurosci) PE gate: PE = mismatch * (1 - stability * 0.5)
 *   // source: Milekic & Alberini (2002) age-dependent threshold: older memories resist
 *   // source: Nader K et al. (2000) Nature 406:722-726 — reconsolidation after retrieval
 *   // source: Osan-Tort-Amaral (PLoS ONE 2011) — low/high threshold values
 *
 * Reconsolidation regime — emotional multiplier (Yonelinas & Ritchey 2015):
 *   Decay ratio b_neutral/b_emotional = 2.0 → up to 1.8x at arousal=0.8
 *
 * Port of: mcp_server/core/reconsolidation.py
 * Pure business logic — no I/O.
 */

import * as nodePath from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

// Temporal distance
// source: mathematical constant — milliseconds per hour
const MS_PER_HOUR = 3_600_000;
// source: mathematical constant — hours in one week (temporal normalization window)
const HOURS_PER_WEEK = 168.0;
// source: engineering default — neutral fallback when timestamp is absent or invalid
const TEMPORAL_DISTANCE_FALLBACK = 0.5;

// Mismatch signal weights (must sum to 1.0)
// source: port of mcp_server/core/reconsolidation.py — hand-set composition weights.
//         Cortex attributes Osan-Tort-Amaral (2011) only to the mismatch THRESHOLDS
//         (below), not to these weights; no paper source for the weight split.
const MISMATCH_WEIGHT_EMBEDDING = 0.5;
const MISMATCH_WEIGHT_DIRECTORY = 0.2;
const MISMATCH_WEIGHT_TEMPORAL = 0.15;
const MISMATCH_WEIGHT_TAG = 0.15;

// Directory distance — sibling-directory partial mismatch
// source: engineering default — 0.0 same dir, 0.5 sibling, 1.0 unrelated
const DIR_DISTANCE_SIBLING = 0.5;

// Reconsolidation thresholds (default values when caller does not override)
// source: Osan-Tort-Amaral (PLoS ONE, 2011) — low/high threshold values for
//         the three-outcome reconsolidation regime (none / update / archive)
const DEFAULT_LOW_THRESHOLD = 0.15;
const DEFAULT_HIGH_THRESHOLD = 0.65;

// Prediction error gate stability dampening coefficient
// source: Lee (Trends Neurosci, 2009) — PE gate: PE = mismatch * (1 - stability * 0.5)
const PE_GATE_STABILITY_COEFF = 0.5;

// Age-dependent threshold parameters
// source: Milekic & Alberini (2002) — older memories require larger prediction error
//         to destabilize; normalization window and age-factor scale from Python port
const AGE_NORMALIZATION_DAYS = 30.0;
const AGE_FACTOR_SCALE = 0.15;

// Stability modulation of effective thresholds
// source: engineering default — calibration pending (see docs/provenance/blend-weight-calibration.md)
const STABILITY_LOW_COEFF = 0.2;
const STABILITY_HIGH_COEFF = 0.1;

// Plasticity susceptibility threshold and adjustment
// source: engineering default — calibration pending (see docs/provenance/blend-weight-calibration.md)
const PLASTICITY_SUSCEPTIBILITY_THRESHOLD = 0.5;
const PLASTICITY_THRESHOLD_ADJUSTMENT = 0.1;

// Emotional arousal cap and strength-delta gain
// source: Yonelinas & Ritchey (2015) — decay ratio b_neutral/b_emotional = 2.0,
//         arousal capped at 0.8 yields up to 1.8x multiplier; gain 0.1 from Python port
const EMOTIONAL_AROUSAL_CAP = 0.8;
const STRENGTH_DELTA_GAIN = 0.1;

// Strength delta on archive (extinction regime)
// source: engineering default — calibration pending (see docs/provenance/blend-weight-calibration.md)
const ARCHIVE_STRENGTH_DELTA = -0.2;

// Content merge lengths
// source: engineering default — max merged length and prefix/suffix window for truncation
const MERGE_MAX_DEFAULT_LENGTH = 2000;
const MERGE_CONTENT_WINDOW = 500;

// Plasticity decay half-life and access spike
// source: engineering default — calibration pending (see docs/provenance/blend-weight-calibration.md)
const PLASTICITY_HALF_LIFE_HOURS_DEFAULT = 6.0;
const PLASTICITY_SPIKE_DEFAULT = 0.3;

// Stability update increment and access-count threshold
// source: engineering default — calibration pending (see docs/provenance/blend-weight-calibration.md)
const STABILITY_INCREMENT_DEFAULT = 0.1;
const STABILITY_DECAY_COEFF = 0.5;
const ACCESS_COUNT_THRESHOLD = 5;

// ── Temporal Distance ─────────────────────────────────────────────────────────

function temporalDistance(memoryLastAccessed: string | null | undefined): number {
  if (!memoryLastAccessed) return TEMPORAL_DISTANCE_FALLBACK;
  try {
    const last = new Date(memoryLastAccessed);
    if (isNaN(last.getTime())) return TEMPORAL_DISTANCE_FALLBACK;
    const hours = (Date.now() - last.getTime()) / MS_PER_HOUR;
    return Math.min(hours / HOURS_PER_WEEK, 1.0); // normalize to 1 week
  } catch {
    return TEMPORAL_DISTANCE_FALLBACK;
  }
}

// ── Tag Divergence ────────────────────────────────────────────────────────────

function tagDivergence(
  memoryTags: ReadonlySet<string>,
  contextTokens: ReadonlySet<string>,
): number {
  if (memoryTags.size > 0 && contextTokens.size > 0) {
    let intersection = 0;
    for (const t of memoryTags) {
      if (contextTokens.has(t)) intersection++;
    }
    const union = new Set([...memoryTags, ...contextTokens]).size;
    return 1.0 - (union > 0 ? intersection / union : 0.0);
  }
  if (memoryTags.size === 0 && contextTokens.size === 0) return 0.0;
  return 1.0;
}

// ── Mismatch Computation ──────────────────────────────────────────────────────

export interface MismatchInput {
  embeddingSimilarity: number | null;
  memoryDirectory: string;
  currentDirectory: string;
  memoryLastAccessed: string | null | undefined;
  memoryTags: ReadonlySet<string>;
  contextTokens: ReadonlySet<string>;
}

/**
 * Compute multi-signal mismatch between stored memory and retrieval context.
 *
 * Signals (weighted):
 *   1. Embedding distance (0.5): 1.0 - cosine_similarity
 *   2. Directory distance (0.2): 0.0/0.5/1.0
 *   3. Temporal distance (0.15): hours since last access, normalized to 1 week
 *   4. Tag divergence (0.15): 1.0 - jaccard_similarity
 */
export function computeMismatch(input: MismatchInput): number {
  const embDistance =
    input.embeddingSimilarity === null
      ? TEMPORAL_DISTANCE_FALLBACK
      : 1.0 - input.embeddingSimilarity;

  let dirDistance: number;
  if (input.memoryDirectory === input.currentDirectory) {
    dirDistance = 0.0;
  } else if (
    nodePath.dirname(input.memoryDirectory) === nodePath.dirname(input.currentDirectory)
  ) {
    dirDistance = DIR_DISTANCE_SIBLING;
  } else {
    dirDistance = 1.0;
  }

  const mismatch =
    MISMATCH_WEIGHT_EMBEDDING * embDistance +
    MISMATCH_WEIGHT_DIRECTORY * dirDistance +
    MISMATCH_WEIGHT_TEMPORAL * temporalDistance(input.memoryLastAccessed) +
    MISMATCH_WEIGHT_TAG * tagDivergence(input.memoryTags, input.contextTokens);

  return Math.max(0.0, Math.min(1.0, mismatch));
}

// ── Decision Types ────────────────────────────────────────────────────────────

export type ReconsolidationAction = "none" | "update" | "archive";

export interface ReconsolidationResult {
  action: ReconsolidationAction;
  predictionError: number;
  strengthDelta: number;
  emotionalMultiplier: number;
}

// ── Action Decision ───────────────────────────────────────────────────────────

export interface DecideActionOptions {
  lowThreshold?: number;
  highThreshold?: number;
}

/**
 * Determine reconsolidation action based on mismatch and memory state.
 *
 * // source: Osan-Tort-Amaral (PLoS ONE, 2011) — thresholds.
 * // source: Lee (Trends Neurosci, 2009) — PE gate.
 * // source: Milekic & Alberini (2002) — age-dependent threshold.
 * // source: Yonelinas & Ritchey (2015) — emotional multiplier.
 *   Decay ratio b_neutral/b_emotional = 2.0 → up to 1.8x at arousal=0.8.
 */
export function decideAction(
  mismatch: number,
  stability = 0.0,
  plasticity = 1.0,
  isProtected = false,
  emotionalArousal = 0.0,
  ageDays = 0.0,
  opts: DecideActionOptions = {},
): ReconsolidationResult {
  if (isProtected) {
    return { action: "none", predictionError: 0.0, strengthDelta: 0.0, emotionalMultiplier: 1.0 };
  }

  const { lowThreshold = DEFAULT_LOW_THRESHOLD, highThreshold = DEFAULT_HIGH_THRESHOLD } = opts;

  // Prediction error gate (Lee 2009): stable memories dampen PE
  const predictionError = mismatch * (1.0 - stability * PE_GATE_STABILITY_COEFF);

  // Age-dependent threshold (Milekic & Alberini 2002):
  // Older memories require larger PE to destabilize
  const ageFactor = Math.min(ageDays / AGE_NORMALIZATION_DAYS, 1.0) * AGE_FACTOR_SCALE;
  let effectiveLow = lowThreshold + ageFactor + stability * STABILITY_LOW_COEFF;
  let effectiveHigh = highThreshold + stability * STABILITY_HIGH_COEFF;

  // Recently accessed (high plasticity) memories are MORE susceptible
  if (plasticity > PLASTICITY_SUSCEPTIBILITY_THRESHOLD) {
    effectiveLow -= PLASTICITY_THRESHOLD_ADJUSTMENT;
    effectiveHigh -= PLASTICITY_THRESHOLD_ADJUSTMENT;
  }

  if (predictionError < effectiveLow) {
    return { action: "none", predictionError, strengthDelta: 0.0, emotionalMultiplier: 1.0 };
  }
  if (predictionError >= effectiveHigh) {
    return {
      action: "archive",
      predictionError,
      strengthDelta: ARCHIVE_STRENGTH_DELTA,
      emotionalMultiplier: 1.0,
    };
  }

  // Reconsolidation regime — emotional multiplier (Yonelinas & Ritchey 2015)
  // Decay ratio b_neutral/b_emotional = 2.0 → up to 1.8x at arousal=0.8
  const emotionalMultiplier = 1.0 + Math.min(emotionalArousal, EMOTIONAL_AROUSAL_CAP);
  const strengthDelta = predictionError * STRENGTH_DELTA_GAIN * emotionalMultiplier;

  return { action: "update", predictionError, strengthDelta, emotionalMultiplier };
}

// ── Content Merge ─────────────────────────────────────────────────────────────

/**
 * Merge new context into existing memory content.
 *
 * If merged exceeds maxLength, keeps first 500 + last 500 of old + full new.
 */
export function mergeContent(
  oldContent: string,
  newContext: string,
  maxLength = MERGE_MAX_DEFAULT_LENGTH,
): string {
  const merged = `${oldContent}\n--- Updated context ---\n${newContext}`;
  if (merged.length <= maxLength) return merged;

  const oldPrefix = oldContent.slice(0, MERGE_CONTENT_WINDOW);
  const oldSuffix = oldContent.length > MERGE_CONTENT_WINDOW ? oldContent.slice(-MERGE_CONTENT_WINDOW) : "";
  if (oldSuffix) {
    return `${oldPrefix}\n...\n${oldSuffix}\n--- Updated context ---\n${newContext}`;
  }
  return `${oldPrefix}\n--- Updated context ---\n${newContext}`;
}

// ── Plasticity / Stability ────────────────────────────────────────────────────

/**
 * Spike plasticity on access with exponential decay since last update.
 * Plasticity decays with half-life, then spikes on each access.
 */
export function computePlasticityDecay(
  currentPlasticity: number,
  hoursElapsed: number,
  halfLifeHours = PLASTICITY_HALF_LIFE_HOURS_DEFAULT,
  spike = PLASTICITY_SPIKE_DEFAULT,
): number {
  let p = currentPlasticity;
  if (hoursElapsed > 0 && halfLifeHours > 0) {
    p *= Math.pow(2, -hoursElapsed / halfLifeHours);
  }
  return Math.min(p + spike, 1.0);
}

/**
 * Update stability based on usefulness feedback.
 * Useful retrievals increase stability; frequent non-useful retrievals decrease it.
 */
export function updateStability(
  currentStability: number,
  wasUseful: boolean,
  accessCount: number,
  increment = STABILITY_INCREMENT_DEFAULT,
): number {
  if (wasUseful) return Math.min(currentStability + increment, 1.0);
  if (accessCount > ACCESS_COUNT_THRESHOLD)
    return Math.max(currentStability - increment * STABILITY_DECAY_COEFF, 0.0);
  return currentStability;
}
