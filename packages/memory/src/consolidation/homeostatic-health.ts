/**
 * Homeostatic plasticity — distribution health metrics.
 *
 * Split from homeostatic_plasticity.py to keep files under 300 lines.
 * Computes statistical health metrics for value distributions (heats, weights)
 * to determine whether homeostatic mechanisms need to intervene.
 *
 * References:
 *   Pfister R et al. (2013) "Good things peak in pairs: a note on the
 *       bimodality coefficient." Frontiers in Psychology 4:700
 *   Pébay P (2008) "Formulas for Robust, One-Pass Parallel Computation of
 *       Covariances and Arbitrary-Order Statistical Moments." Sandia Report
 *       SAND2008-6212. Equations 2.1 (M1), 2.2 (M2), 2.3 (M3), 2.4 (M4).
 *
 * Port of: mcp_server/core/homeostatic_health.py
 * Pure business logic — no I/O.
 */

// ---------------------------------------------------------------------------
// Pébay (2008) SAND2008-6212 — moment update polynomial coefficients
// (equations 2.1–2.4, incremental single-pass updates for M4, M3, M2, M1).
// source: Pébay P (2008) "Formulas for Robust, One-Pass Parallel Computation
//   of Covariances and Arbitrary-Order Statistical Moments." Sandia Report
//   SAND2008-6212. Equations 2.1–2.4 and §3.1 pairwise merge.
// ---------------------------------------------------------------------------
/** Coefficient of (n²-3n+3) term in the M4 incremental update (Pébay 2008 eq 2.4). */
const PEBAY_M4_POLY_OFFSET = 3; // n^2 - 3n + 3
/** Coefficient multiplying δn²·M2 in the M4 incremental update (Pébay 2008 eq 2.4). */
const PEBAY_M4_M2_COEFF = 6.0;
/** Coefficient multiplying δn·M3 in the M4 incremental update (Pébay 2008 eq 2.4). */
const PEBAY_M4_M3_COEFF = 4.0;
/** Coefficient multiplying δn·M2 in the M3 incremental update (Pébay 2008 eq 2.3). */
const PEBAY_M3_M2_COEFF = 3.0;
/** Offset in the (n-2) factor of the M3 incremental update (Pébay 2008 eq 2.3). */
const PEBAY_M3_N_OFFSET = 2;

// ---------------------------------------------------------------------------
// Statistical moment conversion constants (standard textbook definitions).
// Skewness denominator exponent = 3 (third standardised central moment);
// kurtosis denominator exponent = 4 (fourth standardised central moment);
// excess kurtosis = raw − 3.
// source: port of mcp_server/core/homeostatic_health.py:95-96 (M3/(n·std**3),
//   M4/(n·std**4) − 3.0). Definitional standard-moment constants; the source of
//   truth cites no paper for them.
// ---------------------------------------------------------------------------
/** Exponent of σ in the skewness estimator denominator (third standard moment). */
const SKEW_STD_EXPONENT = 3;
/** Exponent of σ in the raw kurtosis estimator denominator (fourth standard moment). */
const KURTOSIS_STD_EXPONENT = 4;
/** Excess-kurtosis offset: excess = raw − 3 (standard definition; no paper cited in source of truth). */
const EXCESS_KURTOSIS_OFFSET = 3.0;

// ---------------------------------------------------------------------------
// Numerical stability floor for standard-deviation comparisons.
// source: port of mcp_server/core/homeostatic_health.py:94 (`if std > 1e-10`).
//   Bare engineering guard in the source of truth — no paper source. (Pébay 2008
//   §4 is cited by the source only for the 1e-9 four-pass postcondition, a
//   different quantity — not this floor.)
// ---------------------------------------------------------------------------
/** Minimum σ below which skew/kurtosis are set to 0 (numerical stability). */
const STD_STABILITY_FLOOR = 1e-10;

// ---------------------------------------------------------------------------
// Pfister (2013) bimodality coefficient formula constants.
// BC = (γ²+1) / (κ+3)   where γ=skewness, κ=excess kurtosis.
// "kurtosis + 3" restores the raw (non-excess) kurtosis; +3 is the
// excess-kurtosis offset above (raw − 3 standard definition), reused here.
// source: Pfister R et al. (2013) "Good things peak in pairs: a note on the
//   bimodality coefficient." Frontiers in Psychology 4:700. Equation 1.
// ---------------------------------------------------------------------------
/** Raw-kurtosis restore offset in the bimodality coefficient denominator (Pfister 2013 eq 1). */
const BIMODALITY_KURTOSIS_OFFSET = 3;
/** Numerical stability guard preventing division by zero in bimodality formula. */
const BIMODALITY_DENOM_MIN = 0.01;

// ---------------------------------------------------------------------------
// Rounding precision constant: round(x, 4) in Python ≡ Math.round(x * 10000) / 10000.
// 4 decimal places is the precision chosen in the Python port (homeostatic_health.py
// _health_from_moments). No external citation — implementation-convention match.
// ---------------------------------------------------------------------------
/** Multiplier for 4-decimal-place rounding (matches Python round(x, 4) convention). */
const ROUND_4DP_FACTOR = 10000;

// ---------------------------------------------------------------------------
// Health-score penalty weights and caps (_compute_health_score).
// source: port of core/homeostatic_health.py:L125-L129; true-hand-tuned,
//   no paper. All seven values are bare literals in the Python source of truth.
// ---------------------------------------------------------------------------
/** Maximum penalty subtracted for deviation from target mean (caps deviation * 2 term). */
const HEALTH_DEVIATION_MAX_PENALTY = 0.4;
/** Bimodality threshold: BC values above this begin incurring a health penalty. */
const HEALTH_BIMODALITY_THRESHOLD = 0.4;
/** Slope of the bimodality penalty: penalty = (BC - threshold) * slope. */
const HEALTH_BIMODALITY_SLOPE = 1.5;
/** Maximum penalty subtracted for bimodality. */
const HEALTH_BIMODALITY_MAX_PENALTY = 0.3;
/** Slope of the skewness penalty: penalty = |skew| * slope. */
const HEALTH_SKEW_SLOPE = 0.15;
/** Maximum penalty subtracted for extreme skewness. */
const HEALTH_SKEW_MAX_PENALTY = 0.2;
/** Standard deviation below which a low-variance penalty is applied. */
const HEALTH_LOW_STD_THRESHOLD = 0.05;
/** Penalty subtracted when std < HEALTH_LOW_STD_THRESHOLD. */
const HEALTH_LOW_STD_PENALTY = 0.1;

export interface DistributionHealth {
  mean: number;
  std: number;
  skew: number;
  kurtosis_excess: number;
  deviation_from_target: number;
  bimodality_coefficient: number;
  health_score: number;
}

const EMPTY_HEALTH: DistributionHealth = {
  mean: 0.0,
  std: 0.0,
  skew: 0.0,
  kurtosis_excess: 0.0,
  deviation_from_target: 1.0,
  bimodality_coefficient: 0.0,
  health_score: 0.0,
};

/**
 * Compute mean, std, skewness, and excess kurtosis in a single pass.
 *
 * Uses Welford's online algorithm extended to third and fourth central
 * moments (Pébay 2008, §2, equations 2.1–2.4). We maintain running
 * M2 (sum of squared deviations), M3 (sum of cubed deviations),
 * and M4 (sum of quartic deviations) via the incremental update
 * formulas. This is numerically stable and touches each value once.
 *
 * Precondition: values is an array of finite numbers.
 * Postcondition: results are within 1e-9 of the four-pass implementation
 *   on any well-conditioned input (Pébay 2008, §4 stability analysis).
 * Invariant (per iteration): after processing n values, (m1, M2, M3, M4)
 *   equal the exact running moments for the first n values.
 *
 * Source: Pébay (2008) SAND2008-6212, equations 2.1–2.4.
 */
function computeMoments(values: number[]): [number, number, number, number] {
  let n = 0;
  let m1 = 0.0;
  let m2 = 0.0;
  let m3 = 0.0;
  let m4 = 0.0;

  for (const x of values) {
    const n1 = n;
    n += 1;
    const delta = x - m1;
    const deltaN = delta / n;
    const deltaN2 = deltaN * deltaN;
    const term1 = delta * deltaN * n1;

    // Fourth moment must be updated before M3 and M2 (depends on old M2, M3).
    m4 +=
      term1 * deltaN2 * (n * n - PEBAY_M4_POLY_OFFSET * n + PEBAY_M4_POLY_OFFSET) +
      PEBAY_M4_M2_COEFF * deltaN2 * m2 -
      PEBAY_M4_M3_COEFF * deltaN * m3;
    // Third moment depends on old M2, must precede M2 update.
    m3 += term1 * deltaN * (n - PEBAY_M3_N_OFFSET) - PEBAY_M3_M2_COEFF * deltaN * m2;
    m2 += term1;
    m1 += deltaN;
  }

  if (n === 0) {
    return [0.0, 0.0, 0.0, 0.0];
  }

  const variance = m2 / Math.max(n - 1, 1);
  const std = Math.sqrt(variance);

  let skew = 0.0;
  let kurtosis = 0.0;
  if (std > STD_STABILITY_FLOOR) {
    skew = m3 / (n * std ** SKEW_STD_EXPONENT);
    kurtosis = m4 / (n * std ** KURTOSIS_STD_EXPONENT) - EXCESS_KURTOSIS_OFFSET;
  }

  return [m1, std, skew, kurtosis];
}

/**
 * Compute overall health score from distribution statistics.
 *
 * Health = 1.0 (perfectly healthy) to 0.0 (needs intervention).
 * Penalizes: high deviation, high bimodality, extreme skew, low variance.
 *
 * Precondition: all arguments are finite numbers.
 * Postcondition: result is clamped to [0, 1].
 */
function computeHealthScore(
  deviation: number,
  bimodality: number,
  skew: number,
  std: number,
): number {
  let health = 1.0;
  health -= Math.min(deviation * 2.0, HEALTH_DEVIATION_MAX_PENALTY);
  health -= Math.min(Math.max(bimodality - HEALTH_BIMODALITY_THRESHOLD, 0) * HEALTH_BIMODALITY_SLOPE, HEALTH_BIMODALITY_MAX_PENALTY);
  health -= Math.min(Math.abs(skew) * HEALTH_SKEW_SLOPE, HEALTH_SKEW_MAX_PENALTY);
  if (std < HEALTH_LOW_STD_THRESHOLD) health -= HEALTH_LOW_STD_PENALTY;
  return Math.max(0.0, Math.min(1.0, health));
}

function healthFromMoments(
  mean: number,
  std: number,
  skew: number,
  kurtosis: number,
  targetMean: number,
): DistributionHealth {
  // Pfister 2013 bimodality coefficient formula
  const bimodality =
    (skew ** 2 + 1) / Math.max(kurtosis + BIMODALITY_KURTOSIS_OFFSET, BIMODALITY_DENOM_MIN);
  const deviation = Math.abs(mean - targetMean);
  const health = computeHealthScore(deviation, bimodality, skew, std);

  return {
    mean: Math.round(mean * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
    std: Math.round(std * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
    skew: Math.round(skew * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
    kurtosis_excess: Math.round(kurtosis * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
    deviation_from_target: Math.round(deviation * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
    bimodality_coefficient: Math.round(bimodality * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
    health_score: Math.round(health * ROUND_4DP_FACTOR) / ROUND_4DP_FACTOR,
  };
}

/**
 * Compute health metrics for a distribution of values (heats, weights, etc.).
 *
 * Returns metrics that indicate whether homeostatic mechanisms are needed.
 *
 * @param values - List of values (e.g., heats).
 * @param targetMean - Desired mean value.
 * @returns Health metrics with scores indicating intervention need.
 *
 * Precondition: values is an array of finite floats.
 * Postcondition: health_score in [0,1]; deviation_from_target >= 0.
 */
export function computeDistributionHealth(
  values: number[],
  targetMean: number,
): DistributionHealth {
  if (values.length === 0) {
    return { ...EMPTY_HEALTH };
  }
  const [mean, std, skew, kurtosis] = computeMoments(values);
  return healthFromMoments(mean, std, skew, kurtosis, targetMean);
}

/** Raw moments tuple for a single chunk — inputs to pairwise merge formulas. */
type RawMoments = [n: number, m1: number, m2: number, m3: number, m4: number];

/**
 * Raw (n, M1, M2, M3, M4) for a single chunk — inputs to pairwise merge
 * formulas in computeDistributionHealthStreaming.
 *
 * Source: Pébay (2008) SAND2008-6212 §3.1 (pairwise merge of moments).
 */
function chunkRawMoments(values: number[]): RawMoments {
  let n = 0;
  let m1 = 0.0;
  let m2 = 0.0;
  let m3 = 0.0;
  let m4 = 0.0;
  for (const x of values) {
    const n1 = n;
    n += 1;
    const delta = x - m1;
    const deltaN = delta / n;
    const deltaN2 = deltaN * deltaN;
    const term1 = delta * deltaN * n1;
    m4 +=
      term1 * deltaN2 * (n * n - PEBAY_M4_POLY_OFFSET * n + PEBAY_M4_POLY_OFFSET) +
      PEBAY_M4_M2_COEFF * deltaN2 * m2 -
      PEBAY_M4_M3_COEFF * deltaN * m3;
    m3 += term1 * deltaN * (n - PEBAY_M3_N_OFFSET) - PEBAY_M3_M2_COEFF * deltaN * m2;
    m2 += term1;
    m1 += deltaN;
  }
  return [n, m1, m2, m3, m4];
}

/**
 * Streaming moments over chunks of values — never fully materializes the list.
 *
 * Applies Pébay 2008 pairwise-combination formulas to merge chunk moments into
 * running totals — mathematically identical to computeDistributionHealth on the
 * concatenated list, but peak memory is O(chunk) not O(total).
 *
 * @param valueChunks - Iterable yielding arrays of floats.
 * @param targetMean - Desired mean value.
 * @returns [health, totalCount].
 *
 * Source: Pébay (2008) SAND2008-6212 §3.1 (pairwise merge of moments).
 * Precondition: each chunk element is a finite float.
 * Postcondition: health result is numerically identical to computeDistributionHealth
 *   applied to the concatenated chunks.
 */
export function computeDistributionHealthStreaming(
  valueChunks: Iterable<number[]>,
  targetMean: number,
): [DistributionHealth, number] {
  // Running aggregated moments (Pébay §3.1 notation).
  let n = 0;
  let m1 = 0.0;
  let m2 = 0.0;
  let m3 = 0.0;
  let m4 = 0.0;

  for (const chunk of valueChunks) {
    if (chunk.length === 0) continue;
    const [nB, m1B, m2B, m3B, m4B] = chunkRawMoments(chunk);
    if (nB === 0) continue;
    if (n === 0) {
      [n, m1, m2, m3, m4] = [nB, m1B, m2B, m3B, m4B];
      continue;
    }
    // Pairwise combine running (a) and chunk (b) moments.
    // Pébay 2008 §3.1 equations 2.1–2.4.
    const nAb = n + nB;
    const delta = m1B - m1;
    const deltaN = delta / nAb;
    const deltaN2 = deltaN * deltaN;
    const naNb = n * nB;

    const m4New =
      m4 +
      m4B +
      delta * deltaN * deltaN2 * naNb * (n * n - naNb + nB * nB) +
      PEBAY_M4_M2_COEFF * deltaN2 * (n * n * m2B + nB * nB * m2) +
      PEBAY_M4_M3_COEFF * deltaN * (n * m3B - nB * m3);
    const m3New =
      m3 +
      m3B +
      delta * deltaN2 * naNb * (n - nB) +
      PEBAY_M3_M2_COEFF * deltaN * (n * m2B - nB * m2);
    const m2New = m2 + m2B + delta * deltaN * naNb;
    const m1New = m1 + deltaN * nB;

    n = nAb;
    m1 = m1New;
    m2 = m2New;
    m3 = m3New;
    m4 = m4New;
  }

  if (n === 0) {
    return [{ ...EMPTY_HEALTH }, 0];
  }

  const variance = m2 / Math.max(n - 1, 1);
  const std = Math.sqrt(variance);
  let skew = 0.0;
  let kurtosis = 0.0;
  if (std > STD_STABILITY_FLOOR) {
    skew = m3 / (n * std ** SKEW_STD_EXPONENT);
    kurtosis = m4 / (n * std ** KURTOSIS_STD_EXPONENT) - EXCESS_KURTOSIS_OFFSET;
  }

  return [healthFromMoments(m1, std, skew, kurtosis, targetMean), n];
}
