/**
 * pg-locomo-runner.ts — REAL-PostgreSQL LoCoMo benchmark runner.
 *
 * Runs the LoCoMo dataset through the TS Cortex recall pipeline (recall()
 * from pg-recall.ts) backed by the REAL PgMemoryStore — so retrieval routes
 * through the actual recall_memories() PL/pgSQL function with PG-native
 * signals (pgvector cosine, pg_trgm GIN trigram, ts_rank_cd FTS). This is
 * the apples-to-apples test vs. the PG-captured Python baseline; the SQLite
 * path only approximates the PG signal VALUES client-side.
 *
 * Single concern: PG benchmark evaluation orchestration (db setup, per-conv
 * isolation, ingest, evaluate, collect). The infrastructure adapter is in
 * pg-pgstore-adapter.ts; scoring in scoring.ts (shared with the SQLite path).
 *
 * Mirrors the SQLite runner's evaluate_conversation contract:
 *   - one shared PgMemoryStore, TRUNCATE'd per conversation for isolation
 *   - sessions seeded as memories with source="session_<idx>"
 *   - each QA's `evidence` parsed into target session indices
 *   - hit_rank = first rank whose memory's session_idx is in target set
 *
 * source: cortex main benchmarks/locomo/run_benchmark.py:43-90 (evaluate_conversation)
 * source: cortex main benchmarks/lib/bench_db.py — BenchmarkDB.recall()
 */

import { spawnSync } from "node:child_process";

import { recall } from "@agentic/memory/recall/pg-recall.js";
import type { PgStore } from "@agentic/memory/recall/pg-recall.js";
import { PgMemoryStore } from "@agentic/memory/remember/storage/pg-store.js";
import {
  TransformersEmbeddingEngine,
  toRecallEmbeddingEngine,
  _resetPipelineCache,
} from "@agentic/memory/infrastructure/transformers-embedding-engine.js";
import { ingestMemoriesBatch } from "@agentic/memory/remember/memory-ingest.js";
import type { EmbeddingEngine as CoreEmbeddingEngine } from "@agentic/core";
import {
  CATEGORY_NAMES,
  extractSessions,
  parseEvidenceRefs,
  type LocomoConversation,
} from "./locomo-loader.js";
import type { QuestionResult } from "./scoring.js";
import { makePgPgStore } from "./pg-pgstore-adapter.js";

// source: cortex main run_benchmark.py:73 — same top_k passed to recall.
const TOP_K = 10;

// WRRF constant from Cormack et al. (SIGIR 2009) — same default as pg-recall.ts.
// source: cortex main mcp_server/core/pg_recall.py — wrrf_k default
const WRRF_K = 60;

// Fresh, isolated test DB. Never the production cortex DB — the runner
// TRUNCATEs the memories table per conversation. Override via CORTEX_PG_URL.
// source: PostgreSQL default TCP port 5432 (postgresql.org/docs runtime config)
const DEFAULT_PG_URL = "postgresql://cdeust@localhost:5432/cortex_ts_parity";

interface SeededState {
  /** Map of memory_id → originating session_idx, mirrors source_map in Python. */
  readonly midToSidx: Map<number, number>;
}

/**
 * Ensure the test database exists. createdb is idempotent-by-intent here:
 * a non-zero exit usually means "already exists", which is the success case.
 * Connecting to the maintenance DB to verify avoids parsing locale-specific
 * createdb error text.
 *
 * precondition: PostgreSQL reachable via trust/peer auth (no password).
 * postcondition: a database named after the path component of pgUrl exists.
 */
function ensureDatabase(pgUrl: string): void {
  const dbName = new URL(pgUrl).pathname.replace(/^\//, "");
  if (!dbName) throw new Error(`CORTEX_PG_URL has no database name: ${pgUrl}`);
  // createdb resolves host/user/port from the same connection URL.
  spawnSync("createdb", [dbName], {
    env: { ...process.env, PGDATABASE: "postgres" },
    stdio: "ignore",
  });
  // Verify connectivity to the target DB; surface a real failure loudly.
  const check = spawnSync("psql", ["-d", pgUrl, "-tAc", "SELECT 1"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (check.status !== 0) {
    throw new Error(
      `Cannot connect to ${dbName}: ${check.stderr?.toString() ?? "unknown error"}`,
    );
  }
}

/**
 * TRUNCATE the memories table (CASCADE clears every FK-dependent table —
 * memory_entities, stage_transitions, archives, etc.) and reset identity so
 * each conversation starts from a clean slate, mirroring the SQLite path's
 * per-conversation in-memory store.
 *
 * source: SQLite runner uses a fresh :memory: store per conversation.
 */
async function resetStore(store: PgMemoryStore): Promise<void> {
  await store.runAsync(async (client) => {
    await client.query("TRUNCATE TABLE memories RESTART IDENTITY CASCADE");
  });
}

async function seedConversation(
  store: PgMemoryStore,
  conv: LocomoConversation,
  embedder: CoreEmbeddingEngine | null,
): Promise<SeededState> {
  const sessions = extractSessions(conv.conversation);
  const midToSidx = new Map<number, number>();

  // Build input for ingestMemoriesBatch — mirrors the SQLite runner exactly.
  // Each session is one input; ingestMemoriesBatch decomposes it into
  // sub-session chunks; all chunks from session_i get source="session_i".
  // source: cortex main benchmarks/lib/bench_db.py:101
  const inputs = sessions.map((s) => ({
    content: s.content,
    tags: ["locomo"] as string[],
    source: `session_${s.session_idx}`,
    created_at: s.date,
  }));

  const { sourceMap } = await ingestMemoriesBatch(inputs, store, embedder, {
    domain: "locomo",
    decompose: true,
    isBenchmark: true,
  });

  // Populate midToSidx from sourceMap (mirrors run_benchmark.py:53-58).
  for (const [mid, src] of sourceMap) {
    if (src.startsWith("session_")) {
      const idx = parseInt(src.slice("session_".length), 10);
      if (!isNaN(idx)) midToSidx.set(mid, idx);
    }
  }

  return { midToSidx };
}

async function evaluateQuestion(
  pgStore: PgStore,
  recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null,
  state: SeededState,
  qa: LocomoConversation["qa"][number],
): Promise<QuestionResult | null> {
  const refs = parseEvidenceRefs(qa.evidence);
  const targetSessions = new Set(refs.map(([sidx]) => sidx));
  if (targetSessions.size === 0) return null;
  const category = CATEGORY_NAMES[qa.category ?? 0] ?? `unknown_${qa.category ?? 0}`;

  // Identical recall options to the SQLite runner so the only variable is the
  // backend signal source (PG-native vs. SQLite approximation).
  // source: cortex main benchmarks/locomo/run_benchmark.py:73
  const candidates = await recall(qa.question, pgStore, recallEmbedder, {
    topK: TOP_K,
    domain: "locomo",
    minHeat: 0.01, // source: cortex main mcp_server/core/pg_recall.py:197
    rerank: true,
    wrrfK: WRRF_K,
    includeGlobals: false,
  });

  let hitRank: number | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const sidx = state.midToSidx.get(candidate.memory_id);
    if (sidx !== undefined && targetSessions.has(sidx)) {
      hitRank = i + 1;
      break;
    }
  }
  return { category, hit_rank: hitRank };
}

async function evaluateConversation(
  store: PgMemoryStore,
  pgStore: PgStore,
  conv: LocomoConversation,
  coreEmbedder: CoreEmbeddingEngine | null,
  recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null,
): Promise<QuestionResult[]> {
  // Per-conversation isolation: clear the shared store before seeding.
  await resetStore(store);
  const state = await seedConversation(store, conv, coreEmbedder);
  const results: QuestionResult[] = [];
  for (const qa of conv.qa) {
    const r = await evaluateQuestion(pgStore, recallEmbedder, state, qa);
    if (r) results.push(r);
  }
  return results;
}

export interface PgRunOptions {
  readonly limit?: number | null;
  readonly onProgress?: (current: number, total: number) => void;
  /**
   * When true, instantiates TransformersEmbeddingEngine (Xenova/all-MiniLM-L6-v2,
   * 384-dim) and uses it for the pgvector signal. The Python LoCoMo baseline
   * was captured with real embeddings; PG parity requires this. Default true.
   */
  readonly useEmbeddings?: boolean;
  /** PostgreSQL connection string for the fresh test DB. */
  readonly pgUrl?: string;
}

/**
 * Run LoCoMo over conversations against REAL PostgreSQL and return results.
 *
 * precondition: PostgreSQL reachable; vector + pg_trgm extensions available.
 * postcondition: returned array contains one QuestionResult per question with
 *   evidence; the test DB's memories table is left holding the last
 *   conversation's rows (callers may inspect count(*) for smoke-test proof).
 */
export async function runLocomoPg(
  conversations: readonly LocomoConversation[],
  options: PgRunOptions = {},
): Promise<QuestionResult[]> {
  const limit = options.limit ?? null;
  const slice = limit !== null && limit > 0 ? conversations.slice(0, limit) : conversations;
  const useEmbeddings = options.useEmbeddings ?? true;
  const pgUrl = options.pgUrl ?? process.env["CORTEX_PG_URL"] ?? DEFAULT_PG_URL;

  ensureDatabase(pgUrl);

  let coreEmbedder: CoreEmbeddingEngine | null = null;
  let recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null = null;
  if (useEmbeddings) {
    coreEmbedder = new TransformersEmbeddingEngine();
    recallEmbedder = toRecallEmbeddingEngine(coreEmbedder);
    // Warm the model so the heavy load is reported by the first onProgress
    // call rather than charged silently to conversation #1.
    await coreEmbedder.embed("warmup");
  }

  // ONE store for the whole run; schema is applied lazily on first use
  // (which also runs CREATE EXTENSION IF NOT EXISTS vector / pg_trgm as the
  // first DDL statements — see pg-schema-tables.ts).
  const store = new PgMemoryStore(pgUrl);
  const pgStore = makePgPgStore(store);
  try {
    const all: QuestionResult[] = [];
    for (let i = 0; i < slice.length; i++) {
      const conv = slice[i];
      if (!conv) continue;
      const convResults = await evaluateConversation(
        store,
        pgStore,
        conv,
        coreEmbedder,
        recallEmbedder,
      );
      all.push(...convResults);
      options.onProgress?.(i + 1, slice.length);
    }
    return all;
  } finally {
    await store.close();
    if (useEmbeddings) _resetPipelineCache();
  }
}

/**
 * Smoke-test helper: count rows currently in the test DB's memories table.
 * Used to prove ingest wrote rows after a 1-conversation run.
 */
export async function countMemoriesPg(pgUrl?: string): Promise<number> {
  const url = pgUrl ?? process.env["CORTEX_PG_URL"] ?? DEFAULT_PG_URL;
  const store = new PgMemoryStore(url);
  try {
    return await store.runAsync(async (client) => {
      const r = await client.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM memories",
      );
      return r.rows[0]?.c ?? 0;
    });
  } finally {
    await store.close();
  }
}
