/* eslint-disable @typescript-eslint/no-magic-numbers */
/**
 * SQLite-to-PgStore adapter for the LoCoMo benchmark harness.
 *
 * Single concern: adapts SqliteMemoryStore to the PgStore port required by
 * recall() from pg-recall.ts, replicating the SQLite search mixin signals
 * (vector, FTS, heat, recency, agent-boost) used by the Python LoCoMo baseline.
 *
 * Extracted from locomo-runner.ts (coding-standards §4.1, 500-line file limit)
 * along concern boundary: infrastructure adapter vs. benchmark evaluation logic.
 * source: coding-standards §4.1 — file-size limit 500 LOC.
 * source: Fowler (2018), Refactoring §6.1 Extract Function — concern boundary.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:39-230
 */

import type { PgStore, PgRecallMemoriesParams } from "@agentic/memory/recall/pg-recall.js";
import type { Candidate } from "@agentic/memory/recall/recall-pipeline-stages.js";
import type { SqliteMemoryStore } from "@agentic/memory/remember/storage/sqlite-store.js";
import { trigramSimilarity } from "@agentic/memory/remember/storage/trigram-similarity.js";

// Default WRRF weights (general intent).
// source: cortex main mcp_server/core/pg_recall_weights.py — general intent defaults
export const DEFAULT_WEIGHTS: Record<string, number> = {
  vector: 1.0,
  fts: 0.5,
  // source: cortex main PG recall_memories p_w_ngram default
  ngram: 0.3,
  heat: 0.3,
  recency: 0.0,
};

// ── SqliteMemoryStore raw-DB accessor ─────────────────────────────────────
// The adapter below needs the raw better-sqlite3 connection for the heat,
// recency, agent-boost, and fetch signals, which have no public API on
// SqliteMemoryStore.  We access _db via a type-cast — locally justified:
// this is a benchmark harness (not production code), and adding public
// accessors to SqliteMemoryStore would widen its surface area permanently
// for a benchmark-only concern.
// Correctness argument: _db is set in the constructor and never reassigned;
// the cast is safe as long as the field name matches (verified 2026-05-06
// against sqlite-store.ts:273).

// RawDb is the better-sqlite3 Database interface subset we actually use.
// We do not import better-sqlite3 types here (not a direct dependency of the
// benchmark package) — the cast is structurally validated by the SQL calls below.
interface RawDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

function getRawDb(store: SqliteMemoryStore): RawDb {
  return (store as unknown as { _db: RawDb })._db;
}

/**
 * Adapt a SqliteMemoryStore to the PgStore port required by recall().
 *
 * recallMemories() replicates the SqliteSearchMixin.recallMemories logic
 * (packages/memory/src/remember/storage/sqlite-store-search.ts:54-86):
 * four WRRF signals (vector, FTS, heat, recency) fused via RRF, plus
 * optional agent-topic boost, then a ranked fetch.
 *
 * precondition: memoryStore is open (not closed).
 * postcondition: returns Candidate[] sorted descending by fused score,
 *   length <= params.max_results; returns [] when the store has no rows
 *   matching the domain/heat filters.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:39-86
 */
export function makePgStore(memoryStore: SqliteMemoryStore): PgStore {
  const db: RawDb = getRawDb(memoryStore);

  /**
   * Build the WHERE clause for heat-filtered domain/directory queries.
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:152-166
   */
  function buildFilter(
    minHeat: number,
    domain: string | null | undefined,
    directory: string | null | undefined,
  ): { conds: string[]; params: unknown[] } {
    const conds = ["heat_base >= ?", "NOT is_stale"];
    const params: unknown[] = [minHeat];
    if (domain) {
      conds.push("(domain = ? OR is_global = 1)");
      params.push(domain);
    }
    if (directory) {
      conds.push("(directory_context = ? OR is_global = 1)");
      params.push(directory);
    }
    return { conds, params };
  }

  /**
   * Vector signal: top-pool RRF contribution from KNN search.
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:63-85
   */
  function signalVector(
    scores: Map<number, number>,
    queryEmbedding: number[] | null,
    weight: number,
    k: number,
    pool: number,
  ): void {
    if (!memoryStore.hasVec || queryEmbedding === null || weight <= 0) return;
    const f32 = new Float32Array(queryEmbedding);
    const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    const hits = memoryStore.searchVectors(buf, pool);
    hits.forEach(([memory_id], rank) => {
      scores.set(memory_id, (scores.get(memory_id) ?? 0) + weight / (k + rank + 1));
    });
  }

  /**
   * FTS signal: top-pool RRF contribution from FTS5 search.
   *
   * PARITY FIX (2026-05-06): pass raw query_text directly to FTS5 without
   * sanitization, matching Python's _signal_fts behavior exactly.
   *
   * Python source: cortex main mcp_server/infrastructure/sqlite_store_search.py:87-106
   *   self._conn.execute("SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
   *                        ORDER BY rank LIMIT ?", (query_text, pool)).fetchall()
   *   wrapped in try/except Exception: pass
   *
   * Python's LoCoMo questions all contain '?' or "'" which are FTS5 syntax
   * errors. Python silently catches these (try/except Exception: pass), so
   * the FTS signal is always 0 for LoCoMo questions. Passing raw text here
   * produces the same behavior: the SQL will raise, the catch returns 0
   * contribution. DO NOT call memoryStore.searchFts() — that sanitizes the
   * query into "word" OR "word" OR ... (disjunction), which is correct for
   * production but diverges from Python's bench behavior on LoCoMo data.
   *
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:87-106
   */
  function signalFts(
    scores: Map<number, number>,
    queryText: string,
    weight: number,
    k: number,
    pool: number,
  ): void {
    if (!queryText || weight <= 0) return;
    // Pass raw queryText to FTS5 — mirrors Python's _signal_fts which does NOT sanitize.
    // Queries with FTS5-special chars (?, ', ,) will throw; catch returns 0 contribution.
    try {
      const rows = db
        .prepare(
          "SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(queryText, pool) as Array<{ rowid: number; rank: number }>;
      rows.forEach((r, rank) => {
        scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + weight / (k + rank + 1));
      });
    } catch {
      // FTS5 syntax error (?, ', , in query text) — silently return 0 contribution.
      // Matches Python's try/except Exception: pass in _signal_fts.
    }
  }

  /**
   * Trigram (ngram) lexical signal: pg_trgm-faithful Jaccard similarity of the
   * query text against each candidate's content over the same candidate pool.
   * For LoCoMo (where FTS is always 0 because questions contain FTS5-special
   * chars) this is the only lexical match. Candidates above the similarity
   * floor are ranked descending and contribute an RRF term, like FTS.
   *
   * source: PostgreSQL pg_trgm (show_trgm + similarity).
   */
  function signalNgram(
    scores: Map<number, number>,
    queryText: string,
    weight: number,
    k: number,
    pool: number,
    minHeat: number,
    domain: string | null | undefined,
    directory: string | null | undefined,
  ): void {
    if (!queryText || weight <= 0) return;
    // source: cortex main PG recall_memories ngram similarity floor
    const minSimilarity = 0.1;
    // Match PG's ngram CTE: scan ALL heat/domain-filtered candidates (pg_trgm's
    // GIN index has no SQLite equivalent), score every one by trigram similarity,
    // keep sim > floor, then take the top `pool` BY SIMILARITY — not by heat.
    // Ranking the heat-top pool by trigram (the prior bug) trigram-scored only
    // the hottest rows, missing low-heat lexically-relevant gold and injecting
    // noise. source: cortex main PG recall_memories ngram CTE (ORDER BY similarity DESC).
    const { conds, params } = buildFilter(minHeat, domain, directory);
    const rows = db
      .prepare(`SELECT id, content FROM memories WHERE ${conds.join(" AND ")}`)
      .all(...params) as Array<{ id: number; content: string }>;
    const scored = rows
      .map((r) => ({ id: r.id, sim: trigramSimilarity(r.content ?? "", queryText) }))
      .filter((r) => r.sim > minSimilarity)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, pool);
    scored.forEach((r, rank) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + weight / (k + rank + 1));
    });
  }

  /**
   * Heat signal: hot memories by heat_base DESC.
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:108-128
   */
  function signalHeat(
    scores: Map<number, number>,
    weight: number,
    k: number,
    pool: number,
    minHeat: number,
    domain: string | null | undefined,
    directory: string | null | undefined,
  ): void {
    if (weight <= 0) return;
    const { conds, params } = buildFilter(minHeat, domain, directory);
    params.push(pool);
    const rows = db
      .prepare(
        `SELECT id FROM memories WHERE ${conds.join(" AND ")} ORDER BY heat_base DESC LIMIT ?`,
      )
      .all(...params) as Array<{ id: number }>;
    rows.forEach((r, rank) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + weight / (k + rank + 1));
    });
  }

  /**
   * Recency signal: memories by created_at DESC.
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:130-151
   */
  function signalRecency(
    scores: Map<number, number>,
    weight: number,
    k: number,
    pool: number,
    minHeat: number,
    domain: string | null | undefined,
    directory: string | null | undefined,
  ): void {
    if (weight <= 0) return;
    const { conds, params } = buildFilter(minHeat, domain, directory);
    params.push(pool);
    const rows = db
      .prepare(
        `SELECT id FROM memories WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as Array<{ id: number }>;
    rows.forEach((r, rank) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + weight / (k + rank + 1));
    });
  }

  /**
   * Agent-topic boost: small additive bonus for memories tagged to agentTopic.
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:152-166
   */
  function applyAgentBoost(
    scores: Map<number, number>,
    agentTopic: string | null | undefined,
    wVector: number,
    wrfK: number,
  ): void {
    if (!agentTopic || scores.size === 0) return;
    const boost = 0.3 * (wVector / wrfK); // source: cortex main mcp_server/infrastructure/sqlite_store_search.py:173
    const ids = [...scores.keys()];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id FROM memories WHERE id IN (${placeholders}) AND agent_context = ?`,
      )
      .all(...ids, agentTopic) as Array<{ id: number }>;
    for (const r of rows) {
      scores.set(r.id, (scores.get(r.id) ?? 0) + boost);
    }
  }

  /**
   * Fetch ranked results from the memories table for the top scoring ids.
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:188-230
   */
  function fetchRankedResults(
    scores: Map<number, number>,
    maxResults: number,
    minHeat: number,
    domain: string | null | undefined,
    directory: string | null | undefined,
  ): Candidate[] {
    const topIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults * 3)
      .map(([id]) => id);

    if (topIds.length === 0) return [];
    const placeholders = topIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...topIds) as Array<Record<string, unknown>>;

    const rowMap = new Map(rows.map((r) => [r["id"] as number, r]));
    const results: Candidate[] = [];

    for (const mid of topIds) {
      const row = rowMap.get(mid);
      if (row == null) continue;
      const heat = (row["heat_base"] as number) ?? (row["heat"] as number) ?? 0;
      if (heat < minHeat || row["is_stale"]) continue;
      const isGlobal = Boolean(row["is_global"]);
      if (domain && row["domain"] !== domain && !isGlobal) continue;
      if (directory && row["directory_context"] !== directory && !isGlobal) continue;
      results.push({
        memory_id: mid,
        content: row["content"] as string,
        score: scores.get(mid) ?? 0,
        heat,
        domain: (row["domain"] as string) ?? "",
        created_at: row["created_at"] as string,
        tags: row["tags"] as string,
        emotional_valence: (row["emotional_valence"] as number) ?? 0,
      });
    }
    return results;
  }

  return {
    /**
     * Client-side WRRF fusion equivalent of the PL/pgSQL recall_memories procedure.
     *
     * precondition: store is open; params.max_results >= 1; params.wrrf_k >= 1.
     * postcondition: returned array is sorted descending by fused WRRF score;
     *   length <= params.max_results; only rows satisfying min_heat and domain
     *   filters are returned.
     *
     * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:39-86
     */
    recallMemories(params: PgRecallMemoriesParams): Candidate[] {
      const {
        query_text,
        query_embedding,
        domain,
        directory,
        agent_topic,
        min_heat,
        max_results,
        wrrf_k,
        weights,
      } = params;

      const wVector = weights["vector"] ?? DEFAULT_WEIGHTS["vector"] ?? 1.0;
      const wFts = weights["fts"] ?? DEFAULT_WEIGHTS["fts"] ?? 0.5;
      const wNgram = weights["ngram"] ?? DEFAULT_WEIGHTS["ngram"] ?? 0.3;
      const wHeat = weights["heat"] ?? DEFAULT_WEIGHTS["heat"] ?? 0.3;
      const wRecency = weights["recency"] ?? DEFAULT_WEIGHTS["recency"] ?? 0.0;
      const pool = max_results * 10; // source: cortex main mcp_server/infrastructure/sqlite_store_search.py:75
      const scores: Map<number, number> = new Map();

      signalVector(scores, query_embedding, wVector, wrrf_k, pool);
      signalFts(scores, query_text, wFts, wrrf_k, pool);
      signalNgram(scores, query_text, wNgram, wrrf_k, pool, min_heat, domain, directory);
      signalHeat(scores, wHeat, wrrf_k, pool, min_heat, domain, directory);
      signalRecency(scores, wRecency, wrrf_k, pool, min_heat, domain, directory);
      applyAgentBoost(scores, agent_topic, wVector, wrrf_k);

      if (scores.size === 0) return [];
      return fetchRankedResults(scores, max_results, min_heat, domain, directory);
    },

    // CandidateStore methods forwarded to SqliteMemoryStore equivalents.

    getMemory: async (id: number) =>
      memoryStore.getMemory(id) as Record<string, unknown> | null,

    // ReconsolidationStore methods — forward writes back to the store.
    bumpHeatRaw: (memoryId: number, newHeatBase: number) => {
      memoryStore.bumpHeatRaw(memoryId, newHeatBase);
    },
    updateMemoryAccess: (memoryId: number) => {
      memoryStore.updateMemoryAccess(memoryId);
    },
  };
}
