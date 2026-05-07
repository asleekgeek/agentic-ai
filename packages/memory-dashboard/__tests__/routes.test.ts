/**
 * routes.test.ts — Fastify inject() tests for all dashboard routes.
 *
 * Tests use an in-process Fastify server (no real ports bound) via
 * fastify.inject(), so they are fast, deterministic, and need no
 * teardown of OS sockets.
 *
 * Coverage targets:
 *   - /health → 200 { ok: true }
 *   - /api/graph → 200, has nodes/edges/meta
 *   - /api/graph/progress → 200, has phase field
 *   - /api/graph/phase?name=L0 → 200, has nodes/edges
 *   - /api/wiki/list → 200, has pages array
 *   - /api/wiki/page → 200 or error object when file absent
 *   - /api/discussions → 200, has meta.total
 *   - /api/memories → 200 (with mock DB), has items array (canonical shape)
 *   - /api/memories/facets → 200, has total/domains/stages/emotions (canonical shape)
 *   - /api/sankey → 200, has transitions
 *   - Static index.html → 200 text/html
 *
 * Response shape contracts derived from canonical Python source:
 *   /api/memories:        source: cortex@ed33435 mcp_server/handlers/memories_page.py
 *   /api/memories/facets: source: cortex@ed33435 mcp_server/handlers/memories_facets.py
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";

import { SqliteAdapter } from "../src/db-adapter.js";
import { registerHealthRoutes } from "../src/routes/health.js";
import { registerGraphRoutes } from "../src/routes/graph.js";
import { registerWikiRoutes } from "../src/routes/wiki.js";
import { registerDiscussionRoutes } from "../src/routes/discussions.js";
import { registerSankeyRoutes } from "../src/routes/sankey.js";
import { registerMemoriesRoutes } from "../src/routes/memories.js";
import { registerFileDiffRoutes } from "../src/routes/file-diff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Test fixture: minimal SQLite DB ─────────────────────────────────────────

let tmpDb: string;
let fastify: FastifyInstance;
let tmpDir: string;

function createFixtureDb(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-dashboard-test-"));
  const dbPath = path.join(tmpDir, "memories.db");
  const db = new Database(dbPath);

  // Fixture schema uses heat_base (canonical column name since A3 migration).
  // source: packages/memory/src/remember/storage/sqlite-schema.ts
  // source: 2026-05-07 schema reconciliation — heat column renamed to heat_base
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT,
      heat_base REAL DEFAULT 0,
      importance REAL DEFAULT 0.5,
      store_type TEXT DEFAULT 'episodic',
      tags TEXT,
      created_at TEXT,
      domain TEXT,
      surprise_score REAL DEFAULT 0,
      emotional_valence REAL DEFAULT 0,
      compression_level INTEGER DEFAULT 0,
      is_compressed INTEGER DEFAULT 0,
      is_protected INTEGER DEFAULT 0,
      is_global INTEGER DEFAULT 0,
      access_count INTEGER DEFAULT 0,
      useful_count INTEGER DEFAULT 0,
      consolidation_stage TEXT DEFAULT 'labile',
      source TEXT,
      agent_context TEXT,
      replay_count INTEGER DEFAULT 0,
      hours_in_stage REAL DEFAULT 0,
      reconsolidation_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 1.0,
      encoding_strength REAL DEFAULT 1.0,
      schema_match_score REAL DEFAULT 0,
      interference_score REAL DEFAULT 0,
      hippocampal_dependency REAL DEFAULT 1.0,
      plasticity REAL DEFAULT 1.0,
      stability REAL DEFAULT 0,
      last_accessed TEXT,
      stage_entered_at TEXT,
      theta_phase_at_encoding REAL DEFAULT 0,
      excitability REAL DEFAULT 1.0,
      separation_index REAL DEFAULT 0,
      is_benchmark INTEGER DEFAULT 0,
      is_stale INTEGER DEFAULT 0
    );
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      heat REAL DEFAULT 0,
      domain TEXT
    );
    CREATE TABLE stage_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_stage TEXT,
      to_stage TEXT,
      count INTEGER DEFAULT 1,
      hours_in_prev_stage REAL DEFAULT 0
    );
  `);

  // Insert deterministic fixture rows.
  // heat_base replaces heat — source: 2026-05-07 schema reconciliation.
  db.prepare(
    "INSERT INTO memories (id, content, heat_base, store_type, domain, consolidation_stage) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("m1", "test memory alpha", 0.8, "episodic", "engineering", "labile");
  db.prepare(
    "INSERT INTO memories (id, content, heat_base, store_type, domain, consolidation_stage) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("m2", "test memory beta", 0.3, "semantic", "research", "consolidated");
  // entities.type is the canonical column (not entity_type) — source: 2026-05-07 schema reconciliation.
  db.prepare(
    "INSERT INTO entities (id, name, type, heat, domain) VALUES (?, ?, ?, ?, ?)"
  ).run("e1", "TestEntity", "concept", 0.5, "engineering");
  db.prepare(
    "INSERT INTO stage_transitions (from_stage, to_stage, count, hours_in_prev_stage) VALUES (?, ?, ?, ?)"
  ).run("labile", "early_ltp", 5, 2.5);

  db.close();
  return dbPath;
}

// ── Build test server ─────────────────────────────────────────────────────────

async function buildTestServer(dbPath: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../src/static"),
    prefix: "/",
    decorateReply: false,
  });

  // Use SqliteAdapter so tests exercise the same DashboardDb interface as production.
  // source: ADR-0042 §tests — parametrize via SqliteAdapter for SQLite path
  const rawDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  const db = new SqliteAdapter(rawDb);

  await registerHealthRoutes(app);
  await registerGraphRoutes(app, { db });
  await registerWikiRoutes(app);
  await registerDiscussionRoutes(app);
  await registerSankeyRoutes(app, { db });
  await registerMemoriesRoutes(app, { db });
  await registerFileDiffRoutes(app);

  return app;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDb = createFixtureDb();
  fastify = await buildTestServer(tmpDb);
  await fastify.ready();
});

afterAll(async () => {
  await fastify.close();
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with ok: true", async () => {
    const res = await fastify.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; pid: number }>();
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe("number");
  });
});

describe("GET /api/graph", () => {
  it("returns 200 with nodes, edges, meta", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/graph" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ nodes: unknown[]; edges: unknown[]; meta: { schema: string } }>();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.meta.schema).toBe("workflow_graph.v1");
  });
});

describe("GET /api/graph/progress", () => {
  it("returns 200 with phase field", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/graph/progress" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ phase: string; pct: number }>();
    expect(typeof body.phase).toBe("string");
    expect(typeof body.pct).toBe("number");
  });
});

describe("GET /api/graph/phase", () => {
  it("returns 200 with nodes and edges arrays for L0", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/graph/phase?name=L0" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ phase: string; nodes: unknown[]; edges: unknown[] }>();
    expect(body.phase).toBe("L0");
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });
});

describe("GET /api/wiki/list", () => {
  it("returns 200 with pages array", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/wiki/list" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pages: unknown[] }>();
    expect(Array.isArray(body.pages)).toBe(true);
  });
});

describe("GET /api/wiki/page", () => {
  it("returns error object when file absent", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/wiki/page?path=nonexistent.md" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ error?: string }>();
    expect(typeof body.error).toBe("string");
  });

  it("rejects path traversal", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/wiki/page?path=../../etc/passwd" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ error?: string }>();
    expect(body.error).toBeTruthy();
  });
});

describe("GET /api/discussions", () => {
  it("returns 200 with meta.total", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/discussions" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ meta: { total: number }; nodes: unknown[] }>();
    expect(typeof body.meta.total).toBe("number");
    expect(Array.isArray(body.nodes)).toBe(true);
  });
});

describe("GET /api/memories", () => {
  // Canonical shape: { items, next_cursor, page_count, sort }
  // source: cortex@ed33435 mcp_server/handlers/memories_page.py:serve() response dict
  it("returns 200 with items array matching workflow_graph.v1 shape", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/memories" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string; content: string; type: string; kind: string }>; next_cursor: string | null; page_count: number; sort: string }>();
    expect(Array.isArray(body.items)).toBe(true); // source: cortex@ed33435 mcp_server/handlers/memories_page.py — "items" key
    expect(body.items.length).toBeGreaterThan(0);
    // id is prefixed with "memory:" in workflow_graph.v1 node shape.
    // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_row_to_node — id: "memory:" + str(d.get("id"))
    expect(body.items[0]?.id).toBe("memory:m1");
    expect(body.items[0]?.type).toBe("memory"); // source: _row_to_node — type: "memory"
    expect(body.items[0]?.kind).toBe("memory"); // source: _row_to_node — kind: "memory"
    expect(typeof body.next_cursor === "string" || body.next_cursor === null).toBe(true);
    expect(typeof body.page_count).toBe("number");
    expect(body.sort).toBe("heat"); // source: memories_page.py — default sort="heat"
  });
});

describe("GET /api/memories/facets", () => {
  // Canonical shape: { total, domains, stages, emotions, global, protected, hot }
  // source: cortex@ed33435 mcp_server/handlers/memories_facets.py:payload dict
  it("returns 200 with canonical facets shape (total/domains/stages/emotions)", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/memories/facets" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      total: number;
      domains: Array<{ name: string; count: number }>;
      stages: Record<string, number>;
      emotions: Record<string, number>;
      global: number;
      protected: number;
      hot: number;
    }>();
    // source: cortex@ed33435 mcp_server/handlers/memories_facets.py — key "total"
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(2); // two fixture rows, neither is_stale
    // source: cortex@ed33435 mcp_server/handlers/memories_facets.py — key "domains" (array of {name,count})
    expect(Array.isArray(body.domains)).toBe(true);
    // source: cortex@ed33435 mcp_server/handlers/memories_facets.py — key "stages" (dict)
    expect(typeof body.stages).toBe("object");
    expect("labile" in body.stages).toBe(true); // source: stages dict has "labile" key
    // source: cortex@ed33435 mcp_server/handlers/memories_facets.py — key "emotions" (dict)
    expect(typeof body.emotions).toBe("object");
    expect("neutral" in body.emotions).toBe(true); // source: emotions dict has "neutral" key
    // source: cortex@ed33435 mcp_server/handlers/memories_facets.py — keys "global", "protected", "hot"
    expect(typeof body.global).toBe("number");
    expect(typeof body.protected).toBe("number");
    expect(typeof body.hot).toBe("number");
  });
});

describe("GET /api/sankey", () => {
  it("returns 200 with transitions, timing, stage_metrics", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/sankey" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ transitions: unknown[]; timing: Record<string, unknown>; stage_metrics: Record<string, unknown> }>();
    expect(Array.isArray(body.transitions)).toBe(true);
    expect(typeof body.timing).toBe("object");
    expect(typeof body.stage_metrics).toBe("object");
  });
});

describe("Static assets", () => {
  it("GET / returns 200 text/html", async () => {
    const res = await fastify.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });
});

describe("GET /api/file-diff", () => {
  it("returns 400 when name is missing", async () => { // source: RFC 7231 §6.5.1 — 400 Bad Request
    const res = await fastify.inject({ method: "GET", url: "/api/file-diff" });
    expect(res.statusCode).toBe(400); // source: RFC 7231 §6.5.1
  });
});
