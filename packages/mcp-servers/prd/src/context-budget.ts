import { type PRDContext, type SectionType } from "@agentic/prd-core";
import {
  SECTIONS_BY_CONTEXT,
  SECTION_RECALL_TEMPLATES as ORCHESTRATION_RECALL_TEMPLATES,
} from "@agentic/prd-orchestration";

/**
 * Context budget coordinator — Beer's missing S2.
 *
 * Prevents token oscillation between Cortex retrieval and PRD generation.
 * Takes PRD context type + current pipeline state, returns token allocations
 * per phase so Claude knows how many results to request from Cortex.
 *
 * source: prd-spec-generator/packages/mcp-server/src/context-budget.ts
 * source: provisional heuristics documented in the original file (2026-Q1).
 */

// ─── Section Token Requirements ──────────────────────────────────────────────

/**
 * Estimated token requirements per section type for generation.
 *
 * source: provisional heuristic — initial values derived from a single
 * production PRD (SnippetLibraryCRUD, 2026-Q1) by counting tokens in the
 * generated section. Phase 4.5 will recalibrate from a corpus of K≥30 real
 * PRD outputs to set per-section P95.
 */
const SECTION_GENERATION_TOKENS: Partial<Record<SectionType, number>> = {
  overview: 1500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  goals: 1000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  requirements: 3000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  user_stories: 4000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  technical_specification: 5000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  acceptance_criteria: 2500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  data_model: 2000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  api_specification: 2500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  security_considerations: 1500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  performance_requirements: 1500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  testing: 4000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  deployment: 2000, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  risks: 1500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
  timeline: 2500, // source: provisional heuristic, prd-spec-generator context-budget.ts 2026-Q1
};

/**
 * Retrieval relevance weight per section type.
 *
 * source: provisional heuristic — assigned by hand (2026-Q1) from structural
 * reasoning about which sections cite code vs which are stakeholder-facing prose.
 */
const SECTION_RETRIEVAL_WEIGHT: Partial<Record<SectionType, number>> = {
  overview: 0.2,
  goals: 0.3,
  requirements: 0.6,
  user_stories: 0.5,
  technical_specification: 1.0,
  acceptance_criteria: 0.5,
  data_model: 0.9,
  api_specification: 0.8,
  security_considerations: 0.7,
  performance_requirements: 0.6,
  testing: 0.8,
  deployment: 0.5,
  risks: 0.4,
  timeline: 0.3,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextBudgetAllocation {
  totalBudget: number;
  sections: SectionBudget[];
  cortexRecall: {
    maxResultsPerSection: Record<string, number>;
    tokensPerMemory: number;
    totalRetrievalBudget: number;
  };
  generationBudget: number;
  validationReserve: number;
  overheadEstimate: number;
}

export interface SectionBudget {
  sectionType: string;
  retrievalTokens: number;
  generationTokens: number;
  cortexMaxResults: number;
}

// ─── Budget Calculation ──────────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 200_000; // source: documented Claude context window for Sonnet/Opus 4.x (model card 2026-01)
const SKILL_MD_OVERHEAD = 35_000; // source: provisional heuristic — SKILL.md ~103K chars at ~3 chars/token ≈ 35K tokens (2026-Q1)
const CONVERSATION_OVERHEAD = 5_000; // source: provisional heuristic — 8–10 clarification rounds × ~500 tokens/round (2026-Q1)
const VALIDATION_RESERVE_RATIO = 0.10; // source: provisional heuristic — 10% reserve covers ≤3 retries at MAX_ATTEMPTS=3 (prd-spec-generator 2026-Q1)
const TOKENS_PER_CORTEX_MEMORY = 500; // source: provisional heuristic — observed average Cortex memory record size in tokens (2026-04)
const RETRIEVAL_BUDGET_RATIO = 0.40; // source: Cortex paper 60/30/10 split adapted for PRD generation (prd-spec-generator 2026-Q1)
const GENERATION_BUDGET_RATIO = 0.50; // source: Cortex paper 60/30/10 split adapted for PRD generation (prd-spec-generator 2026-Q1)
const UNKNOWN_SECTION_WEIGHT = 0.5; // source: provisional heuristic — mid-range default for uncalibrated section types (2026-Q1)
const UNKNOWN_SECTION_GEN_TOKENS = 2000; // source: provisional heuristic — median of SECTION_GENERATION_TOKENS values (2026-Q1)

export function calculateContextBudget(
  prdContext: PRDContext,
  completedSections: string[] = [],
  contextWindowSize: number = DEFAULT_CONTEXT_WINDOW,
): ContextBudgetAllocation {
  const overheadEstimate = SKILL_MD_OVERHEAD + CONVERSATION_OVERHEAD;
  const validationReserve = Math.floor(contextWindowSize * VALIDATION_RESERVE_RATIO);
  const totalBudget = contextWindowSize - overheadEstimate - validationReserve;

  const completedSet = new Set(completedSections);
  const plannedSections = SECTIONS_BY_CONTEXT[prdContext];
  const remainingSections = plannedSections.filter((s) => !completedSet.has(s));

  const retrievalBudget = Math.floor(totalBudget * RETRIEVAL_BUDGET_RATIO);
  const generationBudget = Math.floor(totalBudget * GENERATION_BUDGET_RATIO);

  const totalWeight = remainingSections.reduce(
    (sum, s) => sum + (SECTION_RETRIEVAL_WEIGHT[s] ?? UNKNOWN_SECTION_WEIGHT),
    0,
  );

  const sections: SectionBudget[] = remainingSections.map((sectionType) => {
    const weight = SECTION_RETRIEVAL_WEIGHT[sectionType] ?? UNKNOWN_SECTION_WEIGHT;
    const genTokens =
      SECTION_GENERATION_TOKENS[sectionType] ?? UNKNOWN_SECTION_GEN_TOKENS;
    const retrievalTokens =
      totalWeight > 0
        ? Math.floor(retrievalBudget * (weight / totalWeight))
        : 0;
    const cortexMaxResults = Math.max(
      1,
      Math.floor(retrievalTokens / TOKENS_PER_CORTEX_MEMORY),
    );

    return {
      sectionType,
      retrievalTokens,
      generationTokens: genTokens,
      cortexMaxResults,
    };
  });

  const maxResultsPerSection: Record<string, number> = {};
  for (const s of sections) {
    maxResultsPerSection[s.sectionType] = s.cortexMaxResults;
  }

  return {
    totalBudget,
    sections,
    cortexRecall: {
      maxResultsPerSection,
      tokensPerMemory: TOKENS_PER_CORTEX_MEMORY,
      totalRetrievalBudget: retrievalBudget,
    },
    generationBudget,
    validationReserve,
    overheadEstimate,
  };
}

// ─── Section-Specific Cortex Query Templates ─────────────────────────────────

/**
 * Single source of truth: @agentic/prd-orchestration owns the canonical templates.
 * Re-exported here so the host can pre-fetch using the SAME templates the
 * orchestrator will later use, preventing host/orchestrator divergence.
 *
 * source: prd-spec-generator/packages/mcp-server/src/context-budget.ts
 */
export const SECTION_RECALL_TEMPLATES: Record<SectionType, string> =
  ORCHESTRATION_RECALL_TEMPLATES;
