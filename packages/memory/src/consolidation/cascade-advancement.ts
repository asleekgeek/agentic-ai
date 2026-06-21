/**
 * Consolidation cascade — stage advancement and reconsolidation logic.
 *
 * Split from cascade.py to keep files under the 300-line cap.
 * Contains the transition logic that determines when memories advance
 * between consolidation stages.
 *
 * Schema acceleration (Tse et al. 2007):
 *   Tse showed that rodents with pre-existing spatial schemas consolidated
 *   new schema-consistent associations in ~48 hours, compared to ~2-4 weeks
 *   for schema-inconsistent ones — an approximately 10-15x acceleration.
 *   This applies specifically to systems consolidation (LATE_LTP → CONSOLIDATED),
 *   not to earlier synaptic stages.
 *
 *   IMPORTANT: Tse 2007 is an experimental finding, not a computational model.
 *   No paper in this chain provides a mathematical function mapping
 *   schema_match to consolidation rate. The exponential model used here
 *   (15^(-schema_match)) is an engineering approximation chosen to:
 *   (a) match the ~15x magnitude at full schema match,
 *   (b) provide diminishing returns at low match,
 *   (c) equal 1.0 (no acceleration) at zero match.
 *   The functional form and the 15.0 constant are engineering choices,
 *   not paper-derived equations.
 *
 * References:
 *   Tse D et al. (2007) Schemas and memory consolidation. Science 316:76-82
 *   Kandel ER (2001) The molecular biology of memory storage.
 *   Nader K et al. (2000) Fear memories require protein synthesis in the
 *     amygdala for reconsolidation after retrieval. Nature 406:722-726
 *   McClelland JL et al. (1995) Why are there complementary learning systems. Psychol Rev.
 *   Frey U, Morris RGM (1997) Synaptic tagging and LTP. Nature 385:533-536
 *
 * Pure business logic — no I/O.
 *
 * Port of: mcp_server/core/cascade_advancement.py
 * source: cortex main mcp_server/core/cascade_advancement.py
 */

import { isMechanismDisabled, Mechanism } from "./ablation.js";

// ── Stage constants ────────────────────────────────────────────────────────

export const ConsolidationStage = {
  LABILE: "labile",
  EARLY_LTP: "early_ltp",
  LATE_LTP: "late_ltp",
  CONSOLIDATED: "consolidated",
  RECONSOLIDATING: "reconsolidating",
} as const;

export type ConsolidationStageValue =
  (typeof ConsolidationStage)[keyof typeof ConsolidationStage];

// Stage name constants (local aliases for readability)
const LABILE = ConsolidationStage.LABILE;
const EARLY_LTP = ConsolidationStage.EARLY_LTP;
const LATE_LTP = ConsolidationStage.LATE_LTP;
const CONSOLIDATED = ConsolidationStage.CONSOLIDATED;
const RECONSOLIDATING = ConsolidationStage.RECONSOLIDATING;

// Minimum dwell hours per stage (from cascade_stages.py StageProperties).
// source: cortex main mcp_server/core/cascade_stages.py (imported by cascade_advancement.py)
const STAGE_MIN_DWELL_HOURS: Record<string, number> = {
  labile: 0.0,
  early_ltp: 1.0,
  late_ltp: 6.0,
  consolidated: 48.0,
  reconsolidating: 2.0,
};

// Systems consolidation stages (Tse 2007 applies to these two).
// source: cortex main mcp_server/core/cascade_advancement.py:141
const SYSTEMS_STAGES = new Set<string>([LATE_LTP, CONSOLIDATED]);

// ── Schema-acceleration constants ─────────────────────────────────────────
//
// These are engineering choices calibrated against Tse et al. (2007)'s
// ~10-15x acceleration magnitude. No paper provides equations; values are
// hand-tuned. Source: cascade_advancement.py header + lines 143-153.
// source: engineering choice — calibration pending; mcp_server/core/cascade_advancement.py:143

// Base for schema-acceleration exponential: 15^(-schema_match).
// Matches experimental ~10-15x magnitude (Tse 2007). Engineering approximation.
// source: engineering choice — see cascade_advancement.py header: "The functional form
//   and the 15.0 constant are engineering choices, not paper-derived equations."
const SCHEMA_ACCEL_BASE = 15.0;

// Linear-attenuation coefficient for pre-systems stages (hand-tuned).
// source: engineering choice — mcp_server/core/cascade_advancement.py:153
const EARLY_SCHEMA_ATTENUATION = 0.2;

// ── Stage-readiness formula constants ─────────────────────────────────────
//
// All values below are engineering choices: thresholds and coefficients in
// readiness formulas that were hand-tuned to reflect biological plausibility
// but have no paper-derived equation mapping them exactly. Each constant cites
// the Python line where the same value appears.
// source: engineering choice — mcp_server/core/cascade_advancement.py

// Importance threshold for LABILE -> EARLY_LTP (moderately important).
// source: engineering choice — cascade_advancement.py:59
const LABILE_IMPORTANCE_THRESHOLD = 0.3;

// Dopamine offset in LABILE readiness formula: (dopamine - 0.5) / 1.5 + importance * 0.5
// source: engineering choice — cascade_advancement.py:60
const LABILE_READINESS_DA_OFFSET = 0.5;

// Dopamine scale in LABILE readiness formula.
// source: engineering choice — cascade_advancement.py:60
const LABILE_READINESS_DA_SCALE = 1.5;

// Importance weight in LABILE readiness formula.
// source: engineering choice — cascade_advancement.py:60
const LABILE_READINESS_IMPORTANCE_WEIGHT = 0.5;

// Importance threshold for EARLY_LTP -> LATE_LTP (strong encoding).
// source: engineering choice — cascade_advancement.py:82
const EARLY_LTP_IMPORTANCE_THRESHOLD = 0.4;

// Importance weight in EARLY_LTP readiness formula: replay/2 + importance * 0.5
// source: engineering choice — cascade_advancement.py:83
const EARLY_LTP_READINESS_IMPORTANCE_WEIGHT = 0.5;

// Schema-match threshold below which full replay count (3) is required.
// source: engineering choice — cascade_advancement.py:103
const LATE_LTP_SCHEMA_FAST_THRESHOLD = 0.5;

// Replay count required for LATE_LTP -> CONSOLIDATED without schema boost.
// source: engineering choice — cascade_advancement.py:103
const LATE_LTP_REPLAY_THRESHOLD_NORMAL = 3;

// Replay count required with schema boost (schema >= LATE_LTP_SCHEMA_FAST_THRESHOLD).
// source: engineering choice — cascade_advancement.py:103
const LATE_LTP_REPLAY_THRESHOLD_SCHEMA = 1;

// Minimum denominator guard to avoid division by zero in readiness calculations.
// source: engineering choice — cascade_advancement.py:118, 184
const MIN_DWELL_FLOOR = 0.01;

// Default dopamine level / importance / stability parameter values.
// source: engineering choice — cascade_advancement.py:160, 163, 202
const DEFAULT_DOPAMINE_LEVEL = 1.0;
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_STABILITY = 0.5;

// Cap on readiness score while min-dwell not yet elapsed (just below 1.0).
// source: engineering choice — cascade_advancement.py:185
const READINESS_PREDWELL_CAP = 0.99;

// Base mismatch threshold for reconsolidation.
// source: engineering choice — cascade_advancement.py:203
const DEFAULT_MISMATCH_THRESHOLD = 0.3;

// Stability multiplier applied to the effective reconsolidation threshold.
// source: engineering choice — cascade_advancement.py:228
const RECONSOLIDATION_STABILITY_FACTOR = 0.3;

// ── Schema acceleration ────────────────────────────────────────────────────

/**
 * Compute schema-accelerated minimum dwell time.
 *
 * For systems consolidation stages (late_ltp, consolidated):
 *   Uses exponential acceleration: dwell * 15^(-schema_match).
 *   At schema_match=1.0: ~15x faster (Tse 2007: ~2-4 weeks → 48h).
 *   At schema_match=0.0: no acceleration.
 *   Engineering approximation — Tse 2007 provides no equation.
 *   The 15.0 constant matches the experimental ~10-15x magnitude.
 *   // source: cortex main mcp_server/core/cascade_advancement.py:144
 *
 * For earlier stages: Modest linear factor (hand-tuned, no paper basis).
 *   // source: cortex main mcp_server/core/cascade_advancement.py:147
 *
 * precondition:  stage is one of the 5 consolidation stage names; schemaMatch in [0, 1].
 * postcondition: returns a non-negative float (hours).
 *
 * Port of: mcp_server/core/cascade_advancement.py::_effective_min_dwell
 * source: cortex main mcp_server/core/cascade_advancement.py:122
 */
export function effectiveMinDwell(
  stage: string,
  schemaMatch: number,
): number {
  const baseDwell = STAGE_MIN_DWELL_HOURS[stage] ?? 0;
  if (SYSTEMS_STAGES.has(stage)) {
    // Tse et al. (2007): ~15x acceleration for schema-consistent memories.
    // Engineering approximation: exponential gives diminishing returns.
    const schemaFactor = Math.pow(SCHEMA_ACCEL_BASE, -schemaMatch); // source: cortex main cascade_advancement.py:144
    return baseDwell * schemaFactor;
  }
  // Earlier stages: modest acceleration (hand-tuned)
  const schemaFactor = 1.0 - schemaMatch * EARLY_SCHEMA_ATTENUATION; // source: cortex main cascade_advancement.py:147
  return baseDwell * schemaFactor;
}

// ── Stage-specific checks ──────────────────────────────────────────────────

/**
 * Check LABILE -> EARLY_LTP advancement conditions.
 *
 * Biological basis (Frey & Morris 1997): synaptic tagging requires
 * dopamine signal (DA >= 1.0) indicating the event was noteworthy,
 * OR sufficient importance from the encoding context.
 *
 * Advances if:
 *   - dopamineLevel >= 1.0 (encoding signal present), OR
 *   - importance > 0.3 (moderately important)
 *
 * // source: Frey U, Morris RGM (1997) Synaptic tagging and LTP. Nature 385:533-536
 * // source: cortex main mcp_server/core/cascade_advancement.py:43
 */
function checkLabileAdvancement(
  dopamineLevel: number,
  importance: number,
): [boolean, string, number] {
  const daReady = dopamineLevel >= DEFAULT_DOPAMINE_LEVEL; // source: cortex main cascade_advancement.py:58
  const importanceReady = importance > LABILE_IMPORTANCE_THRESHOLD; // source: cortex main cascade_advancement.py:59
  const readiness = Math.min(1.0, (dopamineLevel - LABILE_READINESS_DA_OFFSET) / LABILE_READINESS_DA_SCALE + importance * LABILE_READINESS_IMPORTANCE_WEIGHT);
  if (daReady || importanceReady) {
    return [true, EARLY_LTP, readiness];
  }
  return [false, LABILE, readiness];
}

/**
 * Check EARLY_LTP -> LATE_LTP advancement conditions.
 *
 * Biological basis (Kandel 2001): transition to late LTP requires
 * protein synthesis triggered by replay (reactivation) or high
 * importance (strong initial encoding).
 *
 * Advances if:
 *   - replayCount >= 1 (memory has been replayed/accessed), OR
 *   - importance > 0.4 (strong encoding)
 *
 * // source: Kandel ER (2001) The molecular biology of memory storage.
 * // source: cortex main mcp_server/core/cascade_advancement.py:66
 */
function checkEarlyLtpAdvancement(
  replayCount: number,
  importance: number,
): [boolean, string, number] {
  const replayReady = replayCount >= 1; // source: cortex main cascade_advancement.py:81
  const importanceBoost = importance > EARLY_LTP_IMPORTANCE_THRESHOLD; // source: cortex main cascade_advancement.py:82
  const readiness = Math.min(1.0, replayCount / 2.0 + importance * EARLY_LTP_READINESS_IMPORTANCE_WEIGHT);
  if (replayReady || importanceBoost) {
    return [true, LATE_LTP, readiness];
  }
  return [false, EARLY_LTP, readiness];
}

/**
 * Check LATE_LTP -> CONSOLIDATED advancement conditions.
 *
 * Biological basis (McClelland 1995, Kandel 2001): systems consolidation
 * requires hippocampal replay to transfer traces to cortical networks.
 * Schema-consistent memories consolidate faster (Tse 2007).
 *
 * Advances if:
 *   - replayCount >= replayThreshold (3 normally, 1 with schema >= 0.5)
 *
 * // source: Tse D et al. (2007) Science 316:76-82
 * // source: cortex main mcp_server/core/cascade_advancement.py:89
 */
function checkLateLtpAdvancement(
  replayCount: number,
  schemaMatch: number,
): [boolean, string, number] {
  const replayThreshold = schemaMatch < LATE_LTP_SCHEMA_FAST_THRESHOLD ? LATE_LTP_REPLAY_THRESHOLD_NORMAL : LATE_LTP_REPLAY_THRESHOLD_SCHEMA; // source: cortex main cascade_advancement.py:103
  const replayReady = replayCount >= replayThreshold;
  const readiness = Math.min(1.0, replayCount / Math.max(replayThreshold, 1));
  if (replayReady) {
    return [true, CONSOLIDATED, readiness];
  }
  return [false, LATE_LTP, readiness];
}

/**
 * Check RECONSOLIDATING -> EARLY_LTP re-stabilization.
 *
 * // source: Nader K et al. (2000) Nature 406:722-726
 * // source: cortex main mcp_server/core/cascade_advancement.py:111
 */
function checkReconsolidatingAdvancement(
  hoursInStage: number,
  effectiveMinDwellHours: number,
): [boolean, string, number] {
  if (hoursInStage >= effectiveMinDwellHours) {
    return [true, EARLY_LTP, 1.0];
  }
  const readiness = hoursInStage / Math.max(effectiveMinDwellHours, MIN_DWELL_FLOOR);
  return [false, RECONSOLIDATING, readiness];
}

// ── Public API ─────────────────────────────────────────────────────────────

// opts-object form kept for backward-compat with existing cascade.ts caller.
export interface AdvancementReadinessOptions {
  dopamineLevel?: number;
  replayCount?: number;
  schemaMatch?: number;
  importance?: number;
}

export interface AdvancementReadinessResult {
  ready: boolean;
  nextStage: string;
  readinessScore: number;
}

/**
 * Determine if a memory is ready to advance to the next consolidation stage.
 *
 * Overload 1 (positional, tuple return — Python-parity form):
 *   computeAdvancementReadiness(stage, hours, dopamine, replay, schema, importance)
 *   → [ready, nextStage, readinessScore]
 *
 * Overload 2 (opts-object, struct return — TS-idiomatic form for existing callers):
 *   computeAdvancementReadiness(stage, hours, opts?)
 *   → { ready, nextStage, readinessScore }
 *
 * precondition: currentStage is one of the 5 stage names; hoursInStage >= 0.
 * postcondition: when ready=false, nextStage equals currentStage.
 *   When ready=true, nextStage is the next stage in the cascade.
 *   readinessScore in [0, 1].
 *   When CASCADE ablated: always returns (false, currentStage, 0.0).
 *
 * Port of: mcp_server/core/cascade_advancement.py::compute_advancement_readiness
 * source: cortex main mcp_server/core/cascade_advancement.py:151
 */
export function computeAdvancementReadiness(
  currentStage: string,
  hoursInStage: number,
  dopamineLevelOrOpts?: number | AdvancementReadinessOptions,
  replayCount?: number,
  schemaMatch?: number,
  importance?: number,
): [boolean, string, number] | AdvancementReadinessResult {
  // Determine calling convention.
  // - undefined third arg → treat as positional (Python-parity tuple return)
  // - object third arg     → opts form (TS-idiomatic struct return)
  // - number third arg     → positional form
  // The tests call computeAdvancementReadiness("unknown_stage", 100) with no
  // third arg and destructure the result as a tuple, so undefined must take
  // the positional branch.
  const isOptsForm =
    typeof dopamineLevelOrOpts === "object" && dopamineLevelOrOpts !== null;

  let dopamine: number;
  let replay: number;
  let schema: number;
  let imp: number;

  if (isOptsForm) {
    const opts = (dopamineLevelOrOpts as AdvancementReadinessOptions | undefined) ?? {};
    dopamine = opts.dopamineLevel ?? DEFAULT_DOPAMINE_LEVEL;
    replay = opts.replayCount ?? 0;
    schema = opts.schemaMatch ?? 0.0;
    imp = opts.importance ?? DEFAULT_IMPORTANCE;
  } else {
    dopamine = (dopamineLevelOrOpts as number) ?? DEFAULT_DOPAMINE_LEVEL;
    replay = replayCount ?? 0;
    schema = schemaMatch ?? 0.0;
    imp = importance ?? DEFAULT_IMPORTANCE;
  }

  // Ablation guard
  if (isMechanismDisabled(Mechanism.CASCADE)) {
    if (isOptsForm) {
      return { ready: false, nextStage: currentStage, readinessScore: 0.0 };
    }
    return [false, currentStage, 0.0];
  }

  // Unknown stage guard
  if (!(currentStage in STAGE_MIN_DWELL_HOURS)) {
    if (isOptsForm) {
      return { ready: false, nextStage: currentStage, readinessScore: 0.0 };
    }
    return [false, currentStage, 0.0];
  }

  const minDwell = effectiveMinDwell(currentStage, schema);

  if (hoursInStage < minDwell) {
    const readiness = Math.min(hoursInStage / Math.max(minDwell, MIN_DWELL_FLOOR), READINESS_PREDWELL_CAP);
    if (isOptsForm) {
      return { ready: false, nextStage: currentStage, readinessScore: readiness };
    }
    return [false, currentStage, readiness];
  }

  let result: [boolean, string, number];
  if (currentStage === LABILE) {
    result = checkLabileAdvancement(dopamine, imp);
  } else if (currentStage === EARLY_LTP) {
    result = checkEarlyLtpAdvancement(replay, imp);
  } else if (currentStage === LATE_LTP) {
    result = checkLateLtpAdvancement(replay, schema);
  } else if (currentStage === RECONSOLIDATING) {
    result = checkReconsolidatingAdvancement(hoursInStage, minDwell);
  } else {
    // CONSOLIDATED: no further advancement
    if (isOptsForm) {
      return { ready: false, nextStage: currentStage, readinessScore: 1.0 };
    }
    return [false, currentStage, 1.0];
  }

  const [ready, nextStage, readinessScore] = result;
  if (isOptsForm) {
    return { ready, nextStage, readinessScore };
  }
  return [ready, nextStage, readinessScore];
}

/**
 * Determine if retrieval should trigger reconsolidation.
 *
 * Only CONSOLIDATED and LATE_LTP memories can reconsolidate.
 * Requires sufficient mismatch between retrieval context and stored context.
 * Higher stability means higher mismatch threshold needed.
 *
 * // source: Nader K et al. (2000) Fear memories require protein synthesis. Nature 406:722-726
 *
 * precondition: mismatchScore in [0, 1]; stability in [0, 1].
 * postcondition: returns tuple (triggered, newStage).
 *   triggered=true only for CONSOLIDATED or LATE_LTP stages.
 *
 * Port of: mcp_server/core/cascade_advancement.py::trigger_reconsolidation
 * source: cortex main mcp_server/core/cascade_advancement.py:192
 */
export function triggerReconsolidation(
  currentStage: string,
  mismatchScore: number,
  stability: number = DEFAULT_STABILITY,
  mismatchThreshold: number = DEFAULT_MISMATCH_THRESHOLD, // source: cortex main cascade_advancement.py:197
): [boolean, string] {
  if (currentStage !== CONSOLIDATED && currentStage !== LATE_LTP) {
    return [false, currentStage];
  }

  const effectiveThreshold = mismatchThreshold + stability * RECONSOLIDATION_STABILITY_FACTOR; // source: cortex main cascade_advancement.py:222

  if (mismatchScore >= effectiveThreshold) {
    return [true, RECONSOLIDATING];
  }

  return [false, currentStage];
}
