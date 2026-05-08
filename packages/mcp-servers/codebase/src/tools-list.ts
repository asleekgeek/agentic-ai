/**
 * tools-list.ts — MCP tools/list response payload (23 tools).
 *
 * Extracted from index.ts to keep the entry-point file under the 500-line limit.
 * source: automatised-pipeline/0.0.9/src/tool_schemas.rs tools_list()
 */

export const TOOLS_LIST = {
  tools: [
    {
      name: "health_check",
      description: "Stage 0 — Healthcheck + handshake verification. Returns server identity, protocol version, and the registered stage count.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "extract_finding",
      description: "Stage 1a — Deterministic extraction. Normalizes one incoming finding to the canonical schema, writes stage-1.source.json + stage-1.extracted.json atomically.",
      inputSchema: {
        type: "object",
        required: ["finding", "output_dir"],
        additionalProperties: false,
        properties: {
          finding: { oneOf: [{ type: "object" }, { type: "string", pattern: "^/.+\\.json$" }] },
          output_dir: { type: "string", pattern: "^/.+" },
          run_id: { type: "string" },
        },
      },
    },
    {
      name: "refine_finding",
      description: "Stage 1b — Orchestrator-aware persistence. Reads stage-1.extracted.json, composes stage-1.refined.json.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir", "refined_prompt", "refinement"],
        additionalProperties: false,
        properties: {
          run_id: { type: "string" }, finding_id: { type: "string" },
          output_dir: { type: "string", pattern: "^/.+" },
          refined_prompt: { type: "object" }, refinement: { type: "object" },
        },
      },
    },
    {
      name: "start_verification",
      description: "Stage 2a — Create a clarification session for a refined finding.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir"],
        additionalProperties: false,
        properties: { run_id: { type: "string" }, finding_id: { type: "string" }, output_dir: { type: "string", pattern: "^/.+" } },
      },
    },
    {
      name: "append_clarification",
      description: "Stage 2b — Append one turn to stage-2.session.json.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir", "kind", "content"],
        additionalProperties: false,
        properties: {
          run_id: { type: "string" }, finding_id: { type: "string" },
          output_dir: { type: "string", pattern: "^/.+" },
          kind: { enum: ["agent_question", "user_answer"] },
          content: { type: "string", minLength: 1 }, meta: { type: "object" },
        },
      },
    },
    {
      name: "finalize_verification",
      description: "Stage 2c — Consume the user-ready signal. Computes transcript digest, writes stage-2.verified.json.", // source: main.rs stages/stage-2.md §12.3 — sha256 digest
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir"],
        additionalProperties: false,
        properties: { run_id: { type: "string" }, finding_id: { type: "string" }, output_dir: { type: "string", pattern: "^/.+" } },
      },
    },
    {
      name: "abort_verification",
      description: "Stage 2d — Kill a non-terminal session.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir"],
        additionalProperties: false,
        properties: { run_id: { type: "string" }, finding_id: { type: "string" }, output_dir: { type: "string", pattern: "^/.+" }, reason: { type: "string" } },
      },
    },
    {
      name: "index_codebase",
      description: "Stage 3a — Walk the directory, parse source files (TypeScript, Python, Rust), and persist a code-intelligence graph to PostgreSQL.",
      inputSchema: {
        type: "object",
        required: ["path", "output_dir"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          language: { type: "string", enum: ["auto", "rust", "python", "typescript", "javascript"], default: "auto" },
          output_dir: { type: "string" },
        },
      },
    },
    {
      name: "query_graph",
      description: "Stage 3a — Execute a Cypher-like query against an indexed code graph. Subset of Cypher translated to PostgreSQL SQL.",
      inputSchema: { type: "object", required: ["graph_path", "query"], additionalProperties: false, properties: { graph_path: { type: "string" }, query: { type: "string" } } },
    },
    {
      name: "get_symbol",
      description: "Stage 3a — Look up a symbol by qualified name. Returns node properties + incoming/outgoing edges.",
      inputSchema: { type: "object", required: ["graph_path", "qualified_name"], additionalProperties: false, properties: { graph_path: { type: "string" }, qualified_name: { type: "string" } } },
    },
    {
      name: "resolve_graph",
      description: "Stage 3b — Resolve cross-file edges (Imports, Calls, Implements, Extends, Uses). Runs after index_codebase.",
      inputSchema: { type: "object", required: ["graph_path"], additionalProperties: false, properties: { graph_path: { type: "string" } } },
    },
    {
      name: "cluster_graph",
      description: "Stage 3c — Louvain+C2 community detection + BFS process tracing. Requires resolve_graph to have been called first.",
      inputSchema: { type: "object", required: ["graph_path"], additionalProperties: false, properties: { graph_path: { type: "string" }, resolution_param: { type: "number", default: 1.0 } } },
    },
    {
      name: "get_processes",
      description: "Stage 3c — List all detected processes (execution flows from entry points). Requires cluster_graph.",
      inputSchema: { type: "object", required: ["graph_path"], additionalProperties: false, properties: { graph_path: { type: "string" } } },
    },
    {
      name: "get_impact",
      description: "Stage 3c — Blast-radius analysis for a symbol. Returns communities + processes it participates in.",
      inputSchema: { type: "object", required: ["graph_path", "qualified_name"], additionalProperties: false, properties: { graph_path: { type: "string" }, qualified_name: { type: "string" } } },
    },
    {
      name: "search_codebase",
      description: "Stage 3d — Hybrid search (PG FTS + TF-IDF + RRF). Returns ranked symbols. Requires analyze_codebase or cluster_graph.",
      inputSchema: {
        type: "object",
        required: ["graph_path", "query"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string" }, query: { type: "string" },
          limit: { type: "integer", default: 20 },
          label_filter: { type: "string", enum: ["Function", "Method", "Struct", "Enum", "Trait", "Module", "Constant", "TypeAlias"] },
        },
      },
    },
    {
      name: "get_context",
      description: "Stage 3d — Full symbol view: imports, calls, community, processes.",
      inputSchema: { type: "object", required: ["graph_path", "qualified_name"], additionalProperties: false, properties: { graph_path: { type: "string" }, qualified_name: { type: "string" } } },
    },
    {
      name: "analyze_codebase",
      description: "Stage 3 — All-in-one: index_codebase + resolve_graph + cluster_graph in sequence.",
      inputSchema: {
        type: "object",
        required: ["path", "output_dir"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          language: { type: "string", enum: ["auto", "rust", "python", "typescript", "javascript"], default: "auto" },
          output_dir: { type: "string" },
          resolution_param: { type: "number", default: 1.0 },
          lsp: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "detect_changes",
      description: "Stage 3e — Git diff impact analysis. Maps changed lines to affected symbols, communities, processes.",
      inputSchema: {
        type: "object",
        required: ["graph_path"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string" }, diff_text: { type: "string" },
          codebase_path: { type: "string" },
          base_ref: { type: "string", default: "HEAD~1" }, head_ref: { type: "string", default: "HEAD" },
        },
      },
    },
    {
      name: "lsp_resolve",
      description: "Stage 3b-v2 — LSP-enhanced resolution. NOT YET PORTED — returns explicit error.",
      inputSchema: {
        type: "object",
        required: ["graph_path", "codebase_path"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string" }, codebase_path: { type: "string" },
          language: { type: "string" }, lsp_command: { type: "string" },
          timeout_ms: { type: "integer", default: 30000 }, // source: tool_schemas.rs lsp_resolve_schema timeout_ms default
        },
      },
    },
    {
      name: "prepare_prd_input",
      description: "Stage 4 — Bundle verified finding + graph intel into stage-4.prd_input.json.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir", "graph_path"],
        additionalProperties: false,
        properties: {
          run_id: { type: "string" }, finding_id: { type: "string" },
          output_dir: { type: "string", pattern: "^/.+" }, graph_path: { type: "string", pattern: "^/.+" },
        },
      },
    },
    {
      name: "validate_prd_against_graph",
      description: "Stage 6 — Validate PRD: symbol hallucination, community consistency, process-impact contradictions.",
      inputSchema: {
        type: "object",
        required: ["prd_path", "graph_path"],
        additionalProperties: false,
        properties: {
          prd_path: { type: "string", pattern: "^/.+" }, graph_path: { type: "string", pattern: "^/.+" },
          affected_symbols_path: { type: "string", pattern: "^/.+" },
          output_dir: { type: "string", pattern: "^/.+" }, run_id: { type: "string" }, finding_id: { type: "string" },
        },
      },
    },
    {
      name: "check_security_gates",
      description: "Stage 8 — Graph-aware security gates: S1 auth-critical community, S2 unsafe symbol, S3 public API, S4 unresolved imports, S5 test gap.",
      inputSchema: {
        type: "object",
        required: ["graph_path", "changed_symbols"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string", pattern: "^/.+" },
          changed_symbols: { type: "array", items: { type: "string" } },
          output_dir: { type: "string", pattern: "^/.+" }, run_id: { type: "string" }, finding_id: { type: "string" },
        },
      },
    },
    {
      name: "verify_semantic_diff",
      description: "Stage 9 — Compare post-implementation graph against pre-implementation graph for regressions.",
      inputSchema: {
        type: "object",
        required: ["before_graph_path", "after_graph_path"],
        additionalProperties: false,
        properties: {
          before_graph_path: { type: "string", pattern: "^/.+" },
          after_graph_path: { type: "string", pattern: "^/.+" },
          report_path: { type: "string", pattern: "^/.+" },
        },
      },
    },
  ],
} as const;
