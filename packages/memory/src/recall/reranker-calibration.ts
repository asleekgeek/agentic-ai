/**
 * Per-process store for Platt calibration of FlashRank reranker scores.
 *
 * Collects (rawScore, label) training pairs from `rate_memory` feedback
 * and fits Platt parameters every N pairs. The fitted parameters are cached
 * and applied in the reranker blend step.
 *
 * Persistence to a `reranker_calibration` table is deferred. The in-process
 * state is reset on restart, which is acceptable:
 *
 *   - Calibration converges in O(MIN_SAMPLES) rate_memory calls.
 *   - Cold start returns raw scores (the current production behaviour), so
 *     restart is never worse than the pre-AF-2 baseline.
 *
 * Pure business logic — module-level mutable state is explicit and audited at
 * the call site (coding-standards §7.2 Construct 1 override for
 * write-once-at-startup / runtime-seed configuration).
 *
 * Port of: cortex core/reranker_calibration.py:1-87
 */

import {
  MIN_SAMPLES,
  fitPlatt,
  type PlattParams,
  type TrainingSample,
} from "./platt-calibration.js";

// ── Config ──────────────────────────────────────────────────────────────
// source: cortex core/reranker_calibration.py:31-32

export const REFIT_EVERY = 50; // Refit parameters every N new samples.
export const MAX_SAMPLES = 2000; // source: cortex core/reranker_calibration.py — FIFO cap so memory doesn't grow unboundedly.

// ── State ───────────────────────────────────────────────────────────────
// source: cortex core/reranker_calibration.py:37-39

const samples: TrainingSample[] = [];
let params: PlattParams | null = null;
let samplesAtLastFit = 0;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Add one (rawScore, useful) pair and possibly refit.
 *
 * precondition:  rawScore is a finite number (the FlashRank CE score at
 *   surfacing time); useful is the user's rating (true/false).
 * postcondition: the samples buffer has one more pair (bounded at MAX_SAMPLES
 *   via FIFO trim). If the number of samples since the last fit crossed
 *   REFIT_EVERY AND the total size is >= MIN_SAMPLES, params is refit via
 *   `fitPlatt`.
 *
 * source: cortex core/reranker_calibration.py:45-69
 */
export function recordRating(rawScore: number, useful: boolean): void {
  samples.push({ rawScore, label: useful ? 1 : 0 });
  if (samples.length > MAX_SAMPLES) {
    // FIFO trim — keep the most recent MAX_SAMPLES pairs.
    samples.splice(0, samples.length - MAX_SAMPLES);
  }

  const samplesSinceFit = samples.length - samplesAtLastFit;
  if (samplesSinceFit >= REFIT_EVERY && samples.length >= MIN_SAMPLES) {
    const fitted = fitPlatt([...samples]);
    if (fitted !== null) {
      params = fitted;
      samplesAtLastFit = samples.length;
    }
  }
}

/**
 * Return the currently-fitted Platt parameters, or null if untrained.
 * source: cortex core/reranker_calibration.py:72-74
 */
export function getParams(): PlattParams | null {
  return params;
}

/**
 * Return the number of collected (rawScore, useful) pairs.
 * source: cortex core/reranker_calibration.py:77-79
 */
export function sampleCount(): number {
  return samples.length;
}

/**
 * Test-only hook: reset all in-process calibration state.
 * source: cortex core/reranker_calibration.py:82-87
 */
export function resetForTests(): void {
  samples.length = 0;
  params = null;
  samplesAtLastFit = 0;
}
