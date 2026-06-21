/**
 * pg-store-queries.ts — Memory query operations for PgMemoryStore.
 * source: cortex main mcp_server/infrastructure/pg_store_queries.py
 */
import type { PoolClient } from "pg";

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:20-28
export async function getMemoriesForDomain(
  client: PoolClient, domain: string,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:21
  minHeat = 0.05, // eslint-disable-line @typescript-eslint/no-magic-numbers
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:21
  limit = 50, // eslint-disable-line @typescript-eslint/no-magic-numbers
): Promise<Record<string, unknown>[]> {
  return (await client.query(
    `SELECT * FROM memories WHERE (domain = $1 OR is_global = TRUE) AND heat_base >= $2 ORDER BY heat_base DESC LIMIT $3`,
    [domain, minHeat, limit])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:30-38
export async function getMemoriesForDirectory(
  client: PoolClient, directory: string,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:31
  minHeat = 0.05, // eslint-disable-line @typescript-eslint/no-magic-numbers
): Promise<Record<string, unknown>[]> {
  return (await client.query(
    `SELECT * FROM memories WHERE (directory_context = $1 OR is_global = TRUE) AND heat_base >= $2 ORDER BY heat_base DESC`,
    [directory, minHeat])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:40-61
export async function getHotMemories(
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:41
  client: PoolClient, minHeat = 0.7, limit = 20, includeBenchmarks = false, // eslint-disable-line @typescript-eslint/no-magic-numbers
): Promise<Record<string, unknown>[]> {
  const f = includeBenchmarks ? "" : "AND NOT coalesce(is_benchmark, FALSE) ";
  if (limit > 0) {
    return (await client.query(`SELECT * FROM memories WHERE heat_base >= $1 ${f}ORDER BY heat_base DESC LIMIT $2`, [minHeat, limit])).rows as Record<string, unknown>[];
  }
  return (await client.query(`SELECT * FROM memories WHERE heat_base >= $1 ${f}ORDER BY heat_base DESC`, [minHeat])).rows as Record<string, unknown>[];
}

/**
 * Stream hot memories hottest-first via KEYSET pagination.
 *
 * Each batch is an independent, index-backed range scan — NOT a server-side
 * cursor over ORDER BY heat_base DESC (which forces PG to sort the whole table
 * before yielding the first row). Keyset paging
 * WHERE (heat_base, id) < (last_heat, last_id) ORDER BY heat_base DESC, id DESC
 * walks the composite (heat_base DESC, id DESC) index forward one bounded page
 * at a time, so the first batch lands fast and memories warm up continuously.
 *
 * columns — explicit projection allowlist (NOT user input). The graph build
 * passes only the rendered fields, excluding the embedding vector,
 * content_tsv and original_content.
 *
 * hardLimit — optional hottest-N subset bound (undefined = full corpus). The
 * caller paginates to exhaustion when unset; per-page memory is one chunkSize
 * batch regardless of total.
 *
 * source: cortex main mcp_server/infrastructure/pg_store_queries.py:63-148
 */
export async function* iterHotMemoriesChunked(
  client: PoolClient,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:65
  minHeat = 0.0, // eslint-disable-line @typescript-eslint/no-magic-numbers
  includeBenchmarks = true,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:67
  chunkSize = 1000, // eslint-disable-line @typescript-eslint/no-magic-numbers
  columns = "*",
  hardLimit?: number | null,
): AsyncGenerator<Record<string, unknown>[]> {
  const benchFilter = includeBenchmarks ? "" : "AND NOT coalesce(is_benchmark, FALSE) ";
  // columns is an internal allowlist; chunkSize/page are cast to int and
  // interpolated; keyset values go through bound params ($n), never interpolated.
  let yielded = 0;
  let lastHeat: number | null = null;
  let lastId: number | null = null;
  const cap = hardLimit != null && hardLimit > 0 ? Math.trunc(hardLimit) : null;
  while (true) {
    let page = Math.trunc(chunkSize);
    if (cap !== null) {
      const remaining = cap - yielded;
      if (remaining <= 0) return;
      page = Math.min(page, remaining);
    }
    let where: string;
    let params: unknown[];
    if (lastHeat === null) {
      where = "heat_base >= $1 ";
      params = [minHeat];
    } else {
      // Keyset cursor: strictly-after (lastHeat, lastId) in the
      // (heat_base DESC, id DESC) order. Tuple compare is index-friendly.
      where = "heat_base >= $1 AND (heat_base, id) < ($2, $3) ";
      params = [minHeat, lastHeat, lastId];
    }
    const sql = `SELECT ${columns} FROM memories WHERE ${where}${benchFilter}ORDER BY heat_base DESC, id DESC LIMIT ${page}`;
    const rows = (await client.query(sql, params)).rows as Record<string, unknown>[];
    if (rows.length === 0) return;
    yield rows;
    yielded += rows.length;
    const tail = rows[rows.length - 1] as Record<string, unknown>;
    lastHeat = tail["heat_base"] as number;
    lastId = tail["id"] as number;
    if (rows.length < page) return;
  }
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:63-75
export async function getAllMemoriesWithEmbeddings(
  client: PoolClient, vectorToBytes: (v: unknown) => Buffer | null,
): Promise<Record<string, unknown>[]> {
  const result = await client.query("SELECT id, heat_base, embedding FROM memories WHERE embedding IS NOT NULL");
  return result.rows.map((row) => {
    const d = { ...(row as Record<string, unknown>) };
    if (d["embedding"] != null) d["embedding"] = vectorToBytes(d["embedding"]);
    return d;
  });
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:77-85
export async function getAllMemoriesForValidation(
  client: PoolClient,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:78
  limit = 1000, // eslint-disable-line @typescript-eslint/no-magic-numbers
): Promise<Record<string, unknown>[]> {
  return (await client.query("SELECT * FROM memories WHERE NOT is_stale ORDER BY last_accessed ASC LIMIT $1", [limit])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:87-95
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- source: cortex main mcp_server/infrastructure/pg_store_queries.py:88
export async function getMemoriesCreatedAfter(client: PoolClient, isoTimestamp: string, limit = 20): Promise<Record<string, unknown>[]> {
  return (await client.query("SELECT * FROM memories WHERE created_at >= $1 ORDER BY created_at ASC LIMIT $2", [isoTimestamp, limit])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:97-105
export async function getMemoriesInTimeWindow(client: PoolClient, centerTime: string, windowMinutes: number): Promise<Record<string, unknown>[]> {
  return (await client.query(
    `SELECT * FROM memories WHERE ABS(EXTRACT(EPOCH FROM (created_at - $1::timestamptz))) / 60 <= $2`,
    [centerTime, windowMinutes])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:107-109
export async function getAllMemoriesForDecay(client: PoolClient): Promise<Record<string, unknown>[]> {
  return (await client.query("SELECT * FROM memories WHERE NOT is_stale")).rows as Record<string, unknown>[];
}

/**
 * Most-recent-first memories carrying `tag`.
 *
 * Replaces full-table scans that filtered by tag in application code. Recency
 * correctness is guaranteed by the ORDER BY; limit only bounds the scan —
 * callers that skip dead entries get limit candidates of headroom.
 *
 * source: cortex main mcp_server/infrastructure/pg_store_queries.py:184-199
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- source: cortex main mcp_server/infrastructure/pg_store_queries.py:184
export async function getMemoriesByTag(client: PoolClient, tag: string, limit = 20): Promise<Record<string, unknown>[]> {
  return (await client.query(
    "SELECT * FROM memories WHERE tags @> $1::jsonb AND NOT is_stale ORDER BY created_at DESC LIMIT $2",
    [JSON.stringify([tag]), limit])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:111-152
export async function* iterMemoriesForDecay(
  client: PoolClient,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:113
  chunkSize = 1000, // eslint-disable-line @typescript-eslint/no-magic-numbers
): AsyncGenerator<Record<string, unknown>[]> {
  let offset = 0;
  while (true) {
    const result = await client.query("SELECT * FROM memories WHERE NOT is_stale ORDER BY id LIMIT $1 OFFSET $2", [chunkSize, offset]);
    const rows = result.rows as Record<string, unknown>[];
    if (rows.length === 0) break;
    yield rows;
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
}

// source: cortex main mcp_server/infrastructure/pg_store_queries.py:154-193
export async function searchByTagVector(
  client: PoolClient, queryEmbedding: Buffer | null, tag: string,
  domain: string | null = null,
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:156
  minHeat = 0.01, // eslint-disable-line @typescript-eslint/no-magic-numbers
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:157
  limit = 3, // eslint-disable-line @typescript-eslint/no-magic-numbers
  bufferToVecLiteral: (buf: Buffer) => string,
): Promise<Record<string, unknown>[]> {
  if (queryEmbedding != null) {
    const vecLiteral = bufferToVecLiteral(queryEmbedding);
    return (await client.query(
      `SELECT *, (1.0 - (embedding <=> $1::vector))::REAL AS score FROM memories
       WHERE tags @> $2::jsonb AND heat_base >= $3 AND NOT is_stale AND embedding IS NOT NULL
       AND (($4::TEXT IS NULL) OR domain = $4 OR is_global = TRUE)
       ORDER BY embedding <=> $1::vector LIMIT $5`,
      [vecLiteral, JSON.stringify([tag]), minHeat, domain, limit])).rows as Record<string, unknown>[];
  }
  return (await client.query(
    `SELECT *, heat_base::REAL AS score FROM memories
     WHERE tags @> $1::jsonb AND heat_base >= $2 AND NOT is_stale
     AND (($3::TEXT IS NULL) OR domain = $3 OR is_global = TRUE)
     ORDER BY heat_base DESC LIMIT $4`,
    [JSON.stringify([tag]), minHeat, domain, limit])).rows as Record<string, unknown>[];
}

/**
 * Delete memories with the given tag, optionally scoped to a domain.
 *
 * precondition: tag is a non-empty string; domain is undefined or non-empty.
 * postcondition: returns the number of rows removed; rows removed iff their
 *   tags JSONB contains [tag] AND (domain is undefined OR domain matches).
 *   domain=undefined preserves global-purge behavior for callers that
 *   actually want it (legacy contract). Caller is responsible for passing
 *   domain when scope matters (e.g. seed-project, which is per-repo by
 *   design — see issue #16).
 *
 * source: cortex main mcp_server/infrastructure/pg_store_queries.py:195-218 (issue #16)
 */
export async function deleteMemoriesByTag(
  client: PoolClient,
  tag: string,
  domain?: string,
): Promise<number> {
  if (domain === undefined) {
    return (await client.query("DELETE FROM memories WHERE tags @> $1::jsonb", [JSON.stringify([tag])])).rowCount ?? 0;
  }
  return (await client.query(
    "DELETE FROM memories WHERE tags @> $1::jsonb AND domain = $2",
    [JSON.stringify([tag]), domain],
  )).rowCount ?? 0;
}

// Source: docs/program/phase-5-pool-admission-design.md Phase 2 B1.
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:206-236
export async function findCoAccessedPairs(client: PoolClient, memoryIds: number[]): Promise<Array<[number, number]>> {
  if (memoryIds.length === 0) return [];
  const result = await client.query<{ a: number; b: number }>(
    `SELECT DISTINCT LEAST(me1.entity_id, me2.entity_id) AS a, GREATEST(me1.entity_id, me2.entity_id) AS b
     FROM memory_entities me1 JOIN memory_entities me2 ON me1.memory_id = me2.memory_id AND me1.entity_id < me2.entity_id
     WHERE me1.memory_id = ANY($1::int[])`, [memoryIds]);
  return result.rows.map((r) => [r.a, r.b] as [number, number]);
}

// Source: Phase 2 B2; Frey & Morris (1997) synaptic tagging.
// source: cortex main mcp_server/infrastructure/pg_store_queries.py:238-258
export async function findSharedEntities(client: PoolClient, memoryId: number, entityIds: number[]): Promise<number[]> {
  if (entityIds.length === 0) return [];
  return (await client.query<{ entity_id: number }>(
    "SELECT entity_id FROM memory_entities WHERE memory_id = $1 AND entity_id = ANY($2::int[])",
    [memoryId, entityIds])).rows.map((r) => r.entity_id);
}

// ── recall_memories: call the PostgreSQL stored procedure ────────────────────
//
// This is the parity-critical path: the Python bench calls the PL/pgSQL
// recall_memories() stored procedure directly via BenchmarkDB.recall() →
// PgMemoryStore.recall_memories(). The TS bench must call the same procedure
// to produce identical ranking.
//
// The stored procedure uses TMM score normalization (Bruch et al. ACM TOIS 2023)
// + weighted-sum fusion — NOT WRRF. This is fundamentally different from the
// SQLite client-side WRRF used as the SQLite fallback.
//
// source: cortex main mcp_server/infrastructure/pg_schema.py:RECALL_MEMORIES_LAZY_FN
// source: cortex main mcp_server/infrastructure/pg_store.py:recall_memories

export interface RecallMemoriesParams {
  queryText: string;
  queryEmbedding: Buffer | null;
  intent?: string;
  domain?: string | null;
  directory?: string | null;
  agentTopic?: string | null;
  minHeat?: number;
  maxResults?: number;
  wrrfK?: number;
  weights?: {
    vector?: number;
    fts?: number;
    heat?: number;
    ngram?: number;
    recency?: number;
  };
  includeGlobals?: boolean;
}

export interface RecallMemoryRow {
  memory_id: number;
  content: string;
  score: number;
  heat: number;
  domain: string;
  created_at: string;
  store_type: string;
  tags: unknown;
  importance: number;
  surprise_score: number;
  emotional_valence: number;
  source: string;
}

/**
 * Call the PostgreSQL recall_memories() stored procedure and return rows.
 *
 * precondition: client is a live PoolClient with the recall_memories function installed.
 * postcondition: returns rows ordered by descending score, length <= maxResults.
 *
 * The queryEmbedding Buffer must contain 384 float32 values (4 bytes each) for
 * the MiniLM-L6-v2 model. Pass null to skip vector signal.
 *
 * source: cortex main mcp_server/infrastructure/pg_schema.py:807-920
 *   (recall_memories stored procedure body)
 * source: cortex main mcp_server/infrastructure/pg_store.py:recall_memories
 *   (Python caller — passes query_embedding as bytes)
 */
export async function callRecallMemories(
  client: PoolClient,
  params: RecallMemoriesParams,
): Promise<RecallMemoryRow[]> {
  const {
    queryText,
    queryEmbedding,
    intent = "general",
    domain = null,
    directory = null,
    agentTopic = null,
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    minHeat = 0.01, // source: cortex main mcp_server/core/pg_recall.py:197
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    maxResults = 10,
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    wrrfK = 60,     // source: cortex main mcp_server/core/pg_recall.py:203
    weights = {},
    includeGlobals = true,
  } = params;

  const wVector = weights.vector ?? 1.0;
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  const wFts    = weights.fts    ?? 0.5;
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  const wHeat   = weights.heat   ?? 0.3;
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  const wNgram  = weights.ngram  ?? 0.3;
  const wRecency = weights.recency ?? 0.0;
  void wrrfK; // PG stored procedure has its own k parameter (unused here)

  // Convert Buffer to pgvector literal: '[f1, f2, ...]'
  // source: cortex main mcp_server/infrastructure/pg_store.py:recall_memories
  //   passes embedding bytes which psycopg adapts to pgvector
  let embeddingLiteral: string | null = null;
  // 384 = MiniLM-L6-v2 embedding dimension
  // source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 (hidden_size=384)
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  if (queryEmbedding !== null && queryEmbedding.byteLength === 384 * Float32Array.BYTES_PER_ELEMENT) { // source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 — dim=384
    const floats = new Float32Array(
      queryEmbedding.buffer,
      queryEmbedding.byteOffset,
      queryEmbedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    embeddingLiteral = `[${Array.from(floats).join(",")}]`;
  }

  // The stored procedure signature (from pg_schema.py):
  //   recall_memories(p_query_text, p_query_emb, p_intent, p_domain,
  //                   p_directory, p_agent_topic, p_min_heat, p_max_results,
  //                   p_wrrf_k, p_w_vector, p_w_fts, p_w_heat, p_w_ngram,
  //                   p_w_recency, p_include_globals)
  // source: cortex main mcp_server/infrastructure/pg_schema.py:RECALL_MEMORIES_LAZY_FN
  const result = await client.query<RecallMemoryRow>(
    `SELECT memory_id, content, score, heat, domain, created_at::text,
            store_type, tags, importance, surprise_score, emotional_valence, source
     FROM recall_memories(
       $1, $2::vector, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12, $13, $14, $15
     )`,
    [
      queryText,
      embeddingLiteral,
      intent,
      domain,
      directory,
      agentTopic,
      minHeat,
      maxResults,
      wrrfK,
      wVector,
      wFts,
      wHeat,
      wNgram,
      wRecency,
      includeGlobals,
    ],
  );

  return result.rows;
}
