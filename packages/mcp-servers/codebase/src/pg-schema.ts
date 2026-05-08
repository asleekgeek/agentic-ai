/**
 * pg-schema.ts — DDL for the code-intelligence graph tables in PostgreSQL.
 *
 * The Rust implementation uses LadybugDB (lbug) with Cypher queries.
 * This TypeScript port maps the same schema to PostgreSQL:
 *   - Node tables → pg tables with label column + properties
 *   - Rel tables  → pg edge tables with from_id / to_id + properties
 *
 * source: automatised-pipeline/0.0.9/src/graph_store.rs — node_table_ddl(),
 *         rel_table_ddl(), REL_TABLES, NODE_LABELS
 *
 * Design: single schema per graph, namespaced by a graph_id UUID.
 */

// source: graph_store.rs node label constants (NODE_DIRECTORY through NODE_STDLIB_SYMBOL)
export const NODE_LABELS = [
  "Directory", "File", "Module", "Function", "Method",
  "Struct", "Enum", "Variant", "Trait", "Field",
  "Constant", "TypeAlias", "Import", "CallSite",
  "Community", "Process", "StdlibSymbol",
] as const;

export type NodeLabel = (typeof NODE_LABELS)[number];

// source: search/bm25.rs SEARCHABLE_LABELS, search/mod.rs SEARCHABLE_LABELS
export const SEARCHABLE_LABELS: NodeLabel[] = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Module", "Constant", "TypeAlias",
];

// source: clustering.rs SYMBOL_LABELS
export const SYMBOL_LABELS: NodeLabel[] = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Constant", "TypeAlias", "Module",
];

// source: clustering.rs MEMBEROF_LABELS
export const MEMBEROF_LABELS: NodeLabel[] = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Constant", "TypeAlias", "Module",
];

// source: graph_store.rs node_table_ddl() — graphs registry table
const GRAPHS_DDL = `
CREATE TABLE IF NOT EXISTS codebase_graphs (
  graph_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_path TEXT        NOT NULL,
  output_dir    TEXT        NOT NULL,
  language      TEXT        NOT NULL DEFAULT 'auto',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indexed_at    TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  clustered_at  TIMESTAMPTZ,
  node_count    BIGINT      DEFAULT 0,
  edge_count    BIGINT      DEFAULT 0,
  files_indexed BIGINT      DEFAULT 0,
  elapsed_ms    BIGINT      DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codebase_graphs_path
  ON codebase_graphs(codebase_path, output_dir);
`;

// source: graph_store.rs node_table_ddl() — single wide node table replacing per-label lbug tables
// Properties mirror graph_store.rs schema: Directory, File, Module, Function, Method,
// Struct, Enum, Variant, Trait, Field, Constant, TypeAlias, Import, CallSite,
// Community, Process, StdlibSymbol.
const NODES_DDL = `
CREATE TABLE IF NOT EXISTS codebase_nodes (
  id              TEXT        NOT NULL,
  graph_id        UUID        NOT NULL REFERENCES codebase_graphs(graph_id) ON DELETE CASCADE,
  label           TEXT        NOT NULL,
  name            TEXT,
  qualified_name  TEXT,
  path            TEXT,
  start_line      BIGINT,
  end_line        BIGINT,
  visibility      TEXT,
  is_async        BOOLEAN,
  receiver_type   TEXT,
  extension       TEXT,
  size_bytes      BIGINT,
  type_annotation TEXT,
  alias           TEXT,
  is_glob         BOOLEAN,
  callee_name     TEXT,
  line            BIGINT,
  col             BIGINT,
  algorithm       TEXT,
  resolution_param DOUBLE PRECISION,
  member_count    BIGINT,
  modularity_contribution DOUBLE PRECISION,
  entry_point_id  TEXT,
  entry_kind      TEXT,
  entry_confidence DOUBLE PRECISION,
  depth           BIGINT,
  symbol_count    BIGINT,
  language        TEXT,
  canonical_path  TEXT,
  PRIMARY KEY (graph_id, id)
);
CREATE INDEX IF NOT EXISTS idx_codebase_nodes_graph_label
  ON codebase_nodes(graph_id, label);
CREATE INDEX IF NOT EXISTS idx_codebase_nodes_qn
  ON codebase_nodes(graph_id, qualified_name);
CREATE INDEX IF NOT EXISTS idx_codebase_nodes_name
  ON codebase_nodes(graph_id, name);
`;

// source: graph_store.rs rel_table_ddl() — single wide edge table replacing per-rel lbug tables
// Resolution edges carry confidence + resolution_method; participates edges carry depth.
const EDGES_DDL = `
CREATE TABLE IF NOT EXISTS codebase_edges (
  edge_id           BIGSERIAL   PRIMARY KEY,
  graph_id          UUID        NOT NULL REFERENCES codebase_graphs(graph_id) ON DELETE CASCADE,
  rel_type          TEXT        NOT NULL,
  from_id           TEXT        NOT NULL,
  to_id             TEXT        NOT NULL,
  confidence        DOUBLE PRECISION,
  resolution_method TEXT,
  depth             BIGINT
);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_graph_rel
  ON codebase_edges(graph_id, rel_type);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_from
  ON codebase_edges(graph_id, from_id);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_to
  ON codebase_edges(graph_id, to_id);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_from_to
  ON codebase_edges(graph_id, from_id, to_id, rel_type);
`;

/**
 * Creates all codebase graph tables. Idempotent (IF NOT EXISTS everywhere).
 * source: graph_store.rs node_table_ddl(), rel_table_ddl()
 */
export const CODEBASE_SCHEMA_DDL = GRAPHS_DDL + NODES_DDL + EDGES_DDL;
