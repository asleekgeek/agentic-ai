/**
 * Oscillatory phase computation -- theta, gamma, and SWR gating logic.
 *
 * Theta gating implements Hasselmo's piecewise model (2002) via sigmoid:
 *   gate(phase) = 1 / (1 + exp(-k * (phase - 0.5)))
 *   enc(phase)  = 1.0 - gate(phase) * X       (EC->CA1 gain)
 *   ret(phase)  = (1-X) + gate(phase) * X     (CA3->CA1 gain)
 *   ach(phase)  = 1.0 - gate(phase) * (1 - ach_baseline)
 *
 * X=0.7 from Hasselmo 2002 Table 1; k=20 for sharp differentiable transition.
 * At k->inf this recovers the paper's discrete piecewise switch.
 * enc + ret = 2 - X = 1.3 at all phases (zero-sum tradeoff).
 *
 * Gamma: 7-item binding per theta cycle (Lisman & Jensen 2013).
 * SWR: consolidation windows for replay-driven plasticity (Buzsaki 2015).
 *
 * References:
 *   Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817
 *   Hasselmo (2005) Hippocampus 15:936-949
 *   Lisman & Jensen (2013) Neuron 77:1002-1016
 *   Buzsaki (2015) Hippocampus 25:1073-1188
 *   Olafsdottir et al. (2018) Curr Biol 28:R37-R50
 *
 * Port of: mcp_server/core/oscillatory_phases.py
 * Pure business logic -- no I/O.
 */

// ── Overflow Clamp Bounds ─────────────────────────────────────────────────────
// Symmetric clamp on the sigmoid exponent to avoid Math.exp() overflow/underflow.
// At ±500 the sigmoid is already at 0 / 1 to full IEEE-754 float precision.
// source: port of core/oscillatory_phases.py:L130-L132; overflow-clamp, no paper.
const SIGMOID_EXPONENT_MAX = 500.0;
const SIGMOID_EXPONENT_MIN = -500.0;

// ── Gamma Serial-Position Decay Rate ─────────────────────────────────────────
// Rate constant for the primacy/recency exponential in gammaBindingStrength.
// Governs how quickly binding strength falls with distance from first/last slot.
// source: port of core/oscillatory_phases.py:L208-L209; true-hand-tuned, no paper.
const GAMMA_DECAY_RATE = 0.5;

// Output floor and scale for binding-strength linear rescaling to [0.5, 1.0].
// source: port of core/oscillatory_phases.py:L211; true-hand-tuned, no paper.
const GAMMA_STRENGTH_FLOOR = 0.5;
const GAMMA_STRENGTH_SCALE = 0.5;

// ── SWR Probability Factor Normalisers ────────────────────────────────────────
// Divisors that convert raw counts / hours to a [0, 1] saturation factor.
// All three are engineering choices; no paper specifies these values.
// source: port of core/oscillatory_phases.py:L229; true-hand-tuned, no paper.
const SWR_OPS_NORMALISER = 20.0;
// source: port of core/oscillatory_phases.py:L230; true-hand-tuned, no paper.
const SWR_IMPORTANCE_NORMALISER = 5.0;
// source: port of core/oscillatory_phases.py:L231; true-hand-tuned, no paper.
const SWR_TIME_NORMALISER = 4.0;

// Weighted combination of the three factors inside computeSWRProbability.
// Weights sum to 1.0 — an arithmetic identity requiring no independent source.
// source: port of core/oscillatory_phases.py:L233; true-hand-tuned, no paper.
const SWR_PROB_WEIGHT_OPS = 0.4;
const SWR_PROB_WEIGHT_IMP = 0.3;
const SWR_PROB_WEIGHT_TIME = 0.3;

// Minimum operations since last SWR before a new event is considered.
// source: port of core/oscillatory_phases.py:L250; default-limit-sentinel-epsilon, no paper.
const SWR_MIN_OPERATIONS = 3;

// Fraction of baseProbability used as the fire threshold in shouldGenerateSWR.
// source: port of core/oscillatory_phases.py:L259; true-hand-tuned, no paper.
const SWR_FIRE_THRESHOLD_FRACTION = 0.5;

// ── Heat-Score Inverted-U Formula Coefficients ────────────────────────────────
// computeHeatScore implements  max(0, 1 - 4*(heat - 0.5)^2):
//   0.5  = peak of the inverted-U (heat value of maximum replay need)
//   4.0  = curvature: forces the parabola to zero at heat=0 and heat=1.0
// Both are determined by the design constraint (peak at 0.5, zeros at {0,1}).
// source: port of core/oscillatory_phases.py:L268; true-hand-tuned, no paper.
const HEAT_SCORE_PEAK = 0.5;
const HEAT_SCORE_CURVATURE = 4.0;

// ── Rehearsal-Need Decay Rate ─────────────────────────────────────────────────
// In  1 / (1 + accessCount * RATE), controls how quickly rehearsal need decays
// as a memory is accessed more. Engineering choice; no paper specifies this value.
// source: port of core/oscillatory_phases.py:L287; true-hand-tuned, no paper.
const REHEARSAL_NEED_DECAY_RATE = 0.5;

// ── Phase Enumerations ───────────────────────────────────────────────────────

/**
 * Which phase of the theta cycle the system is in.
 *
 * Encoding phase (0.0-0.5): High ACh, strong EC->CA1, weak CA3->CA1.
 * Retrieval phase (0.5-1.0): Low ACh, weak EC->CA1, strong CA3->CA1.
 * Transition zone near 0.5 where the sigmoid crosses 0.5.
 */
export type ThetaPhase = "encoding" | "retrieval" | "transition";

/** Sharp-wave ripple state. */
export type SWRState =
  | "quiescent"   // Normal operation, no ripple
  | "ripple"      // Active SWR -- replay and plasticity enabled
  | "refractory"; // Post-ripple cooldown, no new ripple

// ── Hasselmo Piecewise Gating Parameters ────────────────────────────────────

/**
 * Suppression magnitude X: fraction of transmission reduction in the
 * suppressed pathway. X=0.7 means 70% suppression of CA3->CA1 during
 * encoding (or EC->CA1 during retrieval). Derived from Hasselmo, Bodelon
 * & Wyble (2002), Table 1, which reports best performance at high
 * cholinergic suppression levels.
 * // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817, Table 1
 */
export const SUPPRESSION_X = 0.7;

/**
 * Sigmoid steepness for the encoding/retrieval transition. Higher values
 * approach Hasselmo's ideal piecewise (step function) switch. k=20 gives
 * a sharp transition where gate(0.25) < 0.01 and gate(0.75) > 0.99,
 * making the plateau regions effectively flat as in the piecewise model.
 */
export const SIGMOID_STEEPNESS = 20;

/**
 * Tonic ACh floor during retrieval phase (Hasselmo 2005). During encoding,
 * ACh is near 1.0; during retrieval it drops to this baseline.
 * // source: Hasselmo (2005) Hippocampus 15:936-949
 */
export const ACH_BASELINE = 0.3;

/** Transition zone width (fraction of cycle on each side of phase boundary) */
export const TRANSITION_WIDTH = 0.08;

/**
 * Gamma capacity per theta cycle (Lisman & Jensen 2013: ~7 items)
 * // source: Lisman & Jensen (2013) Neuron 77:1002-1016
 */
export const GAMMA_CAPACITY = 7;

/**
 * Theta cycle phase boundary: encoding occupies [0, 0.5), retrieval [0.5, 1.0).
 * The sigmoid gate crosses 0.5 at this midpoint, recovering the paper's
 * piecewise step function at k->inf.
 * // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817
 */
export const THETA_PHASE_MIDPOINT = 0.5;

/**
 * Week time constant for recency decay in replay priority (hours).
 * Memories decay over a week-scale window consistent with hippocampal
 * consolidation timescales reported in Olafsdottir et al. (2018).
 * // source: Olafsdottir et al. (2018) Curr Biol 28:R37-R50
 */
export const HOURS_PER_WEEK = 168.0;

// ── Replay Priority Weights ───────────────────────────────────────────────────
// Weights for the five replay-priority signals. Sum = 1.0. The signal SET
// (importance, heat, surprise, rehearsal, recency) follows Olafsdottir et al.
// (2018); the specific weight VALUES are the Cortex port's hand-set coefficients
// — the paper does not specify them.
// source: port of mcp_server/core/oscillatory_phases.py (weight values; no paper
//   source for the split). Olafsdottir et al. (2018) Curr Biol 28:R37-R50 = signal set.

/** Importance weight in replay priority */
export const REPLAY_WEIGHT_IMPORTANCE = 0.35;
/** Heat-score weight in replay priority */
export const REPLAY_WEIGHT_HEAT = 0.2;
/** Surprise weight in replay priority */
export const REPLAY_WEIGHT_SURPRISE = 0.2;
/** Rehearsal-need weight in replay priority */
export const REPLAY_WEIGHT_REHEARSAL = 0.15;
/** Recency weight in replay priority */
export const REPLAY_WEIGHT_RECENCY = 0.1;

// ── SWR Constants (engineering choices, not from any specific paper) ─────────
// These control the discrete SWR state machine for consolidation scheduling.
// No published paper provides these specific values; they are tuned for
// reasonable behavior in a memory system operating at hours/days timescale.

/** Minimum interval between SWR events (hours) */
export const SWR_MIN_INTERVAL_HOURS = 0.5;

/** Base probability threshold for SWR triggering */
export const SWR_BASE_PROBABILITY = 0.3;

/** Duration of a single SWR burst (in consolidation steps) */
export const SWR_BURST_STEPS = 5;

/** Refractory period after SWR (consolidation steps) */
export const SWR_REFRACTORY_STEPS = 3;

// ── Oscillatory State ─────────────────────────────────────────────────────────

/**
 * Full oscillatory state of the memory system.
 *
 * Pure data object -- no side effects. Functions compute state transitions
 * and return new states.
 */
export interface OscillatoryState {
  theta_phase: number;
  gamma_count: number;
  swr_state: SWRState;
  swr_steps_remaining: number;
  theta_cycles_total: number;
  operations_since_swr: number;
  hours_since_last_swr: number;
  ach_level: number; // Start in encoding mode
}

export function makeOscillatoryState(): OscillatoryState {
  return {
    theta_phase: 0.0,
    gamma_count: 0,
    swr_state: "quiescent",
    swr_steps_remaining: 0,
    theta_cycles_total: 0,
    operations_since_swr: 0,
    hours_since_last_swr: 0.0,
    ach_level: 0.8, // Start in encoding mode
  };
}

// ── Sigmoid Gate (Hasselmo piecewise model) ───────────────────────────────────

/**
 * Encoding-to-retrieval transition: 0 at phase<<0.5, 1 at phase>>0.5.
 *
 * At k->inf recovers Hasselmo 2002 piecewise step function.
 * // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817
 */
function sigmoidGate(phase: number, k: number = SIGMOID_STEEPNESS): number {
  const exponent = -k * (phase - THETA_PHASE_MIDPOINT);
  if (exponent > SIGMOID_EXPONENT_MAX) return 0.0;
  if (exponent < SIGMOID_EXPONENT_MIN) return 1.0;
  return 1.0 / (1.0 + Math.exp(exponent));
}

// ── Theta Phase Logic ─────────────────────────────────────────────────────────

/**
 * Classify a theta phase value into encoding, retrieval, or transition.
 *
 * Phase 0.0-0.5 is encoding (strong EC->CA1, high ACh).
 * Phase 0.5-1.0 is retrieval (strong CA3->CA1, low ACh).
 * Narrow bands around 0.0, 0.5 are transitions (blended behavior).
 *
 * Precondition: phase is a finite number.
 * Postcondition: returns a valid ThetaPhase string.
 */
export function classifyThetaPhase(phase: number): ThetaPhase {
  const p = ((phase % 1.0) + 1.0) % 1.0; // normalize to [0,1)

  if (p < TRANSITION_WIDTH || p > 1.0 - TRANSITION_WIDTH) return "transition";
  if (Math.abs(p - THETA_PHASE_MIDPOINT) < TRANSITION_WIDTH) return "transition";
  if (p < THETA_PHASE_MIDPOINT) return "encoding";
  return "retrieval";
}

/**
 * EC->CA1 gain: 1.0 during encoding, (1-X)=0.3 during retrieval.
 *
 * Hasselmo 2002: enc(phase) = 1.0 - gate(phase) * X.
 * // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817
 */
export function computeEncodingStrength(phase: number): number {
  const p = ((phase % 1.0) + 1.0) % 1.0;
  return 1.0 - sigmoidGate(p) * SUPPRESSION_X;
}

/**
 * CA3->CA1 gain: (1-X)=0.3 during encoding, 1.0 during retrieval.
 *
 * Hasselmo 2002: ret(phase) = (1-X) + gate(phase) * X.
 * Complementary: enc + ret = 2 - X = 1.3 at all phases.
 * // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817
 */
export function computeRetrievalStrength(phase: number): number {
  const p = ((phase % 1.0) + 1.0) % 1.0;
  return (1.0 - SUPPRESSION_X) + sigmoidGate(p) * SUPPRESSION_X;
}

/**
 * ACh level: ~1.0 during encoding, ACH_BASELINE=0.3 during retrieval.
 *
 * Hasselmo 2005: ach(phase) = 1.0 - gate(phase) * (1 - ach_baseline).
 * // source: Hasselmo (2005) Hippocampus 15:936-949
 */
export function computeAchFromPhase(phase: number): number {
  const p = ((phase % 1.0) + 1.0) % 1.0;
  return 1.0 - sigmoidGate(p) * (1.0 - ACH_BASELINE);
}

// ── Gamma Binding ─────────────────────────────────────────────────────────────

/** Check if there's gamma capacity to bind another item this theta cycle. */
export function canBindItem(gammaCount: number, capacity: number = GAMMA_CAPACITY): boolean {
  return gammaCount < capacity;
}

/**
 * Compute binding strength for the Nth item in a gamma sequence.
 *
 * First item gets strongest binding (primacy), last item gets a recency boost.
 * Middle items weaken. Models the serial position effect.
 * Returns value in [0.5, 1.0].
 *
 * Postcondition: result in [0.5, 1.0].
 */
export function gammaBindingStrength(
  position: number,
  capacity: number = GAMMA_CAPACITY,
): number {
  if (capacity <= 1) return 1.0;
  const primacy = Math.exp(-GAMMA_DECAY_RATE * position);
  const recency = Math.exp(-GAMMA_DECAY_RATE * (capacity - 1 - position));
  const raw = Math.max(primacy, recency);
  return GAMMA_STRENGTH_FLOOR + GAMMA_STRENGTH_SCALE * Math.min(raw, 1.0);
}

// ── Sharp-Wave Ripple Logic ───────────────────────────────────────────────────

/**
 * Compute SWR trigger probability from contributing factors.
 *
 * Combines operation count, importance accumulation, and time pressure
 * into a weighted probability score. Weights and scaling factors are
 * hand-tuned engineering choices.
 */
function computeSWRProbability(
  operationsSinceSwr: number,
  hoursSinceLastSwr: number,
  accumulatedImportance: number,
  baseProbability: number,
): number {
  const opFactor = Math.min(operationsSinceSwr / SWR_OPS_NORMALISER, 1.0);
  const impFactor = Math.min(accumulatedImportance / SWR_IMPORTANCE_NORMALISER, 1.0);
  const timeFactor = Math.min(hoursSinceLastSwr / SWR_TIME_NORMALISER, 1.0);

  return baseProbability * (SWR_PROB_WEIGHT_OPS * opFactor + SWR_PROB_WEIGHT_IMP * impFactor + SWR_PROB_WEIGHT_TIME * timeFactor);
}

/**
 * Determine whether to generate a sharp-wave ripple event.
 *
 * Deterministic threshold (no randomness). Thresholds are hand-tuned.
 *
 * Precondition: operationsSinceSwr >= 0; hoursSinceLastSwr >= 0.
 * Postcondition: returns boolean.
 */
export function shouldGenerateSWR(
  operationsSinceSwr: number,
  hoursSinceLastSwr: number,
  accumulatedImportance: number = 0.0,
  minIntervalHours: number = SWR_MIN_INTERVAL_HOURS,
  baseProbability: number = SWR_BASE_PROBABILITY,
): boolean {
  if (hoursSinceLastSwr < minIntervalHours) return false;
  if (operationsSinceSwr < SWR_MIN_OPERATIONS) return false;

  const probability = computeSWRProbability(
    operationsSinceSwr,
    hoursSinceLastSwr,
    accumulatedImportance,
    baseProbability,
  );
  return probability >= baseProbability * SWR_FIRE_THRESHOLD_FRACTION;
}

/**
 * Compute inverted-U heat score for replay priority.
 *
 * Moderate heat memories need replay most -- too hot means already active,
 * too cold means not worth replaying. Peak at heat=0.5.
 */
function computeHeatScore(heat: number): number {
  return Math.max(0.0, 1.0 - HEAT_SCORE_CURVATURE * (heat - HEAT_SCORE_PEAK) ** 2);
}

/**
 * Compute which memories should be replayed during an SWR event.
 *
 * Prioritizes: high importance, moderate heat, high surprise,
 * low access count (under-rehearsed), and recent memories.
 * Based on Olafsdottir et al. (2018).
 *
 * @returns Replay priority score [0, 1].
 *
 * Precondition: all inputs are finite non-negative numbers.
 * Postcondition: result in [0, 1].
 * // source: Olafsdottir et al. (2018) Curr Biol 28:R37-R50
 */
export function computeReplayPriority(
  heat: number,
  importance: number,
  surprise: number,
  accessCount: number,
  hoursSinceCreation: number,
): number {
  const heatScore = computeHeatScore(heat);
  const rehearsalNeed = 1.0 / (1.0 + accessCount * REHEARSAL_NEED_DECAY_RATE);
  // Week time constant — source: Olafsdottir et al. (2018) Curr Biol 28:R37-R50
  const recency = Math.exp(-hoursSinceCreation / HOURS_PER_WEEK);

  const priority =
    importance * REPLAY_WEIGHT_IMPORTANCE +
    heatScore * REPLAY_WEIGHT_HEAT +
    surprise * REPLAY_WEIGHT_SURPRISE +
    rehearsalNeed * REPLAY_WEIGHT_REHEARSAL +
    recency * REPLAY_WEIGHT_RECENCY;

  return Math.min(1.0, Math.max(0.0, priority));
}
