/**
 * consolidation.ts — MCP tool adapters for the consolidation + session topic.
 *
 * Tools registered (4):
 *   consolidate, checkpoint, memory_stats, record_session_end
 *
 * Phase 7 Group D — DI wiring:
 *   - consolidate: calls real handler from @agentic/memory/consolidation.
 *   - checkpoint: lightweight checkpoint stored as a protected memory.
 *     Ported from cortex@ed33435 mcp_server/handlers/checkpoint.py (save path).
 *   - memory_stats: raw stats from ConsolidationStore escape hatch.
 *     Ported from cortex@ed33435 mcp_server/handlers/memory_stats.py.
 *   - record_session_end: incremental EMA profile update.
 *     Ported from cortex@ed33435 mcp_server/handlers/record_session_end.py.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md
 *         §Tier1Memory (consolidate, checkpoint, memory_stats)
 *         §Tier1Core (record_session_end)
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import { handler as consolidateHandler } from "@agentic/memory/consolidation/handler.js";
import { writeStamp as writeConsolidateStamp } from "@agentic/memory/hooks/consolidate-background.js";
import {
  DEFAULT_CONSOLIDATION_SETTINGS,
  NULL_EMBEDDING_ENGINE,
  toConsolidationStore,
} from "@agentic/memory/consolidation/defaults.js";
import type { ProfilesStore } from "@agentic/memory/methodology/types.js";
// Wiki-cycle adapters live in a sibling file to keep this one under
// the §4.1 file-size limit. Same engine + failure-isolation contract.
// source: packages/mcp-servers/memory/src/tools/consolidation-wiki-adapters.ts
import {
  countPendingCurationsSafe,
  countPendingMaintenance,
  runConsolidateWikiCycle,
  type WikiMaintenanceResult,
} from "./consolidation-wiki-adapters.js";

// ── Named constants ───────────────────────────────────────────────────────────
// source: cortex@ed33435 memory_stats.py:77 — avg_heat rounded to 4 decimal places
const ROUNDING_FACTOR_4DP = 10000;
// source: cortex@ed33435 record_session_end.py — EMA_ALPHA=0.1
const EMA_ALPHA = 0.1; // source: mcp_server/core/cognitive_profile.py EMA_ALPHA default

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface ConsolidationDeps {
  store: MemoryStoreExt;
}

// ── Profiles I/O ──────────────────────────────────────────────────────────────
//
// source: packages/memory/src/hooks/session-lifecycle.ts::loadProfiles

function methodologyDir(): string {
  return join(homedir(), ".claude", "methodology");
}

function loadProfiles(): ProfilesStore {
  const profilePath = join(methodologyDir(), "profiles.json");
  if (!existsSync(profilePath)) return { domains: {} };
  try {
    const raw = JSON.parse(readFileSync(profilePath, "utf-8")) as ProfilesStore;
    if (!raw.domains) raw.domains = {};
    return raw;
  } catch {
    return { domains: {} };
  }
}

function saveProfiles(profiles: ProfilesStore): void {
  const dir = methodologyDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf-8");
}


// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}


// ── registerConsolidationTools ────────────────────────────────────────────────

/**
 * Registers consolidation and session lifecycle MCP tools.
 *
 * precondition:  deps.store is a live MemoryStore.
 * postcondition: 4 tools registered; each body calls the real domain handler.
 *
 * source: MCP_TOOLS.md §"consolidate", §"checkpoint", §"memory_stats",
 *         §"record_session_end"
 */
export function registerConsolidationTools(server: McpServer, deps: ConsolidationDeps): void {
  // ── consolidate ───────────────────────────────────────────────────────────
  server.registerTool(
    "consolidate",
    {
      description: "Run memory maintenance pipeline: decay, compression, CLS transfer, memify, pruning, wiki grooming.",
      inputSchema: {
        decay:    z.boolean().default(true).describe("Run decay cycle"),
        compress: z.boolean().default(true).describe("Run compression cycle"),
        cls:      z.boolean().default(true).describe("Run CLS transfer"),
        memify:   z.boolean().default(true).describe("Run memify cycle"),
        deep:     z.boolean().default(false).describe("Deep consolidation (slower)"),
        // G2 — wiki maintenance axes. Defaults match the autonomous
        // policy: stub + classifier purge ON, cap 500/cycle, shallow
        // pages NEVER auto-deleted (queued via curation backlog).
        // source: packages/memory/src/wiki/maintenance.ts
        wiki:                          z.boolean().default(true).describe("Run wiki maintenance cycle"),
        wiki_apply_stubs:              z.boolean().default(true).describe("Purge stub pages (autonomous)"),
        wiki_apply_classifier_rejects: z.boolean().default(true).describe("Purge classifier-reject pages"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/consolidation/handler.ts::handler
        const consolidationStore = toConsolidationStore(deps.store);
        const result = await consolidateHandler(
          consolidationStore,
          DEFAULT_CONSOLIDATION_SETTINGS,
          NULL_EMBEDDING_ENGINE,
          {
            decay:    args.decay,
            compress: args.compress,
            cls:      args.cls,
            memify:   args.memify,
            deep:     args.deep,
          },
        );

        // 2026-05-17: surface pending curation count so the SessionStart
        // preamble and any downstream caller can see how much authoring
        // work the auto-curator has queued up. Failure is non-fatal — a
        // missing curation count must never break consolidate itself.
        // source: cortex@4883307 mcp_server/handlers/consolidate.py:153-172
        const pendingCurations = await countPendingCurationsSafe(deps.store);

        // 2026-05-18 (Phase C): surface drift + coverage counts so
        // SessionStart preamble + dashboard show the FULL maintenance
        // queue, not just curator. Same failure isolation; both fields
        // may be null when project_root resolution fails.
        // source: packages/memory/src/wiki/maintenance-stats.ts
        const maintenance = await countPendingMaintenance();

        // G2 — wiki maintenance cycle. Runs stub purge + classifier
        // purge + backlog refresh on every consolidate call. Failure
        // isolated to the wiki stanza — consolidate's memory work is
        // never blocked by a wiki edge case.
        // source: packages/memory/src/wiki/maintenance.ts
        // source: cortex@4883307+ mcp_server/handlers/consolidation/wiki_maintenance.py
        let wikiResult: WikiMaintenanceResult | { readonly status: string } | null = null;
        if (args.wiki !== false) {
          wikiResult = await runConsolidateWikiCycle(
            deps.store,
            args.wiki_apply_stubs !== false,
            args.wiki_apply_classifier_rejects !== false,
          ).catch((exc) => ({
            status: `wiki_cycle_failed: ${exc instanceof Error ? exc.message : String(exc)}`,
          }));
        }

        const enrichedResult = {
          ...result,
          pending_curations: pendingCurations,
          pending_drift:    maintenance.drift,
          pending_coverage: maintenance.coverage,
          wiki:             wikiResult,
        };

        // 2026-05-18: write the autonomy stamp so SessionStart's TTL
        // gate sees this run — manual ``consolidate`` calls now close
        // the loop the same way the background worker does.
        // source: cortex@HEAD~ mcp_server/handlers/consolidate.py:handler (stamp block)
        try { writeConsolidateStamp(); } catch { /* non-fatal */ }

        return { content: [{ type: "text" as const, text: JSON.stringify(enrichedResult) }] };
      } catch (err) {
        return errorText("consolidate", err);
      }
    },
  );

  // ── checkpoint ────────────────────────────────────────────────────────────
  server.registerTool(
    "checkpoint",
    {
      description: "Save or restore working state for hippocampal replay.",
      inputSchema: {
        action:             z.enum(["save", "restore"]).describe("Checkpoint action"),
        directory:          z.string().default("").describe("Project directory"),
        current_task:       z.string().default("").describe("Current task description"),
        files_being_edited: z.array(z.string()).default([]).describe("Files currently open"),
        key_decisions:      z.array(z.string()).default([]).describe("Key decisions made"),
        open_questions:     z.array(z.string()).default([]).describe("Open questions"),
        next_steps:         z.array(z.string()).default([]).describe("Planned next steps"),
        active_errors:      z.array(z.string()).default([]).describe("Active errors"),
        custom_context:     z.string().default("").describe("Extra context"),
        session_id:         z.string().default("default").describe("Session ID"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/checkpoint.py::handler
        // Lightweight checkpoint: store as a protected memory tagged _checkpoint.
        if (args.action === "save") {
          const content = [
            `[CHECKPOINT] session=${args.session_id}`,
            `task: ${args.current_task}`,
            `files: ${args.files_being_edited.join(", ")}`,
            `decisions: ${args.key_decisions.join("; ")}`,
            `open: ${args.open_questions.join("; ")}`,
            `next: ${args.next_steps.join("; ")}`,
            `errors: ${args.active_errors.join("; ")}`,
            args.custom_context,
          ].filter(Boolean).join("\n");

          const memId = deps.store.insertMemory({
            content,
            tags: ["_checkpoint", `session:${args.session_id}`],
            source: "session",
            domain: "",
            heat: 1.0,
            importance: 1.0,
            store_type: "episodic",
          });
          deps.store.setMemoryProtected(memId, true);

          return { content: [{ type: "text" as const, text: JSON.stringify({
            action:        "save",
            checkpoint_id: String(memId),
            session_id:    args.session_id,
          }) }] };
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          action:     args.action,
          checkpoint: null,
          note:       "checkpoint list/restore: query hot memories tagged _checkpoint",
        }) }] };
      } catch (err) {
        return errorText("checkpoint", err);
      }
    },
  );

  // ── memory_stats ──────────────────────────────────────────────────────────
  server.registerTool(
    "memory_stats",
    {
      description: "Memory system diagnostics — counts, heat distribution, store sizes.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/memory_stats.py::handler
        // Use *Async variant when available (PgMemoryStore) to avoid _runSync() throw.
        // Fall back to sync variant for SqliteMemoryStore.
        // source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
        const storeAny = deps.store as unknown as { getAllMemoriesForDecayAsync?: () => Promise<Record<string, unknown>[]> };
        const allMems = (
          typeof storeAny.getAllMemoriesForDecayAsync === "function"
            ? await storeAny.getAllMemoriesForDecayAsync()
            : deps.store.getAllMemoriesForDecay()
        ) as Array<Record<string, unknown>>;

        const total = allMems.length;
        const episodic = allMems.filter((m) => m["store_type"] === "episodic").length;
        const semantic = allMems.filter((m) => m["store_type"] === "semantic").length;
        const active = allMems.filter((m) => !m["is_stale"] && !m["is_archived"]).length;
        const stale = allMems.filter((m) => m["is_stale"]).length;
        const protected_ = allMems.filter((m) => m["is_protected"]).length;

        const avgHeat = total > 0
          // source: cortex@ed33435 memory_stats.py:77 — avg_heat rounded to 4 decimal places
          ? Math.round((allMems.reduce((s, m) => s + ((m["heat"] as number) ?? 0), 0) / total) * ROUNDING_FACTOR_4DP) / ROUNDING_FACTOR_4DP
          : 0;

        const domainCounts: Record<string, number> = {};
        for (const m of allMems) {
          const d = (m["domain"] as string) ?? "";
          domainCounts[d] = (domainCounts[d] ?? 0) + 1;
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          total_memories:  total,
          episodic_count:  episodic,
          semantic_count:  semantic,
          active_count:    active,
          stale_count:     stale,
          protected_count: protected_,
          avg_heat:        avgHeat,
          domains:         domainCounts,
        }) }] };
      } catch (err) {
        return errorText("memory_stats", err);
      }
    },
  );

  // ── record_session_end ────────────────────────────────────────────────────
  server.registerTool(
    "record_session_end",
    {
      description: "Incremental EMA profile update after a session ends.",
      inputSchema: {
        session_id: z.string().min(1).describe("Session identifier"),
        domain:     z.string().optional().describe("Cognitive domain"),
        tools_used: z.array(z.string()).optional().describe("Tools used in this session"),
        duration:   z.number().optional().describe("Session duration in milliseconds"),
        turn_count: z.number().int().optional().describe("Number of conversation turns"),
        keywords:   z.array(z.string()).optional().describe("Session keywords"),
        cwd:        z.string().optional().describe("Working directory"),
        project:    z.string().optional().describe("Project identifier"),
      },
    },
    async (args) => {
      try {
        // source: cortex@ed33435 mcp_server/handlers/record_session_end.py::handler
        const profiles = loadProfiles();
        const domainId = args.domain ?? "unknown";
        if (domainId && profiles.domains[domainId]) {
          const dp = profiles.domains[domainId];
          const alpha = EMA_ALPHA;
          if (args.tools_used && dp.toolPreferences) {
            for (const tool of args.tools_used) {
              const prev = dp.toolPreferences[tool] as Record<string, number> | undefined;
              if (prev) {
                prev["ratio"] = (1 - alpha) * (prev["ratio"] ?? 0) + alpha;
              } else {
                dp.toolPreferences[tool] = { ratio: alpha, avgPerSession: 1 };
              }
            }
          }
          dp.sessionCount = (dp.sessionCount ?? 0) + 1;
          dp.lastUpdated = new Date().toISOString();
          saveProfiles(profiles);
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          updated:    true,
          domain:     domainId,
          session_id: args.session_id,
        }) }] };
      } catch (err) {
        return errorText("record_session_end", err);
      }
    },
  );
}
