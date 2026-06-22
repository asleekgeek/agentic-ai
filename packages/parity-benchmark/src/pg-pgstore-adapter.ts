 
/**
 * PgMemoryStore-to-PgStore adapter for the LoCoMo benchmark harness.
 *
 * Single concern: adapt the real PgMemoryStore (which calls the PostgreSQL
 * recall_memories() PL/pgSQL function with PG-native signals — pgvector
 * cosine, pg_trgm GIN trigram, ts_rank_cd FTS) to the PgStore port required
 * by recall() from pg-recall.ts.
 *
 * This is the apples-to-apples path vs. the PG-captured Python baseline:
 * the SQLite adapter (sqlite-pgstore-adapter.ts) only approximates the PG
 * signal VALUES client-side, so it plateaus below the PG ranking. This
 * adapter routes through the same stored procedure the Python bench calls.
 *
 * source: cortex main mcp_server/infrastructure/pg_store.py:recall_memories
 * source: cortex main mcp_server/infrastructure/pg_schema.py:RECALL_MEMORIES_LAZY_FN
 */

import type { PgStore, PgRecallMemoriesParams } from "@agentic/memory/recall/pg-recall.js";
import type { Candidate } from "@agentic/memory/recall/recall-pipeline-stages.js";
import type { PgMemoryStore } from "@agentic/memory/remember/storage/pg-store.js";

// pg-store-queries.js is not a public package export; derive its param/row
// types from the PgMemoryStore.recallMemoriesAsync signature instead.
type RecallMemoriesParams = Parameters<PgMemoryStore["recallMemoriesAsync"]>[0];
type RecallMemoryRow = Awaited<
  ReturnType<PgMemoryStore["recallMemoriesAsync"]>
>[number];

/**
 * Convert a query embedding (number[] from the recall pipeline) to the
 * float32 Buffer the PgMemoryStore.recallMemoriesAsync params expect.
 * Returns null when there is no embedding (vector signal skipped).
 *
 * source: cortex main mcp_server/infrastructure/pg_store.py:recall_memories
 *   (query_embedding passed as float32 bytes to the pgvector cast)
 */
function embeddingToBuffer(embedding: number[] | null): Buffer | null {
  if (embedding === null || embedding.length === 0) return null;
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Normalize PG JSONB tags to the Candidate tag shape (string[] | string).
 * PG returns JSONB as a parsed JS value; recall stages accept either form.
 */
function normalizeTags(tags: unknown): string[] | string {
  if (Array.isArray(tags)) return tags as string[];
  if (typeof tags === "string") return tags;
  return [];
}

/**
 * Map one recall_memories() row to a recall-pipeline Candidate.
 * source: pg-store-queries.ts RecallMemoryRow → recall-pipeline-stages.ts Candidate
 */
function rowToCandidate(row: RecallMemoryRow): Candidate {
  return {
    memory_id: row.memory_id,
    content: row.content,
    score: row.score,
    heat: row.heat,
    domain: row.domain,
    created_at: row.created_at,
    tags: normalizeTags(row.tags),
    emotional_valence: row.emotional_valence ?? 0,
    source: row.source ?? "",
  };
}

/**
 * Adapt a PgMemoryStore to the PgStore port required by recall().
 *
 * recallMemories() forwards to PgMemoryStore.recallMemoriesAsync(), which
 * invokes the recall_memories() stored procedure server-side (TMM
 * normalization + weighted-sum fusion over pgvector / pg_trgm / ts_rank_cd
 * signals) — identical to the Python bench path.
 *
 * precondition: store schema applied; vector + pg_trgm extensions installed.
 * postcondition: returns Candidate[] ordered by descending procedure score,
 *   length <= params.max_results; returns [] when no rows match.
 *
 * source: cortex main mcp_server/infrastructure/pg_store.py:recall_memories
 */
export function makePgPgStore(store: PgMemoryStore): PgStore {
  return {
    async recallMemories(params: PgRecallMemoriesParams): Promise<Candidate[]> {
      // Map the recall-pipeline params (snake_case, number[] embedding) to the
      // store-level params (camelCase, Buffer embedding). The stored procedure
      // owns the WRRF/TMM fusion, so wrrf_k + weights flow straight through.
      const storeParams: RecallMemoriesParams = {
        queryText: params.query_text,
        queryEmbedding: embeddingToBuffer(params.query_embedding),
        intent: params.intent,
        domain: params.domain,
        directory: params.directory,
        agentTopic: params.agent_topic,
        minHeat: params.min_heat,
        maxResults: params.max_results,
        wrrfK: params.wrrf_k,
        weights: {
          vector: params.weights["vector"],
          fts: params.weights["fts"],
          heat: params.weights["heat"],
          ngram: params.weights["ngram"],
          recency: params.weights["recency"],
        },
        includeGlobals: params.include_globals,
      };
      const rows = await store.recallMemoriesAsync(storeParams);
      return rows.map(rowToCandidate);
    },

    // recall() uses getMemory for the Titans embedding fetch (momentumState
    // path) and for version-walk neighbors. Forward to the async accessor.
    getMemory: async (id: number) =>
      (await store.getMemoryAsync(id)) as Record<string, unknown> | null,

    // ReconsolidationStore writes — forward to the PG async heat/access writers
    // so the final-ranking reconsolidation mutation lands in the same DB.
    bumpHeatRaw: (memoryId: number, newHeatBase: number) => {
      void store.bumpHeatRawAsync(memoryId, newHeatBase);
    },
    updateMemoryAccess: (memoryId: number) => {
      store.updateMemoryAccess(memoryId);
    },
  };
}
