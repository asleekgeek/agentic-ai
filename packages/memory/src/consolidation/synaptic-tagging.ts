/**
 * Synaptic Tagging & Capture (STC).
 * // source: Frey U, Morris RGM (1997) Nature 385:533-536.
 * // source: Clopath C et al. (2008) PLoS Comp Biol 4:e1000248.
 * // source: Luboeinski J, Tetzlaff C (2021) Frontiers Comp Neurosci. Bistable ODE: dz/dt=z*(1-z)*(z-0.5).
 * Tag window adapted: 90min bio -> 48h. Proximity proxy: Szymkiewicz-Simpson overlap.
 * Port of: mcp_server/core/synaptic_tagging.py  Pure business logic — no I/O.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

// Minimum importance of the new memory to trigger PRP synthesis.
// Maps to: "strong tetanization" threshold in Frey & Morris (1997).
// Hand-tuned: 0.7 chosen so only top-30% importance events produce PRPs.
// Port of: core/synaptic_tagging.py:L71 _DEFAULT_TRIGGER_IMPORTANCE; true-hand-tuned, no paper.
const DTI=0.7;

// Maximum importance of old memories eligible for tag capture.
// Memories above this are already "late-LTP" and don't need retroactive promotion.
// Hand-tuned: 0.5 = median importance. Port of: core/synaptic_tagging.py:L76 _DEFAULT_MAX_WEAK_IMPORTANCE;
// true-hand-tuned, no paper.
const DMW=0.5;

// Minimum Szymkiewicz-Simpson overlap to consider memories "spatially proximate".
// Hand-tuned: 0.3 balances selectivity with recall. Port of: core/synaptic_tagging.py:L83 _DEFAULT_MIN_OVERLAP;
// true-hand-tuned, no paper.
const DMO=0.3;

// Additive importance boost for captured synapses (E-LTP -> L-LTP).
// Hand-tuned: 0.25 moves a typical weak memory (0.3) to moderate (0.55).
// Port of: core/synaptic_tagging.py:L86 _DEFAULT_IMPORTANCE_BOOST; true-hand-tuned, no paper.
const DIB=0.25;

// Multiplicative heat reheat factor for captured synapses.
// Hand-tuned: 1.5x re-raises heat to resist near-term decay.
// Port of: core/synaptic_tagging.py:L90 _DEFAULT_HEAT_BOOST; true-hand-tuned, no paper.
const DHB=1.5;

// Tag window in hours. Biological value ~90 min (Frey & Morris 1997) adapted to 48 h.
// Adaptation ratio justified in module docstring of core/synaptic_tagging.py.
// Port of: core/synaptic_tagging.py:L95 _DEFAULT_TAG_WINDOW_HOURS; true-hand-tuned, no paper.
const DTW=48.0;

// Maximum captures per PRP-producing event.
// Hand-tuned: cap at 5 to prevent a single strong event from promoting too many memories.
// Port of: core/synaptic_tagging.py:L100 _DEFAULT_MAX_PROMOTIONS; true-hand-tuned, no paper.
const DMP=5;

// Bistable consolidation threshold.
// // source: Luboeinski J, Tetzlaff C (2021) Frontiers Comp Neurosci:
//   unstable fixed point of dz/dt = z*(1-z)*(z-0.5) is at z = 0.5.
//   z > 0.5 converges to full consolidation; z < 0.5 decays to 0.
// Port of: core/synaptic_tagging.py:L106 _BISTABLE_THRESHOLD.
const BISTABLE_THRESHOLD=0.5;

// Ceiling for initial z when PRPs are absent (tag set, no capture).
// Must be strictly below BISTABLE_THRESHOLD (0.5) to ensure tag decay.
// Port of: core/synaptic_tagging.py:L150 "return overlap * 0.4  # max 0.4 < 0.5 threshold";
// true-hand-tuned, no paper.
const NO_PRP_Z_CEILING=0.4;

// Arithmetic multiplier and divisor for rounding to 4 decimal places.
// arithmetic-identity: Math.round(x * 10000) / 10000 === round(x, 4).
// Port of: core/synaptic_tagging.py:L202 round(overlap, 4), L207 round(z_final, 4),
// L303-L307 round(..., 4); TS-only constant (Python uses round() built-in), no paper.
const ROUND_4DP = 10000;

// Sentinel default for age_hours when a memory record omits the field.
// default-limit-sentinel-epsilon: chosen large enough to exceed any realistic tag window (48 h).
// Port of: core/synaptic_tagging.py:L177 mem.get("age_hours", 999); TS-only constant, no paper.
const AGE_HOURS_MISSING_SENTINEL = 999;

// Default importance value when a memory record omits the importance field.
// default-limit-sentinel-epsilon: midpoint of [0, 1] — neutral uninformative prior.
// Port of: core/synaptic_tagging.py:L327 mem.get("importance", 0.5); TS-only constant, no paper.
const DEFAULT_IMPORTANCE = 0.5;

// Default heat value when a memory record omits the heat field.
// default-limit-sentinel-epsilon: low initial heat for unconfigured memories.
// Port of: core/synaptic_tagging.py:L328 mem.get("heat", 0.1); TS-only constant, no paper.
const DEFAULT_HEAT = 0.1;

// // source: Luboeinski & Tetzlaff (2021): unstable fixed point at z=0.5.
/** // source: Luboeinski (2021). postcondition: z in [0,1]; z>0.5->toward 1, z<0.5->toward 0. */
export function bistableConsolidation(z:number,dt=1.0):number{return Math.max(0.0,Math.min(1.0,z+z*(1.0-z)*(z-BISTABLE_THRESHOLD)*dt));}
/** postcondition: z<0.5 if !hasPrp; z>=0.5 if hasPrp. */
export function computeInitialZ(hasPrp:boolean,overlap:number):number{return hasPrp?BISTABLE_THRESHOLD+overlap*BISTABLE_THRESHOLD:overlap*NO_PRP_Z_CEILING;}
interface MemRecord{id:number;importance?:number;age_hours?:number;entities?:Set<string>;heat?:number;}
export interface TaggingCandidate{memory_id:number;overlap:number;matched_entities:string[];consolidation_z:number;}
function scoreCandidate(mem:MemRecord,ne:ReadonlySet<string>,mw:number,tw:number,mo:number):[number,TaggingCandidate]|null{
  if((mem.importance??0)>mw)return null;if((mem.age_hours??AGE_HOURS_MISSING_SENTINEL)>tw)return null;
  if(!mem.entities||mem.entities.size===0)return null;
  const inter:string[]=[];for(const e of ne)if(mem.entities.has(e))inter.push(e);
  if(!inter.length)return null;
  const ov=inter.length/Math.min(ne.size,mem.entities.size);if(ov<mo)return null;
  const zf=bistableConsolidation(computeInitialZ(true,ov));
  return[ov,{memory_id:mem.id,overlap:Math.round(ov*ROUND_4DP)/ROUND_4DP,matched_entities:inter.sort(),consolidation_z:Math.round(zf*ROUND_4DP)/ROUND_4DP}];
}
export function findTaggingCandidates(ne:ReadonlySet<string>,imp:number,mems:readonly MemRecord[],opts:{triggerImportance?:number;maxWeakImportance?:number;minOverlap?:number;tagWindowHours?:number;maxPromotions?:number}={}):TaggingCandidate[]{
  const{triggerImportance=DTI,maxWeakImportance=DMW,minOverlap=DMO,tagWindowHours=DTW,maxPromotions=DMP}=opts;
  if(imp<triggerImportance||ne.size===0)return[];
  const cands:[number,TaggingCandidate][]=[];
  for(const m of mems){const r=scoreCandidate(m,ne,maxWeakImportance,tagWindowHours,minOverlap);if(r)cands.push(r);}
  cands.sort((a,b)=>b[0]-a[0]);return cands.slice(0,maxPromotions).map(c=>c[1]);
}
export interface TagBoosts{new_importance:number;new_heat:number;importance_delta:number;heat_delta:number;consolidation_z:number;}
export function computeTagBoosts(ov:number,ci:number,ch:number,ib=DIB,hb=DHB):TagBoosts{
  const z=bistableConsolidation(computeInitialZ(true,ov));
  const ni=Math.min(1.0,ci+ib*ov*z),nh=Math.min(1.0,ch*(1.0+(hb-1.0)*ov*z));
  return{new_importance:Math.round(ni*ROUND_4DP)/ROUND_4DP,new_heat:Math.round(nh*ROUND_4DP)/ROUND_4DP,importance_delta:Math.round((ni-ci)*ROUND_4DP)/ROUND_4DP,heat_delta:Math.round((nh-ch)*ROUND_4DP)/ROUND_4DP,consolidation_z:Math.round(z*ROUND_4DP)/ROUND_4DP};
}
export function applySynapticTags(ne:ReadonlySet<string>,imp:number,mems:readonly MemRecord[],opts:{triggerImportance?:number;maxWeakImportance?:number;minOverlap?:number;tagWindowHours?:number;maxPromotions?:number;importanceBoost?:number;heatBoost?:number}={}):Array<TaggingCandidate&TagBoosts>{
  const{importanceBoost=DIB,heatBoost=DHB,...rest}=opts;
  const cands=findTaggingCandidates(ne,imp,mems,rest);const r:Array<TaggingCandidate&TagBoosts>=[];
  for(const c of cands){const m=mems.find(x=>x.id===c.memory_id);if(!m)continue;r.push({...c,...computeTagBoosts(c.overlap,m.importance??DEFAULT_IMPORTANCE,m.heat??DEFAULT_HEAT,importanceBoost,heatBoost)});}
  return r;
}
