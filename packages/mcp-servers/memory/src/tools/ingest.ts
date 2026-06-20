/**
 * ingest.ts — MCP tool adapters for the upstream ingest topic.
 *
 * Tools registered (5):
 *   import_sessions, codebase_analyze, ingest_codebase, ingest_prd,
 *   change_impact
 *
 * Phase 7 Group D — DI wiring:
 *   - import_sessions: calls real importHandler from @agentic/memory/import.
 *   - codebase_analyze: calls real codebaseAnalyzeHandler.
 *   - ingest_codebase: calls real ingestCodebaseHandler.
 *   - ingest_prd: calls real ingestPrdHandler.
 *   - change_impact: throws MissingStoreError — blocked on AP codebase graph.
 *     source: docs/ADR/0046-change-impact-analysis.md §Phase 3 (not landed)
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md
 *         §UpstreamIngest, §Tier1Memory (import_sessions)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { codebaseAnalysis } from "@agentic/memory";
import { changeImpactHandler } from "@agentic/memory/codebase-analysis/handlers/change-impact.js";
import { importHandler } from "@agentic/memory/import/handler.js";
import { rememberAsync } from "@agentic/memory/remember/handlers/remember.js";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";

// ── Schema constants ──────────────────────────────────────────────────────────
// source: MCP_TOOLS.md §ingest_codebase, §codebase_analyze
// source: cortex tool_registry_memory.py:261 tool_import_sessions(min_importance: float = 0.4); handler import_sessions.py:306 default 0.4
const MIN_IMPORTANCE_DEFAULT = 0.4;
const TOP_SYMBOLS_DEFAULT    = 50;
const TOP_PROCESSES_DEFAULT  = 10;
// source: cortex@2f42428 mcp_server/handlers/codebase_analyze.py — max_files semantics
// Cortex 2026-05-12 fix(#25): 0 (default) means "no limit — process every matching
// file in the tree". Positive values cap the walk via _collectBounded (preserves
// ADR-0045 §R2 streaming). The previous default of 500 truncated real codebases
// at the cap; ai-architect-prd-builder and ai-prd hit 5000 exactly during full-
// scale bootstrap, silently dropping files from the knowledge graph.
const MAX_FILES_DEFAULT        = 0; // source: cortex@2f42428 codebase_analyze.py:96 — default 0 = unbounded
const MAX_FILE_SIZE_KB_DEFAULT = 100;   // source: cortex codebase_analyze.py — max_file_size_kb default
const MAX_FILE_SIZE_KB_MAX     = 4096;  // source: standard 4MB upper bound (also in EXEMPT_PATTERN)

// ── Composition-root deps shape ───────────────────────────────────────────────

export interface IngestDeps {
  store:         codebaseAnalysis.IngestCodebaseDeps["store"];
  wikiRoot:      string;
  mcpClientPool: codebaseAnalysis.McpClientPool | null;
}

// ── MissingStoreError ─────────────────────────────────────────────────────────
// Thrown when a tool handler is called without a live IngestDeps.store injected.

class MissingStoreError extends Error {
  constructor(handlerName: string, blocker: string) {
    super(`${handlerName} requires ${blocker}.`);
    this.name = "MissingStoreError";
  }
}

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── registerIngestTools ───────────────────────────────────────────────────────

/**
 * Registers ingest and import MCP tools.
 *
 * precondition:  deps is provided with a live store and wikiRoot.
 * postcondition: 5 tools registered; import_sessions/codebase_analyze/
 *   ingest_codebase/ingest_prd/change_impact call real handlers.
 *
 * source: MCP_TOOLS.md §"import_sessions", §"codebase_analyze",
 *         §"ingest_codebase", §"ingest_prd", §"change_impact"
 */
export function registerIngestTools(server: McpServer, deps?: IngestDeps): void {
  // ── import_sessions ───────────────────────────────────────────────────────
  server.registerTool(
    "import_sessions",
    {
      description:
        "Import Claude Code JSONL conversation history into the memory store (full-bounded 4 MB read, per ADR-0045 R2 intent).", // source: docs/ADR/0045-bounded-streaming-ingestion.md; readFullBounded replaces readHeadTail for content extraction
      inputSchema: {
        project:        z.string().default("").describe("Project identifier"),
        domain:         z.string().default("").describe("Domain to assign"),
        // source: MCP_TOOLS.md §import_sessions default min_importance=0.4
        min_importance: z.number().min(0).max(1).default(MIN_IMPORTANCE_DEFAULT).describe("Min importance threshold"),
        max_sessions:   z.number().int().min(0).default(0).describe("Max sessions (0 = all)"),
        dry_run:        z.boolean().default(false).describe("Preview without storing"),
      },
    },
    async (args) => {
      try {
        if (!deps) {
          throw new MissingStoreError("import_sessions", "IngestDeps.store — no store injected");
        }
        // source: packages/memory/src/import/handler.ts::importHandler
        // Fix: use rememberAsync so PgMemoryStore.insertMemoryAsync is called instead
        // of the sync insertMemory() which throws on PG. Root-cause: ADR-0042.
        // source: engineer@41e5778 — *Async-when-available pattern for PG/SQLite parity.
        const store = deps.store as unknown as MemoryStoreExt;
        const rememberFn = async (rawArgs: unknown): Promise<{ stored: true } | null> => {
          const result = await rememberAsync(rawArgs, store);
          return result.stored ? { stored: true as const } : null;
        };
        const response = await importHandler(
          {
            project:        args.project,
            domain:         args.domain,
            min_importance: args.min_importance,
            max_sessions:   args.max_sessions,
            dry_run:        args.dry_run,
          },
          rememberFn,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({
          imported:           response.imported,
          skipped:            response.skipped,
          sessions_processed: response.sessions_scanned,
          dry_run:            args.dry_run,
        }) }] };
      } catch (err) {
        return errorText("import_sessions", err);
      }
    },
  );

  // ── codebase_analyze ──────────────────────────────────────────────────────
  server.registerTool(
    "codebase_analyze",
    {
      description: "Walk a codebase and store its structure as memories using AST parsing with regex fallback.",
      inputSchema: {
        directory:        z.string().optional().describe("Root directory to analyze"),
        languages:        z.array(z.string()).optional().describe("Restrict to specific languages"),
        // source: cortex@2f42428 mcp_server/handlers/codebase_analyze.py — max_files semantics
        // 0 (default) = no limit. Positive values cap the walk.
        max_files:        z.number().int().min(0).default(MAX_FILES_DEFAULT).describe("Max files to process (0 = no limit)"),
        // source: cortex@ed33435 mcp_server/handlers/codebase_analyze.py — default max_file_size_kb
        max_file_size_kb: z.number().int().min(1).max(MAX_FILE_SIZE_KB_MAX).default(MAX_FILE_SIZE_KB_DEFAULT).describe("Skip files larger than this KB"),
        incremental:      z.boolean().default(true).describe("Only reprocess changed files"),
        dry_run:          z.boolean().default(false).describe("Report without writing"),
        domain:           z.string().optional().describe("Cognitive domain tag"),
      },
    },
    async (args) => {
      try {
        if (!deps) {
          throw new MissingStoreError("codebase_analyze", "IngestDeps.store — no store injected");
        }
        const analyzeDeps: codebaseAnalysis.CodebaseAnalyzeDeps = { store: deps.store };
        const result = await codebaseAnalysis.codebaseAnalyzeHandler(args as Record<string, unknown>, analyzeDeps);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return errorText("codebase_analyze", err);
      }
    },
  );

  // ── ingest_codebase ───────────────────────────────────────────────────────
  server.registerTool(
    "ingest_codebase",
    {
      description: "Ingest upstream codebase analysis from ai-automatised-pipeline into Cortex.",
      inputSchema: {
        project_path:  z.string().min(1).describe("Path to the codebase"),
        output_dir:    z.string().optional().describe("Output directory for analysis artifacts"),
        language:      z.string().default("auto").describe("Language hint (auto = detect)"),
        force_reindex: z.boolean().default(false).describe("Force reindex even if cached"),
        // source: MCP_TOOLS.md §ingest_codebase default top_symbols=50
        top_symbols:   z.number().int().min(1).default(TOP_SYMBOLS_DEFAULT).describe("Top symbols to extract"),
        // source: MCP_TOOLS.md §ingest_codebase default top_processes=10
        top_processes: z.number().int().min(1).default(TOP_PROCESSES_DEFAULT).describe("Top processes to extract"),
      },
    },
    async (args) => {
      try {
        if (!deps) {
          throw new MissingStoreError("ingest_codebase", "IngestDeps.store — no store injected");
        }

        // When mcpClientPool is null (the codebase MCP plugin is not running),
        // fall back to the local codebase_analyze path which does not require
        // an upstream MCP connection. This provides a usable result instead of
        // the previous "upstream_mcp_unreachable" error.
        //
        // source: cortex@ed33435 mcp_server/handlers/ingest_codebase.py — the
        //   upstream call is optional; a local AST scan is equivalent for most
        //   use cases. The Kuzu graph is only needed for cross-file call edges.
        // source: ADR-0042 — graceful-degradation principle for optional deps.
        if (deps.mcpClientPool === null) {
          process.stderr.write(
            "[ingest_codebase] mcpClientPool is null — falling back to local codebase_analyze.\n" +
            "  To enable full cross-file call-graph ingestion, start the codebase MCP plugin\n" +
            "  and wire McpClientPool at the composition root.\n",
          );
          const analyzeDeps: codebaseAnalysis.CodebaseAnalyzeDeps = { store: deps.store };
          const analyzeResult = await codebaseAnalysis.codebaseAnalyzeHandler(
            {
              directory:        args.project_path,
              max_files:        MAX_FILES_DEFAULT,
              max_file_size_kb: MAX_FILE_SIZE_KB_DEFAULT,
              incremental:      !args.force_reindex,
              dry_run:          false,
              domain:           `code:${String(args.project_path).split("/").pop() ?? "unknown"}`,
            },
            analyzeDeps,
          );
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ingested:          true,
            fallback:          "local_codebase_analyze",
            note:              "Used local AST scan (no MCP pool). Start codebase plugin for full call-graph.",
            ...analyzeResult,
          }) }] };
        }

        const ingestDeps: codebaseAnalysis.IngestCodebaseDeps = {
          store:         deps.store,
          wikiRoot:      deps.wikiRoot,
          mcpClientPool: deps.mcpClientPool,
        };
        const result = await codebaseAnalysis.ingestCodebaseHandler(args as Record<string, unknown>, ingestDeps);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        process.stderr.write(`[ingest_codebase] error: ${err instanceof Error ? err.message : String(err)}\n`);
        return errorText("ingest_codebase", err);
      }
    },
  );

  // ── ingest_prd ────────────────────────────────────────────────────────────
  server.registerTool(
    "ingest_prd",
    {
      description: "Ingest a PRD document into Cortex (from path or content string).",
      inputSchema: {
        path:        z.string().optional().describe("Path to PRD file"),
        content:     z.string().optional().describe("PRD content string"),
        pipeline_id: z.string().optional().describe("Pipeline run ID"),
        title:       z.string().optional().describe("PRD title"),
        validate:    z.boolean().default(false).describe("Validate PRD structure"),
        domain:      z.string().optional().describe("Domain to assign"),
      },
    },
    async (args) => {
      try {
        if (!deps) {
          throw new MissingStoreError("ingest_prd", "IngestDeps.store — no store injected");
        }
        const prdDeps: codebaseAnalysis.IngestPrdDeps = {
          store:         deps.store,
          wikiRoot:      deps.wikiRoot,
          mcpClientPool: deps.mcpClientPool,
        };
        const result = await codebaseAnalysis.ingestPrdHandler(args as Record<string, unknown>, prdDeps);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return errorText("ingest_prd", err);
      }
    },
  );

  // ── change_impact ─────────────────────────────────────────────────────────
  server.registerTool(
    "change_impact",
    {
      description: "Report memories affected by a commit's code changes (ADR-0046 P4).", // source: docs/ADR/0046-change-impact-analysis.md
      inputSchema: {
        base:            z.string().default("HEAD~1").describe("Base git ref"),
        head:            z.string().default("HEAD").describe("Head git ref"),
        expand_impact:   z.boolean().default(false).describe("Expand to transitive impacts"),
        apply_heat_bump: z.boolean().default(false).describe("Apply heat bump to affected memories"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/change_impact.py::handler
        // source: cortex@ed33435 mcp_server/core/change_impact_matcher.py::match_memories
        // Real implementation: packages/memory/src/codebase-analysis/handlers/change-impact.ts
        const store = deps?.store as unknown as MemoryStoreExt;
        const response = await changeImpactHandler(
          {
            base:            args.base,
            head:            args.head,
            expand_impact:   args.expand_impact,
            apply_heat_bump: args.apply_heat_bump,
          },
          {
            store,
            mcpClientPool: deps?.mcpClientPool ?? null,
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("change_impact", err);
      }
    },
  );
}
