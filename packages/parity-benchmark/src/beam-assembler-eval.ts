/**
 * beam-assembler-eval.ts — Stage-aware assembler evaluation for the BEAM benchmark.
 *
 * Single concern: compute current_stage for a question, call assembleContext(),
 * and return ranked candidates in the same format as flat recall() — so the
 * runner's hitRankFor/aggregation logic doesn't change.
 *
 * Extracted from pg-beam-runner.ts to keep that file under 500 lines
 * (coding-standards §4.1). The runner passes hitRankFor and AbilityMetric
 * via callbacks/params to avoid a circular import.
 *
 * source: Cortex benchmarks/beam/run_benchmark.py:53-189
 * source: Cortex mcp_server/core/context_assembly/stage_detector.py
 */

import { assembleContext } from "@agentic/memory/recall/context-assembly/assemble-context.js";
import {
  TemporalStageDetector,
  ExplicitStageDetector,
  type StageDetector,
} from "@agentic/memory/recall/context-assembly/stage-detector.js";
import type { PgStore } from "@agentic/memory/recall/pg-recall.js";
import type { toRecallEmbeddingEngine } from "@agentic/memory/infrastructure/transformers-embedding-engine.js";
import type { BeamMemory, BeamQuestion } from "./beam-loader.js";

// ── Assembler mode type ─────────────────────────────────────────────────────

/**
 * Assembler retrieval mode, mirroring CORTEX_STAGE_DETECTOR in the Python oracle.
 *
 * source: Cortex benchmarks/beam/run_benchmark.py:53-71 (_get_stage_detector)
 */
export type AssemblerMode = "temporal" | "oracle" | "off";

// ── Constants ───────────────────────────────────────────────────────────────

// Gap between calendar days above which TemporalStageDetector starts a new stage.
// source: Cortex benchmarks/beam/run_benchmark.py:65 — gap_hours=24.0
const TEMPORAL_GAP_HOURS = 24.0;

// Slice of day-buckets shown in the smoke diagnostic (display only).
// source: engineering display constant — no Python equivalent
const DIAG_BUCKET_DISPLAY_LIMIT = 5;

// ISO date string slice bounds: chars 0-10 produce "YYYY-MM-DD".
// source: Cortex stage_detector.py:118 — ts.date().isoformat()
const ISO_DATE_SLICE_END = 10;

// Hard cap on chunks per phase forwarded to assembleContext.
// source: Cortex benchmarks/lib/bench_db.py:149 — max_chunks_per_phase=5
const ASSEMBLER_MAX_CHUNKS_PER_PHASE = 5;

// Pass-through recall options, matching bench_db.py defaults.
// source: Cortex benchmarks/lib/bench_db.py:117-138
const MIN_HEAT = 0.01;
const RERANK_ALPHA = 0.7;
const WRRF_K = 60;

// ── Stage helpers ────────────────────────────────────────────────────────────

/**
 * Convert a time_anchor string to a "day-YYYY-MM-DD" bucket.
 *
 * Mirrors TemporalStageDetector.stage_of standalone path (stage_detector.py:114-118)
 * and _current_stage_for_question temporal branch (run_benchmark.py:107-111).
 * Supports ISO date strings (YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS) and
 * BEAM's "Month-DD-YYYY" format (e.g. "March-15-2024").
 *
 * source: Cortex mcp_server/core/context_assembly/stage_detector.py::_parse_ts
 * source: Cortex benchmarks/beam/run_benchmark.py:107-111 (f"day-{ts.date().isoformat()}")
 */
export function anchorToDayBucket(anchor: string): string {
  if (!anchor) return "day-unknown";

  // Try ISO date/datetime (most common in BEAM exported JSON).
  const isoMatch = anchor.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch?.[1]) return `day-${isoMatch[1]}`;

  // Try "Month-DD-YYYY" format (BEAM raw time_anchor).
  // source: Cortex stage_detector.py:157-172
  const monthDayYear = anchor.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/);
  if (monthDayYear) {
    const [, monthName, day, year] = monthDayYear;
    const d = new Date(`${monthName ?? ""} ${day ?? ""}, ${year ?? ""}`);
    if (!isNaN(d.getTime())) {
      return `day-${d.toISOString().slice(0, ISO_DATE_SLICE_END)}`;
    }
  }

  return `day-${anchor}`;
}

/**
 * Derive the question's current_stage for the temporal assembler mode.
 *
 * Mirrors Python _current_stage_for_question temporal branch
 * (run_benchmark.py:74-123). TS adaptation: the raw turn ids are not preserved
 * in BeamConversation. We find the memory whose content matches the question's
 * source_prefixes, take its created_at → day-bucket. If no match, fall back to
 * the last memory's created_at (mirrors Python's last_anchor fallback).
 *
 * source: Cortex benchmarks/beam/run_benchmark.py:74-123
 * source: Cortex mcp_server/core/context_assembly/stage_detector.py::TemporalStageDetector.stage_of
 */
export function currentStageForTemporal(
  question: BeamQuestion,
  memories: readonly BeamMemory[],
): string {
  let lastAnchor = "";
  for (const m of memories) {
    if (m.created_at) lastAnchor = m.created_at;
    const contentLower = m.content.toLowerCase();
    for (const prefix of question.source_prefixes) {
      if (prefix && contentLower.includes(prefix)) {
        return anchorToDayBucket(m.created_at || lastAnchor);
      }
    }
  }
  return anchorToDayBucket(lastAnchor); // source: run_benchmark.py:115-123
}

/**
 * Derive current_stage for oracle mode.
 *
 * Oracle uses plan_id prefixed with "beam:" (run_benchmark.py:179-181).
 * Falls back to the memory's created_at day-bucket when plan_id is absent.
 *
 * source: Cortex benchmarks/beam/run_benchmark.py:113-114, 179-181
 */
export function currentStageForOracle(
  question: BeamQuestion,
  memories: readonly BeamMemory[],
): string {
  let lastPlan = "";
  let lastAnchor = "";
  for (const m of memories) {
    if (m.created_at) lastAnchor = m.created_at;
    if (m.plan_id) lastPlan = m.plan_id;
    const contentLower = m.content.toLowerCase();
    for (const prefix of question.source_prefixes) {
      if (prefix && contentLower.includes(prefix)) {
        const plan = m.plan_id || lastPlan;
        return plan ? `beam:${plan}` : lastAnchor;
      }
    }
  }
  return lastPlan ? `beam:${lastPlan}` : lastAnchor;
}

// ── Assembler candidates retrieval ───────────────────────────────────────────

/** Candidate shape returned by assembleContext, reshaped for hitRankFor. */
export type AssemblerCandidate = { content?: string; score: number };

/**
 * Run the stage-aware assembler for one question and return candidates
 * in the same shape as flat recall() — so hitRankFor() is reused unchanged.
 *
 * precondition: store is connected; question is non-abstention or abstention.
 * postcondition: returns candidates ordered by selection phase (Phase 1 then 2);
 *   the returned list has the same interface as recall() candidates so scoring
 *   logic in the runner is unchanged.
 *
 * source: Cortex benchmarks/beam/run_benchmark.py:166-189 (CORTEX_USE_ASSEMBLER=1 branch)
 */
export async function assemblerCandidatesFor(
  question: BeamQuestion,
  memories: readonly BeamMemory[],
  pgStore: PgStore,
  recallEmbedder: ReturnType<typeof toRecallEmbeddingEngine> | null,
  assemblerMode: AssemblerMode,
  seenDayBuckets: Set<string>,
): Promise<AssemblerCandidate[]> {
  const detector: StageDetector =
    assemblerMode === "temporal"
      ? new TemporalStageDetector(
          TEMPORAL_GAP_HOURS, // source: run_benchmark.py:65 — gap_hours=24.0
          "created_at",
        )
      : new ExplicitStageDetector("agent_context");

  const currentStage =
    assemblerMode === "temporal"
      ? currentStageForTemporal(question, memories)
      : currentStageForOracle(question, memories);

  if (assemblerMode === "temporal") seenDayBuckets.add(currentStage);

  // source: run_benchmark.py:170-188 — token_budget=None (pure rank-based)
  const result = await assembleContext(
    question.question,
    pgStore,
    recallEmbedder,
    currentStage,
    {
      stageDetector: detector,
      tokenBudget: undefined, // source: run_benchmark.py:171 — token_budget=None
      domain: "beam",
      stageField: "agent_context", // source: run_benchmark.py:187
      maxChunksPerPhase: ASSEMBLER_MAX_CHUNKS_PER_PHASE,
      recallOptions: {
        minHeat: MIN_HEAT,
        rerank: true,
        rerankAlpha: RERANK_ALPHA,
        wrrfK: WRRF_K,
        includeGlobals: false,
      },
    },
  );

  // Reshape selected_memories to the same interface as recall() candidates.
  // source: run_benchmark.py:189 — retrieved = asm["selected_memories"]
  return result.selectedMemories.map((m) => ({
    content: m.content,
    score: m.score,
  }));
}

/**
 * Emit the temporal stage detection diagnostic to stderr.
 * Called after all conversations complete when assemblerMode="temporal".
 */
export function emitTemporalDiagnostic(seenDayBuckets: Set<string>): void {
  if (seenDayBuckets.size === 0) return;
  process.stderr.write(
    `  [assembler=temporal] distinct day-buckets: ${seenDayBuckets.size} ` +
      `(${[...seenDayBuckets]
        .sort()
        .slice(0, DIAG_BUCKET_DISPLAY_LIMIT)
        .join(", ")}${seenDayBuckets.size > DIAG_BUCKET_DISPLAY_LIMIT ? " …" : ""})\n`,
  );
}
