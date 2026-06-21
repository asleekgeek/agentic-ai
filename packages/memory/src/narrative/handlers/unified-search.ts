/**
 * Handler: unified_search — RRF-fuse Cortex memory recall with AP code search.
 *
 * Port of: cortex@ed33435 mcp_server/handlers/unified_search.py
 *
 * Composition root: cortex.recall (WRRF semantic memory via recallHandler) +
 * AP code-symbol search (CodebasePort) → core.unified_search_fusion.fuse →
 * single ranked list. Mirrors unified_search.py:85-136 exactly.
 *
 * When AP is off, returns Cortex-only results marked ``status: partial,
 * sources: [cortex]`` — never fails (unified_search.py:112).
 *
 * Fusion contract: each input list presents unique string ids.
 *   - Memories use ``memory:<memory_id>`` (added by _prepMemories — mirrors
 *     unified_search.py:_prep_memories lines 70-82).
 *   - AP symbols use ``symbol:<file>::<name>`` (added here).
 *
 * RRF formula: score(d) = Σ_r 1 / (k + rank_r(d))
 * source: Cormack, Clarke, Buettcher (2009) SIGIR — K=60 canonical value.
 * source: cortex@ed33435 mcp_server/handlers/unified_search.py — canonical contract
 */

import { z } from "zod";
import { fuse, DEFAULT_K } from "../../recall/unified-search-fusion.js";
import {
  recallHandler,
  DEFAULT_RECALL_SETTINGS,
} from "../../recall/recall-handler.js";
import { boundPayload, listTarget } from "../../recall/response-budget.js";
import type { EmbeddingEngine, MemoryStore } from "../../recall/port.js";
import type { RecallResult } from "../../recall/types.js";
import type { CodebasePort, SearchCodebaseInput } from "@agentic/core";

// source: cortex@ed33435 unified_search.py:103 — ap limit = max(top_n*2, top_n)
const AP_LIMIT_MULTIPLIER = 2;
// source: MCP_TOOLS.md §unified_search max_results upper bound
const MAX_RESULTS_CAP = 50; // source: MCP_TOOLS.md §unified_search max=50
// source: MCP_TOOLS.md §unified_search max_results lower bound
const MIN_RESULTS = 1; // source: MCP_TOOLS.md §unified_search min=1
const DEFAULT_MAX_RESULTS = 10; // source: MCP_TOOLS.md §unified_search default max_results=10
// source: cortex@ed33435 unified_search.py:95 — recall asks for 2× top_n
const RECALL_OVERFETCH_MULTIPLIER = 2;
// source: cortex@ed33435 unified_search.py — recall min_heat floor for unified leg
const UNIFIED_RECALL_MIN_HEAT = 0.0;

export const UnifiedSearchRequestSchema = z.object({
  query:       z.string().min(1),
  domain:      z.string().optional(),
  max_results: z.number().int().min(MIN_RESULTS).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
  // source: Cormack, Clarke, Buettcher (2009) SIGIR — K=60 canonical
  k:           z.number().int().min(1).default(DEFAULT_K),
  // source: cortex@ed33435 unified_search.py — optional graph_path for AP leg
  graph_path:  z.string().optional(),
});
export type UnifiedSearchRequest = z.infer<typeof UnifiedSearchRequestSchema>;

/**
 * UnifiedSearchResponse matches cortex@ed33435 unified_search.py response
 * contract (lines 111-122): status / query / sources / counts / results / k.
 * Fused records carry the fusion body plus ``rrf_score`` and ``source_ranks``.
 * source: cortex@ed33435 mcp_server/handlers/unified_search.py:111-122
 */
export interface UnifiedSearchResponse {
  status: "ok" | "partial";
  query: string;
  sources: string[];
  counts: { cortex: number; ap: number; fused: number };
  results: Record<string, unknown>[];
  k: number;
}

export interface UnifiedSearchDeps {
  /** Recall WRRF store — backs the cortex leg (recallHandler). */
  recallStore: MemoryStore;
  /** Embedding engine for the vector signal; null degrades gracefully. */
  embedder: EmbeddingEngine | null;
  /**
   * Optional AP code search port. When absent, AP leg is skipped and status
   * is "partial" (mirrors unified_search.py is_enabled() False branch).
   * source: cortex@ed33435 unified_search.py — ap_client is None guard
   */
  codebasePort?: CodebasePort;
}

/**
 * Tag recall results with a fusion-friendly ``id`` and ``source``, preserving
 * the retriever's own ordering (the one RRF consumes).
 * source: cortex@ed33435 unified_search.py:70-82 _prep_memories
 */
function prepMemories(
  results: ReadonlyArray<RecallResult>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of results) {
    const mid = r.memory_id;
    if (mid === null || mid === undefined) continue;
    out.push({ ...r, id: `memory:${mid}`, source: "cortex" });
  }
  return out;
}

/**
 * Map AP symbols to fusion-friendly records ordered by the AP ranking,
 * tagging each with ``symbol:<file>::<name>`` ids.
 * source: cortex@ed33435 unified_search.py:13-15 — AP id convention
 */
function prepApHits(symbols: Record<string, unknown>[]): Record<string, unknown>[] {
  return symbols.map((sym) => {
    const name = typeof sym["name"] === "string" ? sym["name"] : "";
    const filePath = typeof sym["filePath"] === "string" ? sym["filePath"] : "";
    const kind = typeof sym["kind"] === "string" ? sym["kind"] : "";
    return {
      ...sym,
      id: `symbol:${filePath}::${name}`,
      source: "ap",
      snippet: `${filePath}::${name} [${kind}]`,
    };
  });
}

/**
 * Run the AP code-search leg. Returns [] on absence or failure (graceful
 * degradation — unified_search.py wraps the AP call defensively).
 * source: cortex@ed33435 unified_search.py:101-104
 */
async function searchApLeg(
  deps: UnifiedSearchDeps,
  query: string,
  graphPath: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  if (deps.codebasePort === undefined || graphPath === undefined || graphPath.length === 0) {
    return [];
  }
  try {
    const apInput: SearchCodebaseInput = { graphPath, query, limit };
    const apResult = await deps.codebasePort.searchCodebase(apInput);
    return apResult.results as Record<string, unknown>[];
  } catch {
    // AP leg failure non-fatal — graceful degradation.
    // source: cortex@ed33435 unified_search.py — AP call guarded
    return [];
  }
}

/**
 * RRF-fuse the WRRF cortex recall leg with the AP code-symbol leg.
 *
 * Precondition:  deps.recallStore is valid; rawArgs passes the schema.
 * Postcondition:
 *   status = "ok" when AP leg active, "partial" otherwise.
 *   results = fused list (≤ max_results), each carrying rrf_score + source_ranks.
 *   counts.cortex = recall hits; counts.ap = AP hits; counts.fused = result count.
 *
 * source: cortex@ed33435 mcp_server/handlers/unified_search.py:85-136
 */
export async function unifiedSearchHandler(
  deps: UnifiedSearchDeps,
  rawArgs: unknown,
): Promise<UnifiedSearchResponse> {
  const args: UnifiedSearchRequest = UnifiedSearchRequestSchema.parse(rawArgs ?? {});
  const { query, domain, max_results: topN, k, graph_path } = args;

  // Cortex leg: ask recall for 2× top_n so the fusion has room.
  // source: cortex@ed33435 unified_search.py:93-96
  const recallResp = await recallHandler(
    {
      query,
      domain,
      max_results: Math.max(topN * RECALL_OVERFETCH_MULTIPLIER, topN),
      min_heat: UNIFIED_RECALL_MIN_HEAT,
      // Cortex passes through recall defaults (include_low_signal=False,
      // include_related=False). source: unified_search.py:94 recall_args
      include_low_signal: false,
      include_related: false,
    },
    deps.recallStore,
    deps.embedder,
    DEFAULT_RECALL_SETTINGS,
  );
  // Phase-0 rename: recall now exposes `memories` (was `results`).
  // source: cortex@bc5af469 mcp_server/handlers/recall.py:468 + unified_search.py:97
  const memories = prepMemories(recallResp.memories);

  // AP leg (optional). is_enabled() ≙ codebasePort present + graph_path given.
  // source: cortex@ed33435 unified_search.py:99-104
  const apEnabled = deps.codebasePort !== undefined && graph_path !== undefined && graph_path.length > 0;
  const apHits = prepApHits(
    await searchApLeg(deps, query, graph_path, Math.max(topN * AP_LIMIT_MULTIPLIER, topN)),
  );
  const sources = apEnabled ? ["cortex", "ap"] : ["cortex"];

  // Fuse (RRF, idKey="id", clip to top_n). source: unified_search.py:106-110
  const fused = fuse([["cortex", memories], ["ap", apHits]], k, "id", topN);

  const response: UnifiedSearchResponse = {
    status: apEnabled ? "ok" : "partial",
    query,
    sources,
    counts: { cortex: memories.length, ap: apHits.length, fused: fused.length },
    results: fused,
    k,
  };

  // Bounded I/O: two ListTargets on `results` — memory hits carry their text in
  // `content` (truncated items keep the memory:<id> fusion id for full recall),
  // AP symbol hits carry it in `snippet`; both weighted by score. counts.fused
  // is recomputed after the budget may have dropped tail items.
  // source: cortex@bc5af469 mcp_server/handlers/unified_search.py:127-135
  boundPayload(response, [
    listTarget("results", "content", "score"),
    listTarget("results", "snippet", "score"),
  ]);
  response.counts.fused = response.results.length;
  return response;
}
