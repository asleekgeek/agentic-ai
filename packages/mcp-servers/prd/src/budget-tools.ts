/**
 * Context-budget + retrieval-feedback tools.
 *
 * source: prd-spec-generator/packages/mcp-server/src/budget-tools.ts
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HardOutputRuleViolationSchema,
  type PRDContext,
} from "@agentic/prd-core";

/** Default context window size in tokens for budget calculation.
 *  source: documented Claude context window for Sonnet/Opus 4.x (model card 2026-01). */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000; // source: documented Claude context window for Sonnet/Opus 4.x (model card 2026-01)
import {
  calculateContextBudget,
  SECTION_RECALL_TEMPLATES,
} from "./context-budget.js";
import { mapFailuresToRetrievals } from "./failure-mapper.js";

export function registerBudgetTools(server: McpServer): void {
  server.tool(
    "coordinate_context_budget",
    "Calculate token budget allocation for PRD generation. Returns per-section retrieval limits for Cortex recall, generation budgets, and section-specific query templates. Call this BEFORE starting section generation.",
    {
      prd_context: z
        .enum(["proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd"])
        .describe("The PRD context type"),
      completed_sections: z
        .array(z.string())
        .default([])
        .describe("Section types already generated"),
      context_window_size: z
        .number()
        .int()
        .default(DEFAULT_CONTEXT_WINDOW_TOKENS)
        .describe("Total context window size in tokens"),
    },
    async ({ prd_context, completed_sections, context_window_size }) => {
      const budget = calculateContextBudget(
        prd_context as PRDContext,
        completed_sections,
        context_window_size,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { budget, recallTemplates: SECTION_RECALL_TEMPLATES },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "map_failure_to_retrieval",
    "When validate_prd_section returns violations, call this to get corrective Cortex recall queries. Closes the validation→retrieval feedback loop so retries use better context.",
    {
      violations: z
        .array(HardOutputRuleViolationSchema)
        .describe("Violations from validate_prd_section"),
    },
    async ({ violations }) => {
      const result = mapFailuresToRetrievals(violations);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
