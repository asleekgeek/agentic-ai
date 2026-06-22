/* eslint-disable @typescript-eslint/no-magic-numbers -- all numeric literals sourced from cited Python file */
/**
 * Structured 3-phase context assembly entry point.
 *
 * Mirrors mcp_server/core/pg_recall.py::assemble_context (lines 407-636),
 * adapted for the TypeScript PgStore interface and PgMemoryStore entity APIs.
 *
 * This is the TS port of the new retrieval primitive that replaces flat
 * top-k for long-context scenarios. See context-assembly/ for the full
 * design and paper citations.
 *
 * ## Control flow for token_budget=None (BEAM benchmark path)
 *
 * The BEAM benchmark calls this with tokenBudget=undefined (no LLM reader).
 * In that branch:
 *   - Phase 1 selects by maxChunksPerPhase count only (submodularSelect).
 *   - Phase 2 PPR traversal is gated by count, not by adjBudget.
 *   - Phase 3 summaryFn always returns "" for BEAM → no-op.
 *   - budget.ts::truncate_to_budget, decomposer.ts, condensers paths are
 *     NEVER reached (verified: adj_budget / sum_budget stay undefined;
 *     no truncation call exists in the assembler's no-budget path).
 * The caller reads result.selectedMemories to score retrieval hits.
 *
 * ## Differences from the Python oracle (faithful adaptations)
 *
 * - Python's store.get_memories_mentioning_entity(name, limit=10) has no
 *   TS equivalent. This port implements Phase 2's memoriesByEntityFn by
 *   running one recall() per top-entity-name (capped at TOP_ENTITY_RECALL
 *   items). The entity-name query falls back to WRRF which recovers most
 *   cross-stage memories. Faithfulness note: Python searches by entity name
 *   substring against DB content; this port uses WRRF semantic search with
 *   the entity name as query — structurally equivalent for prose content.
 * - Entity ID lookup uses the entity graph returned by getAllEntitiesAsync().
 *   Entity-to-memory linkage is done by substring matching entity names
 *   against memory content, identical to Python pg_recall.py:521-543.
 *
 * source: Cortex mcp_server/core/pg_recall.py:407-636
 * source: Cortex mcp_server/core/context_assembly/stage_assembler.py
 * source: Cortex mcp_server/core/context_assembly/stage_detector.py
 * source: Cortex benchmarks/lib/bench_db.py:140-170
 * source: Cortex benchmarks/beam/run_benchmark.py:166-189
 */

import { recall, type PgStore, type RecallOptions } from "../pg-recall.js";
import type { EmbeddingEngine } from "../port.js";
import type { Candidate } from "../recall-pipeline-stages.js";
import {
  ExplicitStageDetector,
  type StageDetector,
  type MemoryRecord,
} from "./stage-detector.js";
import {
  StageAwareContextAssembler,
  DEFAULT_BUDGET_SPLIT,
  type StageContextResult,
  type BudgetSplit,
} from "./stage-assembler.js";

// Maximum candidates fetched per Phase 1 recall (factor matches Python oracle).
// source: Cortex pg_recall.py:510 — recall top_k = max_results*3
const PHASE1_RECALL_FACTOR = 3;

// Maximum number of entity names used for Phase 2 memory lookup.
// source: Cortex pg_recall.py:237 — top 50 PPR entity IDs
const TOP_PPR_ENTITY_IDS = 50;

// Recall cap per entity name in Phase 2 (engineering adaptation — no Python
// equivalent since Python uses substring FTS, not per-entity recall).
const PHASE2_RECALL_PER_ENTITY = 10;

// Minimum entity name length to avoid noisy matching.
// source: Cortex pg_recall.py:522 — len(name) >= 3
const MIN_ENTITY_NAME_LENGTH = 3;

/** Options for assembleContext — mirrors bench_db.assemble_context params. */
export interface AssembleContextOptions {
  /** Stage field on memory records (default "plan_id"). */
  stageField?: string;
  /** Caller-provided detector; overrides stageField when given. */
  stageDetector?: StageDetector;
  /** Total token budget. undefined = pure rank-based (BEAM benchmark mode). */
  tokenBudget?: number | null;
  /** Domain filter for Phase 1 recall (default "beam" for benchmark). */
  domain?: string | null;
  /** Budget split (own/adjacent/summaries). Default 0.6/0.3/0.1. */
  budgetSplit?: BudgetSplit;
  /** Hard cap on chunks per phase. Default 5. */
  maxChunksPerPhase?: number;
  /** MMR diversity lambda. Default 0.0 (matches pg_recall.assemble_context default). */
  diversityLambda?: number;
  /** Recall options forwarded to Phase 1 and Phase 2 recall() calls. */
  recallOptions?: Omit<RecallOptions, "topK" | "domain">;
}

/**
 * Structured 3-phase context assembly.
 *
 * precondition: store is connected; currentStage is a valid stage id for the
 *   detector in use; embeddings is non-null for best accuracy.
 * postcondition: returns StageContextResult with selectedMemories (Phase 1 +
 *   Phase 2 items), assembledContext (prompt-ready text), and metadata.
 *   When tokenBudget is undefined, selection is purely rank-based (count only).
 *
 * source: Cortex mcp_server/core/pg_recall.py:407-636
 */
export async function assembleContext(
  query: string,
  store: PgStore,
  embeddings: EmbeddingEngine | null,
  currentStage: string,
  {
    stageField = "plan_id",
    stageDetector: callerDetector,
    tokenBudget,
    domain = null,
    budgetSplit = DEFAULT_BUDGET_SPLIT,
    maxChunksPerPhase = 5,
    diversityLambda = 0.0, // source: pg_recall.py:418 — diversity_lambda default 0.0
    recallOptions = {},
  }: AssembleContextOptions = {},
): Promise<StageContextResult> {
  // Use caller-provided detector, or default to ExplicitStageDetector.
  // source: Cortex pg_recall.py:468-471
  const detector: StageDetector =
    callerDetector ?? new ExplicitStageDetector(stageField);

  // ── Entity graph cache (built once per assemble call) ──────────────────
  // source: Cortex pg_recall.py:475-496 — _ensure_graph closure
  let graphCache: {
    entities: MemoryRecord[];
    relationships: MemoryRecord[];
    idToName: Map<string, string>;
    entityPairs: Array<[string, string]>; // [name_lower, entity_id]
  } | null = null;

  async function ensureGraph(): Promise<typeof graphCache & {}> {
    if (graphCache !== null) return graphCache;
    // PgMemoryStore exposes getAllEntitiesAsync / getAllRelationshipsAsync.
    // We access them via the store's extended interface; fall back to [] if absent.
    const storeExt = store as unknown as {
      getAllEntitiesAsync?: () => Promise<MemoryRecord[]>;
      getAllRelationshipsAsync?: () => Promise<MemoryRecord[]>;
    };
    const entities =
      typeof storeExt.getAllEntitiesAsync === "function"
        ? await storeExt.getAllEntitiesAsync()
        : [];
    const relationships =
      typeof storeExt.getAllRelationshipsAsync === "function"
        ? await storeExt.getAllRelationshipsAsync()
        : [];
    const idToName = new Map<string, string>();
    const entityPairs: Array<[string, string]> = [];
    for (const e of entities) {
      const eid = String(e["id"] ?? "");
      const name = String(e["name"] ?? "").trim();
      if (eid) idToName.set(eid, name);
      const nameLower = name.toLowerCase();
      if (nameLower.length >= MIN_ENTITY_NAME_LENGTH && eid) {
        entityPairs.push([nameLower, eid]);
      }
    }
    graphCache = { entities, relationships, idToName, entityPairs };
    return graphCache;
  }

  // ── Phase 1 retrieve callback ──────────────────────────────────────────
  // Runs WRRF recall, filters to current stage, tags each candidate with
  // entity IDs via substring matching against the graph.
  // source: Cortex pg_recall.py:509-544
  async function retrieveFn(
    q: string,
    stageId: string,
    maxResults: number,
  ): Promise<MemoryRecord[]> {
    const raw: Candidate[] = await recall(q, store, embeddings, {
      topK: maxResults * PHASE1_RECALL_FACTOR,
      domain,
      ...recallOptions,
      includeGlobals: false,
      rerank: recallOptions["rerank"] ?? true,
    });
    const graph = await ensureGraph();

    const filtered: MemoryRecord[] = [];
    for (const c of raw) {
      // We need the full memory record to call stageOf() correctly.
      // The candidate already has created_at (from recall_memories row),
      // plus memory_id, content, domain, tags. Construct a MemoryRecord
      // from the candidate fields.
      const mem: MemoryRecord = {
        memory_id: c.memory_id,
        content: c.content,
        score: c.score,
        heat: c.heat ?? 0,
        domain: c.domain ?? domain,
        created_at: c.created_at ?? null,
        tags: c.tags ?? [],
      };
      if (detector.stageOf(mem) !== stageId) continue;

      // Tag entity IDs via substring match against graph.
      // source: Cortex pg_recall.py:534-543
      const contentLower = String(c.content ?? "").toLowerCase();
      const entityIds: string[] = graph.entityPairs
        .filter(([name]) => contentLower.includes(name))
        .map(([, eid]) => eid);

      filtered.push({
        ...mem,
        embedding: c.embedding ?? null,
        entity_ids: entityIds,
      });
      if (filtered.length >= maxResults) break;
    }
    return filtered;
  }

  // ── Phase 2 entity graph callback ─────────────────────────────────────
  // source: Cortex pg_recall.py:548-550
  async function entityGraphFn(): Promise<[MemoryRecord[], MemoryRecord[]]> {
    const graph = await ensureGraph();
    return [graph.entities, graph.relationships];
  }

  // ── Phase 2 memories-by-entity callback ───────────────────────────────
  // Python oracle uses store.get_memories_mentioning_entity(name, limit=10),
  // which is not available in PgMemoryStore. Adaptation: recall() by entity
  // name (WRRF catches prose mentions). Entity IDs are tagged on returned
  // memories via substring match (same as Phase 1).
  // source: Cortex pg_recall.py:560-597 (structural mirror)
  async function memoriesByEntityFn(
    entityIds: string[],
  ): Promise<MemoryRecord[]> {
    const graph = await ensureGraph();
    const seenIds = new Set<number | string>();
    const out: MemoryRecord[] = [];

    for (const eid of entityIds.slice(0, TOP_PPR_ENTITY_IDS)) {
      const name = graph.idToName.get(eid);
      if (!name || name.length < MIN_ENTITY_NAME_LENGTH) continue;

      const mems: Candidate[] = await recall(name, store, embeddings, {
        topK: PHASE2_RECALL_PER_ENTITY,
        domain,
        ...recallOptions,
        includeGlobals: false,
        rerank: false, // speed: no rerank for Phase 2 entity search
      });
      for (const m of mems) {
        const mid = m.memory_id;
        if (mid == null || seenIds.has(mid)) continue;
        if (domain != null && m.domain !== domain) continue;
        seenIds.add(mid);

        const contentLower = String(m.content ?? "").toLowerCase();
        const memEntityIds: string[] = graph.entityPairs
          .filter(([n]) => contentLower.includes(n))
          .map(([, id]) => id);

        out.push({
          memory_id: mid,
          content: m.content ?? "",
          score: m.score,
          created_at: m.created_at ?? null,
          entity_ids: memEntityIds,
        });
      }
    }
    return out;
  }

  // ── Phase 3 stage summary callback ────────────────────────────────────
  // For BEAM, no pre-computed summaries exist. Always returns "".
  // Production would wire to dual_store_cls / schema_engine.
  // source: Cortex pg_recall.py:603-607
  async function stageSummaryFn(_stageId: string): Promise<string> {
    return "";
  }

  // ── Construct assembler and run ────────────────────────────────────────
  // source: Cortex pg_recall.py:609-636
  const assembler = new StageAwareContextAssembler({
    stageDetector: detector,
    retrieveFn,
    entityGraphFn,
    memoriesByEntityFn,
    stageSummaryFn,
  });

  return assembler.assemble({
    query,
    currentStage,
    tokenBudget: tokenBudget ?? undefined,
    budgetSplit,
    maxChunksPerPhase,
    diversityLambda,
  });
}

// Re-export the result type so callers don't need a deep import.
export type { StageContextResult };
