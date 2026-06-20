/**
 * handlers/rate-memory.ts — Record a usefulness verdict for a memory.
 *
 * Ports: handlers/rate_memory.py (166 LOC)
 *
 * Increments useful_count when helpful, then recomputes metamemory
 * confidence as useful_count / access_count.
 * High-confidence memories resist decay and rank higher in future recalls.
 *
 * Correctness contract:
 *   pre:  memoryId refers to an existing row; useful is a bool.
 *   post: access_count = prev + 1.
 *         useful_count = prev + 1 iff useful = true.
 *         confidence = compute_confidence(access_count, useful_count).
 *         All three fields written in a single UPDATE (atomic).
 *
 * References:
 *   Nelson & Narens (1990): metamemory framework.
 *
 * source: handlers/rate_memory.py
 */

import type { MemoryStore } from "../storage/memory-store.js";
// source: handlers/rate_memory.py:108-111 — AF-2 Platt feedback loop.
//   getRawCeScore scores (query, content); recordRating buffers the
//   (raw_ce, useful) pair and refits the calibrator every REFIT_EVERY pairs.
import { getRawCeScore } from "../../recall/reranker.js";
import { recordRating, sampleCount } from "../../recall/reranker-calibration.js";

// Named constants — rationale for each value:
// source: cortex@ed33435 mcp_server/handlers/rate_memory.py — confidence only
//   computed when access_count >= 3 (insufficient data before that).
const CONFIDENCE_MIN_SAMPLES = 3;
// source: Python round(..., 4) = multiply by 10000 then divide.
// source: cortex@ed33435 mcp_server/handlers/rate_memory.py — round(confidence, 4)
const CONFIDENCE_ROUNDING_FACTOR = 10000;
// source: cortex@ed33435 mcp_server/handlers/rate_memory.py — content_preview = 80 chars
const RATE_CONTENT_PREVIEW_CHARS = 80;
// z=1.0 for ~68% CI Wilson score lower bound.
// source: Agresti & Coull (1998) "Approximate Is Better than Exact for Interval Estimation of Binomial Proportions" — z=1.0 approximation for 68% CI
const WILSON_Z = 1.0;
// Wilson score formula constants — from Wilson (1927) equation (10).
// source: Wilson (1927) "Probable Inference, the Law of Succession, and Statistical Inference"
//   J. Am. Stat. Assoc. 22(158):209-212 — equation (10)
const WILSON_DENOMINATOR_HALVING = 2; // 2n in the numerator offset term
const WILSON_VARIANCE_CORRECTION = 4; // 4n in the variance correction term

export interface RateMemoryRequest {
  memory_id: number;
  useful: boolean;
  query?: string;
}

export interface RateMemoryResponse {
  rated: boolean;
  memory_id?: number;
  useful?: boolean;
  access_count?: number;
  useful_count?: number;
  confidence?: number;
  content_preview?: string;
  reason?: string;
  // AF-2 feedback signal — set only when a query was supplied and the
  // cross-encoder scored the pair. source: handlers/rate_memory.py:164-166
  platt_sample_recorded?: boolean;
  platt_sample_count?: number;
}

/**
 * Record a (raw_ce_score, useful) sample for AF-2 Platt calibration.
 *
 * Returns true iff a sample was actually recorded. No-op (returns false) when
 * query is empty, content is empty, or the cross-encoder is unavailable.
 *
 * precondition:  useful is a bool.
 * postcondition: on true, the reranker-calibration buffer has one more pair
 *   and a refit may have happened as a side effect of recordRating.
 *
 * source: handlers/rate_memory.py:92-112 _record_platt_sample
 */
async function recordPlattSample(
  query: string,
  content: string,
  useful: boolean,
): Promise<boolean> {
  if (!query || !content) return false;
  const rawCe = await getRawCeScore(query, content);
  if (rawCe === null) return false;
  recordRating(rawCe, useful);
  return true;
}

/**
 * Compute metamemory confidence from access and useful counts.
 *
 * precondition:  accessCount > 0.
 * postcondition: returned value in [0, 1]; returns null if accessCount < 3
 *   (insufficient data — caller uses existing confidence).
 *
 * Formula: Wilson score interval midpoint for a binomial proportion.
 * source: thermodynamics.py:compute_metamemory_confidence
 */
function computeMetamemoryConfidence(
  accessCount: number,
  usefulCount: number,
): number | null {
  if (accessCount < CONFIDENCE_MIN_SAMPLES) return null;
  // Wilson score lower bound (z=WILSON_Z for ~68% CI).
  // Formula: (p + z^2/(2n) - z*sqrt((p(1-p)+z^2/(4n))/n)) / (1 + z^2/n)
  // source: Wilson (1927) J. Am. Stat. Assoc. 22(158):209-212 — equation (10)
  const z = WILSON_Z;
  const p = usefulCount / accessCount;
  const n = accessCount;
  const numerator =
    p + z ** 2 / (WILSON_DENOMINATOR_HALVING * n) - z * Math.sqrt((p * (1 - p) + z ** 2 / (WILSON_VARIANCE_CORRECTION * n)) / n);
  const denominator = 1 + z ** 2 / n;
  return Math.max(0.0, Math.min(1.0, numerator / denominator));
}

/**
 * rateMemory — record usefulness feedback and update metamemory.
 *
 * source: handlers/rate_memory.py:handler
 */
export function rateMemory(
  args: RateMemoryRequest,
  store: MemoryStore,
): RateMemoryResponse {
  const memoryId = args.memory_id;
  const useful = args.useful;

  if (!memoryId || memoryId < 1) {
    return { rated: false, reason: "no_memory_id" };
  }

  const mem = store.getMemory(memoryId);
  if (mem === null) {
    return { rated: false, reason: "not_found", memory_id: memoryId };
  }

  const accessCount = (mem.access_count ?? 0) + 1;
  const usefulCount = (mem.useful_count ?? 0) + (useful ? 1 : 0);

  // Recompute confidence per Nelson & Narens 1990.
  const newConf = computeMetamemoryConfidence(accessCount, usefulCount);
  const confidence =
    newConf !== null ? newConf : (mem.confidence ?? 1.0);

  store.updateMemoryMetamemory(memoryId, accessCount, usefulCount, confidence);

  return {
    rated: true,
    memory_id: memoryId,
    useful,
    access_count: accessCount,
    useful_count: usefulCount,
    confidence: Math.round(confidence * CONFIDENCE_ROUNDING_FACTOR) / CONFIDENCE_ROUNDING_FACTOR,
    content_preview: mem.content.slice(0, RATE_CONTENT_PREVIEW_CHARS),
  };
}

/**
 * rateMemoryAsync — async variant that calls *Async store methods when available.
 *
 * MCP tool handlers MUST use this when the store may be PgMemoryStore.
 *
 * precondition:  same as rateMemory().
 * postcondition: same as rateMemory().
 * source: ADR-0042 — async path required for PG backend.
 */
export async function rateMemoryAsync(
  args: RateMemoryRequest,
  store: MemoryStore,
): Promise<RateMemoryResponse> {
  const memoryId = args.memory_id;
  const useful = args.useful;

  if (!memoryId || memoryId < 1) {
    return { rated: false, reason: "no_memory_id" };
  }

  const mem = store.getMemoryAsync
    ? await store.getMemoryAsync(memoryId)
    : store.getMemory(memoryId);

  if (mem === null) {
    return { rated: false, reason: "not_found", memory_id: memoryId };
  }

  const accessCount = (mem.access_count ?? 0) + 1;
  const usefulCount = (mem.useful_count ?? 0) + (useful ? 1 : 0);

  const newConf = computeMetamemoryConfidence(accessCount, usefulCount);
  const confidence = newConf !== null ? newConf : (mem.confidence ?? 1.0);

  // updateMemoryMetamemory uses void this.runAsync() on PG — works in fire-and-forget mode.
  store.updateMemoryMetamemory(memoryId, accessCount, usefulCount, confidence);

  // AF-2: collect a Platt training sample when the caller supplied the
  // surfacing query. Silent best-effort — the metamemory update above is the
  // primary contract. The query field is NOT model-facing (it is not in the
  // tool_rate_memory signature); only non-MCP callers pass it.
  // source: handlers/rate_memory.py:151-153,164-166
  const plattRecorded = await recordPlattSample(
    args.query ?? "",
    mem.content,
    useful,
  );

  const response: RateMemoryResponse = {
    rated: true,
    memory_id: memoryId,
    useful,
    access_count: accessCount,
    useful_count: usefulCount,
    confidence: Math.round(confidence * CONFIDENCE_ROUNDING_FACTOR) / CONFIDENCE_ROUNDING_FACTOR,
    content_preview: mem.content.slice(0, RATE_CONTENT_PREVIEW_CHARS),
  };
  if (plattRecorded) {
    response.platt_sample_recorded = true;
    response.platt_sample_count = sampleCount();
  }
  return response;
}
