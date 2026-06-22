/* eslint-disable @typescript-eslint/no-magic-numbers -- all numeric literals sourced from cited Python file */
/**
 * Three-phase stage-aware context assembler.
 *
 * Ports Clément Deust's Swift StageAwareContextAssembler (ai-architect-prd-builder
 * StageAwareContextAssembler.swift) via its Python port to TypeScript, adapted
 * for the Cortex memory types and the BEAM benchmark runner.
 *
 * ## The algorithm (token_budget=None path — load-bearing for BEAM)
 *
 * Given a query and a current_stage, assemble structured context in three phases:
 *
 *   Phase 1 — Own-stage (retrieve + submodular select)
 *     Call retrieveFn(query, current_stage, maxChunksPerPhase*3).
 *     Select chunks via submodular coverage (Krause & Guestrin 2008)
 *     instead of top-k, to avoid near-duplicate drowning.
 *
 *   Phase 2 — Adjacent stages via entity graph / PPR (30% of budget)
 *     Extract entities from Phase 1 results.
 *     Run Personalized PageRank (HippoRAG, Gutiérrez NeurIPS 2024) over
 *     the entity graph seeded on those entities.
 *     Select cross-stage memories ranked by PPR mass.
 *
 *   Phase 3 — Summary fallback (10% of budget)
 *     For stages not covered by Phase 1+2, retrieve pre-computed
 *     schema-structured summaries. For BEAM, stageSummaryFn always
 *     returns "" so Phase 3 is a structural no-op.
 *
 * ## token_budget=None contract (verified against Python control flow)
 *
 * When tokenBudget is undefined/null the assembler:
 *   - Selects by maxChunksPerPhase count only — no token truncation.
 *   - Phase 2 greedy pack terminates by count, not by adjBudget.
 *   - Phase 3 summary loop terminates only on empty string from stageSummaryFn.
 *   - estimate_tokens() is still called for bookkeeping in metadata but
 *     NEVER gates selection.
 * This matches the Python oracle path (run_benchmark.py:166-189,
 * stage_assembler.py:182-187, coverage.py:58-67).
 *
 * ## LLM-condensation paths NOT exercised when tokenBudget is undefined
 *
 * budget.py::truncate_to_budget, decomposer.py::assemble_prompt,
 * condensers.py, warning.py — these are only reached when a real integer
 * token_budget is passed (caller has an LLM reader). The Python control-flow
 * proof: adj_budget and sum_budget are set to None when token_budget is None
 * (stage_assembler.py:183-187), and all budget-gated blocks short-circuit
 * when None. Those modules are ported in this package but are unreachable
 * from the BEAM benchmark path.
 *
 * source: Cortex mcp_server/core/context_assembly/stage_assembler.py
 * source: Cortex mcp_server/core/pg_recall.py:407-636 (assemble_context)
 */

import { estimateTokens } from "./budget.js";
import {
  submodularSelect,
  type Candidate as CoverageCandidate,
} from "./coverage.js";
import {
  buildEntityAdjacency,
  personalizedPagerank,
  scoreMemoriesByPpr,
  type Adjacency,
} from "./ppr-traversal.js";
import type { StageDetector, MemoryRecord } from "./stage-detector.js";

// ── Budget split ─────────────────────────────────────────────────────────

/**
 * Three-phase budget proportions. Must sum to 1.0.
 *
 * source: Cortex stage_assembler.py::BudgetSplit (default 0.6/0.3/0.1)
 */
export interface BudgetSplit {
  readonly ownStage: number;
  readonly adjacent: number;
  readonly summaries: number;
}

// source: Cortex stage_assembler.py::DEFAULT_SPLIT
export const DEFAULT_BUDGET_SPLIT: BudgetSplit = {
  ownStage: 0.6,
  adjacent: 0.3,
  summaries: 0.1,
};

// ── Result container ─────────────────────────────────────────────────────

/**
 * Structured output of the 3-phase assembler.
 *
 * selectedMemories contains the actual memory dicts chosen in Phase 1 and
 * Phase 2, each tagged with a `phase` field (1 or 2). Downstream evaluators
 * (benchmark scorers) read selectedMemories to compute retrieval hits.
 * The concatenated text fields (ownStageContext etc.) are for the LLM reader,
 * not for scoring.
 *
 * source: Cortex stage_assembler.py::StageContextResult
 */
export interface StageContextResult {
  readonly ownStageContext: string;
  readonly adjacentStageContext: string;
  readonly stageSummaries: string;
  readonly assembledContext: string;
  /** Phase 1 + Phase 2 selected memories; each has a `phase` field. */
  readonly selectedMemories: SelectedMemory[];
  readonly metadata: Record<string, unknown>;
}

/** One selected memory annotated with its phase. */
export interface SelectedMemory {
  readonly memory_id: number | string | null;
  readonly content: string;
  readonly score: number;
  /** 1 = own-stage (Phase 1), 2 = adjacent-stage (Phase 2). */
  readonly phase: 1 | 2;
}

// ── Assembler callbacks ──────────────────────────────────────────────────

/**
 * Callback: retrieve candidate memories for a given stage.
 * Returns list of memory dicts with at least content, memory_id, score.
 * source: Cortex stage_assembler.py::StageAwareContextAssembler.__init__ retrieve_fn
 */
export type RetrieveFn = (
  query: string,
  stageId: string,
  maxResults: number,
) => Promise<MemoryRecord[]>;

/**
 * Callback: return (entities, relationships) for the corpus.
 * source: Cortex stage_assembler.py::StageAwareContextAssembler.__init__ entity_graph_fn
 */
export type EntityGraphFn = () => Promise<
  [MemoryRecord[], MemoryRecord[]]
>;

/**
 * Callback: map entity_ids to memories containing those entities.
 * source: Cortex stage_assembler.py::StageAwareContextAssembler.__init__ memories_by_entity_fn
 */
export type MemoriesByEntityFn = (
  entityIds: string[],
) => Promise<MemoryRecord[]>;

/**
 * Callback: return a schema-structured summary string for a stage_id.
 * For BEAM, always returns "". For production, wires to dual_store_cls.
 * source: Cortex stage_assembler.py::StageAwareContextAssembler.__init__ stage_summary_fn
 */
export type StageSummaryFn = (stageId: string) => Promise<string>;

// ── Main assembler ───────────────────────────────────────────────────────

/**
 * Three-phase context assembler for stage-scoped retrieval.
 *
 * Wire dependencies at construction time. All external calls are
 * callbacks so this class stays dependency-free (no direct pg_store,
 * no direct embeddings, no direct schema_engine).
 *
 * source: Cortex mcp_server/core/context_assembly/stage_assembler.py::StageAwareContextAssembler
 */
export class StageAwareContextAssembler {
  private readonly _detector: StageDetector;
  private readonly _retrieve: RetrieveFn;
  private readonly _graph: EntityGraphFn;
  private readonly _memByEnt: MemoriesByEntityFn;
  private readonly _summary: StageSummaryFn;

  constructor({
    stageDetector,
    retrieveFn,
    entityGraphFn,
    memoriesByEntityFn,
    stageSummaryFn,
  }: {
    stageDetector: StageDetector;
    retrieveFn: RetrieveFn;
    entityGraphFn: EntityGraphFn;
    memoriesByEntityFn: MemoriesByEntityFn;
    stageSummaryFn: StageSummaryFn;
  }) {
    this._detector = stageDetector;
    this._retrieve = retrieveFn;
    this._graph = entityGraphFn;
    this._memByEnt = memoriesByEntityFn;
    this._summary = stageSummaryFn;
  }

  /**
   * Run the 3-phase assembly.
   *
   * precondition: currentStage is a valid stage id returned by stageDetector;
   *   retrieveFn and entityGraphFn are wired to a live store.
   * postcondition: selectedMemories contains all Phase 1 + Phase 2 selected
   *   memories (tagged with phase=1 or 2); assembledContext is prompt-ready;
   *   metadata captures bookkeeping; Phase 3 is a no-op when stageSummaryFn
   *   returns "".
   *
   * When tokenBudget is undefined/null, selection is purely by count
   * (maxChunksPerPhase) — used for retrieval evaluation where text length is
   * irrelevant and the metric is rank-based. When a reader is downstream, the
   * caller should pass reasoner.contextWindowSize * 0.75 to enforce a real
   * budget (the Swift ContextDecomposer pattern).
   *
   * source: Cortex stage_assembler.py::StageAwareContextAssembler.assemble
   */
  async assemble({
    query,
    currentStage,
    tokenBudget,
    budgetSplit = DEFAULT_BUDGET_SPLIT,
    maxChunksPerPhase = 5,
    diversityLambda = 0.5,
  }: {
    query: string;
    currentStage: string;
    tokenBudget?: number | null;
    budgetSplit?: BudgetSplit;
    maxChunksPerPhase?: number;
    diversityLambda?: number;
  }): Promise<StageContextResult> {
    // source: stage_assembler.py:183-187 — budget split only computed when
    // token_budget is not None; undefined means rank-based mode.
    const adjBudget =
      tokenBudget != null
        ? Math.floor(tokenBudget * budgetSplit.adjacent)
        : undefined;
    const sumBudget =
      tokenBudget != null
        ? Math.floor(tokenBudget * budgetSplit.summaries)
        : undefined;

    const selectedMemories: SelectedMemory[] = [];

    // ── Phase 1 — Own-stage ─────────────────────────────────────────────
    // source: stage_assembler.py:194-218
    // Selection decoupled from token budget: always pick up to maxChunksPerPhase
    // items so retrieval ranking metrics stay well-defined. Token budget only
    // gates text assembly (below), not item selection count.
    const ownChunks = await this._retrieve(
      query,
      currentStage,
      maxChunksPerPhase * 3, // source: stage_assembler.py:201 — factor 3 for diversity headroom
    );

    const selectedOwn = submodularSelect(ownChunks as CoverageCandidate[], {
      tokenBudget: undefined, // rank-based mode: no token gate on count
      diversityLambda,
      maxChunks: maxChunksPerPhase,
    });

    for (const c of selectedOwn) {
      selectedMemories.push({
        memory_id:
          (c["memory_id"] as number | string | null | undefined) ?? null,
        content: String(c["content"] ?? ""),
        score: Number(c["score"] ?? 0),
        phase: 1,
      });
    }
    const ownText = selectedOwn
      .map((c) => String(c["content"] ?? ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const ownTokens = estimateTokens(ownText);

    // ── Phase 2 — Adjacent stages via PPR ───────────────────────────────
    // source: stage_assembler.py:221-267
    // Extract entities from Phase 1 results, run PPR, fetch cross-stage mems.
    const seedEntities = new Map<string, number>();
    for (const c of selectedOwn) {
      const entityIds = c["entity_ids"] as unknown[] | null | undefined;
      if (Array.isArray(entityIds)) {
        for (const eid of entityIds) {
          const key = String(eid);
          seedEntities.set(key, (seedEntities.get(key) ?? 0) + 1);
        }
      }
    }

    let adjacentText = "";
    let adjacentTokens = 0;
    const coveredStages = new Set<string>([currentStage]);

    if (seedEntities.size > 0) {
      const [entities, relationships] = await this._graph();
      const adjacency: Adjacency = buildEntityAdjacency(
        entities,
        relationships,
      );
      const ppr = personalizedPagerank(adjacency, seedEntities);

      // source: stage_assembler.py:236-238 — top 50 PPR entity IDs
      const topEntityIds = [...ppr.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 50) // source: stage_assembler.py:237
        .map(([id]) => id);
      const candidateMems = await this._memByEnt(topEntityIds);

      // Filter to NOT-current-stage, score by PPR mass
      const crossStage = candidateMems.filter(
        (m) => this._detector.stageOf(m) !== currentStage,
      );
      const scored = scoreMemoriesByPpr(crossStage, ppr);

      // Greedy pack within adjBudget (or ignore when undefined)
      // source: stage_assembler.py:247-266
      const adjacentParts: string[] = [];
      let used = 0;
      for (const [m, score] of scored.slice(0, maxChunksPerPhase * 2)) {
        const content = String(m["content"] ?? "");
        const t = estimateTokens(content);
        if (adjBudget !== undefined && used + t > adjBudget) continue;
        adjacentParts.push(content);
        selectedMemories.push({
          memory_id:
            (m["memory_id"] as number | string | null | undefined) ??
            (m["id"] as number | string | null | undefined) ??
            null,
          content,
          score: Number(score),
          phase: 2,
        });
        used += t;
        coveredStages.add(this._detector.stageOf(m));
        if (adjacentParts.length >= maxChunksPerPhase) break;
      }
      adjacentText = adjacentParts.join("\n\n").trim();
      adjacentTokens = used;
    }

    // ── Phase 3 — Summary fallback ───────────────────────────────────────
    // source: stage_assembler.py:271-284
    // For BEAM, stageSummaryFn always returns "" so this is a structural no-op.
    // The allStages([]) call uses detector's cache, matching the Python pattern.
    const summaryParts: string[] = [];
    let summaryTokens = 0;
    const allStages = this._detector.allStages([]);
    const uncoveredStages = allStages.filter((s) => !coveredStages.has(s));
    for (const stageId of uncoveredStages) {
      const summary = await this._summary(stageId);
      if (!summary) continue;
      const t = estimateTokens(summary);
      if (sumBudget !== undefined && summaryTokens + t > sumBudget) break;
      summaryParts.push(`[${stageId}] ${summary}`);
      summaryTokens += t;
    }
    const summaryText = summaryParts.join("\n\n").trim();

    // ── Assemble ─────────────────────────────────────────────────────────
    // source: stage_assembler.py:287-294
    const parts: string[] = [];
    if (ownText) {
      parts.push(
        `## Current Stage Context (${currentStage})\n\n${ownText}`,
      );
    }
    if (adjacentText) {
      parts.push(`## Related Prior Context\n\n${adjacentText}`);
    }
    if (summaryText) {
      parts.push(`## Stage Summaries\n\n${summaryText}`);
    }
    const assembled = parts.join("\n\n");
    const totalTokens = ownTokens + adjacentTokens + summaryTokens;

    // source: stage_assembler.py:298-319 — metadata fields
    const adjacentStages = [...coveredStages].filter(
      (s) => s !== currentStage,
    );
    const metadata: Record<string, unknown> = {
      own_stage_chunks: selectedOwn.length,
      own_stage_tokens: ownTokens,
      adjacent_stages: adjacentStages.sort(),
      adjacent_tokens: adjacentTokens,
      summary_stages: uncoveredStages.slice(0, summaryParts.length),
      summary_tokens: summaryTokens,
      total_tokens: totalTokens,
      token_budget: tokenBudget ?? null,
      budget_split: [
        budgetSplit.ownStage,
        budgetSplit.adjacent,
        budgetSplit.summaries,
      ],
    };

    return {
      ownStageContext: ownText,
      adjacentStageContext: adjacentText,
      stageSummaries: summaryText,
      assembledContext: assembled,
      selectedMemories,
      metadata,
    };
  }
}
