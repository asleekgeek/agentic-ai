/**
 * Oscillatory phase computation and clock state transitions.
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
 * // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817.
 *   X=0.7 from Table 1 — best performance at high cholinergic suppression.
 * // source: Hasselmo (2005) Hippocampus 15:936-949 — ACh modulation formula.
 * // source: Lisman & Jensen (2013) Neuron 77:1002-1016 — gamma capacity 7 items.
 * // source: Buzsaki (2015) Hippocampus 25:1073-1188 — SWR consolidation windows.
 * // source: Olafsdottir et al. (2018) Curr Biol 28:R37-R50 — replay priority.
 *
 * Port of: mcp_server/core/oscillatory_clock.py + oscillatory_phases.py
 * Pure business logic — no I/O.
 */

// ── Phase Enumerations ────────────────────────────────────────────────────────

export type ThetaPhaseName = "encoding" | "retrieval" | "transition";
export type SWRStateName = "quiescent" | "ripple" | "refractory";

// ── Hasselmo Piecewise Gating Parameters ────────────────────────────────────

// Suppression magnitude X: fraction of transmission reduction in the
// suppressed pathway. X=0.7 means 70% suppression of CA3->CA1 during
// encoding (or EC->CA1 during retrieval).
// // source: Hasselmo, Bodelon & Wyble (2002), Table 1.
export const SUPPRESSION_X = 0.7;

// Sigmoid steepness for the encoding/retrieval transition.
// k=20 gives a sharp transition where gate(0.25) < 0.01 and gate(0.75) > 0.99.
export const SIGMOID_STEEPNESS = 20;

// Tonic ACh floor during retrieval phase.
// // source: Hasselmo (2005): during encoding ACh is near 1.0; retrieval drops to baseline.
export const ACH_BASELINE = 0.3;

// Transition zone width (fraction of cycle on each side of phase boundary)
export const TRANSITION_WIDTH = 0.08;

// Gamma capacity per theta cycle.
// // source: Lisman & Jensen (2013): ~7 items.
export const GAMMA_CAPACITY = 7;

// SWR engineering constants — hand-tuned, not from a specific paper.
export const SWR_MIN_INTERVAL_HOURS = 0.5;
export const SWR_BASE_PROBABILITY = 0.3;
export const SWR_BURST_STEPS = 5;
export const SWR_REFRACTORY_STEPS = 3;

// Sigmoid overflow clamp: exp(x) for |x| > 500 is numerically indistinguishable
// from 0 or Infinity in IEEE-754 double precision. Clamp avoids NaN / Infinity.
// source: port of core/oscillatory_phases.py:L130-131; overflow-clamp, no paper.
const SIGMOID_EXPONENT_MAX = 500.0;

// Gamma binding strength serial-position exponent.
// Both arms of the primacy/recency model: exp(-0.5 * position) and
// exp(-0.5 * (capacity - 1 - position)). Coefficient 0.5 controls decay rate.
// source: port of core/oscillatory_phases.py:L208-209; true-hand-tuned, no paper.
const GAMMA_BINDING_DECAY = -0.5;

// Gamma binding strength lower bound: minimum strength returned is 0.5.
// The formula returns 0.5 + 0.5 * min(raw, 1.0); both 0.5 terms are the same
// literal so one const covers both uses.
// source: port of core/oscillatory_phases.py:L211; true-hand-tuned, no paper.
const GAMMA_BINDING_FLOOR = 0.5;

// SWR probability: normalizer for operation-count factor.
// Scales operations_since_swr to [0, 1] at 20 operations.
// source: port of core/oscillatory_phases.py:L229; true-hand-tuned, no paper.
const SWR_OP_FACTOR_SCALE = 20.0;

// SWR probability: normalizer for accumulated-importance factor.
// source: port of core/oscillatory_phases.py:L230; true-hand-tuned, no paper.
const SWR_IMP_FACTOR_SCALE = 5.0;

// SWR probability: normalizer for time factor (hours).
// source: port of core/oscillatory_phases.py:L231; true-hand-tuned, no paper.
const SWR_TIME_FACTOR_SCALE = 4.0;

// SWR probability weights for the three contributing factors (must sum to 1.0).
// source: port of core/oscillatory_phases.py:L233; true-hand-tuned, no paper.
const SWR_OP_WEIGHT   = 0.4;
const SWR_IMP_WEIGHT  = 0.3;
const SWR_TIME_WEIGHT = 0.3;

// Minimum operations before SWR can trigger.
// source: port of core/oscillatory_phases.py:L249; true-hand-tuned, no paper.
const SWR_MIN_OPERATIONS = 3;

// SWR fire threshold: probability must reach baseProbability * 0.5.
// source: port of core/oscillatory_phases.py:L259; true-hand-tuned, no paper.
const SWR_PROBABILITY_THRESHOLD_FACTOR = 0.5;

// Heat-score inverted-U curvature: 4.0 * (heat - 0.5)^2.
// Gives score = 0 at heat = 0 or 1, score = 1 at heat = 0.5.
// source: port of core/oscillatory_phases.py:L268; true-hand-tuned, no paper.
const HEAT_SCORE_CURVATURE = 4.0;

// Heat peak for the inverted-U score: score peaks at heat = HEAT_SCORE_PEAK.
// source: port of core/oscillatory_phases.py:L268; true-hand-tuned, no paper.
const HEAT_SCORE_PEAK = 0.5;

// Rehearsal-need decay factor: rehearsalNeed = 1 / (1 + accessCount * 0.5).
// Decays to ~0.67 at count=1, ~0.5 at count=2.
// source: port of core/oscillatory_phases.py:L287; true-hand-tuned, no paper.
const REHEARSAL_DECAY_FACTOR = 0.5;

// Default operations-per-theta-cycle for advance_theta.
// source: port of core/oscillatory_phases.py:L44-48 (operations_per_cycle=20);
// true-hand-tuned, no paper.
const DEFAULT_OPERATIONS_PER_CYCLE = 20;

// Phase rounding precision: round(phase * 1_000_000) / 1_000_000 gives 6 dp.
// Matches Python round(new_phase, 6) in advance_theta (oscillatory_phases.py:L65).
// arithmetic-identity: 1_000_000 = 10^6, no paper.
const PHASE_ROUND_FACTOR = 1_000_000;

// ACh rounding precision: round(ach * 10000) / 10000 gives 4 dp.
// Matches Python round(compute_ach_from_phase(new_phase), 4) (oscillatory_phases.py:L72).
// arithmetic-identity: 10000 = 10^4, no paper.
const ACH_ROUND_FACTOR = 10000;

// SWR encoding suppression during ripple: phase_mod *= 0.3.
// Hippocampus busy with replay; new encoding nearly suppressed.
// source: port of core/oscillatory_clock.py:L164; true-hand-tuned, no paper.
const SWR_ENCODING_SUPPRESSION = 0.3;

// SWR plasticity boost during ripple: base_delta * 1.5.
// Replay-driven LTP is stronger than normal encoding-phase plasticity.
// source: port of core/oscillatory_clock.py:L196; true-hand-tuned, no paper.
const SWR_PLASTICITY_BOOST = 1.5;

// Initial / default ACh level: system starts in encoding mode (high ACh).
// source: port of core/oscillatory_phases.py:L117 `ach_level: float = 0.8`;
// true-hand-tuned, no paper.
const ACH_INITIAL = 0.8;

// Theta cycle phase midpoint: sigmoid inflection at phase=0.5 separates
// encoding (0.0–0.5) from retrieval (0.5–1.0).
// // source: Hasselmo, Bodelon & Wyble (2002) Neural Computation 14:793-817 —
// gate(phase) = 1 / (1 + exp(-k * (phase - 0.5))).
export const THETA_PHASE_MIDPOINT = 0.5;

// Week expressed in hours — unit-conversion constant used as the recency
// decay time constant in replay priority scoring.
// // source: factual unit conversion: 7 days × 24 hours/day = 168 h.
export const HOURS_PER_WEEK = 168.0;

// Replay priority weights (must sum to 1.0).
// // source: Olafsdottir et al. (2018) Curr Biol 28:R37-R50 — replay
// prioritises importance, novelty (surprise), rehearsal need, and recency.
// Specific weight values are calibrated to this timescale; Olafsdottir
// provides the qualitative ordering (importance > heat ≈ surprise > rehearsal
// > recency) that these weights implement.
export const REPLAY_WEIGHT_IMPORTANCE = 0.35;
export const REPLAY_WEIGHT_HEAT       = 0.20;
export const REPLAY_WEIGHT_SURPRISE   = 0.20;
export const REPLAY_WEIGHT_REHEARSAL  = 0.15;
export const REPLAY_WEIGHT_RECENCY    = 0.10;

// ── Oscillatory State ─────────────────────────────────────────────────────────

export interface OscillatoryState {
  readonly thetaPhase: number;
  readonly gammaCount: number;
  readonly swrState: SWRStateName;
  readonly swrStepsRemaining: number;
  readonly thetaCyclesTotal: number;
  readonly operationsSinceSwr: number;
  readonly hoursSinceLastSwr: number;
  readonly achLevel: number;
}

export function makeInitialOscillatoryState(): OscillatoryState {
  return {
    thetaPhase: 0.0,
    gammaCount: 0,
    swrState: "quiescent",
    swrStepsRemaining: 0,
    thetaCyclesTotal: 0,
    operationsSinceSwr: 0,
    hoursSinceLastSwr: 0.0,
    achLevel: ACH_INITIAL, // Start in encoding mode
  };
}

// ── Sigmoid Gate (Hasselmo piecewise model) ───────────────────────────────────

function sigmoidGate(phase: number, k = SIGMOID_STEEPNESS): number {
  const exponent = -k * (phase - THETA_PHASE_MIDPOINT);
  // Clamp to avoid overflow in exp()
  if (exponent > SIGMOID_EXPONENT_MAX) return 0.0;
  if (exponent < -SIGMOID_EXPONENT_MAX) return 1.0;
  return 1.0 / (1.0 + Math.exp(exponent));
}

// ── Theta Phase Logic ─────────────────────────────────────────────────────────

/** Classify a theta phase value into encoding, retrieval, or transition. */
export function classifyThetaPhase(phase: number): ThetaPhaseName {
  const p = phase % 1.0;
  if (p < TRANSITION_WIDTH || p > 1.0 - TRANSITION_WIDTH) return "transition";
  if (Math.abs(p - THETA_PHASE_MIDPOINT) < TRANSITION_WIDTH) return "transition";
  if (p < THETA_PHASE_MIDPOINT) return "encoding";
  return "retrieval";
}

/**
 * EC->CA1 gain: 1.0 during encoding, (1-X)=0.3 during retrieval.
 * // source: Hasselmo 2002: enc(phase) = 1.0 - gate(phase) * X.
 */
export function computeEncodingStrength(phase: number): number {
  const p = phase % 1.0;
  return 1.0 - sigmoidGate(p) * SUPPRESSION_X;
}

/**
 * CA3->CA1 gain: (1-X)=0.3 during encoding, 1.0 during retrieval.
 * // source: Hasselmo 2002: ret(phase) = (1-X) + gate(phase) * X.
 * Complementary: enc + ret = 2 - X = 1.3 at all phases.
 */
export function computeRetrievalStrength(phase: number): number {
  const p = phase % 1.0;
  return (1.0 - SUPPRESSION_X) + sigmoidGate(p) * SUPPRESSION_X;
}

/**
 * ACh level: ~1.0 during encoding, ACH_BASELINE=0.3 during retrieval.
 * // source: Hasselmo 2005: ach(phase) = 1.0 - gate(phase) * (1 - ach_baseline).
 */
export function computeAchFromPhase(phase: number): number {
  const p = phase % 1.0;
  return 1.0 - sigmoidGate(p) * (1.0 - ACH_BASELINE);
}

// ── Gamma Binding ─────────────────────────────────────────────────────────────

/** Check if there is gamma capacity to bind another item this theta cycle. */
export function canBindItem(gammaCount: number, capacity = GAMMA_CAPACITY): boolean {
  return gammaCount < capacity;
}

/**
 * Compute binding strength for the Nth item in a gamma sequence.
 * Models the serial position effect (primacy + recency).
 * Returns value in [0.5, 1.0].
 */
export function gammaBindingStrength(position: number, capacity = GAMMA_CAPACITY): number {
  if (capacity <= 1) return 1.0;
  const primacy = Math.exp(GAMMA_BINDING_DECAY * position);
  const recency = Math.exp(GAMMA_BINDING_DECAY * (capacity - 1 - position));
  const raw = Math.max(primacy, recency);
  return GAMMA_BINDING_FLOOR + GAMMA_BINDING_FLOOR * Math.min(raw, 1.0);
}

// ── SWR Logic ─────────────────────────────────────────────────────────────────

function computeSwrProbability(
  operationsSinceSwr: number,
  hoursSinceLastSwr: number,
  accumulatedImportance: number,
  baseProbability: number,
): number {
  const opFactor = Math.min(operationsSinceSwr / SWR_OP_FACTOR_SCALE, 1.0);
  const impFactor = Math.min(accumulatedImportance / SWR_IMP_FACTOR_SCALE, 1.0);
  const timeFactor = Math.min(hoursSinceLastSwr / SWR_TIME_FACTOR_SCALE, 1.0);
  return baseProbability * (SWR_OP_WEIGHT * opFactor + SWR_IMP_WEIGHT * impFactor + SWR_TIME_WEIGHT * timeFactor);
}

/** Determine whether to generate a sharp-wave ripple event. */
export function shouldGenerateSwr(
  operationsSinceSwr: number,
  hoursSinceLastSwr: number,
  accumulatedImportance = 0.0,
  opts: {
    minIntervalHours?: number;
    baseProbability?: number;
  } = {},
): boolean {
  const { minIntervalHours = SWR_MIN_INTERVAL_HOURS, baseProbability = SWR_BASE_PROBABILITY } = opts;
  if (hoursSinceLastSwr < minIntervalHours) return false;
  if (operationsSinceSwr < SWR_MIN_OPERATIONS) return false;
  const probability = computeSwrProbability(
    operationsSinceSwr,
    hoursSinceLastSwr,
    accumulatedImportance,
    baseProbability,
  );
  return probability >= baseProbability * SWR_PROBABILITY_THRESHOLD_FACTOR;
}

// ── Replay Priority ───────────────────────────────────────────────────────────

function computeHeatScore(heat: number): number {
  return Math.max(0.0, 1.0 - HEAT_SCORE_CURVATURE * Math.pow(heat - HEAT_SCORE_PEAK, 2));
}

/**
 * Compute which memories should be replayed during an SWR event.
 *
 * Prioritizes: high importance, moderate heat, high surprise, low access count,
 * and recent memories.
 * // source: Olafsdottir et al. (2018) Curr Biol 28:R37-R50.
 */
export function computeReplayPriority(
  heat: number,
  importance: number,
  surprise: number,
  accessCount: number,
  hoursSinceCreation: number,
): number {
  const heatScore = computeHeatScore(heat);
  const rehearsalNeed = 1.0 / (1.0 + accessCount * REHEARSAL_DECAY_FACTOR);
  const recency = Math.exp(-hoursSinceCreation / HOURS_PER_WEEK); // Week time constant

  const priority =
    importance * REPLAY_WEIGHT_IMPORTANCE +
    heatScore  * REPLAY_WEIGHT_HEAT       +
    surprise   * REPLAY_WEIGHT_SURPRISE   +
    rehearsalNeed * REPLAY_WEIGHT_REHEARSAL +
    recency    * REPLAY_WEIGHT_RECENCY;

  return Math.min(1.0, Math.max(0.0, priority));
}

// ── State Transitions ─────────────────────────────────────────────────────────

/**
 * Advance the theta clock by a number of operations.
 *
 * Each operation advances the phase by 1/operationsPerCycle. When the phase
 * wraps past 1.0, a new theta cycle begins and gamma resets.
 */
export function advanceTheta(
  state: OscillatoryState,
  operations = 1,
  operationsPerCycle = DEFAULT_OPERATIONS_PER_CYCLE,
): OscillatoryState {
  const phaseIncrement = operations / operationsPerCycle;
  const rawPhase = state.thetaPhase + phaseIncrement;
  const newCycles = state.thetaCyclesTotal + Math.floor(rawPhase);
  const newPhase = rawPhase % 1.0;

  const gammaCount =
    Math.floor(state.thetaPhase + phaseIncrement) === 0 ? state.gammaCount : 0;

  return {
    ...state,
    thetaPhase: Math.round(newPhase * PHASE_ROUND_FACTOR) / PHASE_ROUND_FACTOR,
    gammaCount,
    thetaCyclesTotal: newCycles,
    operationsSinceSwr: state.operationsSinceSwr + operations,
    achLevel: Math.round(computeAchFromPhase(newPhase) * ACH_ROUND_FACTOR) / ACH_ROUND_FACTOR,
  };
}

/** Record a gamma binding event (one item bound). */
export function advanceGamma(state: OscillatoryState): OscillatoryState {
  return { ...state, gammaCount: state.gammaCount + 1 };
}

/** Transition to SWR (sharp-wave ripple) state. */
export function beginSwr(state: OscillatoryState): OscillatoryState {
  return {
    ...state,
    swrState: "ripple",
    swrStepsRemaining: SWR_BURST_STEPS,
    operationsSinceSwr: 0,
    hoursSinceLastSwr: 0.0,
  };
}

function nextSwrState(
  swrState: SWRStateName,
  remaining: number,
): [SWRStateName, number] {
  if (swrState === "ripple") {
    const newRemaining = remaining - 1;
    if (newRemaining <= 0) return ["refractory", SWR_REFRACTORY_STEPS];
    return [swrState, newRemaining];
  }
  if (swrState === "refractory") {
    const newRemaining = remaining - 1;
    if (newRemaining <= 0) return ["quiescent", 0];
    return [swrState, newRemaining];
  }
  return [swrState, remaining];
}

/** Advance one consolidation step during SWR or refractory period. */
export function stepSwr(state: OscillatoryState): OscillatoryState {
  const [swrState, remaining] = nextSwrState(state.swrState, state.swrStepsRemaining);
  return { ...state, swrState, swrStepsRemaining: remaining };
}

/** Check if the system is in an active SWR (replay/plasticity enabled). */
export function isSwrActive(state: OscillatoryState): boolean {
  return state.swrState === "ripple";
}

// ── Phase-Gated Modulation ────────────────────────────────────────────────────

/** Apply oscillatory modulation to an encoding operation. SWR suppresses new encoding. */
export function modulateEncoding(baseStrength: number, state: OscillatoryState): number {
  let phaseMod = computeEncodingStrength(state.thetaPhase);
  if (isSwrActive(state)) phaseMod *= SWR_ENCODING_SUPPRESSION;
  return baseStrength * phaseMod;
}

/** Apply oscillatory modulation to a retrieval operation. */
export function modulateRetrieval(baseScore: number, state: OscillatoryState): number {
  return baseScore * computeRetrievalStrength(state.thetaPhase);
}

/**
 * Apply oscillatory modulation to a plasticity update (LTP/LTD).
 * During SWR, replay-driven plasticity is boosted.
 */
export function modulatePlasticity(baseDelta: number, state: OscillatoryState): number {
  if (isSwrActive(state)) return baseDelta * SWR_PLASTICITY_BOOST;
  return baseDelta * computeEncodingStrength(state.thetaPhase);
}

// ── Serialization ─────────────────────────────────────────────────────────────

export function stateToDict(state: OscillatoryState): Record<string, unknown> {
  return {
    theta_phase: state.thetaPhase,
    gamma_count: state.gammaCount,
    swr_state: state.swrState,
    swr_steps_remaining: state.swrStepsRemaining,
    theta_cycles_total: state.thetaCyclesTotal,
    operations_since_swr: state.operationsSinceSwr,
    hours_since_last_swr: state.hoursSinceLastSwr,
    ach_level: state.achLevel,
  };
}

export function stateFromDict(data: Record<string, unknown>): OscillatoryState {
  return {
    thetaPhase: (data["theta_phase"] as number | undefined) ?? 0.0,
    gammaCount: (data["gamma_count"] as number | undefined) ?? 0,
    swrState: ((data["swr_state"] as string | undefined) ?? "quiescent") as SWRStateName,
    swrStepsRemaining: (data["swr_steps_remaining"] as number | undefined) ?? 0,
    thetaCyclesTotal: (data["theta_cycles_total"] as number | undefined) ?? 0,
    operationsSinceSwr: (data["operations_since_swr"] as number | undefined) ?? 0,
    hoursSinceLastSwr: (data["hours_since_last_swr"] as number | undefined) ?? 0.0,
    achLevel: (data["ach_level"] as number | undefined) ?? ACH_INITIAL,
  };
}
