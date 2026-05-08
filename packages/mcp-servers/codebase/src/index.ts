/**
 * index.ts — MCP server entry point for the codebase intelligence plugin.
 *
 * Full TypeScript port of automatised-pipeline 0.0.9 (Rust → TS).
 * 23 MCP tools over PostgreSQL backend (replaces LadybugDB subprocess).
 *
 * Tool status:
 *   PORTED (22): health_check, extract_finding, refine_finding,
 *     start_verification, append_clarification, finalize_verification,
 *     abort_verification, index_codebase, query_graph, get_symbol,
 *     resolve_graph, cluster_graph, get_processes, get_impact,
 *     search_codebase, get_context, analyze_codebase, detect_changes,
 *     check_security_gates, verify_semantic_diff, prepare_prd_input,
 *     validate_prd_against_graph
 *   STUB (1): lsp_resolve — explicit "not_ported" error
 *
 * source: automatised-pipeline/0.0.9/src/main.rs handle_tool_call()
 * source: automatised-pipeline/0.0.9/src/tool_schemas.rs tools_list()
 */

import * as readline from "node:readline";
import { ensureSchema } from "./graph-store.js";
import { handleToolCall } from "./tool-handlers.js";
import { TOOLS_LIST } from "./tools-list.js";

// ---------------------------------------------------------------------------
// Server identity — source: main.rs:53-55
// ---------------------------------------------------------------------------

const SERVER_NAME = "ai-architect";
const SERVER_VERSION = "0.1.0-ts";
// source: main.rs:53 — PROTOCOL_VERSION "2024-11-05" (MCP spec date)
const PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire layer — source: main.rs:120-143
// Error codes — source: JSON-RPC 2.0 spec §5.1 (https://www.jsonrpc.org/specification)
// ---------------------------------------------------------------------------

// source: JSON-RPC 2.0 spec §5.1 — standard error codes
const JSONRPC_PARSE_ERROR = -32700; // source: JSON-RPC 2.0 spec §5.1
const JSONRPC_METHOD_NOT_FOUND = -32601; // source: JSON-RPC 2.0 spec §5.1
const JSONRPC_INTERNAL_ERROR = -32603; // source: JSON-RPC 2.0 spec §5.1

interface Request {
  id?: unknown;
  method: string;
  params?: unknown;
}

function writeMessage(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Main loop — JSON-RPC 2.0 over stdio
// source: main.rs main() BufRead loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await ensureSchema();
  } catch (e) {
    process.stderr.write(`codebase: PG schema init warning: ${e}\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    void (async () => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let req: Request;
      try {
        req = JSON.parse(trimmed) as Request;
      } catch {
        sendError(null, JSONRPC_PARSE_ERROR, "Parse error");
        return;
      }

      const { id, method, params } = req;
      if (id === undefined && !["initialize", "initialized"].includes(method)) return;

      try {
        switch (method) {
          case "initialize":
            sendResponse(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            });
            break;

          case "initialized":
            break;

          case "ping":
            sendResponse(id, {});
            break;

          case "tools/list":
            sendResponse(id, TOOLS_LIST);
            break;

          case "tools/call": {
            const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
            const toolName = p.name ?? "";
            const toolArgs = p.arguments ?? {};
            const result = await handleToolCall(toolName, toolArgs, TOOLS_LIST.tools.length);
            sendResponse(id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            });
            break;
          }

          default:
            sendError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`codebase: error handling ${method}: ${msg}\n`);
        sendError(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${msg}`);
      }
    })();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch(e => {
  process.stderr.write(`codebase: fatal: ${e}\n`);
  process.exit(1);
});
