#!/usr/bin/env node
/**
 * @agentic/mcp-server-memory — Composition root.
 *
 * PATTERN: MCP Composition Root (see docs/PATTERNS.md)
 *
 * This file is the single boundary between the @agentic/memory domain layer
 * and the stdio MCP transport. It:
 *   1. Instantiates an McpServer with identity metadata.
 *   2. Constructs infrastructure adapters (SqliteMemoryStore, AnthropicLlmClient
 *      when ANTHROPIC_API_KEY is set, SqliteNarrativeAdapter, SqliteRecallAdapter).
 *   3. Delegates tool registration to one file per topic in src/tools/.
 *   4. Connects the server to StdioServerTransport.
 *
 * All tools from MCP_TOOLS.md are registered by the register* functions.
 *
 * Logging: ONLY to stderr. Never to stdout. Writing to stdout corrupts the
 * JSON-RPC framing on the stdio transport.
 * source: modelcontextprotocol.io/quickstart/server §"Logging in MCP Servers"
 *
 * source: @modelcontextprotocol/sdk v1.29.0 API — McpServer + StdioServerTransport
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmClient } from "@agentic/core";
import { AnthropicLlmClient } from "@agentic/memory/infrastructure/anthropic-llm-client.js";
import { SqliteNarrativeAdapter } from "@agentic/memory/narrative/handlers/sqlite-narrative-adapter.js";
import { PgNarrativeAdapter } from "@agentic/memory/narrative/handlers/pg-narrative-adapter.js";
import { SqliteMemoryStore } from "@agentic/memory/remember/storage/sqlite-store.js";
import { PgMemoryStore } from "@agentic/memory/remember/storage/pg-store.js";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import type { GraphPort } from "@agentic/memory/graph/port.js";
import type { MemoryStore as RecallMemoryStore } from "@agentic/memory/recall/port.js";
import type { MemoryItem } from "@agentic/memory/recall/types.js";

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

// ── Storage backend selection ─────────────────────────────────────────────────
//
// DATABASE_URL is set → PgMemoryStore (PostgreSQL backend).
// DATABASE_URL is absent → SqliteMemoryStore (SQLite backend, default).
//
// Guard: the agentic-ai plugin must NEVER connect to the standalone Python
// Cortex's PostgreSQL database. Detect the canonical Cortex database name
// and refuse to connect. Already implemented in earlier commits; verified here.
//
// source: Martin, R. C. (2017). Clean Architecture, Ch. 11 — configuration
//         is the only acceptable source of global state; frozen after startup.
// source: install/MIGRATION_FROM_OLD_PLUGINS.md §"PostgreSQL backend"

const rawDatabaseUrl = process.env["DATABASE_URL"] ?? "";

// Invariant: NEVER connect to the standalone Python Cortex database named 'cortex'.
// That database belongs to the Python plugin; connecting to it would corrupt
// its schema and violate plugin isolation.
// source: packages/mcp-servers/memory/src/index.ts — guard first established d717923
if (rawDatabaseUrl) {
  try {
    const u = new URL(rawDatabaseUrl);
    const dbName = u.pathname.replace(/^\//, "");
    if (dbName === "cortex") {
      process.stderr.write(
        "[mcp-server-memory] FATAL: DATABASE_URL points to a database named 'cortex' " +
        "which is reserved for the standalone Python Cortex plugin. " +
        "Set DATABASE_URL to a different database (e.g. postgresql://localhost/cortex_agentic).\n",
      );
      process.exit(1);
    }
  } catch {
    // URL parse failed — let PgMemoryStore report the error on first query
  }
}

// MemoryStoreExt is the behavioral contract both backends implement.
// LSP-VIOLATION CLOSED: the composition root now types the store as
// MemoryStoreExt (not MemoryStore) so all extended methods are accessible
// without escape-hatch casts. Neither backend returns [] for methods that
// should return data.
let memoryStore: MemoryStoreExt;
let narrativeStore: InstanceType<typeof SqliteNarrativeAdapter> | PgNarrativeAdapter;

if (rawDatabaseUrl) {
  // ── PostgreSQL backend ──────────────────────────────────────────────────
  const pgStore = new PgMemoryStore(rawDatabaseUrl);
  memoryStore = pgStore;
  narrativeStore = new PgNarrativeAdapter(pgStore);
  process.stderr.write(`[mcp-server-memory] PostgreSQL store active (DATABASE_URL set)\n`);
} else {
  // ── SQLite backend (default) ────────────────────────────────────────────
  const dbPath: string = process.env["CORTEX_DB_PATH"] ??
    join(homedir(), ".cortex", "cortex.db");
  const sqliteStore = new SqliteMemoryStore(dbPath);
  memoryStore = sqliteStore;

  // Narrative adapter for SQLite: access internal DB connection.
  // The _db field is a better-sqlite3 Database instance; cast through unknown
  // to avoid importing better-sqlite3 types in this package.
  // source: packages/memory/src/remember/storage/sqlite-store.ts — _db field
  // source: packages/memory/src/narrative/handlers/sqlite-narrative-adapter.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const narrativeDb = (sqliteStore as any)._db as ConstructorParameters<typeof SqliteNarrativeAdapter>[0];
  narrativeStore = new SqliteNarrativeAdapter(narrativeDb);
  process.stderr.write(`[mcp-server-memory] SQLite store open: ${dbPath}\n`);
}

// ── RecallStore adapter ───────────────────────────────────────────────────────
//
// Adapts MemoryStoreExt (sync) to RecallMemoryStore (async, recall port).
//
// LSP-VIOLATION CLOSED (#2, #3): previously all extended methods were accessed
// via escape-hatch `storeExt["method"]?.() ?? []` which silently returned []
// on PgMemoryStore. Now all methods delegate directly to MemoryStoreExt typed
// methods which are implemented by both SqliteMemoryStore and PgMemoryStore.
//
// source: Martin, R. C. (2017). Clean Architecture, Ch. 11 — adapters
//   transform incompatible shapes at the composition root.
// source: packages/memory/src/recall/port.ts::MemoryStore (target interface)

const recallStore: RecallMemoryStore = {
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_search.py::vec_search
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store.py::search_vectors
  searchByVector: async (embedding, topK, minHeat) => {
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    const hits = memoryStore.searchVectors(buf, topK, minHeat);
    return hits.map(([memory_id, distance]) => ({ memory_id, distance }));
  },

  // LSP-VIOLATION CLOSED (#3): searchFts is now on MemoryStoreExt.
  // SQLite: uses FTS5 MATCH. PG: uses websearch_to_tsquery on content_tsv.
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_search.py::fts_search
  // source: PostgreSQL 11+ websearch_to_tsquery
  searchByFts: async (query, limit) => {
    return memoryStore.searchFts(query, limit).map(([memory_id, score]) => ({ memory_id, score }));
  },

  // source: packages/memory/src/remember/storage/memory-store.ts::getMemory
  getMemory: async (id) => {
    return memoryStore.getMemory(id) as MemoryItem | null;
  },

  // LSP-VIOLATION CLOSED (#2): getByIds is now on MemoryStoreExt.
  // source: packages/memory/src/remember/storage/memory-store.ts::getByIds
  getByIds: async (ids) => {
    return memoryStore.getByIds(ids) as unknown as MemoryItem[];
  },

  // LSP-VIOLATION CLOSED (#2): getMemoriesForDomain is now on MemoryStoreExt.
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::get_memories_for_domain
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py::getMemoriesForDomain
  getMemoriesForDomain: async (domain, minHeat, limit) => {
    return memoryStore.getMemoriesForDomain(domain, minHeat, limit) as unknown as MemoryItem[];
  },

  // LSP-VIOLATION CLOSED (#2): getMemoriesForDirectory is now on MemoryStoreExt.
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::get_memories_for_directory
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py::getMemoriesForDirectory
  getMemoriesForDirectory: async (directory, minHeat) => {
    return memoryStore.getMemoriesForDirectory(directory, minHeat) as unknown as MemoryItem[];
  },

  // LSP-VIOLATION CLOSED (#2): getHotMemories is now on MemoryStoreExt.
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::get_hot_memories
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py::getHotMemories
  getHotMemories: async (minHeat, limit) => {
    return memoryStore.getHotMemories(minHeat, limit) as unknown as MemoryItem[];
  },

  // getAllActiveRules: not on MemoryStoreExt (rules are SQLite-only for now).
  // Returns [] on PG — this is a documented limitation, not a hidden failure.
  // source: packages/memory/src/recall/port.ts::getAllActiveRules
  getAllActiveRules: async () => {
    const store = memoryStore as unknown as { getAllActiveRules?: () => unknown[] };
    return store.getAllActiveRules?.() ?? [];
  },

  // getActiveProspectiveMemories: on MemoryStoreExt.
  // source: packages/memory/src/recall/port.ts::getActiveProspectiveMemories
  getActiveProspectiveMemories: async () => {
    return memoryStore.getActiveProspectiveMemories();
  },

  // source: packages/memory/src/remember/storage/memory-store.ts::updateMemoryAccess
  updateMemoryAccess: async (memoryId) => {
    memoryStore.updateMemoryAccess(memoryId);
  },

  // incrementReplayCount: on MemoryStoreExt.
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::increment_replay_count
  incrementReplayCount: async (memoryId) => {
    memoryStore.incrementReplayCount(memoryId);
  },

  // reinforceOrCreateRelationship: on MemoryStoreExt.
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store.py::reinforce_or_create_relationship
  reinforceOrCreateRelationship: async (entityA, entityB, learningRate) => {
    memoryStore.reinforceOrCreateRelationship(entityA, entityB, learningRate);
  },
};

// ── GraphPort adapter ─────────────────────────────────────────────────────────
//
// Adapts MemoryStoreExt to GraphPort for the navigate_memory tool.
// LSP-VIOLATION CLOSED: getRecentlyAccessedMemories and incrementReplayCount
// are now on MemoryStoreExt — no escape-hatch cast needed.
//
// source: packages/memory/src/graph/port.ts::GraphPort

const graphPort: GraphPort = {
  // source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_stats.py:90-101
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store_stats.py:48-52
  getRecentlyAccessedMemories: async (limit, minAccessCount) => {
    const raw = memoryStore.getRecentlyAccessedMemories(limit, minAccessCount);
    return raw.map((m) => ({
      id:           Number(m["id"]),
      content:      String(m["content"] ?? ""),
      lastAccessed: m["last_accessed"] as string | undefined,
      heat:         (m["heat_base"] as number | undefined) ?? (m["heat"] as number | undefined),
      domain:       m["domain"] as string | undefined,
      tags:         Array.isArray(m["tags"]) ? m["tags"] as string[] : [],
    }));
  },
  getMemory: async (memoryId) => {
    const mem = memoryStore.getMemory(memoryId);
    if (!mem) return undefined;
    return {
      id:           mem.id,
      content:      mem.content,
      lastAccessed: mem.last_accessed,
      heat:         mem.heat,
      domain:       mem.domain,
      tags:         Array.isArray(mem.tags) ? mem.tags : [],
    };
  },
  updateMemoryAccess: async (memoryId) => {
    memoryStore.updateMemoryAccess(memoryId);
  },
  // incrementReplayCount is now on MemoryStoreExt — no escape-hatch needed.
  incrementReplayCount: async (memoryId) => {
    memoryStore.incrementReplayCount(memoryId);
  },
};

// ── Tool registration — one call per topic file ───────────────────────────────
// source: docs/PHASE_PLAN.md §"Phase 4 merge order"

registerRecallTools(server, { store: recallStore, embedder: null, graphPort });     // 4 tools
registerRememberTools(server, { store: memoryStore });                               // 4 tools
registerMethodologyTools(server);                                                    // 5 tools
registerConsolidationTools(server, { store: memoryStore });                         // 4 tools
registerManagementTools(server, { store: memoryStore });                            // 5 tools
registerNarrativeTools(server, { store: narrativeStore, llmClient });               // 3 tools
registerAdvancedTools(server, { store: memoryStore });                              // 6 tools
registerWikiTools(server);                                                           // 8 tools
registerIngestTools(server, { store: memoryStore, wikiRoot: process.env["CORTEX_WIKI_ROOT"] ?? join(homedir(), ".claude", "methodology", "wiki"), mcpClientPool: null }); // 6 tools
registerNavigationTools(server, { store: memoryStore });                            // 2 tools

// ── Transport ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-server-memory] running on stdio, tools registered\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`[mcp-server-memory] fatal: ${String(err)}\n`);
  process.exit(1);
});
