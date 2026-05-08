/**
 * management.ts — MCP tool adapters for the memory management topic.
 *
 * Tools registered (5):
 *   validate_memory, seed_project, backfill_memories, get_methodology_graph,
 *   get_telemetry
 *
 * Phase 7 Group D — DI wiring:
 *   - validate_memory: marks stale memories whose source files no longer exist.
 *     Ported from cortex@ed33435 mcp_server/handlers/validate_memory.py.
 *   - seed_project: calls real seedProjectHandlerFn from @agentic/memory/codebase-analysis.
 *   - backfill_memories: calls backfillMemoriesHandler (force:true, full-file scan,
 *     rglob discovery, hash-dedup). Replaces importHandler which used force:false
 *     causing ~90% write-gate rejection. source: backfill-memories.ts fix 0.1.4.
 *   - get_methodology_graph: builds graph from profiles.json.
 *     Ported from cortex@ed33435 mcp_server/handlers/get_methodology_graph.py.
 *   - get_telemetry: returns in-process telemetry counters + read/write ratio.
 *     Ported from cortex@ed33435 mcp_server/handlers/get_telemetry.py.
 *
 * NOTE: codebase_analyze is registered exclusively in tools/ingest.ts.
 *   The duplicate registration here was removed to prevent "Tool already registered"
 *   errors at MCP startup. source: 2026-05-08 cleanup pass.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md
 *         §Tier1Manage, §Tier1Core (get_methodology_graph)
 * source: cortex@ed33435 mcp_server/handlers/get_telemetry.py
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import { backfillMemoriesHandler, type BackfillImportResponse } from "@agentic/memory/import/backfill-memories.js";
import { rememberAsync } from "@agentic/memory/remember/handlers/remember.js";
import { handler as seedProjectHandlerFn } from "@agentic/memory/codebase-analysis/handlers/seed-project.js";
import { summary as telemetrySummary } from "@agentic/memory/shared/telemetry.js";

// ── Named constants ───────────────────────────────────────────────────────────
// source: cortex@ed33435 validate_memory.py — default staleness threshold 0.5
const VALIDATE_STALENESS_DEFAULT = 0.5;
// source: cortex@ed33435 validate_memory.py:200 — error list capped at 10
const VALIDATE_ERROR_CAP = 10;
// source: cortex@ed33435 seed_project.py — max_file_size_kb default=64KB
const SEED_MAX_FILE_SIZE_KB = 64;
// source: MCP_TOOLS.md §backfill_memories max_files default=20
const BACKFILL_MAX_FILES_DEFAULT = 20;
// source: session_extractor.py — baseline importance score = 0.3 (any message with text content)
// Setting min_importance = 0.3 includes all messages that pass SKIP_RE + MIN_CONTENT_LEN filters.
// Previous default was 0.35 which excluded messages with no category keyword match.
// source: empirical — 3,077 files, 2026-05-08: 0.3 captures 45k items vs 17k at 0.35.
const BACKFILL_MIN_IMPORTANCE = 0.3;

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface ManagementDeps {
  store: MemoryStoreExt;
}

// ── Profiles I/O ──────────────────────────────────────────────────────────────

function loadProfilesRaw(): Record<string, unknown> {
  const profilePath = join(homedir(), ".claude", "methodology", "profiles.json");
  if (!existsSync(profilePath)) return { domains: {} };
  try {
    return JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { domains: {} };
  }
}

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── registerManagementTools ───────────────────────────────────────────────────

/**
 * Registers memory management MCP tools.
 *
 * precondition:  deps.store is a live MemoryStore.
 * postcondition: 4 tools registered; validate_memory, backfill_memories,
 *   get_methodology_graph call real handlers;
 *   seed_project calls the real seedProjectHandlerFn.
 *
 * source: MCP_TOOLS.md §"validate_memory", §"seed_project",
 *         §"backfill_memories", §"codebase_analyze", §"get_methodology_graph"
 */
export function registerManagementTools(server: McpServer, deps: ManagementDeps): void {
  // ── validate_memory ───────────────────────────────────────────────────────
  server.registerTool(
    "validate_memory",
    {
      description: "Validate memories against current filesystem state (mark stale if referenced files no longer exist).",
      inputSchema: {
        memory_id:           z.number().int().optional().describe("Specific memory ID or null for batch"),
        domain:              z.string().optional().describe("Domain filter"),
        directory:           z.string().optional().describe("Directory filter"),
        base_dir:            z.string().default("").describe("Base directory for path resolution"),
        staleness_threshold: z.number().min(0).max(1).default(VALIDATE_STALENESS_DEFAULT).describe("Heat threshold for stale mark"),
        dry_run:             z.boolean().default(false).describe("Preview without writing"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/validate_memory.py::_handler_impl
        // Use *Async variant when available (PgMemoryStore) to avoid _runSync() throw.
        // source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
        const storeAny = deps.store as unknown as { getAllMemoriesForDecayAsync?: () => Promise<Record<string, unknown>[]> };
        const allMems =
          typeof storeAny.getAllMemoriesForDecayAsync === "function"
            ? await storeAny.getAllMemoriesForDecayAsync()
            : deps.store.getAllMemoriesForDecay();

        const candidates = args.memory_id !== undefined
          ? allMems.filter((m) => m["id"] === args.memory_id)
          : allMems.filter((m) => {
              if (args.domain && m["domain"] !== args.domain) return false;
              if (args.directory && !String(m["directory"] ?? "").startsWith(args.directory)) return false;
              return true;
            });

        let validated = 0;
        let staleMarked = 0;
        const errors: string[] = [];

        for (const mem of candidates) {
          try {
            validated++;
            const heat = (mem["heat"] as number | undefined) ?? 0;
            if (heat >= args.staleness_threshold) continue;

            const tags = (mem["tags"] as string[] | undefined) ?? [];
            const fileRef = tags.find((t) => t.startsWith("file:") || t.startsWith("path:"));
            if (!fileRef) continue;

            const filePath = fileRef.replace(/^(?:file:|path:)/, "");
            const absPath = args.base_dir ? join(args.base_dir, filePath) : filePath;
            if (existsSync(absPath)) continue;

            if (!args.dry_run) {
              deps.store.markMemoryStale(Number(mem["id"]), true);
            }
            staleMarked++;
          } catch (e) {
            errors.push(String(e));
          }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          validated,
          stale_marked: staleMarked,
          dry_run:      args.dry_run,
          errors:       errors.slice(0, VALIDATE_ERROR_CAP),
        }) }] };
      } catch (err) {
        return errorText("validate_memory", err);
      }
    },
  );

  // ── seed_project ──────────────────────────────────────────────────────────
  server.registerTool(
    "seed_project",
    {
      description: "Bootstrap memory from an existing codebase by scanning files and creating structured memories.",
      inputSchema: {
        directory:        z.string().default("").describe("Project directory to seed from"),
        domain:           z.string().default("").describe("Domain to assign"),
        max_file_size_kb: z.number().int().min(1).default(SEED_MAX_FILE_SIZE_KB).describe("Max file size in KB"),
        dry_run:          z.boolean().default(false).describe("Preview without writing"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/seed_project.py::handler
        // source: cortex@ed33435 mcp_server/handlers/seed_project_stages.py
        // Real implementation: packages/memory/src/codebase-analysis/handlers/seed-project.ts
        const response = await seedProjectHandlerFn(
          {
            directory:        args.directory,
            domain:           args.domain,
            max_file_size_kb: args.max_file_size_kb,
            dry_run:          args.dry_run,
          },
          { store: deps.store },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("seed_project", err);
      }
    },
  );

  // ── backfill_memories ─────────────────────────────────────────────────────
  server.registerTool(
    "backfill_memories",
    {
      description: "Auto-import prior Claude Code conversation JSONL files, applying Ebbinghaus-decay initial heat.",
      inputSchema: {
        project:         z.string().default("").describe("Project identifier"),
        max_files:       z.number().int().min(1).default(BACKFILL_MAX_FILES_DEFAULT).describe("Max JSONL files to process"),
        // source: Ebbinghaus retention curve — min_importance threshold of 0.35
        // per MCP_TOOLS.md §backfill_memories default
        min_importance:  z.number().min(0).max(1).default(BACKFILL_MIN_IMPORTANCE).describe("Minimum importance score"),
        dry_run:         z.boolean().default(false).describe("Preview without writing"),
        force_reprocess: z.boolean().default(false).describe("Reprocess already-imported files"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/import/backfill-memories.ts::backfillMemoriesHandler
        //
        // CRITICAL FIX: Previously called importHandler (import_sessions path) which
        // used force:false, causing the write gate to reject ~90% of memories.
        // backfillMemoriesHandler uses force:true (bypass gate), hash-based dedup via
        // backfill_log, and rglob discovery matching Python backfill_memories.py.
        //
        // Contract change (LSP):
        //   Pre:  same args (project, max_files, min_importance, dry_run, force_reprocess)
        //   Post: stored count is now up to 100x higher because gate bypass is active.
        //         Dedup guarantee: backfill_log (SQLite) / no-op on PG (PG gets dedup
        //         via ON CONFLICT on content_hash at the memories table level).
        //
        // source: cortex@ed33435 mcp_server/handlers/backfill_memories.py:handler
        // source: engineer@41e5778 — *Async-when-available pattern for PG/SQLite parity.
        // RememberHandler expects (args: RememberArgs) but rememberAsync accepts unknown.
        // The cast is safe: backfillMemoriesHandler passes args through RememberArgs shape.
        // source: import/types.ts::RememberHandler contract; backfill-memories.ts::importSingleItem
        const rememberFn = async (rawArgs: unknown): Promise<{ stored: boolean; memory_id?: number } | null> => {
          const result = await rememberAsync(rawArgs, deps.store);
          if (!result.stored) return null;
          return { stored: true, memory_id: (result as { memory_id?: number }).memory_id };
        };

        const response = await backfillMemoriesHandler(
          {
            project:         args.project,
            max_files:       args.max_files,
            min_importance:  args.min_importance,
            dry_run:         args.dry_run,
            force_reprocess: args.force_reprocess,
          },
          deps.store,
          rememberFn,
        );

        if ("dry_run" in response && response.dry_run) {
          return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
        }
        const imp = response as BackfillImportResponse;
        return { content: [{ type: "text" as const, text: JSON.stringify({
          backfilled:          imp.backfilled,
          files_processed:     imp.files_processed,
          files_already_done:  imp.files_already_done,
          items_gated:         imp.items_gated,
          total_files_found:   imp.total_files_found,
        }) }] };
      } catch (err) {
        return errorText("backfill_memories", err);
      }
    },
  );

  // ── get_methodology_graph ─────────────────────────────────────────────────
  server.registerTool(
    "get_methodology_graph",
    {
      description: "Returns methodology map as graph data for 3D visualisation.",
      inputSchema: {
        domain: z.string().optional().describe("Domain to visualise"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/get_methodology_graph.py::handler
        const profiles = loadProfilesRaw();
        const domains = (profiles["domains"] ?? {}) as Record<string, Record<string, unknown>>;

        const nodes: Array<Record<string, unknown>> = [];
        const edges: Array<Record<string, unknown>> = [];
        let edgeId = 0;

        for (const [id, domain] of Object.entries(domains)) {
          if (args.domain && id !== args.domain) continue;
          nodes.push({
            id,
            label:         domain["label"] ?? id,
            session_count: domain["sessionCount"] ?? 0,
            confidence:    domain["confidence"] ?? 0,
          });

          const bridges = (domain["connectionBridges"] ?? []) as Array<Record<string, unknown>>;
          for (const bridge of bridges) {
            const target = bridge["targetDomain"] as string | undefined;
            if (!target) continue;
            edges.push({
              id:          edgeId++,
              source:      id,
              target,
              bridge_type: bridge["bridgeType"] ?? "unknown",
              strength:    bridge["strength"] ?? 0,
            });
          }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({ nodes, edges }) }] };
      } catch (err) {
        return errorText("get_methodology_graph", err);
      }
    },
  );

  // ── get_telemetry ─────────────────────────────────────────────────────────
  server.registerTool(
    "get_telemetry",
    {
      description:
        "Return in-process telemetry snapshot: per-op call counts, latency, byte volume, " +
        "success/failure split, and the computed read/write ratio. " +
        "Use this to verify Cortex's empirical read/write workload distribution " +
        // source: cortex@ed33435 mcp_server/handlers/get_telemetry.py — Popper C6 claim grounded in measurement
        "(Popper C6 — grounds the read-heavy workload claim in " +
        "measurement, not assertion). Counters are per-process and reset on restart; " +
        "the durable record is the JSONL at ~/.claude/methodology/telemetry.jsonl.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/get_telemetry.py::handler
        // source: cortex@ed33435 mcp_server/core/telemetry.py::summary
        const result = telemetrySummary();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return errorText("get_telemetry", err);
      }
    },
  );
}
