/**
 * pg-longmemeval-runner.ts — REAL-PostgreSQL LongMemEval benchmark runner.
 *
 * Runs the LongMemEval dataset through the TS Cortex recall pipeline (recall()
 * from pg-recall.ts) backed by the REAL PgMemoryStore — so retrieval routes
 * through the actual recall_memories() PL/pgSQL function with PG-native signals
 * (pgvector cosine, pg_trgm GIN trigram, ts_rank_cd FTS). This is the
 * apples-to-apples test vs. the PG-captured published Cortex numbers
 * (docs/arxiv-thermodynamic/main.pdf Table tab:benchmarks — R@10 98.4%,
 * MRR 0.9124).
 *
 * Mirrors pg-locomo-runner.ts. The ONE structural difference faithful to the
 * Python oracle: LongMemEval isolation is PER-QUESTION, not per-conversation —
 * each question carries its own haystack, so the store is TRUNCATE'd and
 * re-seeded before EACH question (run_benchmark.py:248 db.clear()).
 *
 * Per-question protocol (run_benchmark.py:227-288):
 *   - TRUNCATE the store
 *   - seed one memory per haystack session, source = session id, with the
 *     session's parsed date (created_at) and two-phase decayed heat
 *   - recall(question) with top_k=10, domain="longmemeval", rerank on
 *   - retrieved session ids = source_map[memory_id] for each candidate
 *   - hit_rank = first rank whose session id is in answer_session_ids
 *
 * source: cortex main benchmarks/longmemeval/run_benchmark.py:227-288
 * source: cortex main benchmarks/lib/bench_db.py — BenchmarkDB.load_memories / recall
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
import type { LongMemEvalQuestion } from "./longmemeval-loader.js";
import type { QuestionResult } from "./scoring.js";
import { makePgPgStore } from "./pg-pgstore-adapter.js";

// source: cortex main run_benchmark.py:283 / bench_db.py:117 — top_k passed to recall.
const TOP_K = 10;

// WRRF constant from Cormack et al. (SIGIR 2009) — same default as pg-recall.ts.
// source: cortex main mcp_server/core/pg_recall.py — wrrf_k default
const WRRF_K = 60;

// FlashRank linear-blend weight — the BEAM ablation optimum used by bench_db.
// source: cortex main benchmarks/lib/bench_db.py:122 — rerank_alpha=0.70
const RERANK_ALPHA = 0.7;

// Heat floor below which memories are filtered. Same default as bench_db.recall.
// source: cortex main benchmarks/lib/bench_db.py:120 — min_heat=0.01
const MIN_HEAT = 0.01;

// Fresh, isolated test DB. Never the production cortex DB — the runner
// TRUNCATEs the memories table per question. Override via CORTEX_PG_URL.
// source: PostgreSQL default TCP port 5432 (postgresql.org/docs runtime config)
const DEFAULT_PG_URL = "postgresql://cdeust@localhost:5432/cortex_ts_parity";

interface SeededState {
  /** Map of memory_id → originating session id, mirrors source_map in Python. */
  readonly midToSid: Map<number, string>;
}

/**
 * Ensure the test database exists (createdb is idempotent-by-intent; a non-zero
 * exit usually means "already exists"). Then verify connectivity and fail loud.
 *
 * precondition: PostgreSQL reachable via trust/peer auth (no password).
 * postcondition: a database named after the path component of pgUrl exists.
 *
 * source: pg-locomo-runner.ts ensureDatabase (identical contract).
 */
function ensureDatabase(pgUrl: string): void {
  const dbName = new URL(pgUrl).pathname.replace(/^\//, "");
  if (!dbName) throw new Error(`CORTEX_PG_URL has no database name: ${pgUrl}`);
  spawnSync("createdb", [dbName], {
    env: { ...process.env, PGDATABASE: "postgres" },
    stdio: "ignore",
  });
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
 * TRUNCATE the memories table (CASCADE clears every FK-dependent table) and
 * reset identity so each question starts from a clean slate, mirroring the
 * Python per-question db.clear().
 *
 * source: cortex main run_benchmark.py:248 — db.clear() before each question.
 */
async function resetStore(store: PgMemoryStore): Promise<void> {
  await store.runAsync(async (client) => {
    await client.query("TRUNCATE TABLE memories RESTART IDENTITY CASCADE");
  });
}

/**
 * Seed one question's haystack: one memory per session, source = session id,
 * with the session's parsed date and two-phase decayed heat. Populate
 * midToSid from the returned source_map (chunks inherit their session source).
 *
 * source: cortex main run_benchmark.py:250-269 — memories list + load_memories.
 */
async function seedQuestion(
  store: PgMemoryStore,
  question: LongMemEvalQuestion,
  embedder: CoreEmbeddingEngine | null,
): Promise<SeededState> {
  const midToSid = new Map<number, string>();

  // One input per haystack session — source carries the gold session id.
  // ingestMemoriesBatch decomposes each session into sub-chunks; every chunk
  // from session_i keeps source = its session id (mirrors source_map).
  // source: cortex main run_benchmark.py:258-267 + bench_db.py:101 (decompose=True)
  const inputs = question.sessions.map((s) => ({
    content: s.content,
    tags: [question.question_type],
    source: s.session_id,
    created_at: s.date,
    heat: s.heat,
  }));

  const { sourceMap } = await ingestMemoriesBatch(inputs, store, embedder, {
    domain: "longmemeval",
    decompose: true,
    isBenchmark: true,
  });

  for (const [mid, src] of sourceMap) {
    midToSid.set(mid, src);
  }
  return { midToSid };
}

/**
 * Recall for one question and compute its hit_rank against the gold set.
 *
 * Recall options are IDENTICAL to the Python oracle so the only variable is the
 * backend signal source: top_k=10, domain="longmemeval", min_heat=0.01,
 * rerank=true, rerank_alpha=0.70, include_globals=false.
 *
 * source: cortex main run_benchmark.py:283 + bench_db.py:114-138.
 */
async function evaluateQuestion(
  pgStore: PgStore,
  recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null,
  state: SeededState,
  question: LongMemEvalQuestion,
): Promise<QuestionResult | null> {
  const gold = new Set(question.answer_session_ids);
  if (gold.size === 0) return null;

  const candidates = await recall(question.question, pgStore, recallEmbedder, {
    topK: TOP_K,
    domain: "longmemeval",
    minHeat: MIN_HEAT,
    rerank: true,
    rerankAlpha: RERANK_ALPHA,
    wrrfK: WRRF_K,
    includeGlobals: false,
  });

  let hitRank: number | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const sid = state.midToSid.get(candidate.memory_id);
    if (sid !== undefined && gold.has(sid)) {
      hitRank = i + 1;
      break;
    }
  }
  return { category: question.category, hit_rank: hitRank };
}

export interface PgLongMemEvalRunOptions {
  readonly limit?: number | null;
  readonly onProgress?: (current: number, total: number) => void;
  /**
   * When true, instantiates TransformersEmbeddingEngine (Xenova/all-MiniLM-L6-v2,
   * 384-dim) for the pgvector signal. The Python baseline was captured with real
   * embeddings; PG parity requires this. Default true.
   */
  readonly useEmbeddings?: boolean;
  /** PostgreSQL connection string for the fresh test DB. */
  readonly pgUrl?: string;
}

/**
 * Run LongMemEval over questions against REAL PostgreSQL and return results.
 *
 * precondition: PostgreSQL reachable; vector + pg_trgm extensions available.
 * postcondition: returned array contains one QuestionResult per question that
 *   has gold answer session ids; the test DB's memories table is left holding
 *   the last question's rows (callers may inspect count(*) for smoke proof).
 *
 * source: cortex main run_benchmark.py:226-288 — per-question load → recall loop.
 */
export async function runLongMemEvalPg(
  questions: readonly LongMemEvalQuestion[],
  options: PgLongMemEvalRunOptions = {},
): Promise<QuestionResult[]> {
  const limit = options.limit ?? null;
  const slice =
    limit !== null && limit > 0 ? questions.slice(0, limit) : questions;
  const useEmbeddings = options.useEmbeddings ?? true;
  const pgUrl = options.pgUrl ?? process.env["CORTEX_PG_URL"] ?? DEFAULT_PG_URL;

  ensureDatabase(pgUrl);

  let coreEmbedder: CoreEmbeddingEngine | null = null;
  let recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null = null;
  if (useEmbeddings) {
    coreEmbedder = new TransformersEmbeddingEngine();
    recallEmbedder = toRecallEmbeddingEngine(coreEmbedder);
    // Warm the model so the heavy load is charged to setup, not question #1.
    await coreEmbedder.embed("warmup");
  }

  // ONE store for the whole run; schema (incl. CREATE EXTENSION vector / pg_trgm)
  // is applied lazily on first use — see pg-schema-tables.ts.
  const store = new PgMemoryStore(pgUrl);
  const pgStore = makePgPgStore(store);
  try {
    const all: QuestionResult[] = [];
    for (let i = 0; i < slice.length; i++) {
      const question = slice[i];
      if (!question) continue;
      // Per-question isolation: clear the shared store before seeding.
      await resetStore(store);
      const state = await seedQuestion(store, question, coreEmbedder);
      const r = await evaluateQuestion(pgStore, recallEmbedder, state, question);
      if (r) all.push(r);
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
 * Used to prove ingest wrote rows after a small slice run.
 *
 * source: pg-locomo-runner.ts countMemoriesPg (identical contract).
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
