#!/usr/bin/env node

/**
 * @agentic/mcp-server-prd — Composition root (full port).
 *
 * 15 tools: 5 diagnostics + 2 validation + 2 evidence + 6 pipeline/verification + 2 budget.
 *
 * source: prd-spec-generator/packages/mcp-server/src/index.ts (full port with
 *   @prd-gen/* imports replaced by @agentic/prd-* workspace packages).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRD_CONTEXT_CONFIGS,
  CAPABILITIES,
  STRATEGY_TIERS,
  SectionTypeSchema,
  type PRDContext,
} from "@agentic/prd-core";

import { tryCreateEvidenceRepository, type EvidenceRepository } from "@agentic/prd-core";
import { validateSection, validateDocument } from "@agentic/prd-validation";
import { registerBudgetTools } from "./budget-tools.js";
import { registerPipelineTools } from "./pipeline-tools.js";
import {
  checkReliabilityHealth,
  closeReliabilityRepo,
} from "./reliability-wiring.js";

export { getConsensusReliabilityProvider } from "./reliability-wiring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Domain Constants ────────────────────────────────────────────────────────

/** Maximum history records the evidence DB query accepts. Prevents runaway full-table scans. */
const QUALITY_HISTORY_MAX_LIMIT = 200; // source: arbitrary cap — well above any reasonable UI display limit
/** Default history record count. Balances response size vs utility. */
const QUALITY_HISTORY_DEFAULT_LIMIT = 20; // source: provisional heuristic — enough for trend analysis without large payload
/** Minimum strategy executions before including a strategy in performance report. */
const STRATEGY_MIN_EXECUTIONS_DEFAULT = 5; // source: provisional heuristic — 5 runs gives a non-trivial sample per strategy

// ─── Config Loading ──────────────────────────────────────────────────────────

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(__dirname, "..", "..", "..");

function loadSkillConfig(): Record<string, unknown> {
  const configPaths = [
    process.env.PRD_GEN_SKILL_CONFIG,
    join(PLUGIN_ROOT, "skill-config.json"),
    join(PLUGIN_ROOT, "packages", "skill", "skill-config.json"),
  ].filter(Boolean) as string[];

  for (const p of configPaths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }

  return { version: "2.0.0", status: "config_not_found" };
}

function loadSkillMd(): string {
  const skillPaths = [
    join(PLUGIN_ROOT, "skills", "prd-spec-generator", "SKILL.md"),
    join(PLUGIN_ROOT, "packages", "skill", "SKILL.md"),
  ];

  for (const p of skillPaths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  return "SKILL.md not found";
}

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "prd-gen",
  version: "0.1.0",
});

// Lazy-init evidence repository (only when better-sqlite3 is available).
let _evidenceRepo: EvidenceRepository | null | undefined = undefined;
function getEvidenceRepo(): EvidenceRepository | null {
  if (_evidenceRepo === undefined) {
    _evidenceRepo = tryCreateEvidenceRepository();
  }
  return _evidenceRepo;
}

// ─── Tool 1: get_config ──────────────────────────────────────────────────────

server.tool(
  "get_config",
  "Get the full skill configuration",
  {},
  async () => {
    const config = loadSkillConfig();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
    };
  },
);

// ─── Tool 2: read_skill_config ───────────────────────────────────────────────

server.tool(
  "read_skill_config",
  "Read the SKILL.md content that drives PRD generation",
  {},
  async () => {
    const skillMd = loadSkillMd();
    return {
      content: [{ type: "text" as const, text: skillMd }],
    };
  },
);

// ─── Tool 3: check_health ────────────────────────────────────────────────────

server.tool(
  "check_health",
  "Check system health — verify all components are accessible",
  {},
  async () => {
    const configAvailable = loadSkillConfig().version !== undefined;
    const skillAvailable = loadSkillMd() !== "SKILL.md not found";

    let dbHealthy = false;
    try {
      const repo = getEvidenceRepo();
      if (repo) {
        repo.getQualityHistory(1);
        dbHealthy = true;
      }
    } catch {
      dbHealthy = false;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "ok",
              configAvailable,
              skillAvailable,
              evidenceDbHealthy: dbHealthy,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 4: get_prd_context_info ────────────────────────────────────────────

server.tool(
  "get_prd_context_info",
  "Get configuration for a specific PRD context type",
  {
    context: z
      .enum([
        "proposal",
        "feature",
        "bug",
        "incident",
        "poc",
        "mvp",
        "release",
        "cicd",
      ])
      .describe("The PRD context type"),
  },
  async ({ context }) => {
    const config = PRD_CONTEXT_CONFIGS[context as PRDContext];
    return {
      content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
    };
  },
);

// ─── Tool 5: list_available_strategies ───────────────────────────────────────

server.tool(
  "list_available_strategies",
  "List thinking strategies available to the pipeline.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              strategies: CAPABILITIES.allowedStrategies,
              tiers: STRATEGY_TIERS,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 6: validate_prd_section ────────────────────────────────────────────

server.tool(
  "validate_prd_section",
  "Run deterministic Hard Output Rules validation on a single PRD section. Returns violations found — zero LLM calls, pure regex/parsing.",
  {
    content: z.string().describe("The markdown content of the PRD section"),
    section_type: SectionTypeSchema.describe(
      "The type of PRD section being validated",
    ),
  },
  async ({ content, section_type }) => {
    const report = validateSection(content, section_type);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(report, null, 2) },
      ],
    };
  },
);

// ─── Tool 7: validate_prd_document ───────────────────────────────────────────

server.tool(
  "validate_prd_document",
  "Run full document validation including cross-section checks (SP arithmetic, AC numbering, FR-AC coverage, test traceability). Returns comprehensive validation report.",
  {
    sections: z
      .array(
        z.object({
          type: SectionTypeSchema.describe("Section type"),
          content: z.string().describe("Section content"),
        }),
      )
      .describe("Array of PRD sections to validate"),
  },
  async ({ sections }) => {
    const report = validateDocument(sections);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(report, null, 2) },
      ],
    };
  },
);

// ─── Tool 8: get_quality_history ─────────────────────────────────────────────

server.tool(
  "get_quality_history",
  "Get historical PRD quality scores from the evidence repository",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(QUALITY_HISTORY_MAX_LIMIT)
      .default(QUALITY_HISTORY_DEFAULT_LIMIT)
      .describe("Maximum number of records to return"),
  },
  async ({ limit }) => {
    const repo = getEvidenceRepo();
    if (!repo) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Evidence repository unavailable (better-sqlite3 not loaded)",
            }),
          },
        ],
        isError: true,
      };
    }
    const history = repo.getQualityHistory(limit);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(history, null, 2) },
      ],
    };
  },
);

// ─── Tool 9: get_strategy_effectiveness ──────────────────────────────────────

server.tool(
  "get_strategy_effectiveness",
  "Get strategy performance data — actual vs expected improvement, compliance rate",
  {
    min_executions: z
      .number()
      .int()
      .min(1)
      .default(STRATEGY_MIN_EXECUTIONS_DEFAULT)
      .describe("Minimum executions required to include a strategy"),
  },
  async ({ min_executions }) => {
    const repo = getEvidenceRepo();
    if (!repo) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Evidence repository unavailable (better-sqlite3 not loaded)",
            }),
          },
        ],
        isError: true,
      };
    }
    const performance = repo.getStrategyPerformance(min_executions);
    const adjustments = repo.getHistoricalAdjustments(min_executions);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              performance,
              adjustments: Object.fromEntries(adjustments),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Budget + feedback tools (Tools 10–11) ───────────────────────────────────

registerBudgetTools(server);

// ─── Pipeline / verification tools (Tools 12–15) ────────────────────────────

registerPipelineTools(server);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // D2.6 — reliability DB health check at startup.
  // A failed health check is NOT fatal — consensus falls back to the Beta(7,3)
  // prior for all cells, preserving backward-compat.
  const reliabilityHealth = checkReliabilityHealth();
  if (!reliabilityHealth.healthy) {
    console.error(
      `[prd-gen] reliability.db health check FAILED: ${reliabilityHealth.message}`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});

// ─── Graceful shutdown — release DB connections ───────────────────────────────
process.on("SIGTERM", () => {
  closeReliabilityRepo();
  process.exit(0);
});
process.on("SIGINT", () => {
  closeReliabilityRepo();
  process.exit(0);
});
