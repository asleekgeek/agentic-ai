/**
 * Memory thermodynamics — heat, surprise, decay, importance, valence.
 *
 * Pure business logic — no I/O.
 *
 * Key concepts:
 *   - Heat: freshness signal (1.0=hot, 0.0=cold). Decays over time, reheated on access.
 *   - Surprise: novelty signal (1.0=maximally novel). Drives write gate decisions.
 *   - Importance: Edmundson (1969) four-feature scoring (cue + key + title + loc).
 *   - Valence: VADER compound sentiment (Hutto & Gilbert 2014).
 *   - Metamemory: tracks access frequency and usefulness for confidence calibration.
 *
 * Citations:
 *   // source: Ebbinghaus H (1885) "Über das Gedächtnis." R(t) = e^{-t/S}.
 *     Importance and valence modulate S, following the finding that emotional
 *     and meaningful memories decay slower (McGaugh 2004).
 *   // source: Edmundson HP (1969) "New Methods in Automatic Extracting."
 *     JACM 16(2):264-285. Four-feature scoring with validated weights w_cue=2,
 *     w_key=1, w_title=1, w_loc=1.
 *   // source: Hutto CJ & Gilbert E (2014) "VADER: A Parsimonious Rule-based Model
 *     for Sentiment Analysis of Social Media Text." ICWSM.
 *     compound = x / sqrt(x^2 + alpha), alpha=15.
 *   // source: Emotional resistance: time-dependent (Yonelinas & Ritchey 2015).
 *     Emotional advantage grows with delay (Kleinsmith & Kaplan 1963 crossover).
 *
 * Port of: mcp_server/core/thermodynamics.py
 */

// ── Named constants ───────────────────────────────────────────────────────────

/** Top-quartile divisor for Edmundson key feature (top 25% of unique terms).
 * // source: port of core/thermodynamics.py:L183 (top_k = len(sorted_counts)//4 = "top quartile of unique terms"); arithmetic-identity (quartile divisor), no paper for this value. Edmundson (1969) grounds the four-feature importance formula, not this divisor.
 */
const EDMUNDSON_KEY_TOP_QUARTILE_DIVISOR = 4;

/** Importance threshold above which the slower (importance) decay factor applies.
 * // source: port of core/thermodynamics.py:L261-263; true-hand-tuned threshold, no paper (Craik & Lockhart 1972 backs the concept that meaningful memories consolidate better, not this 0.7 cutoff).
 */
const IMPORTANCE_HIGH_THRESHOLD = 0.7;

// Default return value for computeSurprise when no existing memories are present.
// Port of core/thermodynamics.py:L143 `return 0.5`; default-limit-sentinel-epsilon,
// no paper. Neutral midpoint of [0, 1] surprise range.
const SURPRISE_DEFAULT_NO_MEMORIES = 0.5;

// Default boost factor for applySurpriseBoost (base_heat += surprise * boost_factor).
// Port of core/thermodynamics.py:L149 `boost_factor: float = 0.3`; true-hand-tuned,
// no paper. Controls how strongly novelty inflates initial heat.
const SURPRISE_BOOST_FACTOR_DEFAULT = 0.3;

// Additive cue boost applied when content contains code blocks or file paths.
// Port of core/thermodynamics.py:L212 `cue = min(1.0, cue + 0.15)`; true-hand-tuned,
// no paper. Signals that technical content is typically higher importance.
const EDMUNDSON_TECHNICAL_CUE_BOOST = 0.15;

// Rounding precision for Edmundson importance score: round(x, 4) in Python
// is equivalent to Math.round(x * 10_000) / 10_000 in TypeScript.
// Port of core/thermodynamics.py:L234 `round(raw / max_raw, 4)`;
// arithmetic-identity (10^4), no paper.
const IMPORTANCE_ROUND_FACTOR = 10000;

// Default importance used when no importance argument is supplied to computeDecay.
// Port of core/thermodynamics.py:L250 `importance: float = 0.5`;
// default-limit-sentinel-epsilon, no paper. Neutral midpoint of [0, 1].
const DECAY_DEFAULT_IMPORTANCE = 0.5;

// Default hourly decay factor λ in heat(t) = heat(0) · λ^t (Ebbinghaus 1885).
// Port of core/thermodynamics.py:L51 `_DECAY_FACTOR_DEFAULT = 0.95`.
// Explicitly stated in Python docstring: "tuned to produce reasonable half-lives
// (~14h normal) … Not from any paper." true-hand-tuned, no paper.
const DECAY_FACTOR_DEFAULT = 0.95;

// Decay factor applied when importance > IMPORTANCE_HIGH_THRESHOLD.
// Port of core/thermodynamics.py:L255 `importance_decay_factor: float = 0.998`.
// Explicitly stated in Python docstring: "tuned to produce reasonable half-lives
// (~346h important) … Not from any paper." true-hand-tuned, no paper.
const IMPORTANCE_DECAY_FACTOR_DEFAULT = 0.998;

// Default emotional decay resistance weight.
// Port of core/thermodynamics.py:L256 `emotional_decay_resistance: float = 0.5`;
// true-hand-tuned, no paper. Controls how much |valence| slows decay.
const EMOTIONAL_DECAY_RESISTANCE_DEFAULT = 0.5;

// Confidence modifier gain: confidence_mod = 1.0 + confidence * 0.1.
// Port of core/thermodynamics.py:L292 `confidence_mod = 1.0 + confidence * 0.1`;
// true-hand-tuned; Python docstring says "Engineering decision — no paper."
const CONFIDENCE_MOD_GAIN = 0.1;

// Default bonus added to heat for in-session memories.
// Port of core/thermodynamics.py:L302 `bonus: float = 0.2`; true-hand-tuned,
// no paper. Engineering decision to prevent "I just told you this" failures.
const SESSION_COHERENCE_BONUS_DEFAULT = 0.2;

// Default session window in hours for computeSessionCoherence.
// Port of core/thermodynamics.py:L303 `window_hours: float = 4.0`; true-hand-tuned,
// no paper. Chosen to match a typical working session length.
const SESSION_COHERENCE_WINDOW_HOURS_DEFAULT = 4.0;

// Milliseconds per hour — used to convert Date.now() delta to hours.
// TS-only (Python uses timedelta.total_seconds() / 3600.0); arithmetic-identity
// (1000 ms/s × 3600 s/h = 3_600_000), no paper.
const MS_PER_HOUR = 3_600_000;

// Minimum access count before metamemory confidence is meaningful.
// Port of core/thermodynamics.py:L325 `if access_count <= 3: return None`;
// true-hand-tuned, no paper. Python docstring notes: "Loosely inspired by
// Nelson & Narens (1990) metamemory framework but implemented as a simple ratio."
const METAMEMORY_MIN_ACCESS_COUNT = 3;

// ── Edmundson cue word sets ────────────────────────────────────────────────
// Bonus words: domain-specific high-importance indicators (positive cue)
// Stigma words: low-importance indicators (negative cue)

const BONUS_WORDS = new Set([
  "error", "exception", "traceback", "failed", "failure", "bug", "crash",
  "broken", "timeout", "denied", "rejected", "deprecated", "decided",
  "chose", "switched", "migrated", "selected", "picked", "opted",
  "design", "pattern", "refactor", "architecture", "restructure",
  "modular", "decouple", "abstract", "breaking", "migration", "critical",
  "security", "vulnerability", "performance", "bottleneck", "regression",
  "root cause",
]);

const STIGMA_WORDS = new Set([
  "maybe", "minor", "trivial", "fyi", "note", "aside", "btw",
  "probably", "might", "perhaps", "just", "small",
]);

const CODE_BLOCK_RE = /```|`[^`]+`/;
const FILE_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.\w+/;
const WORD_RE = /[a-z]+(?:'[a-z]+)?/gi;
const ERROR_KW_RE = /\b(error|exception|traceback|failed|failure|bug|crash|broken|timeout|denied|rejected|deprecated)\b/i;
const DECISION_KW_RE = /\b(decided|chose|switched|migrated|selected|picked|opted)\b/i;

// ── Surprise ─────────────────────────────────────────────────────────────────

/**
 * Compute how novel content is relative to existing memories.
 *
 * surprise = 1.0 - max_similarity. Returns 0.5 if no existing memories.
 */
export function computeSurprise(
  _content: string,
  existingSimilarities: readonly number[],
): number {
  if (existingSimilarities.length === 0) return SURPRISE_DEFAULT_NO_MEMORIES;
  const maxSim = Math.max(...existingSimilarities);
  return Math.max(0.0, Math.min(1.0, 1.0 - maxSim));
}

/** Apply surprise boost to initial heat. Capped at 1.0. */
export function applySurpriseBoost(
  baseHeat: number,
  surprise: number,
  boostFactor = SURPRISE_BOOST_FACTOR_DEFAULT,
): number {
  return Math.min(baseHeat + surprise * boostFactor, 1.0);
}

// ── Edmundson Importance ─────────────────────────────────────────────────────

function edmundsonCue(words: string[]): number {
  if (words.length === 0) return 0.0;
  let bonus = 0;
  let stigma = 0;
  for (const w of words) {
    if (BONUS_WORDS.has(w)) bonus++;
    if (STIGMA_WORDS.has(w)) stigma++;
  }
  const raw = (bonus - stigma) / words.length;
  return Math.max(0.0, Math.min(1.0, raw));
}

function edmundsonKey(words: string[]): number {
  if (words.length === 0) return 0.0;
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  if (freq.size < 2) return 0.0;
  const sortedCounts = Array.from(freq.values()).sort((a, b) => b - a);
  const totalMass = sortedCounts.reduce((s, c) => s + c, 0);
  const topK = Math.max(1, Math.floor(sortedCounts.length / EDMUNDSON_KEY_TOP_QUARTILE_DIVISOR));
  const topMass = sortedCounts.slice(0, topK).reduce((s, c) => s + c, 0);
  return topMass / totalMass;
}

/**
 * Edmundson (1969) four-feature importance scoring.
 *
 * // source: Edmundson HP (1969) "New Methods in Automatic Extracting."
 *   JACM 16(2):264-285.
 *   importance = w_cue * cue(m) + w_key * key(m) + w_title * title(m) + w_loc * loc(m)
 *   Validated weights: w_cue=2, w_key=1, w_title=1, w_loc=1.
 *
 * Final score normalized to [0, 1].
 */
export function computeImportance(
  content: string,
  tags: readonly string[] | null = null,
): number {
  const words: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WORD_RE.source, "gi");
  while ((m = re.exec(content)) !== null) {
    words.push(m[0].toLowerCase());
  }

  let cue = edmundsonCue(words);
  // Boost cue for code blocks and file paths (technical cue signals)
  if (CODE_BLOCK_RE.test(content) || FILE_PATH_RE.test(content)) {
    cue = Math.min(1.0, cue + EDMUNDSON_TECHNICAL_CUE_BOOST);
  }

  const key = edmundsonKey(words);

  let title = 0.0;
  if (tags && tags.length > 0) {
    const tagWords = new Set(tags.map((t) => t.toLowerCase()));
    const overlap = [...tagWords].filter((t) => BONUS_WORDS.has(t)).length;
    title = overlap / tags.length;
  }

  const loc = 0.0; // Not applicable for single-unit memories

  // Edmundson validated weights
  const wCue = 2, wKey = 1, wTitle = 1, wLoc = 1;
  const raw = wCue * cue + wKey * key + wTitle * title + wLoc * loc;
  const maxRaw = wCue + wKey + wTitle + wLoc; // 5
  return Math.min(1.0, Math.round((raw / maxRaw) * IMPORTANCE_ROUND_FACTOR) / IMPORTANCE_ROUND_FACTOR);
}

// ── Decay (Ebbinghaus + modulation) ──────────────────────────────────────────

/**
 * Exponential forgetting: heat(t) = heat(0) * λ^t  (Ebbinghaus 1885).
 *
 * λ (effective decay factor per hour) is modulated by:
 *   - Importance > 0.7: λ increases to importanceDecayFactor (slower decay).
 *     // source: Craik & Lockhart (1972) levels-of-processing.
 *   - |valence|: pushes λ toward 1.0 (emotional memories resist decay).
 *     // source: McGaugh (2004) amygdala modulation of consolidation.
 *     // source: Emotional resistance: time-dependent (Yonelinas & Ritchey 2015).
 *     // source: Emotional advantage grows with delay (Kleinsmith & Kaplan 1963 crossover).
 *   - confidence: minor λ increase. Engineering decision — no paper.
 *
 * Constants: decayFactor=0.95 and importanceDecayFactor=0.998 are tuned
 * to produce reasonable half-lives (~14h normal, ~346h important) for a
 * memory system operating at hours/days timescale. Not from any paper.
 *
 * Precision note: JS uses IEEE 754 double (same as Python float). The
 * time_saturation formula 1 - exp(-hours) is identical. No epsilon needed.
 */
export function computeDecay(
  currentHeat: number,
  hoursElapsed: number,
  importance = DECAY_DEFAULT_IMPORTANCE,
  valence = 0.0,
  confidence = 1.0,
  opts: {
    decayFactor?: number;
    importanceDecayFactor?: number;
    emotionalDecayResistance?: number;
  } = {},
): number {
  if (hoursElapsed <= 0) return currentHeat;

  const {
    decayFactor = DECAY_FACTOR_DEFAULT,
    importanceDecayFactor = IMPORTANCE_DECAY_FACTOR_DEFAULT,
    emotionalDecayResistance = EMOTIONAL_DECAY_RESISTANCE_DEFAULT,
  } = opts;

  const base = importance > IMPORTANCE_HIGH_THRESHOLD ? importanceDecayFactor : decayFactor;

  // Emotional resistance: time-dependent (Yonelinas & Ritchey 2015).
  // Emotional advantage grows with delay (Kleinsmith & Kaplan 1963 crossover).
  // At t=0: no resistance. At t>>1h: full resistance (up to 30% at |v|=1).
  const timeSaturation = 1.0 - Math.exp(-hoursElapsed);
  const emotionalMod =
    1.0 + Math.abs(valence) * emotionalDecayResistance * timeSaturation;
  let effective = 1.0 - (1.0 - base) / emotionalMod;

  // Confidence modifier
  const confidenceMod = 1.0 + confidence * CONFIDENCE_MOD_GAIN;
  effective = 1.0 - (1.0 - effective) / confidenceMod;

  effective = Math.max(0.0, Math.min(effective, 1.0));
  return currentHeat * Math.pow(effective, hoursElapsed);
}

// ── Session Coherence ─────────────────────────────────────────────────────────

/**
 * Boost heat for memories created within the current session window.
 *
 * Prevents "I just told you this" by keeping active context elevated.
 * Engineering decision — no paper source.
 */
export function computeSessionCoherence(
  heat: number,
  createdAtIso: string,
  bonus = SESSION_COHERENCE_BONUS_DEFAULT,
  windowHours = SESSION_COHERENCE_WINDOW_HOURS_DEFAULT,
): number {
  try {
    const memDt = new Date(createdAtIso);
    if (isNaN(memDt.getTime())) return heat;
    const hours = (Date.now() - memDt.getTime()) / MS_PER_HOUR;
    if (hours < windowHours) {
      const freshness = 1.0 - hours / windowHours;
      return Math.min(heat + bonus * freshness, 1.0);
    }
  } catch {
    // ignore
  }
  return heat;
}

// ── Metamemory ────────────────────────────────────────────────────────────────

/**
 * Update confidence after enough data points.
 * Returns null if not enough data (fewer than 4 accesses).
 *
 * Loosely inspired by Nelson & Narens (1990) metamemory framework but
 * implemented as a simple ratio, not their full monitoring-control model.
 */
export function computeMetamemoryConfidence(
  accessCount: number,
  usefulCount: number,
): number | null {
  if (accessCount <= METAMEMORY_MIN_ACCESS_COUNT) return null;
  return usefulCount / accessCount;
}

// ── Content Classification ────────────────────────────────────────────────────

/** Check if content contains error/exception keywords. */
export function isErrorContent(content: string): boolean {
  return ERROR_KW_RE.test(content);
}

/** Check if content contains decision keywords. */
export function isDecisionContent(content: string): boolean {
  return DECISION_KW_RE.test(content);
}
