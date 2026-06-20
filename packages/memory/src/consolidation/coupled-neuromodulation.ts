/**
 * Coupled neuromodulation — 4-channel (DA,NE,ACh,5-HT) cascade.
 * // source: Rescorla & Wagner (1972) Classical Conditioning II, pp.64-99. RPE.
 * // source: Schultz W (1997) Science 275:1593. DA [0,3].
 * // source: Aston-Jones & Cohen (2005) Annu Rev Neurosci 28:403. NE tonic/phasic.
 * // source: Hasselmo ME (2005) Hippocampus 15:936. ACh theta.
 * // source: Dayan & Huys (2009) Annu Rev Neurosci 32:95. 5-HT exploration.
 * // source: Dawes RM (1979) Am Psychologist 34(7):571. Equal weights composite.
 * Port of: mcp_server/core/coupled_neuromodulation.py + neuromodulation_channels.py
 * Pure business logic — no I/O.
 */

// ── NeuromodulatoryState defaults ────────────────────────────────────────────

// Default resting-state baseline for DA prediction value (da_baseline).
// Port of core/coupled_neuromodulation.py:L64 (NeuromodulatoryState.da_baseline = 0.5).
// Midpoint of the valid baseline range [0.1, 0.9]; engineering heuristic, no paper.
const DA_BASELINE_DEFAULT = 0.5;

// Default ach_from_theta signal when no theta phase information is available.
// Port of core/coupled_neuromodulation.py:L82 (OperationSignals.ach_from_theta = 0.5).
// Neutral midpoint — no encoding/retrieval bias; engineering heuristic, no paper.
const ACH_FROM_THETA_DEFAULT = 0.5;

// Default memory_importance when not provided.
// Port of core/coupled_neuromodulation.py:L84 (OperationSignals.memory_importance = 0.5).
// Neutral midpoint of [0, 1] importance scale; engineering heuristic, no paper.
const MEMORY_IMPORTANCE_DEFAULT = 0.5;

// ── DA reward-mapping heuristics ─────────────────────────────────────────────

// Base reward value for a positive outcome (error resolved / test passed).
// Port of core/neuromodulation_channels.py:L148 (actual = 0.7 + memory_importance * 0.3).
// Engineering translation of Schultz (1997) juice-reward paradigm to memory ops; no paper
// provides this numeric mapping.
const DA_POSITIVE_BASE = 0.7;

// Importance scaling factor for positive outcomes.
// Port of core/neuromodulation_channels.py:L148 (actual = 0.7 + memory_importance * 0.3).
// Engineering heuristic; no paper source.
const DA_POSITIVE_IMPORTANCE_SCALE = 0.3;

// Base reward value for a negative outcome (error encountered / test failed).
// Port of core/neuromodulation_channels.py:L150 (actual = 0.2 - memory_importance * 0.1).
// Engineering heuristic; no paper source.
const DA_NEGATIVE_BASE = 0.2;

// Importance scaling factor for negative outcomes.
// Port of core/neuromodulation_channels.py:L150 (actual = 0.2 - memory_importance * 0.1).
// Engineering heuristic; no paper source.
const DA_NEGATIVE_IMPORTANCE_SCALE = 0.1;

// Neutral (no-op) actual reward — neither positive nor negative.
// Port of core/neuromodulation_channels.py:L152 (actual = 0.5).
// Midpoint of [0, 1]; engineering heuristic, no paper.
const DA_NEUTRAL_ACTUAL = 0.5;

// ── DA baseline clamp bounds ──────────────────────────────────────────────────

// Lower clamp for the DA running baseline. Prevents complete extinction of
// prediction. Port of core/neuromodulation_channels.py:L162 (max(0.1, ...)).
// Engineering heuristic; no paper source.
const DA_BASELINE_MIN = 0.1;

// Upper clamp for the DA running baseline. Prevents runaway potentiation.
// Port of core/neuromodulation_channels.py:L162 (min(0.9, ...)).
// Engineering heuristic; no paper source.
const DA_BASELINE_MAX = 0.9;

// ── NE arousal constants ──────────────────────────────────────────────────────

// NE burst magnitude scale factor for error events: burst = 0.5 * (1 - adaptation).
// Port of core/neuromodulation_channels.py:L186 (burst = 0.5 * (1.0 - ne_adaptation)).
// Inspired by Aston-Jones & Cohen (2005) phasic burst concept; specific value
// is hand-tuned for hours timescale, no paper source.
const NE_BURST_SCALE = 0.5;

// Upper clamp for NE habituation accumulator (ne_adaptation max = 0.8).
// Port of core/neuromodulation_channels.py:L188 (min(0.8, ne_adaptation + ...)).
// Engineering heuristic; no paper source.
const NE_ADAPTATION_MAX = 0.8;

// NE tonic-return rate when no error: ne += 0.1 * (1 - ne).
// Port of core/neuromodulation_channels.py:L190 (current_ne + 0.1 * (1.0 - current_ne)).
// Engineering heuristic reflecting slow return to tonic; no paper source.
const NE_TONIC_RETURN_RATE = 0.1;

// ── Serotonin exploration constants ──────────────────────────────────────────

// Neutral novelty ratio used when total_entities == 0.
// Port of core/neuromodulation_channels.py:L214 (novelty_ratio = 0.5 if total == 0).
// Midpoint — no information about novelty; engineering heuristic, no paper source.
const SER_NOVELTY_DEFAULT = 0.5;

// Additive novelty contribution to 5-HT target: target = 0.5 + novelty_ratio * 0.8.
// Port of core/neuromodulation_channels.py:L218 (0.5 + novelty_ratio * 0.8 - ...).
// Engineering translation of Dayan & Huys (2009) behavioral inhibition concept;
// no paper provides this specific coefficient.
const SER_NOVELTY_GAIN = 0.8;

// Subtractive schema-match contribution: target -= exploitation_signal * 0.5.
// Port of core/neuromodulation_channels.py:L218 (... - exploitation_signal * 0.5).
// Engineering heuristic; no paper source.
const SER_SCHEMA_SUPPRESSION = 0.5;

// 5-HT target lower clamp. Port of core/neuromodulation_channels.py:L219 (max(0.3, ...)).
// Shared with NE/ACh lower bound convention; engineering heuristic, no paper source.
const SER_TARGET_MIN = 0.3;

// 5-HT target upper clamp. Port of core/neuromodulation_channels.py:L219 (min(1.8, ...)).
// Below the NE/ACh ceiling of 2.0 to reflect 5-HT's smaller dynamic range
// in this engineering model; hand-tuned, no paper source.
const SER_TARGET_MAX = 1.8;

// 5-HT base offset for target computation: target = 0.5 + ...
// Port of core/neuromodulation_channels.py:L218 (target = 0.5 + novelty_ratio * 0.8 ...).
// Midpoint baseline; engineering heuristic, no paper source.
const SER_TARGET_BASE = 0.5;

// ── Cross-coupling channel clamps ─────────────────────────────────────────────

// Lower clamp for NE, ACh, and 5-HT after cross-coupling.
// Port of core/neuromodulation_channels.py:L250-252 (max(0.3, min(2.0, ...))).
// Engineering heuristic preventing complete channel silencing; no paper source.
const CHANNEL_MIN = 0.3;

// ── ACh novelty boost (computeAch) ────────────────────────────────────────────

// Novelty boost coefficient for ACh: ach += novelty_ratio * 0.3.
// Port of core/coupled_neuromodulation.py:L94 (novel / max(total, 1) * 0.3).
// Engineering heuristic; no paper source.
const ACH_NOVELTY_BOOST = 0.3;

// ── Write-gate floor ──────────────────────────────────────────────────────────

// Minimum NE value used as divisor in write-gate threshold to prevent division by zero.
// Port of core/coupled_neuromodulation.py:L177 (max(ne, 0.01)).
// Overflow/divide-by-zero clamp; no paper source.
const NE_MIN_DIVISOR = 0.01;

// ── Cascade gate threshold ────────────────────────────────────────────────────

// DA × importance threshold for cascade gate. Docstring states "hand-tuned."
// Port of core/coupled_neuromodulation.py:L192 (return (da * importance) > 0.7).
// True hand-tuned; no paper source.
const CASCADE_GATE_THRESHOLD = 0.7;

// ── Composite modulation defaults ─────────────────────────────────────────────

// Importance value used in cascade_gate call within computeCompositeModulation.
// Port of core/coupled_neuromodulation.py:L224 (compute_cascade_gate(da, 0.5)).
// Neutral midpoint; engineering heuristic, no paper source.
const COMPOSITE_CASCADE_IMPORTANCE = 0.5;

// ── stateFromDict defaults ────────────────────────────────────────────────────

// Default da_baseline used when deserializing from dict with missing key.
// Port of core/coupled_neuromodulation.py:L250 (data.get("da_baseline", 0.5)).
// Same default as NeuromodulatoryState.da_baseline field; engineering heuristic, no paper.
const DA_BASELINE_DICT_DEFAULT = 0.5;

export const DA_ALPHA=0.3,NE_ALPHA=0.2,ACH_ALPHA=0.4,SER_ALPHA=0.15; // Ordered by biological speed
const DA_NE=-0.15,NE_ACH=0.2,SER_DA=-0.1,ACH_SER=-0.15; // Cross-coupling (engineering heuristic)
const NE_HAB_RATE=0.05,NE_HAB_DECAY=0.02;
// source: Schultz W (1997) Science 275:1593. DA neurons fire at ~5 Hz tonic, ~20-30 Hz burst (~4-6x baseline). Using 3x as conservative upper bound to avoid positive RPE dominating downstream modulation.
const DA_CEILING=3.0;
// source: Rescorla & Wagner (1972) Classical Conditioning II pp.64-99; Daw (2011) Sutton & Barto (1998). Combined alpha*beta within standard simulation range [0.01-0.25]. Each memory operation has a single stimulus context so alpha and beta are merged.
const DA_LEARNING_RATE=0.1;
// source: Dawes RM (1979) Am Psychologist 34(7):571. Equal weights match or beat optimised regression when k<10 predictors and training data is limited. k=4 channels (DA, NE, ACh, 5-HT).
const DAWES_CHANNEL_COUNT=4;
// source: Python equivalent round(x,4) — 4 decimal precision for neuromodulatory state values matching mcp_server/core/coupled_neuromodulation.py.
const ROUNDING_PRECISION_SCALE=10000;
export interface NeuromodulatoryState{readonly dopamine:number;readonly norepinephrine:number;readonly acetylcholine:number;readonly serotonin:number;readonly daBaseline:number;readonly neAdaptation:number;}
export function makeNeuromodulatoryState(o:Partial<NeuromodulatoryState>={}):NeuromodulatoryState{return{dopamine:o.dopamine??1.0,norepinephrine:o.norepinephrine??1.0,acetylcholine:o.acetylcholine??1.0,serotonin:o.serotonin??1.0,daBaseline:o.daBaseline??DA_BASELINE_DEFAULT,neAdaptation:o.neAdaptation??0.0};}
export interface OperationSignals{readonly errorEncountered:boolean;readonly errorResolved:boolean;readonly testPassed:boolean;readonly testFailed:boolean;readonly novelEntities:number;readonly totalEntities:number;readonly thetaPhase:number;readonly achFromTheta:number;readonly schemaMatch:number;readonly memoryImportance:number;}
export function makeOperationSignals(o:Partial<OperationSignals>={}):OperationSignals{return{errorEncountered:o.errorEncountered??false,errorResolved:o.errorResolved??false,testPassed:o.testPassed??false,testFailed:o.testFailed??false,novelEntities:o.novelEntities??0,totalEntities:o.totalEntities??0,thetaPhase:o.thetaPhase??0.0,achFromTheta:o.achFromTheta??ACH_FROM_THETA_DEFAULT,schemaMatch:o.schemaMatch??0.0,memoryImportance:o.memoryImportance??MEMORY_IMPORTANCE_DEFAULT};}
/** // source: Rescorla-Wagner (1972); Schultz (1997). postcondition: da in [0,3], newBaseline in [0.1,0.9]. */
export function computeDopamineRpe(op:boolean,on:boolean,mi:number,dab:number):[number,number]{
  const actual=op?DA_POSITIVE_BASE+mi*DA_POSITIVE_IMPORTANCE_SCALE:on?DA_NEGATIVE_BASE-mi*DA_NEGATIVE_IMPORTANCE_SCALE:DA_NEUTRAL_ACTUAL,delta=actual-dab;
  return[Math.max(0.0,Math.min(DA_CEILING,1.0+delta)),Math.max(DA_BASELINE_MIN,Math.min(DA_BASELINE_MAX,dab+DA_LEARNING_RATE*(actual-dab)))];
}
/** // source: Aston-Jones (2005). postcondition: ne in [0.3,2.0]. */
export function computeNorepinephrineArousal(err:boolean,cne:number,nad:number):[number,number]{
  let ne:number,na:number;
  if(err){ne=Math.min(2.0,cne+NE_BURST_SCALE*(1.0-nad));na=Math.min(NE_ADAPTATION_MAX,nad+NE_HAB_RATE);}
  else{ne=cne+NE_TONIC_RETURN_RATE*(1.0-cne);na=Math.max(0.0,nad-NE_HAB_DECAY);}
  return[Math.max(CHANNEL_MIN,Math.min(2.0,ne)),na];
}
/** // source: Dayan & Huys (2009). */
export function computeSerotoninExploration(sm:number,ne:number,te:number,cs:number):number{
  const nov=te>0?ne/Math.max(te,1):SER_NOVELTY_DEFAULT,target=Math.max(SER_TARGET_MIN,Math.min(SER_TARGET_MAX,SER_TARGET_BASE+nov*SER_NOVELTY_GAIN-sm*SER_SCHEMA_SUPPRESSION));
  return cs+SER_ALPHA*(target-cs);
}
/** Cross-coupling (engineering heuristic). postcondition: DA[0,3], NE/ACh/5-HT[0.3,2.0]. */
export function applyCrossCoupling(da:number,ne:number,ach:number,ser:number):[number,number,number,number]{
  return[Math.max(0.0,Math.min(DA_CEILING,da+SER_DA*(ser-1.0))),Math.max(CHANNEL_MIN,Math.min(2.0,ne+DA_NE*(da-1.0))),Math.max(CHANNEL_MIN,Math.min(2.0,ach+NE_ACH*(ne-1.0))),Math.max(CHANNEL_MIN,Math.min(2.0,ser+ACH_SER*(ach-1.0)))];
}
function computeAch(s:OperationSignals):number{return s.achFromTheta+(s.totalEntities>0?s.novelEntities/Math.max(s.totalEntities,1)*ACH_NOVELTY_BOOST:0.0);}
export function updateState(cur:NeuromodulatoryState,signals:OperationSignals):NeuromodulatoryState{
  const[daR,nb]=computeDopamineRpe(signals.errorResolved||signals.testPassed,signals.errorEncountered||signals.testFailed,signals.memoryImportance,cur.daBaseline);
  const[neR,na]=computeNorepinephrineArousal(signals.errorEncountered,cur.norepinephrine,cur.neAdaptation);
  const achR=computeAch(signals),serR=computeSerotoninExploration(signals.schemaMatch,signals.novelEntities,signals.totalEntities,cur.serotonin);
  const daB=cur.dopamine+DA_ALPHA*(daR-cur.dopamine),neB=cur.norepinephrine+NE_ALPHA*(neR-cur.norepinephrine),achB=cur.acetylcholine+ACH_ALPHA*(achR-cur.acetylcholine);
  const[da,ne,ach,ser]=applyCrossCoupling(daB,neB,achB,serR);
  return{dopamine:Math.round(da*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,norepinephrine:Math.round(ne*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,acetylcholine:Math.round(ach*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,serotonin:Math.round(ser*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,daBaseline:Math.round(nb*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,neAdaptation:Math.round(na*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE};
}
export function modulateLtpRate(b:number,da:number):number{return b*da;}
export function modulatePrecisionGain(b:number,ne:number):number{return b*ne;}
export function modulateWriteGateThreshold(b:number,ne:number):number{return b/Math.max(ne,NE_MIN_DIVISOR);}
export function modulateSpreadingBreadth(b:number,ser:number):number{return Math.max(1,Math.round(b*ser));}
export function modulateRetrievalTemperature(b:number,ser:number):number{return b*ser;}
export function computeCascadeGate(da:number,imp:number):boolean{return da*imp>CASCADE_GATE_THRESHOLD;}
/** // source: Dawes (1979): equal weights match optimized regression when k<10. */
export function computeCompositeModulation(s:NeuromodulatoryState):Record<string,unknown>{
  const{dopamine:da,norepinephrine:ne,acetylcholine:ach,serotonin:ser}=s;
  const c=(da+ne+ach+ser)/DAWES_CHANNEL_COUNT;
  return{dopamine:da,norepinephrine:ne,acetylcholine:ach,serotonin:ser,heat_modulation:Math.round(c*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,importance_modulation:Math.round(c*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,decay_modulation:Math.round(c*ROUNDING_PRECISION_SCALE)/ROUNDING_PRECISION_SCALE,cascade_gate:computeCascadeGate(da,COMPOSITE_CASCADE_IMPORTANCE)};
}
export function stateToDict(s:NeuromodulatoryState):Record<string,unknown>{return{dopamine:s.dopamine,norepinephrine:s.norepinephrine,acetylcholine:s.acetylcholine,serotonin:s.serotonin,da_baseline:s.daBaseline,ne_adaptation:s.neAdaptation};}
export function stateFromDict(d:Record<string,unknown>):NeuromodulatoryState{return{dopamine:(d["dopamine"] as number|undefined)??1.0,norepinephrine:(d["norepinephrine"] as number|undefined)??1.0,acetylcholine:(d["acetylcholine"] as number|undefined)??1.0,serotonin:(d["serotonin"] as number|undefined)??1.0,daBaseline:(d["da_baseline"] as number|undefined)??DA_BASELINE_DICT_DEFAULT,neAdaptation:(d["ne_adaptation"] as number|undefined)??0.0};}
