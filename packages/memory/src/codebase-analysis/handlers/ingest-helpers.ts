/**
 * Shared helpers for ingest-codebase and ingest-prd handlers.
 *
 * Ported from mcp_server/handlers/ingest_helpers.py
 *
 * Two concerns:
 *
 * 1. Graph-path memoisation — after a codebase analysis, the returned
 *    graph_path is stored as a protected Cortex memory tagged
 *    `_code_graph:<project-id>` so subsequent ingest runs can reuse
 *    the same graph without re-indexing.
 *
 * 2. Safe MCP calls — wraps mcp client calls with a uniform error shape
 *    so ingest handlers don't each re-derive the try/catch boilerplate.
 *    Callers supply an McpClientPool instance; there is no module-level
 *    pool singleton. When no pool is provided, McpConnectionError is
 *    thrown to preserve the previous observable contract for callers that
 *    have not yet wired a real pool.
 */

import { createHash } from "node:crypto";
import { resolve, basename, join } from "node:path";
import * as fs from "node:fs";
// source: cortex main mcp_server/handlers/ingest_helpers.py
import { govern } from "../../infrastructure/upstream-governor.js";

export const CODE_GRAPH_TAG_PREFIX = "_code_graph:";
// source: 8 hex chars = 32-bit collision space; sufficient for project-key disambiguation
const PROJECT_KEY_HASH_LENGTH = 8;

// ── McpClientPool port ────────────────────────────────────────────────────
//
// Core declares what it needs (DIP §5.1): a pool that can call any upstream
// MCP tool by server name + tool name. Infrastructure implements this
// interface. The composition root injects the concrete adapter.
//
// precondition:  serverName and toolName are non-empty strings.
// postcondition: resolves with the upstream tool result payload, or rejects
//                with McpConnectionError on transport failure.
export interface McpClientPool {
  call(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

// ── Project identification ─────────────────────────────────────────────────

export function projectKey(projectPath: string): string {
  /**
   * Stable project key = last path segment + short hash of full path.
   */
  const p = resolve(projectPath);
  const digest = createHash("sha256").update(p, "utf8").digest("hex").slice(0, PROJECT_KEY_HASH_LENGTH); // source: SHA-256 (FIPS 180-4) — standard hash algorithm for key derivation
  return `${basename(p)}-${digest}`;
}

export function codeGraphTag(projectPath: string): string {
  /**
   * Canonical tag used to memoise a code graph path for a project.
   */
  return `${CODE_GRAPH_TAG_PREFIX}${projectKey(projectPath)}`;
}

// ── Graph path cache ──────────────────────────────────────────────────────

export function graphPathIsMaterialised(graphPath: string | null): boolean {
  /**
   * True when `graphPath` points at a graph that still exists on disk.
   *
   * AP writes `<output_dir>/graph` as a LadybugDB directory; pre-3.14
   * builds wrote a single file at the same slot. Either form counts as
   * valid only when **non-empty** — an existing-but-empty directory is a
   * half-built or wiped graph, which must read as a cache miss so the
   * caller re-analyses rather than silently projecting zero symbols.
   *
   * source: cortex main mcp_server/handlers/ingest_helpers.py
   */
  if (!graphPath) {
    return false;
  }
  try {
    if (!fs.existsSync(graphPath)) {
      return false;
    }
    const st = fs.statSync(graphPath);
    if (st.isDirectory()) {
      return fs.readdirSync(graphPath).length > 0;
    }
    return st.size > 0;
  } catch {
    return false;
  }
}

function memoTags(mem: Record<string, unknown>): unknown[] {
  /**
   * Tags of a memory row as a list (rows may store JSON-encoded tags).
   */
  let raw = mem["tags"] ?? [];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown[];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function memoRecencyKey(mem: Record<string, unknown>): string {
  /**
   * Sortable recency key for a memo row (most-recent sorts highest).
   *
   * Prefers `created_at` (when the path was memoised); falls back to
   * `heat_base_set_at` then `last_accessed`. A missing value sorts oldest.
   * ISO-8601 strings sort lexicographically in chronological order, so
   * plain string comparison is correct here.
   *
   * source: cortex main mcp_server/handlers/ingest_helpers.py
   */
  for (const field of ["created_at", "heat_base_set_at", "last_accessed"]) {
    const val = mem[field];
    if (val === null || val === undefined || val === "") {
      continue;
    }
    const iso = (val as { toISOString?: () => string }).toISOString;
    return typeof iso === "function" ? iso.call(val) : String(val);
  }
  return "";
}

export function findCachedGraph(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any,
  projectPath: string,
): string | null {
  /**
   * Return the cached graph_path for a project, or null.
   *
   * Returns the path from the MOST-RECENT memo tagged with the project's
   * code-graph tag whose graph **still exists on disk**. A memo whose
   * graph was deleted (path missing or empty) is skipped, never returned
   * — this is the self-heal: a stale memo can no longer make the caller
   * project an empty graph. When no live graph is found, returns null so
   * the caller re-analyses and re-memoises.
   *
   * source: cortex main mcp_server/handlers/ingest_helpers.py
   */
  const tag = codeGraphTag(projectPath);
  let mems: Record<string, unknown>[];
  try {
    if (typeof store.getMemoriesByTag === "function") {
      // Tag-filtered, recency-ordered lookup. The previous full-table
      // scan materialized every memory (content + embeddings) to find a
      // handful of graph memos (bounded-I/O audit).
      mems = store.getMemoriesByTag(tag, 20) as Record<string, unknown>[];
    } else {
      // test fakes / stores without the tag query
      mems = store.getAllMemoriesForDecay() as Record<string, unknown>[];
    }
  } catch {
    return null;
  }

  const candidates: [string, string][] = []; // [recencyKey, graphPath]
  for (const mem of mems) {
    if (!memoTags(mem).includes(tag)) {
      continue;
    }
    const content = (mem["content"] as string) ?? "";
    if (!content.startsWith("graph_path=")) {
      continue;
    }
    const path = content.slice("graph_path=".length).trim();
    if (path) {
      candidates.push([memoRecencyKey(mem), path]);
    }
  }

  // Most-recent first; return the first whose graph is materialised AND
  // still fresh (built after the newest source change). A stale graph is
  // skipped so the caller re-analyses — "never serve a stale graph".
  candidates.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  for (const [, path] of candidates) {
    if (!graphPathIsMaterialised(path)) {
      continue;
    }
    if (!graphIsFresh(projectPath, path)) {
      continue;
    }
    return path;
  }
  return null;
}

// Directories never worth scanning for source-change detection: VCS,
// dependency caches, build outputs, virtualenvs, and the graph's own
// sidecar index. Pruned so the freshness walk early-exits cheaply on a
// real repo instead of stat-ing hundreds of thousands of vendored files.
// source: cortex main mcp_server/handlers/ingest_helpers.py
const FRESHNESS_IGNORE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
  ".next",
  ".idea",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "search_index",
]);

export function graphIsFresh(projectPath: string, graphPath: string): boolean {
  /**
   * False when a source file changed AFTER the graph was built.
   *
   * Compares the graph artefact's own mtime (its build time) against the
   * newest source file under `projectPath`. A bounded, ignore-pruned walk
   * early-exits on the FIRST file newer than the graph, so a changed repo
   * is detected without a full scan in the common case.
   *
   * Returns true (treat as fresh) when the project root is absent or the
   * graph mtime is unreadable — staleness cannot be proven, and rejecting
   * on uncertainty would force a needless re-analyse. The existence and
   * health gates handle those cases; this gate's sole job is detecting a
   * real source-vs-graph time skew.
   *
   * source: cortex main mcp_server/handlers/ingest_helpers.py
   */
  let builtAt: number;
  try {
    builtAt = fs.statSync(graphPath).mtimeMs;
  } catch {
    return true;
  }
  let rootIsDir: boolean;
  try {
    rootIsDir = fs.statSync(projectPath).isDirectory();
  } catch {
    rootIsDir = false;
  }
  if (!rootIsDir) {
    return true;
  }
  const stack: string[] = [projectPath];
  while (stack.length > 0) {
    const dirpath = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirpath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dirpath, entry.name);
      if (entry.isDirectory()) {
        if (FRESHNESS_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        stack.push(full);
        continue;
      }
      try {
        if (fs.statSync(full).mtimeMs > builtAt) {
          return false;
        }
      } catch {
        continue;
      }
    }
  }
  return true;
}

export function memoiseGraphPath(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any,
  projectPath: string,
  graphPath: string,
): number | null {
  /**
   * Persist the graph path as a protected memory for future lookups.
   */
  const tag = codeGraphTag(projectPath);
  const record = {
    content: `graph_path=${graphPath}`,
    tags: [tag, "_ingest", "code-graph"],
    source: "ingest_codebase",
    domain: "cortex-ingest",
    directory_context: resolve(projectPath),
    is_protected: true,
    importance: 1.0,
    heat: 1.0,
  };
  try {
    return store.insertMemory(record) as number;
  } catch {
    return null;
  }
}

// ── MCP call helpers ──────────────────────────────────────────────────────

/**
 * Invoke a tool on an upstream MCP server; return parsed result.
 *
 * precondition:  serverName and toolName are non-empty strings.
 * postcondition: resolves with the raw tool payload dict when the server
 *                answers successfully.
 *
 * When `pool` is null (composition root has not yet wired a real pool),
 * McpConnectionError is thrown. This preserves the previous observable
 * contract while making the missing-pool condition explicit at the call site
 * rather than silently swallowed. Callers that catch McpConnectionError
 * already handle this case correctly.
 */
export async function callUpstream(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  pool: McpClientPool | null = null,
): Promise<Record<string, unknown>> {
  if (pool === null) {
    throw new McpConnectionError(
      `callUpstream(${serverName}, ${toolName}) — McpClientPool not injected. ` +
        `Wire a real pool via the deps object at the composition root.`,
    );
  }
  // Bound concurrent in-flight calls to this single-process upstream child
  // across every Cortex handler. Without this, two batch tools (distinct
  // admission semaphores) can hammer the shared child until it OOMs and the
  // next stdin write raises a connection-lost error.
  // source: cortex main mcp_server/handlers/ingest_helpers.py
  const release = await govern(serverName);
  try {
    return await pool.call(serverName, toolName, args);
  } finally {
    release();
  }
}

export function normaliseMcpPayload(payload: unknown): unknown {
  /**
   * MCP call() sometimes returns a dict with a 'content' array.
   *
   * The pipeline's tools emit {"content": [{"type": "text", "text": "{...}"}]};
   * callers want the inner JSON. Other servers answer with a plain dict.
   * This helper collapses both shapes to the underlying object.
   */
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  if (!("content" in p)) return payload;
  const content = p["content"];
  if (!Array.isArray(content) || content.length === 0) return payload;
  const first = content[0] as Record<string, unknown>;
  if (first["type"] !== "text") return payload;
  const text = (first["text"] as string) ?? "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

// ── Error types ───────────────────────────────────────────────────────────

export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConnectionError";
  }
}
