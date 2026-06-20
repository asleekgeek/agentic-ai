/**
 * remember.ts — MCP tool adapters for the memory write topic.
 *
 * Tools registered (4):
 *   remember, forget, anchor, rate_memory
 *
 * Phase 7 Group D — DI wiring: MemoryStore is injected via RememberDeps.
 * Each tool body calls the async-aware domain handler variant.
 *
 * ADR-0042 compliance: all four handlers now call *Async variants when the
 * injected store is PgMemoryStore (detected via presence of insertMemoryAsync).
 * The sync variants throw at runtime on PgMemoryStore (PgMemoryStore._runSync
 * is intentionally broken for PG). Using *Async is the only safe path.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md
 *         §Tier1Memory (remember), §Tier1Manage (forget, anchor, rate_memory)
 * source: packages/memory/src/remember/handlers/{remember,forget,anchor,rate-memory}.ts
 * source: ADR-0042 — MCP entry must honour DATABASE_URL
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStore } from "@agentic/memory/remember/storage/memory-store.js";
import { rememberAsync } from "@agentic/memory/remember/handlers/remember.js";
import type { WriteEmbedder } from "@agentic/memory/remember/handlers/remember.js";
import { forgetAsync } from "@agentic/memory/remember/handlers/forget.js";
import { anchorAsync } from "@agentic/memory/remember/handlers/anchor.js";
import { rateMemoryAsync } from "@agentic/memory/remember/handlers/rate-memory.js";

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface RememberDeps {
  store: MemoryStore;
  // Curation-on-write embedder (MEM-G1). null on the live server until Phase-7
  // Group-A wires a real embedder; curation-on-write is a no-op when absent, so
  // the write path stays byte-identical until then.
  // source: packages/memory/src/remember/handlers/remember-helpers.ts::WriteEmbedder
  embedder?: WriteEmbedder | null;
}

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── registerRememberTools ─────────────────────────────────────────────────────

/**
 * Registers the 4 memory-write MCP tools onto the given server instance.
 *
 * precondition:  deps.store is a live MemoryStore (SQLite or PG).
 * postcondition: 4 tools registered; each body calls the async-aware domain
 *   handler which routes to *Async store methods when available (PG path),
 *   or falls through to sync methods (SQLite path).
 *
 * source: MCP_TOOLS.md §"remember", §"forget", §"anchor", §"rate_memory"
 * source: ADR-0042 — async path for PG backend
 */
export function registerRememberTools(server: McpServer, deps: RememberDeps): void {
  // ── remember ──────────────────────────────────────────────────────────────
  server.registerTool(
    "remember",
    {
      description: "Store a memory through the predictive coding write gate.",
      inputSchema: {
        content:     z.string().min(1).describe("Memory content to store"),
        tags:        z.array(z.string()).default([]).describe("Tags for categorisation"),
        directory:   z.string().default("").describe("Project directory"),
        domain:      z.string().optional().describe("Cognitive domain"),
        source:      z.enum(["session", "tool", "user", "consolidation", "import"]).default("user").describe("Memory source"),
        force:       z.boolean().default(false).describe("Bypass write gate"),
        agent_topic: z.string().default("").describe("Agent topic scope"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/remember/handlers/remember.ts::rememberAsync
        // rememberAsync calls *Async store methods when available (PG), else sync (SQLite).
        // deps.embedder is null until Phase-7 Group-A → curation-on-write is a no-op.
        const response = await rememberAsync(args, deps.store, deps.embedder ?? null);
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("remember", err);
      }
    },
  );

  // ── forget ────────────────────────────────────────────────────────────────
  server.registerTool(
    "forget",
    {
      description: "Delete or soft-delete a memory by integer ID.",
      inputSchema: {
        memory_id: z.number().int().min(1).describe("Memory ID to delete"),
        soft:      z.boolean().default(false).describe("Soft-delete (archive rather than purge)"),
        force:     z.boolean().default(false).describe("Force delete even if protected"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/remember/handlers/forget.ts::forgetAsync
        const response = await forgetAsync(args, deps.store);
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("forget", err);
      }
    },
  );

  // ── anchor ────────────────────────────────────────────────────────────────
  server.registerTool(
    "anchor",
    {
      description: "Mark a memory as compaction-resistant (heat_base=1.0, no_decay=true, is_protected=true).",
      inputSchema: {
        memory_id: z.number().int().min(1).describe("Memory ID to anchor"),
        reason:    z.string().default("").describe("Reason for anchoring"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/remember/handlers/anchor.ts::anchorAsync
        const response = await anchorAsync(args, deps.store);
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("anchor", err);
      }
    },
  );

  // ── rate_memory ───────────────────────────────────────────────────────────
  server.registerTool(
    "rate_memory",
    {
      description: "Rate a memory as useful or not to update metamemory confidence and useful_count.",
      inputSchema: {
        memory_id: z.number().int().min(1).describe("Memory ID to rate"),
        useful:    z.boolean().describe("Whether the memory was useful"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/remember/handlers/rate-memory.ts::rateMemoryAsync
        const response = await rateMemoryAsync(args, deps.store);
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("rate_memory", err);
      }
    },
  );
}
