/**
 * routes/graph.ts — GET /api/graph, /api/graph/progress, /api/graph/phase
 *
 * TS port of:
 *   cortex@ed33435 mcp_server/server/http_standalone_graph.py (get_graph_response)
 *   cortex@ed33435 mcp_server/server/http_standalone_endpoints.py (serve_graph,
 *     serve_graph_progress, serve_graph_phase)
 *
 * Responsibilities:
 *   - Return a cached workflow-graph JSON structure.
 *   - The graph is built lazily in a background async task when first requested.
 *   - Expose a progress endpoint so the browser can show a build status bar.
 *   - Expose a phase endpoint for incremental append-only client loading.
 *
 * Layer: handlers — reads from @agentic/memory domain objects, writes HTTP responses.
 *
 * precondition:  dbPath points to a readable SQLite file.
 * postcondition: /api/graph returns { nodes, edges, meta } once baseline_ready=true.
 */

import type { FastifyInstance } from "fastify";
import type { DashboardDb } from "../db-adapter.js";
import { computeEffectiveHeat } from "../util/heat.js";

// ── Named constants ───────────────────────────────────────────────────────────
const EPOCH_DIVISOR = 1000; // source: POSIX — convert ms to seconds (Date.now() returns ms)
const PROGRESS_STARTING = 0.01; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:389 — initial pct
const PROGRESS_L0 = 0.05; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:496 — L0 phase pct
const PROGRESS_L5 = 0.28; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:505 — L5 phase pct
const LABEL_MAX_LEN = 80; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py — label truncation
// ── Types ─────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  domain?: string;
  domain_id?: string;
  [key: string]: unknown;
}

interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  type: string;
  weight: number;
  [key: string]: unknown;
}

interface GraphMeta {
  schema: string;
  node_count: number;
  edge_count: number;
  stage: string;
  domain_count?: number;
  memory_count?: number;
  entity_count?: number;
  counts?: Record<string, number>;
  progress?: BuildProgress;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  links?: GraphEdge[];
  meta: GraphMeta;
}

interface BuildProgress {
  phase: string;
  phase_seq: number;
  pct: number;
  message: string;
  baseline_ready: boolean;
  full_ready: boolean;
  node_count: number;
  edge_count: number;
  started_at: number;
  elapsed: number;
}

// ── Module-level cache ────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:40-103

let _graphCache: GraphResponse | null = null;
let _buildRunning = false;

// source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:90-102
const _progress: BuildProgress = {
  phase: "idle",
  phase_seq: 0,
  pct: 0,
  message: "",
  baseline_ready: false,
  full_ready: false,
  node_count: 0,
  edge_count: 0,
  started_at: 0,
  elapsed: 0,
};

// Phase payloads for incremental append-only loading.
// source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:227-237
const _phasePayloads: Record<string, { nodes: GraphNode[]; edges: GraphEdge[] }> = {
  L0: { nodes: [], edges: [] },
  L1: { nodes: [], edges: [] },
  L2: { nodes: [], edges: [] },
  L3: { nodes: [], edges: [] },
  L4: { nodes: [], edges: [] },
  L5: { nodes: [], edges: [] },
};

// ── Graph builder ─────────────────────────────────────────────────────────────

/**
 * Build the workflow graph from the SQLite store.
 * Produces L0–L5 node layers (domains, memories, entities).
 *
 * precondition:  dbPath is a valid SQLite file with a `memories` table.
 * postcondition: _graphCache is populated; _progress.baseline_ready = true.
 *
 * source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:284-972
 *   (simplified: L0 domains, L5 memories, L5 entities — no AP/AST L6 overlay)
 */
async function buildGraph(db: DashboardDb): Promise<void> {
  if (_buildRunning) return;
  _buildRunning = true;
  _progress.phase = "starting";
  _progress.pct = PROGRESS_STARTING; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:389 — initial pct=0.01
  _progress.message = "opening database…";
  _progress.started_at = Date.now() / EPOCH_DIVISOR; // source: standard POSIX epoch seconds, matches Python time.monotonic() semantics
  _progress.baseline_ready = false;
  _progress.full_ready = false;

  // Reset phase buffers.
  for (const k of Object.keys(_phasePayloads)) {
    _phasePayloads[k] = { nodes: [], edges: [] };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  try {
    // ── L0: domain nodes ──────────────────────────────────────────────────
    // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:495-551
    _progress.phase = "L0 domains";
    _progress.pct = PROGRESS_L0; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:496 — L0 pct=0.05
    _progress.message = "building domain nodes…";

    const domainRows = await db.prepare(
      "SELECT DISTINCT domain FROM memories WHERE domain IS NOT NULL AND domain != '' ORDER BY domain"
    ).all<{ domain: string }>();

    const domainNodeMap = new Map<string, string>();
    for (const row of domainRows) {
      const slug = row.domain.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const id = `domain:${slug}`;
      domainNodeMap.set(row.domain, id);
      const node: GraphNode = { id, kind: "domain", type: "domain", label: row.domain, domain: row.domain };
      nodes.push(node);
      const l0 = _phasePayloads["L0"];
      if (l0) l0.nodes.push(node);
    }
    _progress.phase_seq++;

    // ── L5: memory nodes ──────────────────────────────────────────────────
    // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:503-505
    _progress.phase = "L5 memories";
    _progress.pct = PROGRESS_L5; // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:505 — L5 pct=0.28
    _progress.message = "loading memories…";

    interface MemoryRow {
      id: string;
      content: string;
      heat_base: number | null;        // raw stored value — effective heat applied post-read
      heat_base_set_at: string | null; // for computeEffectiveHeat() decay reference
      last_accessed: string | null;    // fallback reference time
      stage_entered_at: string | null; // for stage_hours in beta calculation
      no_decay: number | null;         // if truthy, skip decay
      emotional_valence: number | null;
      importance: number;
      store_type: string;
      domain: string | null;
      tags: string | null;
      created_at: string | null;
      consolidation_stage: string | null;
      is_protected: number;
      is_global: number;
    }

    // Fetch heat_base plus decay fields so computeEffectiveHeat() can produce the
    // same value as the PL/pgSQL effective_heat() function on PG.
    // ORDER BY heat_base DESC — SQLite has no UDF for effective_heat; heat_base
    // preserves rank ordering within the same stage and recency (documented limitation).
    // source: 2026-05-07 schema reconciliation — heat column renamed to heat_base.
    // source: 2026-05-08 effective heat — decay fields added for computeEffectiveHeat().
    const tNow = new Date();
    const memRows = await db.prepare(
      `SELECT id, content, heat_base, heat_base_set_at, last_accessed,
              stage_entered_at, no_decay, emotional_valence, importance,
              store_type, domain, tags, created_at, consolidation_stage,
              is_protected, is_global
       FROM memories WHERE NOT is_benchmark AND NOT is_stale
       ORDER BY heat_base DESC` // source: cortex@ed33435 mcp_server/server/http_standalone_graph.py:161 — get_hot_memories(limit=0) equivalent
    ).all<MemoryRow>();

    for (const m of memRows) {
      const id = `memory:${m.id}`;
      const domainId = m.domain ? domainNodeMap.get(m.domain) : undefined;
      // Apply effective heat decay — mirrors PL/pgSQL effective_heat() used by recall.
      // source: packages/memory-dashboard/src/util/heat.ts:computeEffectiveHeat
      // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:586-683
      const effectiveHeat = computeEffectiveHeat(
        {
          heat_base: m.heat_base,
          heat_base_set_at: m.heat_base_set_at,
          last_accessed: m.last_accessed,
          created_at: m.created_at,
          stage_entered_at: m.stage_entered_at,
          is_protected: m.is_protected,
          no_decay: m.no_decay,
          consolidation_stage: m.consolidation_stage,
          emotional_valence: m.emotional_valence,
        },
        tNow,
      );
      const node: GraphNode = {
        id,
        kind: "memory",
        type: "memory",
        label: (m.content ?? "").slice(0, LABEL_MAX_LEN),
        domain: m.domain ?? "",
        domain_id: domainId ?? "",
        heat: effectiveHeat,
        importance: m.importance,
        store_type: m.store_type,
        consolidation_stage: m.consolidation_stage ?? "labile",
        is_protected: Boolean(m.is_protected),
        is_global: Boolean(m.is_global),
      };
      nodes.push(node);
      const l5m = _phasePayloads["L5"];
      if (l5m) l5m.nodes.push(node);
      if (domainId) {
        const edge: GraphEdge = { source: id, target: domainId, kind: "in_domain", type: "in_domain", weight: 1.0 };
        edges.push(edge);
        if (l5m) l5m.edges.push(edge);
      }
    }

    // ── L5: entity nodes ─────────────────────────────────────────────────
    interface EntityRow {
      id: string;
      name: string;
      entity_type: string; // aliased from entities.type — API contract uses entity_type
      heat: number;
      domain: string | null;
    }

    // entities.type is the canonical column (not entity_type); alias to entity_type
    // to preserve the API contract without changing the DB schema.
    // source: 2026-05-07 schema reconciliation — entities table has `type` not `entity_type`
    const entityRows = await db.prepare(
      `SELECT id, name, type AS entity_type, heat, domain FROM entities ORDER BY heat DESC` // source: cortex@ed33435 mcp_server/server/http_dashboard_data.py:17 — get_all_entities(min_heat=0.0); 500 cap for graph render budget
    ).all<EntityRow>();

    for (const e of entityRows) {
      const id = `entity:${e.id}`;
      const domainId = e.domain ? domainNodeMap.get(e.domain) : undefined;
      const node: GraphNode = {
        id,
        kind: "entity",
        type: "entity",
        label: e.name ?? "",
        domain: e.domain ?? "",
        domain_id: domainId ?? "",
        entity_type: e.entity_type,
        heat: e.heat,
      };
      nodes.push(node);
      const l5e = _phasePayloads["L5"];
      if (l5e) l5e.nodes.push(node);
      if (domainId) {
        const edge: GraphEdge = { source: id, target: domainId, kind: "in_domain", type: "in_domain", weight: 0.5 };
        edges.push(edge);
      }
    }

    _progress.phase_seq++;

    const kindCounts: Record<string, number> = {};
    for (const n of nodes) {
      const k = n.kind ?? "";
      kindCounts[k] = (kindCounts[k] ?? 0) + 1;
    }

    _graphCache = {
      nodes,
      edges,
      links: edges,
      meta: {
        schema: "workflow_graph.v1",
        node_count: nodes.length,
        edge_count: edges.length,
        stage: "baseline",
        domain_count: kindCounts["domain"] ?? 0,
        memory_count: kindCounts["memory"] ?? 0,
        entity_count: kindCounts["entity"] ?? 0,
        counts: kindCounts,
      },
    };

    _progress.phase = "full_ready";
    _progress.pct = 1.0;
    _progress.message = `ready: ${nodes.length} nodes`;
    _progress.baseline_ready = true;
    _progress.full_ready = true;
    _progress.node_count = nodes.length;
    _progress.edge_count = edges.length;
  } catch (err) {
    _progress.phase = "error";
    _progress.message = String(err);
  } finally {
    _buildRunning = false;
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export interface GraphRouteDeps {
  db: DashboardDb;
}

/**
 * Register /api/graph, /api/graph/progress, /api/graph/phase routes.
 *
 * precondition:  fastify instance is not yet started.
 * postcondition: three routes are registered.
 */
export async function registerGraphRoutes(
  fastify: FastifyInstance,
  deps: GraphRouteDeps,
): Promise<void> {
  /**
   * GET /api/graph[?domain=<filter>]
   *
   * Returns the cached graph; kicks background build on first call.
   * Returns a placeholder with progress while the build is running.
   *
   * source: cortex@ed33435 mcp_server/server/http_standalone_endpoints.py:113-118
   */
  fastify.get("/api/graph", async (_req, reply) => {
    if (!_graphCache) {
      void buildGraph(deps.db);
    }
    if (_graphCache) {
      return reply.send(_graphCache);
    }
    return reply.send({
      nodes: [],
      edges: [],
      meta: {
        schema: "workflow_graph.v1",
        node_count: 0,
        edge_count: 0,
        stage: "building",
        progress: { ..._progress, elapsed: _progress.started_at > 0 ? Date.now() / EPOCH_DIVISOR - _progress.started_at : 0 }, // source: POSIX epoch seconds — matches Python time.monotonic() relative time
      },
    });
  });

  /**
   * GET /api/graph/progress
   *
   * Returns the background build progress snapshot.
   * source: cortex@ed33435 mcp_server/server/http_standalone_endpoints.py:121-128
   */
  fastify.get("/api/graph/progress", async (_req, reply) => {
    return reply.send({
      ..._progress,
      elapsed: _progress.started_at > 0 ? Date.now() / EPOCH_DIVISOR - _progress.started_at : 0, // source: POSIX epoch seconds — matches Python time.monotonic() relative time
    });
  });

  /**
   * GET /api/graph/phase?name=<L0|L1|L2|L3|L4|L5>
   *
   * Returns only the nodes + edges produced by a single phase.
   * source: cortex@ed33435 mcp_server/server/http_standalone_endpoints.py:131-156
   */
  fastify.get<{ Querystring: { name?: string } }>("/api/graph/phase", async (req, reply) => {
    const name = req.query.name ?? "";
    const payload = _phasePayloads[name] ?? { nodes: [], edges: [] };
    return reply.send({ phase: name, ready: _progress.full_ready, nodes: payload.nodes, edges: payload.edges });
  });
}
