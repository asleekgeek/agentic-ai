#!/usr/bin/env node
/**
 * @agentic/mcp-server-memory — Composition root.
 *
 * PATTERN: MCP Composition Root (see docs/PATTERNS.md)
 *
 * This file is the single boundary between the @agentic/memory domain layer
 * and the stdio MCP transport. It:
 *   1. Instantiates an McpServer with identity metadata.
 *   2. Constructs infrastructure adapters — PgMemoryStore when DATABASE_URL
 *      is set, SqliteMemoryStore otherwise (ADR-0042).
 *   3. Runs the db-guard: refuses to start if DATABASE_URL points to the
 *      standalone Python Cortex database (exit 78).
 *   4. Delegates tool registration to one file per topic in src/tools/.
 *   5. Connects the server to StdioServerTransport.
 *
 * ADR-0042 compliance: DATABASE_URL is now honoured at the MCP entry point.
 * Prior to this fix the MCP server always used SqliteMemoryStore regardless
 * of DATABASE_URL — write operations silently went to ~/.cortex/cortex.db
 * while the dashboard (plugins/memory/dist/server.js) correctly used PG.
 * This fix completes ADR-0042 for the MCP entry point.
 *
 * All tools from MCP_TOOLS.md are registered by the register* functions.
 *
 * Logging: ONLY to stderr. Never to stdout. Writing to stdout corrupts the
 * JSON-RPC framing on the stdio transport.
 * source: modelcontextprotocol.io/quickstart/server §"Logging in MCP Servers"
 *
 * source: @modelcontextprotocol/sdk v1.29.0 API — McpServer + StdioServerTransport
 * source: ADR-0042 — MCP entry must honour DATABASE_URL
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmClient } from "@agentic/core";
import { AnthropicLlmClient } from "@agentic/memory/infrastructure/anthropic-llm-client.js";
import { SqliteNarrativeAdapter } from "@agentic/memory/narrative/handlers/sqlite-narrative-adapter.js";
import { SqliteMemoryStore } from "@agentic/memory/remember/storage/sqlite-store.js";
import { PgMemoryStore } from "@agentic/memory/remember/storage/pg-store.js";
import type { GraphPort } from "@agentic/memory/graph/port.js";
import type { MemoryStore as RecallMemoryStore } from "@agentic/memory/recall/port.js";
import type { MemoryItem } from "@agentic/memory/recall/types.js";
import type { MemoryStore } from "@agentic/memory/remember/storage/memory-store.js";

import { assertNotForbiddenDb } from "./db-guard.js";
import { registerRecallTools } from "./tools/recall.js";
import { registerRememberTools } from "./tools/remember.js";
import { registerMethodologyTools } from "./tools/methodology.js";
import { registerConsolidationTools } from "./tools/consolidation.js";
import { registerManagementTools } from "./tools/management.js";
import { registerNarrativeTools } from "./tools/narrative.js";
import { registerAdvancedTools } from "./tools/advanced.js";
import { registerWikiTools } from "./tools/wiki.js";
import { registerIngestTools } from "./tools/ingest.js";
import { registerNavigationTools } from "./tools/navigation.js";

// ── Server identity ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "@agentic/mcp-server-memory",
  version: "0.1.0",
});

// ── LLM client ────────────────────────────────────────────────────────────────
// source: docs/PHASE_7_TRACKING.md §Group C — LLM client wiring
// source: https://docs.anthropic.com/en/api/getting-started — auth via env var

const llmClient: LlmClient | null = process.env["ANTHROPIC_API_KEY"]
  ? new AnthropicLlmClient()
  : null;

if (llmClient !== null) {
  process.stderr.write("[mcp-server-memory] ANTHROPIC_API_KEY present — LLM client active\n");
} else {
  process.stderr.write("[mcp-server-memory] ANTHROPIC_API_KEY absent — LLM client disabled (graceful degradation)\n");
}

// ── Store selection (ADR-0042) ────────────────────────────────────────────────
//
// precondition:  DATABASE_URL is a valid PostgreSQL connection string, OR
//   absent/empty (SQLite fallback).
// postcondition: memoryStore is a live MemoryStore (Pg or SQLite).
// invariant:     DATABASE_URL pointing to the standalone Python Cortex
//   database (db_name=cortex on localhost) causes immediate exit(78).
//
// source: ADR-0042 — MCP entry must honour DATABASE_URL; guard against
//   accidentally touching the Python Cortex DB (db_name=cortex on localhost).
// source: Martin, R. C. (2017). Clean Architecture, Ch. 11 — configuration
//   is the only acceptable source of global state; frozen after startup.

const databaseUrl: string | undefined = process.env["DATABASE_URL"];

let memoryStore: MemoryStore;
let isPgStore = false;

if (databaseUrl) {
  // Guard: refuse to connect to the standalone Python Cortex database.
  // source: ADR-0042 §guard — exit 78 on db_name=cortex on localhost.
  assertNotForbiddenDb(databaseUrl);

  process.stderr.write(`[mcp-server-memory] DATABASE_URL set — using PgMemoryStore\n`);
  memoryStore = new PgMemoryStore(databaseUrl);
  isPgStore = true;
} else {
  // SQLite fallback.
  // source: install/MIGRATION_FROM_OLD_PLUGINS.md §"SQLite fallback DB"
  const dbPath: string = process.env["CORTEX_DB_PATH"] ??
    join(homedir(), ".cortex", "cortex.db");

  memoryStore = new SqliteMemoryStore(dbPath);
  process.stderr.write(`[mcp-server-memory] SQLite store open: ${dbPath}\n`);
}

// ── Narrative adapter (SQLite-only) ──────────────────────────────────────────
//
// SqliteNarrativeAdapter requires the internal _db field of SqliteMemoryStore.
// When using PgMemoryStore, narrative tools are disabled (narrativeStore = null).
// Narrative tools in registry-memory.ts already handle null narrativeStore.
//
// source: packages/memory/src/narrative/handlers/sqlite-narrative-adapter.ts

const narrativeStore: SqliteNarrativeAdapter | null = isPgStore
  ? null
  : (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const narrativeDb = (memoryStore as any)._db as ConstructorParameters<typeof SqliteNarrativeAdapter>[0];
      return new SqliteNarrativeAdapter(narrativeDb);
    })();

// Type-narrow: PgMemoryStore for calling *Async methods in adapters.
const pgStore: PgMemoryStore | null = isPgStore ? (memoryStore as PgMemoryStore) : null;

// ── Recall adapter (SQLite sync-lift / PG async) ──────────────────────────────
//
// Adapts MemoryStore to RecallMemoryStore (async, recall port).
//
// For SQLite: lifts sync calls with Promise.resolve().
// For PG: calls the *Async variants directly (sync variants throw via _runSync).
//
// source: Martin, R. C. (2017). Clean Architecture, Ch. 11 — adapters
//   transform incompatible shapes at the composition root.
// source: packages/memory/src/recall/port.ts::MemoryStore (target interface)
// source: ADR-0042 — async path for PG backend

const storeExt = memoryStore as unknown as Record<string, (...a: unknown[]) => unknown>;

const recallStore: RecallMemoryStore = {
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_search.py::vec_search
  searchByVector: async (embedding, topK, minHeat) => {
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    if (pgStore) {
      const hits = await pgStore.searchVectorsAsync(buf, topK, minHeat);
      return hits.map(([memory_id, distance]) => ({ memory_id, distance }));
    }
    const hits = memoryStore.searchVectors(buf, topK, minHeat);
    return hits.map(([memory_id, distance]) => ({ memory_id, distance }));
  },

  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_search.py::fts_search
  // SqliteMemoryStore.searchFts returns Array<[memoryId, score]>; the legacy
  // ftsSearch fallback returns Array<{id, rank}>. Detect both shapes so the
  // recall pipeline never receives `memory_id: undefined`.
  searchByFts: async (query, limit) => {
    const tupleSearch = (memoryStore as unknown as {
      searchFts?: (q: string, l: number) => Array<[number, number]>;
    }).searchFts;
    if (tupleSearch) {
      return tupleSearch(query, limit).map(([memory_id, score]) => ({ memory_id, score }));
    }
    const raw = (storeExt["ftsSearch"]?.(query, limit) ?? []) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      memory_id: r["id"] as number,
      score:     (r["rank"] as number ?? r["score"] as number) ?? 0,
    }));
  },

  // source: packages/memory/src/remember/storage/sqlite-store.ts::getMemory
  getMemory: async (id) => {
    if (pgStore) return (await pgStore.getMemoryAsync(id)) as unknown as MemoryItem | null;
    return memoryStore.getMemory(id) as MemoryItem | null;
  },

  // source: packages/memory/src/remember/storage/sqlite-store.ts::getByIds (escape hatch)
  getByIds: async (ids) => {
    if (pgStore) {
      const results = await Promise.all(ids.map((id) => pgStore.getMemoryAsync(id)));
      return results.filter((r) => r !== null) as unknown as MemoryItem[];
    }
    const raw = (storeExt["getByIds"]?.(ids) ??
      ids.map((id) => memoryStore.getMemory(id)).filter(Boolean)) as MemoryItem[];
    return raw.filter(Boolean);
  },

  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::get_memories_for_domain
  getMemoriesForDomain: async (domain, minHeat, limit) => {
    const raw = (storeExt["getMemoriesForDomain"]?.(domain, minHeat, limit) ?? []) as MemoryItem[];
    return raw;
  },

  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::get_memories_for_directory
  getMemoriesForDirectory: async (directory, minHeat) => {
    const raw = (storeExt["getMemoriesForDirectory"]?.(directory, minHeat) ?? []) as MemoryItem[];
    return raw;
  },

  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::get_hot_memories
  getHotMemories: async (minHeat, limit) => {
    const raw = (storeExt["getHotMemories"]?.(minHeat, limit) ?? []) as MemoryItem[];
    return raw;
  },

  // source: packages/memory/src/recall/port.ts::getAllActiveRules
  getAllActiveRules: async () => {
    return (storeExt["getAllActiveRules"]?.() ?? []) as unknown[];
  },

  // source: packages/memory/src/recall/port.ts::getActiveProspectiveMemories
  getActiveProspectiveMemories: async () => {
    return (storeExt["getActiveProspectiveMemories"]?.() ?? []) as unknown[];
  },

  // source: packages/memory/src/remember/storage/sqlite-store.ts::updateMemoryAccess
  updateMemoryAccess: async (memoryId) => {
    memoryStore.updateMemoryAccess(memoryId);
  },

  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::increment_replay_count
  incrementReplayCount: async (memoryId) => {
    storeExt["incrementReplayCount"]?.(memoryId);
  },

  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::reinforce_or_create_relationship
  reinforceOrCreateRelationship: async (entityA, entityB, learningRate) => {
    storeExt["reinforceOrCreateRelationship"]?.(entityA, entityB, learningRate);
  },
};

// ── GraphPort adapter ─────────────────────────────────────────────────────────
// Adapts MemoryStore to GraphPort for the navigate_memory tool.
// source: packages/memory/src/graph/port.ts::GraphPort

const graphPort: GraphPort = {
  getRecentlyAccessedMemories: async (limit, minAccessCount) => {
    const raw = (storeExt["getRecentlyAccessedMemories"]?.(limit, minAccessCount) ?? []) as Array<Record<string, unknown>>;
    return raw.map((m) => ({
      id:           Number(m["id"]),
      content:      String(m["content"] ?? ""),
      lastAccessed: m["last_accessed"] as string | undefined,
      heat:         m["heat"] as number | undefined,
      domain:       m["domain"] as string | undefined,
      tags:         Array.isArray(m["tags"]) ? m["tags"] as string[] : [],
    }));
  },
  getMemory: async (memoryId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mem: any;
    if (pgStore) {
      mem = await pgStore.getMemoryAsync(memoryId);
    } else {
      mem = memoryStore.getMemory(memoryId);
    }
    if (!mem) return undefined;
    return {
      id:           mem.id as number,
      content:      mem.content as string,
      lastAccessed: (mem.last_accessed ?? mem.lastAccessed) as string | undefined,
      heat:         mem.heat as number | undefined,
      domain:       mem.domain as string | undefined,
      tags:         Array.isArray(mem.tags) ? mem.tags as string[] : [],
    };
  },
  updateMemoryAccess: async (memoryId) => {
    memoryStore.updateMemoryAccess(memoryId);
  },
  incrementReplayCount: async (memoryId) => {
    storeExt["incrementReplayCount"]?.(memoryId);
  },
};

// ── Tool registration — one call per topic file ───────────────────────────────
// source: docs/PHASE_PLAN.md §"Phase 4 merge order"

registerRecallTools(server, { store: recallStore, embedder: null, graphPort });     // 4 tools
registerRememberTools(server, { store: memoryStore });                               // 4 tools
registerMethodologyTools(server);                                                    // 5 tools
registerConsolidationTools(server, { store: memoryStore });                         // 4 tools
registerManagementTools(server, { store: memoryStore });                            // 5 tools
// narrativeStore is null when using PgMemoryStore (SQLite-only feature).
// registerNarrativeTools accepts null and degrades gracefully.
registerNarrativeTools(server, narrativeStore ? { store: narrativeStore, llmClient } : null);  // 3 tools
registerAdvancedTools(server, { store: memoryStore });                              // 6 tools
registerWikiTools(server);                                                           // 8 tools
registerIngestTools(server, { store: memoryStore, wikiRoot: process.env["CORTEX_WIKI_ROOT"] ?? join(homedir(), ".claude", "methodology", "wiki"), mcpClientPool: null }); // 6 tools
registerNavigationTools(server, { store: memoryStore });                            // 2 tools

// ── Transport ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-server-memory] running on stdio, tools registered\n");
  if (isPgStore) {
    process.stderr.write("[mcp-server-memory] backend: PostgreSQL (DATABASE_URL)\n");
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[mcp-server-memory] fatal: ${String(err)}\n`);
  process.exit(1);
});
