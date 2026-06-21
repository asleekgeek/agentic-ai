/**
 * Intent classification and retrieval weight computation.
 *
 * Port of: mcp_server/core/query_intent.py
 *
 * Detects query intent via regex pattern matching and question-word
 * boosters, then maps intent to retrieval signal weights for RRF fusion.
 *
 * Pure business logic — no I/O.
 */

import { type QueryIntentValue, QueryIntent, type SignalWeights } from "./types.js";

// ── Intent patterns ────────────────────────────────────────────────────────
// Port of: mcp_server/core/query_intent.py _*_RE constants

const TEMPORAL_RE =
  /\b(when|happened|history|last time|recently|before|after|yesterday|today|earlier|previous|chronolog|timeline|sequence)\b/i;

const CAUSAL_RE =
  /\b(why|because|caused|cause|root cause|reason|led to|resulted in|consequence|due to|fault|blame|origin|source of)\b/i;

const SEMANTIC_RE =
  /\b(related|similar|like|about|associated|connected|relevant|pertaining|regarding|concerning|involves)\b/i;

const ENTITY_RE =
  /\b(what is|who is|tell me about|describe|define|explain|details on|info about|information on)\b/i;

const KNOWLEDGE_UPDATE_RE =
  /\b(latest|current|now|recently|updated|changed|new|most recent|anymore|still|switched|moved|replaced|no longer|instead|currently)\b/i;

const MULTI_HOP_RE =
  /\b(both|and also|as well as|together|between|compare|relationship|how does.*relate|connect|in common)\b/i;

const INSTRUCTION_RE =
  /\b(instruction|guideline|requirement|constraint|supposed to|expected to|should i|must i)\b|what (?:rule|format|style|tone|constraint)|how should (?:i|you|we)/i;

// Event ordering — ChronoRAG (Chen et al., 2025): chronological assembly improves ordering.
// source: parity with mcp_server/core/query_intent.py:64
const EVENT_ORDER_RE =
  /\b(what happened first|in what order|sequence of|chronological|what came before|what came after|order of events|first.*then.*then|happened before|happened after|what order|which came first|what was the first|what was the last|earliest|latest)\b/i;

// Summarization — MMR diversity reranking (Carbonell & Goldstein, SIGIR 1998)
const SUMMARIZATION_RE =
  /\b(summarize|summary|overview|recap|give me a rundown|tell me about all|everything about|what do you know about|main points|key events|highlights|what happened with)\b/i;

// Preference queries — ENGRAM (arxiv 2511.12960)
const PREFERENCE_RE =
  /\b(prefer|preference|favorite|like|dislike|taste|style|choice|habit|want|wish|rather)\b|what (?:do|does|did) (?:i|the user|they) (?:like|prefer|want)|how (?:do|does|did) (?:i|the user|they) (?:like|prefer)/i;

const QUESTION_WHY = /^\s*why\b/i;
const QUESTION_WHEN = /^\s*when\b/i;
const QUESTION_WHAT = /^\s*(what|who)\b/i;
const QUESTION_HOW = /^\s*how\b/i;
const QUESTION_INSTRUCTION = /^\s*(how should|what (?:format|rule|constraint|style|tone))\b/i;

// ── Pattern scoring constants ──────────────────────────────────────────────
// Port of: mcp_server/core/query_intent.py _score_patterns

// Boost added to KNOWLEDGE_UPDATE when ENTITY pattern also matches.
const KNOWLEDGE_UPDATE_ENTITY_BOOST = 0.5;

// EVENT_ORDER match gives a stronger base signal than other patterns
// to override TEMPORAL when both fire.
const EVENT_ORDER_SCORE_BOOST = 1.5;

// Temporal also receives a partial credit when event-order fires.
const EVENT_ORDER_TEMPORAL_BOOST = 0.3;

// Multi-hop boost when two or more named entities are present.
const MULTI_ENTITY_HOP_BOOST = 0.5;

// ── Question-booster constants ─────────────────────────────────────────────
// Port of: mcp_server/core/query_intent.py _apply_question_boosters

const QUESTION_WHY_CAUSAL_BOOST = 0.5;
const QUESTION_WHEN_TEMPORAL_BOOST = 0.5;
const QUESTION_WHAT_ENTITY_BOOST = 0.3;
const QUESTION_WHAT_SEMANTIC_BOOST = 0.2;
const QUESTION_HOW_CAUSAL_BOOST = 0.3;
const QUESTION_INSTRUCTION_BOOST = 0.8;

// ── Score rounding ─────────────────────────────────────────────────────────
// Port of: mcp_server/core/query_intent.py classify_query_intent —
// round(v, 3) maps to Math.round(v * 1000) / 1000 in TypeScript.
const SCORE_ROUND_FACTOR = 1000; // source: parity with mcp_server/core/query_intent.py:204 — round(v, 3) → 10^3

// ── Derived-signal weight multipliers (expandSignalWeights) ────────────────
// Port of: mcp_server/core/retrieval_dispatch.py _base_weights (lines 86-91)
// and compute_signal_weights sa formula (line 157).

const SIGNAL_SA_FTS_FACTOR = 0.5;
const SIGNAL_HOPFIELD_VECTOR_FACTOR = 0.5;
const SIGNAL_HDC_VECTOR_FACTOR = 0.4;
const SIGNAL_SR_HEAT_FACTOR = 0.6;
const SIGNAL_BM25_FTS_FACTOR = 0.8;
const SIGNAL_NGRAM_FTS_FACTOR = 0.6;

// ── Pattern scoring ────────────────────────────────────────────────────────

function scorePatterns(query: string): Record<string, number> {
  const scores: Record<string, number> = {
    [QueryIntent.TEMPORAL]: 0,
    [QueryIntent.CAUSAL]: 0,
    [QueryIntent.SEMANTIC]: 0,
    [QueryIntent.ENTITY]: 0,
    [QueryIntent.KNOWLEDGE_UPDATE]: 0,
    [QueryIntent.MULTI_HOP]: 0,
    [QueryIntent.INSTRUCTION]: 0,
    [QueryIntent.EVENT_ORDER]: 0,
    [QueryIntent.SUMMARIZATION]: 0,
    [QueryIntent.PREFERENCE]: 0,
  };

  if (TEMPORAL_RE.test(query)) scores[QueryIntent.TEMPORAL] = (scores[QueryIntent.TEMPORAL] ?? 0) + 1;
  if (CAUSAL_RE.test(query)) scores[QueryIntent.CAUSAL] = (scores[QueryIntent.CAUSAL] ?? 0) + 1;
  if (SEMANTIC_RE.test(query)) scores[QueryIntent.SEMANTIC] = (scores[QueryIntent.SEMANTIC] ?? 0) + 1;
  if (ENTITY_RE.test(query)) scores[QueryIntent.ENTITY] = (scores[QueryIntent.ENTITY] ?? 0) + 1;
  if (KNOWLEDGE_UPDATE_RE.test(query)) {
    scores[QueryIntent.KNOWLEDGE_UPDATE] = (scores[QueryIntent.KNOWLEDGE_UPDATE] ?? 0) + 1;
    if (ENTITY_RE.test(query)) {
      scores[QueryIntent.KNOWLEDGE_UPDATE] = (scores[QueryIntent.KNOWLEDGE_UPDATE] ?? 0) + KNOWLEDGE_UPDATE_ENTITY_BOOST;
    }
  }
  if (MULTI_HOP_RE.test(query)) scores[QueryIntent.MULTI_HOP] = (scores[QueryIntent.MULTI_HOP] ?? 0) + 1;
  if (INSTRUCTION_RE.test(query)) scores[QueryIntent.INSTRUCTION] = (scores[QueryIntent.INSTRUCTION] ?? 0) + 1;
  if (EVENT_ORDER_RE.test(query)) {
    // strong signal — overrides temporal
    scores[QueryIntent.EVENT_ORDER] = (scores[QueryIntent.EVENT_ORDER] ?? 0) + EVENT_ORDER_SCORE_BOOST;
    scores[QueryIntent.TEMPORAL] = (scores[QueryIntent.TEMPORAL] ?? 0) + EVENT_ORDER_TEMPORAL_BOOST;
  }
  if (SUMMARIZATION_RE.test(query)) scores[QueryIntent.SUMMARIZATION] = (scores[QueryIntent.SUMMARIZATION] ?? 0) + 1;
  if (PREFERENCE_RE.test(query)) scores[QueryIntent.PREFERENCE] = (scores[QueryIntent.PREFERENCE] ?? 0) + 1;

  // Multi-entity detection boosts multi-hop
  const namedEntities = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  if (namedEntities.length >= 2) {
    scores[QueryIntent.MULTI_HOP] = (scores[QueryIntent.MULTI_HOP] ?? 0) + MULTI_ENTITY_HOP_BOOST;
  }

  return scores;
}

// ── Question boosters ──────────────────────────────────────────────────────

function applyQuestionBoosters(
  query: string,
  scores: Record<string, number>,
): void {
  if (QUESTION_WHY.test(query)) scores[QueryIntent.CAUSAL] = (scores[QueryIntent.CAUSAL] ?? 0) + QUESTION_WHY_CAUSAL_BOOST;
  if (QUESTION_WHEN.test(query)) scores[QueryIntent.TEMPORAL] = (scores[QueryIntent.TEMPORAL] ?? 0) + QUESTION_WHEN_TEMPORAL_BOOST;
  if (QUESTION_WHAT.test(query)) {
    scores[QueryIntent.ENTITY] = (scores[QueryIntent.ENTITY] ?? 0) + QUESTION_WHAT_ENTITY_BOOST;
    scores[QueryIntent.SEMANTIC] = (scores[QueryIntent.SEMANTIC] ?? 0) + QUESTION_WHAT_SEMANTIC_BOOST;
  }
  if (QUESTION_HOW.test(query)) scores[QueryIntent.CAUSAL] = (scores[QueryIntent.CAUSAL] ?? 0) + QUESTION_HOW_CAUSAL_BOOST;
  if (QUESTION_INSTRUCTION.test(query)) scores[QueryIntent.INSTRUCTION] = (scores[QueryIntent.INSTRUCTION] ?? 0) + QUESTION_INSTRUCTION_BOOST;
}

// ── Weight maps ────────────────────────────────────────────────────────────
// Port of: mcp_server/core/query_intent.py _BASE_WEIGHTS, _INTENT_WEIGHT_OVERRIDES

const BASE_WEIGHTS: SignalWeights = {
  vector: 1.0,
  fts: 0.5,
  heat: 0.3,
  temporal: 0.2,
  causal: 0.1,
  entity: 0.2,
  spreading: 0.3,
};

const INTENT_WEIGHT_OVERRIDES: Partial<Record<QueryIntentValue, Partial<SignalWeights>>> = {
  [QueryIntent.TEMPORAL]: {
    temporal: 1.0,
    heat: 0.5,
    vector: 0.5,
    causal: 0.3,
    spreading: 0.2,
  },
  [QueryIntent.CAUSAL]: {
    causal: 1.0,
    entity: 0.7,
    vector: 0.5,
    temporal: 0.5,
    spreading: 0.6,
  },
  [QueryIntent.SEMANTIC]: {
    vector: 1.0,
    fts: 0.7,
    heat: 0.3,
    entity: 0.5,
    spreading: 0.5,
  },
  [QueryIntent.ENTITY]: {
    entity: 1.0,
    fts: 0.8,
    vector: 0.5,
    causal: 0.3,
    spreading: 0.8,
  },
  [QueryIntent.KNOWLEDGE_UPDATE]: {
    heat: 1.0,
    vector: 0.8,
    fts: 0.6,
    temporal: 0.8,
    entity: 0.5,
    spreading: 0.3,
  },
  [QueryIntent.MULTI_HOP]: {
    vector: 1.0,
    fts: 0.7,
    entity: 0.8,
    spreading: 1.0,
    heat: 0.3,
    causal: 0.5,
  },
  [QueryIntent.INSTRUCTION]: {
    fts: 1.0,
    vector: 0.5,
    heat: 0.3,
    entity: 0.3,
    spreading: 0.3,
  },
  // Event ordering: temporal + vector for finding events, recency to anchor time.
  // ChronoRAG (Chen et al., 2025) validates chronological reranking is applied post-retrieval.
  [QueryIntent.EVENT_ORDER]: {
    temporal: 1.0,
    vector: 0.8,
    fts: 0.6,
    heat: 0.3,
    entity: 0.5,
    spreading: 0.3,
  },
  // Summarization: broad retrieval, diversity matters more than precision.
  // MMR reranking (Carbonell & Goldstein, SIGIR 1998) applied post-retrieval.
  [QueryIntent.SUMMARIZATION]: {
    vector: 1.0,
    fts: 0.8,
    heat: 0.5,
    entity: 0.6,
    spreading: 0.5,
  },
  // Preference: FTS boosted (preference keywords are distinctive),
  // heat boosted (preferences tend to be important).
  // ENGRAM (arxiv 2511.12960) shows typed retrieval improves preference recall.
  [QueryIntent.PREFERENCE]: {
    fts: 0.8,
    heat: 0.5,
    vector: 0.7,
    entity: 0.5,
    spreading: 0.5,
  },
};

// ── Public API ────────────────────────────────────────────────────────────

export interface QueryIntentResult {
  intent: QueryIntentValue;
  scores: Record<string, number>;
  weights: SignalWeights;
}

/**
 * Classify a query's intent for retrieval signal routing.
 *
 * Returns:
 *   - intent: primary intent value
 *   - scores: per-intent floating-point scores
 *   - weights: recommended retrieval signal weights
 *
 * Port of: mcp_server/core/query_intent.py::classify_query_intent
 */
export function classifyQueryIntent(query: string): QueryIntentResult {
  const scores = scorePatterns(query);
  applyQuestionBoosters(query, scores);

  const maxScore = Math.max(...Object.values(scores));
  let primary: QueryIntentValue = QueryIntent.GENERAL;
  if (maxScore > 0) {
    const winner = Object.entries(scores).reduce((best, [k, v]) =>
      v > (scores[best] ?? 0) ? k : best,
    Object.keys(scores)[0] as string);
    primary = winner as QueryIntentValue;
  }

  const weights = computeRetrievalWeights(primary, scores);
  return {
    intent: primary,
    scores: Object.fromEntries(
      Object.entries(scores).map(([k, v]) => [k, Math.round(v * SCORE_ROUND_FACTOR) / SCORE_ROUND_FACTOR]),
    ),
    weights,
  };
}

/**
 * Compute retrieval signal weights based on classified intent.
 *
 * Port of: mcp_server/core/query_intent.py::compute_retrieval_weights
 */
export function computeRetrievalWeights(
  primaryIntent: QueryIntentValue,
  _scores: Record<string, number>,
): SignalWeights {
  const weights: SignalWeights = { ...BASE_WEIGHTS };
  const overrides = INTENT_WEIGHT_OVERRIDES[primaryIntent];
  if (overrides) {
    Object.assign(weights, overrides);
  }
  return Object.fromEntries(
    Object.entries(weights).map(([k, v]) => [k, Math.round(v * SCORE_ROUND_FACTOR) / SCORE_ROUND_FACTOR]),
  ) as SignalWeights;
}

// ── Per-signal WRRF weight expansion (port of retrieval_dispatch.py) ──

// source: cortex@ed33435 mcp_server/core/retrieval_dispatch.py:86-91 — base
//   weight constants. Multiplied by intent-derived modifiers then expanded
//   across the 9 actual signals fused by the recall handler.
const FUSION_BASE_VECTOR = 1.0;
const FUSION_BASE_FTS = 0.5;
const FUSION_BASE_HEAT = 0.3;

/**
 * Expand intent weights into the per-signal WRRF weight map the fuser uses.
 *
 * Mirrors cortex@ed33435 retrieval_dispatch.py::_base_weights — the Python
 * recall pipeline never fuses with the raw intent dictionary; it always
 * passes through this expansion so derived signals (hopfield/hdc/sr/bm25/
 * ngram) get sensible weights proportional to their parent (vector / fts /
 * heat). Without this expansion, plain RRF dominates and derived signals
 * (hopfield/hdc/sr/bm25/ngram) get equal weight regardless of their
 * informativeness.
 * source: parity with mcp_server/core/retrieval_dispatch.py:145-164
 *   (compute_signal_weights)
 *
 * precondition: intentWeights contains the keys vector/fts/heat/spreading
 *   (others are tolerated and ignored).
 * postcondition: returned object has weights for every signal the recall
 *   handler emits: vector, fts, heat, hopfield, hdc, sr, sa, bm25, ngram.
 *
 * source: cortex@ed33435 mcp_server/core/retrieval_dispatch.py:_base_weights:86-91
 */
export function expandSignalWeights(
  intentWeights: SignalWeights,
): Record<string, number> {
  const v = FUSION_BASE_VECTOR * (intentWeights["vector"] ?? 1.0);
  const f = FUSION_BASE_FTS * (intentWeights["fts"] ?? 1.0);
  const h = FUSION_BASE_HEAT * (intentWeights["heat"] ?? 1.0);
  // source: retrieval_dispatch.py:157 — sa = f * 0.5 * intent_weights['spreading']
  const sa = f * SIGNAL_SA_FTS_FACTOR * (intentWeights["spreading"] ?? 1.0);
  return {
    vector: v,
    fts: f,
    heat: h,
    // source: retrieval_dispatch.py:_base_weights (lines 86-91) — derived signal multipliers
    hopfield: v * SIGNAL_HOPFIELD_VECTOR_FACTOR,
    hdc: v * SIGNAL_HDC_VECTOR_FACTOR,
    sr: h * SIGNAL_SR_HEAT_FACTOR,
    sa,
    bm25: f * SIGNAL_BM25_FTS_FACTOR,
    ngram: f * SIGNAL_NGRAM_FTS_FACTOR,
  };
}
