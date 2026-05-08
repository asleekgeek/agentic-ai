/**
 * tool-handlers.ts — MCP tool dispatch: one case per pipeline stage.
 *
 * Extracted from index.ts to keep the entry-point file under the 500-line limit.
 * source: automatised-pipeline/0.0.9/src/main.rs handle_tool_call()
 */

import { indexCodebase } from "./indexer.js";
import { resolveGraph } from "./resolver.js";
import { clusterGraph, getProcesses, getImpact } from "./clustering.js";
import { searchGraph, getContext, getSymbol } from "./search.js";
import { GraphStore, cypherToSql } from "./graph-store.js";
import { analyzeDiff, analyzeGitDiff } from "./git-diff.js";
import { checkSecurityGates, writeSecurityReport } from "./security-gates.js";
import { diffGraphs } from "./semantic-diff.js";
import { preparePrdInput, validatePrdAgainstGraph } from "./prd-input.js";
import {
  runExtractFinding, runRefineFinding,
  runStartVerification, runAppendClarification,
  runFinalizeVerification, runAbortVerification,
} from "./findings.js";

// source: main.rs:53-55 — server identity constants (duplicated for handler independence)
const SERVER_NAME_HANDLER = "ai-architect";
const SERVER_VERSION_HANDLER = "0.1.0-ts";
const PROTOCOL_VERSION_HANDLER = "2024-11-05"; // source: main.rs:53 — MCP spec date

// source: tool_schemas.rs search_codebase_schema limit default = 20
const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Dispatches a tools/call request to the appropriate handler.
 * source: main.rs handle_tool_call() switch statement
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  stageCount: number
): Promise<unknown> {
  switch (name) {
    // Stage 0 — source: main.rs health_check handler
    case "health_check":
      return {
        server: SERVER_NAME_HANDLER,
        version: SERVER_VERSION_HANDLER,
        protocol: PROTOCOL_VERSION_HANDLER,
        implementation: "TypeScript (port of automatised-pipeline 0.0.9 Rust)",
        stages_registered: stageCount,
        backend: "PostgreSQL (cortex_agentic DB)",
        status: "ok",
      };

    // Stage 1 — source: main.rs stage 1a/1b handlers
    case "extract_finding":
      return runExtractFinding(args);
    case "refine_finding":
      return runRefineFinding(args);

    // Stage 2 — source: main.rs stage 2a/2b/2c/2d handlers
    case "start_verification":
      return runStartVerification(args);
    case "append_clarification":
      return runAppendClarification(args);
    case "finalize_verification":
      return runFinalizeVerification(args);
    case "abort_verification":
      return runAbortVerification(args);

    // Stage 3a — source: main.rs index_codebase handler
    case "index_codebase": {
      const codePath = String(args["path"] ?? "");
      const outputDir = String(args["output_dir"] ?? "");
      const lang = args["language"] as string | undefined;
      const result = await indexCodebase(
        codePath,
        outputDir,
        lang && lang !== "auto" ? lang as "typescript" : undefined
      );
      return {
        status: "ok",
        graph_path: result.graphPath,
        graph_id: result.graphId,
        node_count: result.nodeCount,
        edge_count: result.edgeCount,
        files_indexed: result.filesIndexed,
        elapsed_ms: result.elapsedMs,
      };
    }

    // Stage 3a — source: main.rs query_graph handler
    case "query_graph": {
      const graphPath = String(args["graph_path"] ?? "");
      const query = String(args["query"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const translated = cypherToSql(query, store.graphId);
      if (!translated) {
        return {
          status: "error",
          message: "Cannot translate Cypher query to SQL. Use SQL syntax for PostgreSQL backend.",
          hint: "Supported: MATCH (n:Label) RETURN ..., MATCH (n:Label) WHERE n.prop='val' RETURN ...",
        };
      }
      const result = await store.executeQuery(translated.sql, translated.params);
      return { columns: result.columns, rows: result.rows, row_count: result.rows.length };
    }

    // Stage 3a — source: main.rs get_symbol handler
    case "get_symbol": {
      const graphPath = String(args["graph_path"] ?? "");
      const qualifiedName = String(args["qualified_name"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await getSymbol(store, qualifiedName);
      if (!result) return { status: "not_found", qualified_name: qualifiedName };
      return { status: "ok", node: result.node, in_edges: result.inEdges, out_edges: result.outEdges };
    }

    // Stage 3b — source: main.rs resolve_graph handler
    case "resolve_graph": {
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await resolveGraph(store);
      return {
        status: "ok",
        imports_resolved: result.importsResolved,
        calls_resolved: result.callsResolved,
        impls_resolved: result.implsResolved,
        extends_resolved: result.extendsResolved,
        uses_resolved: result.usesResolved,
        total_edges: result.totalEdges,
        total_refs: result.totalRefs,
        unresolved_count: result.unresolved.length,
        elapsed_ms: result.elapsedMs,
      };
    }

    // Stage 3c — source: main.rs cluster_graph handler
    case "cluster_graph": {
      const graphPath = String(args["graph_path"] ?? "");
      const gamma = typeof args["resolution_param"] === "number" ? args["resolution_param"] : 1.0;
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await clusterGraph(store, gamma);
      return {
        status: "ok",
        communities: result.communities,
        modularity: result.modularity,
        processes: result.processes,
        elapsed_ms: result.elapsedMs,
      };
    }

    case "get_processes": {
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const procs = await getProcesses(store);
      return {
        status: "ok",
        processes: procs.map(p => ({
          name: p.name, entry_point: p.entryPoint,
          entry_kind: p.entryKind, depth: p.depth, node_count: p.nodeCount,
        })),
      };
    }

    case "get_impact": {
      const graphPath = String(args["graph_path"] ?? "");
      const qualifiedName = String(args["qualified_name"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await getImpact(store, qualifiedName);
      return { status: "ok", qualified_name: qualifiedName, communities: result.communities, processes: result.processes };
    }

    // Stage 3d — source: main.rs search_codebase handler
    case "search_codebase": {
      const graphPath = String(args["graph_path"] ?? "");
      const query = String(args["query"] ?? "");
      const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_SEARCH_LIMIT;
      const labelFilter = args["label_filter"] as string | undefined;
      const store = await GraphStore.fromGraphPath(graphPath);
      const results = await searchGraph(store, query, { limit, label_filter: labelFilter, min_score: 0 });
      return { status: "ok", query, results };
    }

    case "get_context": {
      const graphPath = String(args["graph_path"] ?? "");
      const qualifiedName = String(args["qualified_name"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      try {
        const ctx = await getContext(store, qualifiedName);
        return { status: "ok", context: ctx };
      } catch (e: unknown) {
        const err = e as { notFound?: boolean; input?: string; didYouMean?: string[] };
        if (err.notFound) {
          return { status: "not_found", input: err.input ?? qualifiedName, did_you_mean: err.didYouMean ?? [] };
        }
        throw e;
      }
    }

    // Stage 3 all-in-one — source: main.rs analyze_codebase handler
    case "analyze_codebase": {
      const codePath = String(args["path"] ?? "");
      const outputDir = String(args["output_dir"] ?? "");
      const lang = args["language"] as string | undefined;
      const gamma = typeof args["resolution_param"] === "number" ? args["resolution_param"] : 1.0;
      const indexResult = await indexCodebase(
        codePath, outputDir,
        lang && lang !== "auto" ? lang as "typescript" : undefined
      );
      const store = new GraphStore(indexResult.graphId);
      const resolveResult = await resolveGraph(store);
      const clusterResult = await clusterGraph(store, gamma);
      return {
        status: "ok",
        graph_path: indexResult.graphPath,
        graph_id: indexResult.graphId,
        index: { node_count: indexResult.nodeCount, edge_count: indexResult.edgeCount,
                 files_indexed: indexResult.filesIndexed, elapsed_ms: indexResult.elapsedMs },
        resolve: { total_edges: resolveResult.totalEdges, total_refs: resolveResult.totalRefs,
                   elapsed_ms: resolveResult.elapsedMs },
        cluster: { communities: clusterResult.communities, modularity: clusterResult.modularity,
                   processes: clusterResult.processes, elapsed_ms: clusterResult.elapsedMs },
      };
    }

    // Stage 3e — source: main.rs detect_changes handler
    case "detect_changes": {
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      let analysis;
      if (args["diff_text"]) {
        analysis = await analyzeDiff(store, String(args["diff_text"]));
      } else {
        const codebasePath = String(args["codebase_path"] ?? "");
        const baseRef = String(args["base_ref"] ?? "HEAD~1");
        const headRef = String(args["head_ref"] ?? "HEAD");
        analysis = await analyzeGitDiff(store, codebasePath, baseRef, headRef);
      }
      return {
        status: "ok",
        files_changed: analysis.files_changed,
        symbols_affected: analysis.symbols_affected,
        communities_affected: analysis.communities_affected,
        processes_affected: analysis.processes_affected,
        risk_score: analysis.risk_score,
      };
    }

    // Stage 3b-v2 — LSP stub (not ported)
    // source: lsp_resolver.rs / lsp_client.rs — requires native LSP client
    case "lsp_resolve":
      return {
        error: "tool lsp_resolve not yet ported, see TODO at packages/mcp-servers/codebase/src/index.ts",
        status: "not_ported",
        message: "LSP-enhanced resolution requires native LSP client. Use resolve_graph for static resolution.",
      };

    // Stage 4 — source: main.rs prepare_prd_input handler
    case "prepare_prd_input": {
      const runId = String(args["run_id"] ?? "");
      const findingId = String(args["finding_id"] ?? "");
      const outputDir = String(args["output_dir"] ?? "");
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await preparePrdInput(store, runId, findingId, outputDir);
      return {
        status: "ok",
        artifact_path: result.artifact_path,
        matched_symbol_count: result.matched_symbol_count,
        impacted_community_count: result.impacted_community_count,
        impacted_process_count: result.impacted_process_count,
      };
    }

    // Stage 6 — source: main.rs validate_prd_against_graph handler
    case "validate_prd_against_graph": {
      const prdPath = String(args["prd_path"] ?? "");
      const graphPath = String(args["graph_path"] ?? "");
      const affectedSymbolsPath = args["affected_symbols_path"] as string | undefined;
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await validatePrdAgainstGraph(store, prdPath, affectedSymbolsPath);
      return { status: "ok", ...result };
    }

    // Stage 8 — source: main.rs check_security_gates handler
    case "check_security_gates": {
      const graphPath = String(args["graph_path"] ?? "");
      const changedSymbols = Array.isArray(args["changed_symbols"])
        ? (args["changed_symbols"] as string[]) : [];
      const store = await GraphStore.fromGraphPath(graphPath);
      const report = await checkSecurityGates(store, changedSymbols);
      if (args["output_dir"] && args["run_id"] && args["finding_id"]) {
        writeSecurityReport(String(args["output_dir"]), String(args["run_id"]),
          String(args["finding_id"]), report);
      }
      return { status: "ok", ...report };
    }

    // Stage 9 — source: main.rs verify_semantic_diff handler
    case "verify_semantic_diff": {
      const beforePath = String(args["before_graph_path"] ?? "");
      const afterPath = String(args["after_graph_path"] ?? "");
      const reportPath = args["report_path"] as string | undefined;
      const result = await diffGraphs(beforePath, afterPath, reportPath);
      return {
        status: "ok",
        summary: result.summary,
        regression_score: result.regression_score,
        verdict: result.verdict,
        report: result.report,
      };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
