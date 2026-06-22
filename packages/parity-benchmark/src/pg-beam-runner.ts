/**
 * pg-beam-runner.ts — REAL-PostgreSQL BEAM benchmark runner (retrieval proxy).
 *
 * Runs the BEAM 100K dataset through the TS Cortex recall pipeline (recall()
 * from pg-recall.ts) backed by the REAL PgMemoryStore — so retrieval routes
 * through the actual recall_memories() PL/pgSQL function with PG-native signals
 * (pgvector cosine, pg_trgm GIN trigram, ts_rank_cd FTS). This is the
 * apples-to-apples test vs. the PG-captured published Cortex BEAM-100K number
 * (docs/arxiv-thermodynamic/main.pdf + docs/arxiv-context-assembly/main.tex —
 * retrieval-proxy MRR 0.591).
 *
 * IMPORTANT — what this measures: BEAM's PUBLISHED headline metric is an
 * end-to-end LLM-as-judge nugget score, which this runner does NOT compute.
 * Cortex reports a RETRIEVAL-PROXY MRR (the rank of the first memory whose
 * content matches the gold answer or a gold source-turn prefix), used only for
 * within-system, same-harness comparison. This runner reproduces that proxy
 * EXACTLY as the Python BEAM runner computes it — no LLM judge.
 *
 * Mirrors pg-locomo-runner.ts (per-conversation isolation: db.clear() →
 * load_memories → evaluate all the conversation's questions). The structural
 * difference faithful to the Python oracle is the SCORING + AGGREGATION:
 *   - hit_rank = first retrieved memory whose content contains the answer
 *     substring OR an 80-char source-turn prefix (content match, not source id);
 *     abstention is special (hit_rank=1 when retrieval is empty or top score
 *     < 0.3, i.e. the system correctly found nothing confident).
 *   - per-conversation per-ability MRR/R@5/R@10, then mean over conversations
 *     per ability, then mean over abilities = the OVERALL (nested macro-average).
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:126-274 (evaluate_retrieval)
 * source: cortex main benchmarks/beam/run_benchmark.py:336-432 (nested aggregation)
 * source: cortex main benchmarks/lib/bench_db.py:114-138 (recall options)
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
  isContentHit,
  type BeamConversation,
  type BeamQuestion,
} from "./beam-loader.js";
import type { BenchmarkScores, CategoryScores } from "./scoring.js";
import { makePgPgStore } from "./pg-pgstore-adapter.js";

// source: cortex main bench_db.py:117 — top_k passed to recall.
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

// Abstention success threshold: top retrieval score below this means the system
// correctly found nothing confident. Engineering heuristic per the Python proxy.
// source: cortex main benchmarks/beam/run_benchmark.py:222 (score < 0.3)
const ABSTENTION_SCORE_FLOOR = 0.3;

// Retrieval-recall cutoffs the BEAM proxy reports.
// source: cortex main benchmarks/beam/run_benchmark.py:262-265
const RECALL_AT_5 = 5;
const RECALL_AT_10 = 10;

// Fresh, isolated test DB. Never the production cortex DB — the runner
// TRUNCATEs the memories table per conversation. Override via CORTEX_PG_URL.
// source: PostgreSQL default TCP port 5432 (postgresql.org/docs runtime config)
const DEFAULT_PG_URL = "postgresql://cdeust@localhost:5432/cortex_ts_parity";

/** One per-conversation per-ability aggregate (mirrors metrics[ability]). */
interface AbilityMetric {
  readonly mrr: number;
  readonly recall_at_5: number;
  readonly recall_at_10: number;
  readonly total_questions: number;
}

/**
 * Ensure the test database exists (createdb is idempotent-by-intent; a non-zero
 * exit usually means "already exists"). Then verify connectivity and fail loud.
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
 * reset identity so each conversation starts from a clean slate, mirroring the
 * Python per-conversation db.clear().
 *
 * source: cortex main run_benchmark.py:365 — db.clear() before each conversation.
 */
async function resetStore(store: PgMemoryStore): Promise<void> {
  await store.runAsync(async (client) => {
    await client.query("TRUNCATE TABLE memories RESTART IDENTITY CASCADE");
  });
}

/**
 * Seed one conversation's turns as memories (user/assistant pairs with date
 * headers). BEAM ingests one memory per turn-pair; created_at carries the
 * propagated time-anchor for recency.
 *
 * source: cortex main run_benchmark.py:352-366 + bench_db.py:101 (decompose).
 */
async function seedConversation(
  store: PgMemoryStore,
  conv: BeamConversation,
  embedder: CoreEmbeddingEngine | null,
): Promise<void> {
  const inputs = conv.memories.map((m) => ({
    content: m.content,
    tags: ["beam"] as string[],
    source: "beam",
    created_at: m.created_at,
  }));
  await ingestMemoriesBatch(inputs, store, embedder, {
    domain: "beam",
    decompose: true,
    isBenchmark: true,
  });
}

/**
 * Compute hit_rank for one question against the retrieved candidates.
 *
 * Abstention: success (hit_rank=1) when retrieval is empty or the top score is
 * below the abstention floor — the system correctly found nothing confident.
 * Otherwise: first rank whose content matches the answer/source proxy.
 *
 * source: cortex main run_benchmark.py:211-239.
 */
function hitRankFor(
  question: BeamQuestion,
  candidates: ReadonlyArray<{ content?: string; score: number }>,
): number | null {
  if (question.is_abstention) {
    const top = candidates[0];
    if (!top || top.score < ABSTENTION_SCORE_FLOOR) return 1;
    return null;
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    const contentLower = (c.content ?? "").toLowerCase();
    if (isContentHit(question, contentLower)) return i + 1;
  }
  return null;
}

/**
 * Recall for every question in a conversation, bucketed by ability, and
 * aggregate each ability to a per-conversation AbilityMetric.
 *
 * Recall options are IDENTICAL to the Python oracle so the only variable is the
 * backend signal source: top_k=10, domain="beam", min_heat=0.01, rerank=true,
 * rerank_alpha=0.70, include_globals=false.
 *
 * source: cortex main run_benchmark.py:135-274 + bench_db.py:114-138.
 */
async function evaluateConversation(
  pgStore: PgStore,
  recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null,
  conv: BeamConversation,
): Promise<Map<string, AbilityMetric>> {
  const ranksByAbility = new Map<string, Array<number | null>>();

  for (const q of conv.questions) {
    const candidates = await recall(q.question, pgStore, recallEmbedder, {
      topK: TOP_K,
      domain: "beam",
      minHeat: MIN_HEAT,
      rerank: true,
      rerankAlpha: RERANK_ALPHA,
      wrrfK: WRRF_K,
      includeGlobals: false,
    });
    const rank = hitRankFor(q, candidates);
    const list = ranksByAbility.get(q.ability) ?? [];
    list.push(rank);
    ranksByAbility.set(q.ability, list);
  }

  const metrics = new Map<string, AbilityMetric>();
  for (const [ability, ranks] of ranksByAbility) {
    metrics.set(ability, aggregateAbility(ranks));
  }
  return metrics;
}

// source: cortex main run_benchmark.py:258-271 — per-ability mrr/r5/r10 over its
// questions, miss counted as 0.
function aggregateAbility(ranks: ReadonlyArray<number | null>): AbilityMetric {
  const total = ranks.length;
  if (total === 0) {
    return { mrr: 0, recall_at_5: 0, recall_at_10: 0, total_questions: 0 };
  }
  let mrrSum = 0;
  let r5 = 0;
  let r10 = 0;
  for (const rank of ranks) {
    if (rank !== null && rank > 0) {
      mrrSum += 1.0 / rank;
      if (rank <= RECALL_AT_5) r5++;
      if (rank <= RECALL_AT_10) r10++;
    }
  }
  return {
    mrr: mrrSum / total,
    recall_at_5: r5 / total,
    recall_at_10: r10 / total,
    total_questions: total,
  };
}

// Mean of a numeric list, 0 on empty. source: run_benchmark.py:406-419.
function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Fold the per-conversation per-ability metrics into the BEAM nested
 * macro-average and shape it as BenchmarkScores so report.ts can diff it:
 *   - per ability: mean over conversations of (mrr / r5 / r10), sum of questions
 *   - overall: mean over abilities of those per-ability means
 *
 * source: cortex main run_benchmark.py:402-419 (ability mean over runs/convs;
 *   overall = mean of per-ability values).
 */
export function aggregateBeam(
  perConversation: ReadonlyArray<Map<string, AbilityMetric>>,
): BenchmarkScores {
  const byAbility = new Map<string, AbilityMetric[]>();
  for (const conv of perConversation) {
    for (const [ability, m] of conv) {
      const list = byAbility.get(ability) ?? [];
      list.push(m);
      byAbility.set(ability, list);
    }
  }

  const byCategory: Record<string, CategoryScores> = {};
  const abilityMrr: number[] = [];
  const abilityR5: number[] = [];
  const abilityR10: number[] = [];
  for (const [ability, ms] of [...byAbility.entries()].sort()) {
    const mrr = mean(ms.map((m) => m.mrr));
    const r5 = mean(ms.map((m) => m.recall_at_5));
    const r10 = mean(ms.map((m) => m.recall_at_10));
    const questions = ms.reduce((a, m) => a + m.total_questions, 0);
    byCategory[ability] = {
      mrr,
      recall_at_5: r5,
      recall_at_10: r10,
      questions,
    };
    abilityMrr.push(mrr);
    abilityR5.push(r5);
    abilityR10.push(r10);
  }

  const totalQuestions = Object.values(byCategory).reduce(
    (a, c) => a + c.questions,
    0,
  );
  return {
    overall: {
      mrr: mean(abilityMrr),
      recall_at_5: mean(abilityR5),
      recall_at_10: mean(abilityR10),
      questions: totalQuestions,
    },
    by_category: byCategory,
  };
}

export interface PgBeamRunOptions {
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
 * Run BEAM over conversations against REAL PostgreSQL and return the aggregated
 * retrieval-proxy scores (nested macro-average; headline is overall MRR).
 *
 * precondition: PostgreSQL reachable; vector + pg_trgm extensions available.
 * postcondition: returned BenchmarkScores has one by_category entry per ability
 *   seen; the test DB's memories table is left holding the last conversation's
 *   rows (callers may inspect count(*) for smoke proof).
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:336-419.
 */
export async function runBeamPg(
  conversations: readonly BeamConversation[],
  options: PgBeamRunOptions = {},
): Promise<BenchmarkScores> {
  const limit = options.limit ?? null;
  const slice =
    limit !== null && limit > 0 ? conversations.slice(0, limit) : conversations;
  const useEmbeddings = options.useEmbeddings ?? true;
  const pgUrl = options.pgUrl ?? process.env["CORTEX_PG_URL"] ?? DEFAULT_PG_URL;

  ensureDatabase(pgUrl);

  let coreEmbedder: CoreEmbeddingEngine | null = null;
  let recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null = null;
  if (useEmbeddings) {
    coreEmbedder = new TransformersEmbeddingEngine();
    recallEmbedder = toRecallEmbeddingEngine(coreEmbedder);
    // Warm the model so the heavy load is charged to setup, not conversation #1.
    await coreEmbedder.embed("warmup");
  }

  // ONE store for the whole run; schema (incl. CREATE EXTENSION vector / pg_trgm)
  // is applied lazily on first use — see pg-schema-tables.ts.
  const store = new PgMemoryStore(pgUrl);
  const pgStore = makePgPgStore(store);
  try {
    const perConversation: Array<Map<string, AbilityMetric>> = [];
    for (let i = 0; i < slice.length; i++) {
      const conv = slice[i];
      if (!conv) continue;
      // Per-conversation isolation: clear the shared store before seeding.
      await resetStore(store);
      await seedConversation(store, conv, coreEmbedder);
      const metrics = await evaluateConversation(pgStore, recallEmbedder, conv);
      perConversation.push(metrics);
      options.onProgress?.(i + 1, slice.length);
    }
    return aggregateBeam(perConversation);
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
