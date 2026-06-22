/**
 * PG handler path — handler-level enrichments after pg-recall.recall().
 *
 * Extracted from recall-handler.ts (coding-standards §4.1: 500-line max).
 *
 * Applies the production enrichment layer that cortex main runs after
 * pg_recall() returns:
 *   filter_low_signal → tag filter → cap → inject_triggered_memories →
 *   _apply_co_activation → _apply_rules_and_order → _track_recall_replay →
 *   strategic ordering → inline_related_neighbors → bound_payload
 *
 * Port of: cortex main mcp_server/handlers/recall.py:415-484
 */

import { applyCoActivation } from "./co-activation.js";
import { applyStrategicOrdering } from "./multi-signal-fusion.js";
import {
  filterByTags,
  filterLowSignal,
  inlineRelatedNeighbors,
} from "./recall-helpers.js";
import { boundPayload, listTarget } from "./response-budget.js";
import type { EmbeddingEngine, MemoryStore } from "./port.js";
import { classifyQueryIntent } from "./query-intent.js";
import { recall as pgRecallFn, type PgStore } from "./pg-recall.js";
import { applyRules } from "./rules.js";
import type { RecallRequest, RecallResponse, RecallResult } from "./types.js";
import { QueryIntent } from "./types.js";
import type { RecallSettings } from "./recall-handler.js";

// ── Constants (imported from recall-handler scope via POOL_MULTIPLIER) ────
// source: cortex main mcp_server/handlers/recall.py:414
const POOL_MULTIPLIER = 3; // source: cortex main mcp_server/handlers/recall.py (pool multiplier = 3)
const POOL_FLOOR = 30;     // source: cortex main mcp_server/handlers/recall.py (pool floor = 30)
const DEFAULT_IMPORTANCE = 0.5; // source: cortex main mcp_server/handlers/recall.py (default importance = 0.5)
const ABLATE_CO_ACTIVATION = process.env["CORTEX_ABLATE_CO_ACTIVATION"] === "1";

// ── PG path enrichments ───────────────────────────────────────────────────

/**
 * Production recall path when the store implements PgStore.recallMemories.
 *
 * Calls pg-recall.recall() (faithful WRRF + pipeline stages) then applies
 * the handler-level enrichments in cortex main recall.py order.
 *
 * precondition: store has recallMemories; query is non-empty
 * postcondition: returns RecallResponse with memories bounded to max_results
 *
 * Port of: cortex main mcp_server/handlers/recall.py:415-484
 */
export async function pgHandlerPath(
  args: RecallRequest,
  store: PgStore,
  embeddings: EmbeddingEngine | null,
  settings: RecallSettings,
  trackReplay: (results: Array<{ memory_id: number }>, store: MemoryStore) => Promise<void>,
  injectTriggered: (
    results: RecallResult[],
    query: string,
    store: MemoryStore,
    maxInject: number | null,
  ) => Promise<RecallResult[]>,
  empty: RecallResponse,
  query: string,
  max_results: number,
  min_heat: number,
  include_low_signal: boolean,
  include_related: boolean,
  tagsAny: string[],
  tagsAll: string[],
): Promise<RecallResponse> {
  // Over-fetch 3× so after low-signal drops we still surface max_results.
  // source: cortex main mcp_server/handlers/recall.py:414
  const fetchK = include_low_signal ? max_results : max_results * POOL_MULTIPLIER;

  const intentInfo = classifyQueryIntent(query);
  const intent = intentInfo.intent;

  let candidates = await pgRecallFn(query, store, embeddings, {
    topK: Math.max(fetchK, POOL_FLOOR),
    domain: args.domain ?? null,
    directory: args.directory ?? null,
    agentTopic: args.agent_topic ?? null,
    minHeat: min_heat,
    rerank: true,
    wrrfK: settings.WRRF_K,
  });

  if (candidates.length === 0) return { ...empty, intent };

  // Map Candidates to handler result shape.
  // source: cortex main mcp_server/handlers/recall_helpers.py:build_result
  let results: RecallResult[] = candidates.map((c) => ({
    memory_id: c.memory_id,
    content: c.content ?? "",
    score: c.score ?? 0.0,
    heat: (c.heat as number | undefined) ?? 0.0,
    domain: (c.domain as string | undefined) ?? "",
    tags: Array.isArray(c.tags)
      ? (c.tags as string[])
      : (typeof c.tags === "string" ? [c.tags as string] : []),
    store_type: (c["store_type"] as string | undefined) ?? "episodic",
    created_at: (c.created_at as string | undefined) ?? "",
    importance: (c["importance"] as number | undefined) ?? DEFAULT_IMPORTANCE,
    surprise: (c["surprise"] as number | undefined) ?? 0,
    recency_boost: 0.0,
  }));

  // Low-signal filter — source: cortex main recall.py:432-434
  let lowSignalDropped = 0;
  if (!include_low_signal) {
    const filtered = filterLowSignal(results);
    results = filtered.kept as typeof results;
    lowSignalDropped = filtered.dropped;
  }

  // Positive tag filter — source: cortex main recall.py:439-440
  if (tagsAny.length > 0 || tagsAll.length > 0) {
    results = filterByTags(results, tagsAny, tagsAll) as typeof results;
  }

  // Cap to max_results — source: cortex main recall.py:443
  results = results.slice(0, max_results);

  // inject_triggered_memories — source: cortex main recall.py:446
  const withTriggers = await injectTriggered(
    results,
    query,
    store as unknown as MemoryStore,
    max_results,
  );

  // _apply_co_activation — source: cortex main recall.py:447
  if (!ABLATE_CO_ACTIVATION) {
    await applyCoActivation(withTriggers, store as unknown as MemoryStore, settings);
  }

  // _apply_rules_and_order — source: cortex main recall.py:448
  let rules: unknown[] = [];
  try {
    rules = await (store as unknown as MemoryStore).getAllActiveRules();
  } catch { /* rules unavailable */ }
  const afterRules =
    rules.length > 0
      ? (applyRules(
          withTriggers as Array<Record<string, unknown>>,
          rules as Parameters<typeof applyRules>[1],
          "score",
        ) as RecallResult[])
      : withTriggers;

  // _track_recall_replay — source: cortex main recall.py:453
  await trackReplay(afterRules, store as unknown as MemoryStore);

  // inline_related_neighbors — source: cortex main recall.py:459-460
  if (include_related) {
    await inlineRelatedNeighbors(afterRules, store as unknown as MemoryStore);
  }

  // Strategic ordering — source: Liu et al. (2023) "Lost in the Middle"
  const ordered = settings.STRATEGIC_ORDERING_ENABLED
    ? applyStrategicOrdering(
        afterRules,
        settings.STRATEGIC_TOP_FRACTION,
        settings.STRATEGIC_BOTTOM_FRACTION,
      )
    : afterRules;

  const response: RecallResponse = {
    memories: ordered,
    count: ordered.length,
    intent,
    dispatch_tier: "pg",
    signals: {},
    enhancements: {
      query_expanded: false,
      multihop_applied: false,
      reranked: true,
      knowledge_update_boost: intent === QueryIntent.KNOWLEDGE_UPDATE,
      strategic_ordering: settings.STRATEGIC_ORDERING_ENABLED,
    },
    low_signal_dropped: lowSignalDropped,
  };

  boundPayload(response, [listTarget("memories", "content", "score")]);
  response.count = response.memories.length;
  return response;
}
