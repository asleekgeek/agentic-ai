/**
 * graph-store.ts — PostgreSQL backend for the code-intelligence graph.
 *
 * This is the TypeScript port of graph_store.rs (lbug → pg).
 * The Rust impl used LadybugDB with Cypher queries; this impl uses
 * PostgreSQL with parameterised SQL queries over a flat node + edge table.
 *
 * source: automatised-pipeline/0.0.9/src/graph_store.rs
 */

import pg from "pg";
import { CODEBASE_SCHEMA_DDL } from "./pg-schema.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// PG connection pool — shared singleton
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const connStr = process.env["DATABASE_URL"] ??
      "postgresql://localhost:5432/cortex_agentic"; // source: packages/memory/src/remember/storage/pg-schema-tables.ts — shared DB
    _pool = new Pool({ connectionString: connStr, max: 5 });
    _pool.on("error", (err) => {
      process.stderr.write(`codebase pg pool error: ${err.message}\n`);
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

let _schemaInitialised = false;

export async function ensureSchema(): Promise<void> {
  if (_schemaInitialised) return;
  const pool = getPool();
  await pool.query(CODEBASE_SCHEMA_DDL);
  _schemaInitialised = true;
}

// ---------------------------------------------------------------------------
// GraphStore — wraps a specific graph_id in the codebase_graphs table
// ---------------------------------------------------------------------------

export interface GraphRecord {
  graph_id: string;
  codebase_path: string;
  output_dir: string;
  language: string;
  created_at: Date;
  indexed_at: Date | null;
  resolved_at: Date | null;
  clustered_at: Date | null;
  node_count: number;
  edge_count: number;
  files_indexed: number;
  elapsed_ms: number;
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
}

export class GraphStore {
  constructor(public readonly graphId: string) {}

  // ── Graph record management ───────────────────────────────────────────────

  static async create(
    codebasePath: string,
    outputDir: string,
    language: string
  ): Promise<GraphStore> {
    await ensureSchema();
    const pool = getPool();
    const res = await pool.query<{ graph_id: string }>(
      `INSERT INTO codebase_graphs (codebase_path, output_dir, language)
       VALUES ($1, $2, $3) RETURNING graph_id`,
      [codebasePath, outputDir, language]
    );
    const row = res.rows[0];
    if (!row) throw new Error("GraphStore.create: no row returned");
    return new GraphStore(row.graph_id);
  }

  /**
   * Finds the most-recent graph for a given output_dir, or creates a new one.
   * source: graph_store.rs:133-151 — open_or_create()
   */
  static async openOrCreate(
    codebasePath: string,
    outputDir: string,
    language = "auto"
  ): Promise<GraphStore> {
    await ensureSchema();
    const pool = getPool();
    const res = await pool.query<{ graph_id: string }>(
      `SELECT graph_id FROM codebase_graphs
       WHERE output_dir = $1
       ORDER BY created_at DESC LIMIT 1`,
      [outputDir]
    );
    if (res.rows[0]) {
      return new GraphStore(res.rows[0].graph_id);
    }
    return GraphStore.create(codebasePath, outputDir, language);
  }

  /** Resolves graph_id from a graph path (output_dir or graph_id string). */
  static async fromGraphPath(graphPath: string): Promise<GraphStore> {
    await ensureSchema();
    const pool = getPool();
    // Check if it's a UUID (graph_id directly)
    if (/^[0-9a-f-]{36}$/.test(graphPath)) {
      const r = await pool.query<{ graph_id: string }>(
        "SELECT graph_id FROM codebase_graphs WHERE graph_id = $1",
        [graphPath]
      );
      if (r.rows[0]) return new GraphStore(r.rows[0].graph_id);
    }
    // Look up by output_dir (exact or as prefix)
    const r2 = await pool.query<{ graph_id: string }>(
      `SELECT graph_id FROM codebase_graphs
       WHERE output_dir = $1 OR output_dir LIKE $2
       ORDER BY created_at DESC LIMIT 1`,
      [graphPath, graphPath + "%"]
    );
    if (r2.rows[0]) return new GraphStore(r2.rows[0].graph_id);
    throw new Error(`GraphStore.fromGraphPath: no graph found for path ${graphPath}`);
  }

  async getRecord(): Promise<GraphRecord> {
    const pool = getPool();
    const r = await pool.query<GraphRecord>(
      "SELECT * FROM codebase_graphs WHERE graph_id = $1",
      [this.graphId]
    );
    const row = r.rows[0];
    if (!row) throw new Error(`GraphStore: graph_id ${this.graphId} not found`);
    return row;
  }

  async updatePhase(phase: "indexed" | "resolved" | "clustered", stats?: {
    node_count?: number;
    edge_count?: number;
    files_indexed?: number;
    elapsed_ms?: number;
  }): Promise<void> {
    const pool = getPool();
    const col = `${phase}_at`;
    let sql = `UPDATE codebase_graphs SET ${col} = NOW()`;
    const params: unknown[] = [this.graphId];
    let idx = 2;
    if (stats) {
      for (const [k, v] of Object.entries(stats)) {
        if (v !== undefined) {
          sql += `, ${k} = $${idx++}`;
          params.push(v);
        }
      }
    }
    sql += ` WHERE graph_id = $1`;
    await pool.query(sql, params);
  }

  // ── Node operations ───────────────────────────────────────────────────────

  /**
   * Inserts or upserts a single node.
   * source: graph_store.rs:164-175 — insert_node()
   */
  async insertNode(label: string, props: Record<string, unknown>): Promise<void> {
    const pool = getPool();
    const allProps = { ...props, label, graph_id: this.graphId };
    const cols = Object.keys(allProps);
    const vals = Object.values(allProps);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const setClauses = cols
      .filter(c => c !== "id" && c !== "graph_id")
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(", ");
    await pool.query(
      `INSERT INTO codebase_nodes (${cols.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (graph_id, id) DO UPDATE SET ${setClauses}`,
      vals
    );
  }

  /**
   * Bulk-inserts nodes of the same label.
   * source: graph_store.rs:195-215 — bulk_insert_nodes()
   * Uses a single multi-row INSERT for performance.
   * source: graph_store.rs:94 — BULK_BATCH_SIZE = 500
   */
  async bulkInsertNodes(
    label: string,
    rows: Array<Record<string, unknown>>
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const BATCH = 500; // source: graph_store.rs:94
    const pool = getPool();
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      // Collect all unique columns across the chunk
      const colSet = new Set<string>(["id", "graph_id", "label"]);
      for (const row of chunk) {
        for (const k of Object.keys(row)) colSet.add(k);
      }
      const cols = Array.from(colSet);
      const vals: unknown[] = [];
      const rowPlaceholders: string[] = [];
      for (const row of chunk) {
        const ph: string[] = [];
        for (const col of cols) {
          if (col === "graph_id") {
            ph.push(`$${vals.length + 1}`);
            vals.push(this.graphId);
          } else if (col === "label") {
            ph.push(`$${vals.length + 1}`);
            vals.push(label);
          } else {
            ph.push(`$${vals.length + 1}`);
            vals.push(row[col] ?? null);
          }
        }
        rowPlaceholders.push(`(${ph.join(", ")})`);
      }
      const setClauses = cols
        .filter(c => c !== "id" && c !== "graph_id")
        .map(c => `${c} = EXCLUDED.${c}`)
        .join(", ");
      await pool.query(
        `INSERT INTO codebase_nodes (${cols.join(", ")})
         VALUES ${rowPlaceholders.join(", ")}
         ON CONFLICT (graph_id, id) DO UPDATE SET ${setClauses}`,
        vals
      );
      inserted += chunk.length;
    }
    return inserted;
  }

  /**
   * Inserts a single directed edge.
   * source: graph_store.rs:253-276 — insert_edge()
   */
  async insertEdge(
    relType: string,
    fromId: string,
    toId: string,
    props: Record<string, unknown> = {}
  ): Promise<void> {
    const pool = getPool();
    const confidence = props["confidence"] ?? null;
    const resMethod = props["resolution_method"] ?? null;
    const depthVal = props["depth"] ?? null;
    await pool.query(
      `INSERT INTO codebase_edges (graph_id, rel_type, from_id, to_id, confidence, resolution_method, depth)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [this.graphId, relType, fromId, toId, confidence, resMethod, depthVal]
    );
  }

  /**
   * Bulk-inserts edges of the same type.
   * source: graph_store.rs:229-251 — bulk_insert_edges()
   */
  async bulkInsertEdges(
    relType: string,
    edges: Array<{ from: string; to: string; props?: Record<string, unknown> }>
  ): Promise<number> {
    if (edges.length === 0) return 0;
    const BATCH = 500; // source: graph_store.rs:94
    const pool = getPool();
    let inserted = 0;
    for (let i = 0; i < edges.length; i += BATCH) {
      const chunk = edges.slice(i, i + BATCH);
      const vals: unknown[] = [];
      const ph: string[] = [];
      for (const e of chunk) {
        const base = vals.length;
        vals.push(this.graphId, relType, e.from, e.to,
          e.props?.["confidence"] ?? null,
          e.props?.["resolution_method"] ?? null,
          e.props?.["depth"] ?? null
        );
        // 7 columns: graph_id, rel_type, from_id, to_id, confidence, resolution_method, depth
        // source: CODEBASE_SCHEMA_DDL codebase_edges INSERT column order
        // eslint-disable-next-line @typescript-eslint/no-magic-numbers
        const [p1,p2,p3,p4,p5,p6,p7] = [base+1,base+2,base+3,base+4,base+5,base+6,base+7];
        ph.push(`($${p1},$${p2},$${p3},$${p4},$${p5},$${p6},$${p7})`);
      }
      await pool.query(
        `INSERT INTO codebase_edges
         (graph_id, rel_type, from_id, to_id, confidence, resolution_method, depth)
         VALUES ${ph.join(",")}`,
        vals
      );
      inserted += chunk.length;
    }
    return inserted;
  }

  // ── Query operations ──────────────────────────────────────────────────────

  /**
   * Executes an arbitrary SQL query returning rows.
   * NOTE: This is NOT Cypher. The query_graph MCP tool accepts Cypher-like
   * syntax and we translate common patterns to SQL.
   * source: graph_store.rs:279-287 — execute_query()
   */
  async executeQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const pool = getPool();
    const r = await pool.query(sql, params);
    const columns = r.fields.map(f => f.name);
    const rows = r.rows.map(row =>
      r.fields.map(f => {
        const v = row[f.name];
        return v === null || v === undefined ? "" : String(v);
      })
    );
    return { columns, rows };
  }

  /**
   * Returns the total number of nodes across all labels.
   * source: graph_store.rs:290-304 — node_count()
   */
  async nodeCount(): Promise<number> {
    const pool = getPool();
    const r = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM codebase_nodes WHERE graph_id = $1",
      [this.graphId]
    );
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }

  /**
   * Returns the total number of edges.
   * source: graph_store.rs:307-321 — edge_count()
   */
  async edgeCount(): Promise<number> {
    const pool = getPool();
    const r = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM codebase_edges WHERE graph_id = $1",
      [this.graphId]
    );
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }

  /** Returns nodes of a label. */
  async nodesOfLabel(label: string): Promise<Array<Record<string, string | null>>> {
    const pool = getPool();
    const r = await pool.query(
      "SELECT * FROM codebase_nodes WHERE graph_id = $1 AND label = $2",
      [this.graphId, label]
    );
    return r.rows;
  }

  /** Returns all edges of a rel_type. */
  async edgesOfType(relType: string): Promise<Array<{ from_id: string; to_id: string; confidence: number | null; resolution_method: string | null; depth: number | null }>> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT from_id, to_id, confidence, resolution_method, depth
       FROM codebase_edges WHERE graph_id = $1 AND rel_type = $2`,
      [this.graphId, relType]
    );
    return r.rows;
  }

  /** Looks up a node by qualified_name (or id) across all labels. */
  async findNode(qualifiedName: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT * FROM codebase_nodes
       WHERE graph_id = $1 AND (qualified_name = $2 OR id = $2)
       LIMIT 1`,
      [this.graphId, qualifiedName]
    );
    return r.rows[0] ?? null;
  }

  /** Looks up a node by id. */
  async findNodeById(id: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();
    const r = await pool.query(
      "SELECT * FROM codebase_nodes WHERE graph_id = $1 AND id = $2 LIMIT 1",
      [this.graphId, id]
    );
    return r.rows[0] ?? null;
  }

  /** Returns outgoing edges from a node id. */
  async outEdges(nodeId: string): Promise<Array<{ rel_type: string; to_id: string; confidence: number | null; resolution_method: string | null }>> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT rel_type, to_id, confidence, resolution_method
       FROM codebase_edges WHERE graph_id = $1 AND from_id = $2`,
      [this.graphId, nodeId]
    );
    return r.rows;
  }

  /** Returns incoming edges to a node id. */
  async inEdges(nodeId: string): Promise<Array<{ rel_type: string; from_id: string; confidence: number | null; resolution_method: string | null }>> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT rel_type, from_id, confidence, resolution_method
       FROM codebase_edges WHERE graph_id = $1 AND to_id = $2`,
      [this.graphId, nodeId]
    );
    return r.rows;
  }

  /** Deletes all data for this graph. */
  async drop(): Promise<void> {
    const pool = getPool();
    await pool.query(
      "DELETE FROM codebase_graphs WHERE graph_id = $1",
      [this.graphId]
    );
  }
}

// ---------------------------------------------------------------------------
// Cypher → SQL translator (for query_graph tool)
// ---------------------------------------------------------------------------

/**
 * Translates a subset of Cypher queries to SQL against the PG schema.
 * Covers the patterns actually used by agents:
 *   MATCH (n:Label) RETURN ...
 *   MATCH (n:Label) WHERE n.prop = '...' RETURN ...
 *   MATCH (a)-[:Rel]->(b) WHERE ... RETURN ...
 *   MATCH (n:Label) RETURN count(n)
 *
 * source: graph_store.rs:279-287 — execute_query() accepts Cypher natively.
 * We approximate it for the MCP surface; complex Cypher returns an error.
 */
export function cypherToSql(cypher: string, graphId: string): { sql: string; params: unknown[] } | null {
  const clean = cypher.trim();

  // Pattern: MATCH (n:Label) RETURN count(n)
  const countMatch = clean.match(
    /^MATCH\s*\(n:(\w+)\)\s*RETURN\s*count\(n\)$/i
  );
  if (countMatch) {
    const label = countMatch[1];
    return {
      sql: "SELECT COUNT(*) AS \"count(n)\" FROM codebase_nodes WHERE graph_id = $1 AND label = $2",
      params: [graphId, label],
    };
  }

  // Pattern: MATCH (n:Label) RETURN n.x, n.y, ...
  const simpleMatch = clean.match(
    /^MATCH\s*\(n:(\w+)\)\s*(?:WHERE\s+(.+?))?\s*RETURN\s+(.+?)(?:\s+LIMIT\s+(\d+))?$/is
  );
  if (simpleMatch) {
    // Capture groups: [1]=label [2]=where [3]=return [4]=limit — source: regex above
    /* eslint-disable @typescript-eslint/no-magic-numbers */
    const label = simpleMatch[1] ?? "";
    const whereClause = simpleMatch[2];
    const returnClause = simpleMatch[3] ?? "";
    const limit = simpleMatch[4];
    /* eslint-enable @typescript-eslint/no-magic-numbers */
    const params: unknown[] = [graphId, label];
    let sql = `SELECT ${buildSelectCols(returnClause, "n")} FROM codebase_nodes n WHERE graph_id = $1 AND label = $2`;
    if (whereClause) {
      const { clause, addedParams } = translateWhere(whereClause, "n", params.length);
      sql += ` AND ${clause}`;
      params.push(...addedParams);
    }
    if (limit) sql += ` LIMIT ${parseInt(limit, 10)}`;
    return { sql, params };
  }

  // Pattern: MATCH (a:From)-[:Rel]->(b:To) WHERE ... RETURN ...
  const edgeMatch = clean.match(
    /^MATCH\s*\(a:(\w+)\)-\[:(\w+)\]->\(b:(\w+)\)\s*(?:WHERE\s+(.+?))?\s*RETURN\s+(.+?)(?:\s+LIMIT\s+(\d+))?$/is
  );
  if (edgeMatch) {
    // Capture groups: [1]=fromLabel [2]=relType [3]=toLabel [4]=where [5]=return [6]=limit
    /* eslint-disable @typescript-eslint/no-magic-numbers */
    const fromLabel = edgeMatch[1] ?? "";
    const relType = edgeMatch[2] ?? "";
    const toLabel = edgeMatch[3] ?? "";
    const whereClause = edgeMatch[4];
    const returnClause = edgeMatch[5] ?? "";
    const limit = edgeMatch[6];
    /* eslint-enable @typescript-eslint/no-magic-numbers */
    const params: unknown[] = [graphId, relType, fromLabel, toLabel];
    let sql = `
      SELECT ${buildSelectCols(returnClause, "a", "b")}
      FROM codebase_edges e
      JOIN codebase_nodes a ON a.graph_id = e.graph_id AND a.id = e.from_id AND a.label = $3
      JOIN codebase_nodes b ON b.graph_id = e.graph_id AND b.id = e.to_id AND b.label = $4
      WHERE e.graph_id = $1 AND e.rel_type = $2`;
    if (whereClause) {
      const { clause, addedParams } = translateWhere(whereClause, "a", params.length, "b");
      sql += ` AND ${clause}`;
      params.push(...addedParams);
    }
    if (limit) sql += ` LIMIT ${parseInt(limit, 10)}`;
    return { sql, params };
  }

  return null; // Cannot translate
}

function buildSelectCols(returnClause: string, ..._aliases: string[]): string {
  // n.qualified_name → n.qualified_name (alias as "n.qualified_name")
  const parts = returnClause.split(",").map(p => {
    const t = p.trim();
    if (t.match(/^\w+\.\w+$/)) return `${t} AS "${t}"`;
    if (t.match(/^count\(\w+\)$/i)) return `COUNT(*) AS "${t}"`;
    return t;
  });
  return parts.join(", ");
}

function translateWhere(
  where: string,
  primaryAlias: string,
  paramOffset: number,
  secondaryAlias?: string
): { clause: string; addedParams: unknown[] } {
  // n.prop = 'value' → n.prop = $N
  const params: unknown[] = [];
  let pIdx = paramOffset + 1;
  let clause = where;
  clause = clause.replace(/(\w+)\.(\w+)\s*=\s*'((?:[^'\\]|\\.)*)'/g, (_m, alias, prop, val) => {
    params.push(val.replace(/\\'/g, "'").replace(/\\\\/g, "\\"));
    return `${alias}.${prop} = $${pIdx++}`;
  });
  // Prefix alias if unqualified
  void primaryAlias; void secondaryAlias;
  return { clause, addedParams: params };
}
