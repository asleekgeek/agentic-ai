/**
 * Pipeline-tool registration — orchestrator + verification.
 *
 * Tools:
 *   start_pipeline          — initialize a pipeline run, return first NextAction
 *   submit_action_result    — feed an ActionResult to the reducer, return next action
 *   get_pipeline_state      — read current state by run_id
 *   plan_section_verification   — emit JudgeRequest[] for a section
 *   plan_document_verification  — emit JudgeRequest[] across all sections
 *   conclude_verification       — aggregate JudgeVerdict[] → VerificationReport
 *
 * source: prd-spec-generator/packages/mcp-server/src/pipeline-tools.ts
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  newPipelineState,
  step,
  InMemoryRunStore,
  ActionResultSchema,
  type PipelineState,
} from "@agentic/prd-orchestration";
import {
  planSectionVerification,
  planDocumentVerification,
  concludeSection,
  concludeDocument,
} from "@agentic/prd-verification";
import {
  SectionTypeSchema,
  JudgeVerdictSchema,
  ClaimSchema,
  ExternalGroundingTypeSchema,
  tryCreateEvidenceRepository,
  type EvidenceRepository,
  type Claim,
} from "@agentic/prd-core";
import { EffectivenessTracker } from "@agentic/prd-strategy";
import {
  getRetryArmForRun,
  getMaxAttemptsForRun,
  MAX_ATTEMPTS_BASELINE,
} from "@agentic/prd-benchmark";
import { buildConcludeOpts } from "./build-conclude-opts.js";

const runStore = new InMemoryRunStore();

/**
 * Lazy EvidenceRepository + EffectivenessTracker.
 * source: Phase 4 strategy-wiring (2026-04).
 */
let _repo: EvidenceRepository | null | undefined = undefined;
let _tracker: EffectivenessTracker | null = null;
function getTracker(): EffectivenessTracker | null {
  if (_repo === undefined) {
    _repo = tryCreateEvidenceRepository();
    if (_repo) _tracker = new EffectivenessTracker(_repo);
  }
  return _tracker;
}

/**
 * Drain `state.strategy_executions` and forward each entry to the
 * EvidenceRepository. Returns the state with the queue cleared.
 *
 * The drain ALWAYS clears the queue, even when no repository is wired —
 * the queue would otherwise grow unbounded across pipeline runs.
 */
function drainStrategyExecutions(state: PipelineState): PipelineState {
  if (state.strategy_executions.length === 0) return state;
  const tracker = getTracker();
  if (tracker) {
    for (const exec of state.strategy_executions) {
      try {
        tracker.recordExecution({ ...exec, sessionId: state.run_id });
      } catch {
        // Best-effort; persistence failure must not break the pipeline.
      }
    }
  }
  return { ...state, strategy_executions: [] };
}

/**
 * Per-run_id in-flight guard for submit_action_result.
 * source: pipeline-tools.ts — defense-in-depth concurrency guard.
 */
const inFlight = new Set<string>();

const RUN_ID_RADIX = 36; // source: base-36 (alphanumeric) gives compact IDs — standard Node.js idiom
const RUN_ID_RANDOM_START = 2; // source: slice(2) removes "0." prefix from Math.random().toString(36)
const RUN_ID_RANDOM_END = 8; // source: 6 chars of base-36 randomness = ~1.6B permutations, sufficient for in-process uniqueness

function generateRunId(): string {
  return (
    "run_" +
    Date.now().toString(RUN_ID_RADIX) +
    "_" +
    Math.random().toString(RUN_ID_RADIX).slice(RUN_ID_RANDOM_START, RUN_ID_RANDOM_END)
  );
}

interface PipelineEnvelope {
  run_id: string;
  current_step: string;
  messages: ReadonlyArray<{ text: string; level: "info" | "warn" | "error" }>;
  action: unknown;
  state_summary: {
    sections: Array<{ section_type: string; status: string; attempt: number; violation_count: number }>;
    clarification_rounds: number;
    errors: number;
  };
}

function envelope(
  state: PipelineState,
  action: unknown,
  messages: ReadonlyArray<{ text: string; level: "info" | "warn" | "error" }> = [],
): PipelineEnvelope {
  return {
    run_id: state.run_id,
    current_step: state.current_step,
    messages,
    action,
    state_summary: {
      sections: state.sections.map((s) => ({
        section_type: s.section_type,
        status: s.status,
        attempt: s.attempt,
        violation_count: s.violation_count,
      })),
      clarification_rounds: state.clarifications.length,
      errors: state.errors.length,
    },
  };
}

export function registerPipelineTools(server: McpServer): void {
  // ─── start_pipeline ─────────────────────────────────────────────────────

  server.tool(
    "start_pipeline",
    "Initialize a new PRD pipeline run. Returns run_id and the first NextAction the host must execute.",
    {
      feature_description: z
        .string()
        .describe("What the PRD is about — passed to all prompts"),
      codebase_path: z
        .string()
        .optional()
        .describe("Absolute path to the codebase. Triggers index_codebase via automatised-pipeline."),
      skip_preflight: z
        .boolean()
        .optional()
        .describe(
          "If true, skip the preflight step that probes Cortex (and ai-architect when codebase_path is set). Default false. Use only when you accept degraded section generation without persistent memory recall.",
        ),
    },
    async ({ feature_description, codebase_path, skip_preflight }) => {
      const run_id = generateRunId();
      const initial = newPipelineState({
        run_id,
        feature_description,
        codebase_path: codebase_path ?? null,
        skip_preflight: skip_preflight ?? false,
      });

      // B1 — Wire retry_policy from composition root (Curie A7).
      // source: Curie cross-audit Wave D, A7 anomaly resolution.
      const arm = getRetryArmForRun(run_id);
      const maxAttempts = getMaxAttemptsForRun(run_id, MAX_ATTEMPTS_BASELINE);
      // arm is captured above to keep the seam call visible at the composition
      // root; the value itself flows via maxAttempts into retry_policy.
      void arm;
      const initialWithPolicy =
        initial.retry_policy !== null
          ? initial
          : { ...initial, retry_policy: { maxAttempts, arm: getRetryArmForRun(run_id) } };

      const { state, action, messages } = step({ state: initialWithPolicy });
      const drained = drainStrategyExecutions(state);
      runStore.set(drained);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(envelope(drained, action, messages), null, 2),
          },
        ],
      };
    },
  );

  // ─── submit_action_result ──────────────────────────────────────────────────

  server.tool(
    "submit_action_result",
    "Feed an ActionResult to the pipeline runner; receive the next NextAction.",
    {
      run_id: z.string(),
      result: ActionResultSchema,
    },
    async ({ run_id, result }) => {
      if (inFlight.has(run_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `concurrent submission rejected for run_id ${run_id}`,
              }),
            },
          ],
          isError: true,
        };
      }
      inFlight.add(run_id);
      try {
        const current = runStore.get(run_id);
        if (!current) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `unknown run_id: ${run_id}` }),
              },
            ],
            isError: true,
          };
        }
        const out = step({ state: current, result });
        const drained = drainStrategyExecutions(out.state);
        runStore.set(drained);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                envelope(drained, out.action, out.messages),
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        inFlight.delete(run_id);
      }
    },
  );

  // ─── get_pipeline_state ─────────────────────────────────────────────────

  server.tool(
    "get_pipeline_state",
    "Read the current pipeline state by run_id.",
    {
      run_id: z.string(),
      format: z.enum(["full", "summary"]).default("summary"),
    },
    async ({ run_id, format }) => {
      const state = runStore.get(run_id);
      if (!state) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `unknown run_id: ${run_id}` }),
            },
          ],
          isError: true,
        };
      }
      const body =
        format === "full"
          ? JSON.stringify(state, null, 2)
          : JSON.stringify(envelope(state, null), null, 2);
      return { content: [{ type: "text" as const, text: body }] };
    },
  );

  // ─── plan_section_verification ─────────────────────────────────────────────

  server.tool(
    "plan_section_verification",
    "Extract claims from a PRD section and select judges. Returns JudgeRequest[] the host must execute via Agent tool in parallel.",
    {
      section_type: SectionTypeSchema,
      content: z.string(),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
    },
    async ({ section_type, content, codebase_excerpts, memory_excerpts }) => {
      const plan = planSectionVerification(section_type, content, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    },
  );

  // ─── plan_document_verification ────────────────────────────────────────────

  server.tool(
    "plan_document_verification",
    "Same as plan_section_verification but across all sections of a document.",
    {
      sections: z
        .array(
          z.object({
            type: SectionTypeSchema,
            content: z.string(),
          }),
        )
        .min(1),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
    },
    async ({ sections, codebase_excerpts, memory_excerpts }) => {
      const plan = planDocumentVerification(sections, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    },
  );

  // ─── conclude_verification ─────────────────────────────────────────────────

  server.tool(
    "conclude_verification",
    "Aggregate JudgeVerdict[] from spawned subagents into a VerificationReport (consensus + dissent). " +
    "IMPORTANT: omitting claim_types when a reliability repository is open suppresses observation flushing " +
    "for this batch — the calibration data will be missing for these runs (one-sided censoring).",
    {
      scope: z.enum(["section", "document"]).default("section"),
      section_type: SectionTypeSchema.optional(),
      verdicts: z.array(JudgeVerdictSchema),
      consensus_strategy: z
        .enum(["weighted_average", "bayesian"])
        .default("weighted_average"),
      run_id: z
        .string()
        .optional()
        .describe(
          "Pipeline run_id — required for calibrated Bayesian reliability weights. " +
          "When absent, falls back to Beta(7,3) prior for all judges.",
        ),
      claim_types: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Map of claim_id → claim_type. When provided, enables per-(judge × claim_type) " +
          "reliability lookup. Omit to fall back to per-agent scalar priors.",
        ),
      claims: z
        .array(
          z.object({
            claim_id: z.string(),
            claim_type: ClaimSchema.shape.claim_type,
            text: z.string().optional().default(""),
            evidence: z.string().optional().default(""),
            source_section: z.string().optional(),
            external_grounding: z
              .object({
                type: ExternalGroundingTypeSchema,
                payload: z.unknown(),
              })
              .optional(),
          }),
        )
        .optional()
        .describe(
          "OPTIONAL. Pass Claim objects from the corresponding plan_section_verification " +
          "/ plan_document_verification response for oracle-based ground truth.",
        ),
    },
    async ({ scope, section_type, verdicts, consensus_strategy, run_id, claim_types, claims }) => {
      let claimsMap: ReadonlyMap<string, Claim> | undefined;
      if (claims !== undefined && claims.length > 0) {
        const map = new Map<string, Claim>();
        for (const raw of claims) {
          const parsed = ClaimSchema.safeParse({
            ...raw,
            text: raw.text ?? "",
            evidence: raw.evidence ?? "",
          });
          if (parsed.success) {
            map.set(parsed.data.claim_id, parsed.data);
          }
        }
        if (map.size > 0) claimsMap = map;
      }

      const concludeOpts = buildConcludeOpts({ consensus_strategy, run_id, claim_types, claims: claimsMap });

      const report =
        scope === "document"
          ? concludeDocument(verdicts, concludeOpts)
          : concludeSection(section_type ?? "overview", verdicts, concludeOpts);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );
}
