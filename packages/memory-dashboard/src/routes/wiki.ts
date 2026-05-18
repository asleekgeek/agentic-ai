/**
 * routes/wiki.ts — GET /api/wiki/* + POST /api/wiki/save
 *
 * TS port of cortex@ed33435 mcp_server/server/http_standalone_wiki.py
 *
 * Endpoints:
 *   GET  /api/wiki/list          — list wiki pages
 *   GET  /api/wiki/page?path=    — read a single page
 *   GET  /api/wiki/concepts      — concept list
 *   GET  /api/wiki/drafts        — draft list
 *   GET  /api/wiki/views         — saved views
 *   GET  /api/wiki/bibliography  — bibliography listing
 *   POST /api/wiki/save          — save a wiki page (JSON body)
 *
 * Layer: handlers — delegates file-system reads to `@agentic/memory/wiki`
 *   when available; falls back to direct FS reads for METHODOLOGY_DIR.
 *
 * precondition:  METHODOLOGY_DIR env var is set OR defaults to ~/.claude/methodology.
 * postcondition: all routes return JSON or an error object.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";
// Phase C — per-project maintenance counts (drift + coverage) so the
// dashboard project cards can show maintenance badges.
// source: packages/memory/src/wiki/maintenance-stats.ts
import {
  computeWikiMaintenanceStats,
  defaultExtractDomain,
} from "@agentic/memory/wiki/maintenance-stats.js";
import { autoResolveProjectRoot } from "@agentic/memory/wiki/project-roots.js";
import { collectSourceFiles } from "@agentic/memory/codebase-analysis/handlers/codebase-analyze-helpers.js";
import type { PageMtimeFn } from "@agentic/memory/wiki/auto-curator.js";

// ── Named constants ───────────────────────────────────────────────────────────
const HTTP_400 = 400; // source: RFC 7231 §6.5.1 — Bad Request
const HTTP_500 = 500; // source: RFC 7231 §6.6 — Internal Server Error

// source: cortex@ed33435 mcp_server/infrastructure/config.py (METHODOLOGY_DIR)
function getMethodologyDir(): string {
  return (
    process.env["METHODOLOGY_DIR"] ??
    path.join(os.homedir(), ".claude", "methodology")
  );
}

function getWikiDir(): string {
  return path.join(getMethodologyDir(), "wiki");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * List all markdown files under a directory (non-recursive, top level only).
 * source: cortex@ed33435 mcp_server/handlers/wiki_api.py (list_wiki_pages)
 *
 * precondition:  wikiDir may or may not exist.
 * postcondition: returns array of relative path strings; empty if dir absent.
 */
function listWikiPages(wikiDir: string): string[] {
  try {
    const entries = fs.readdirSync(wikiDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Read a wiki page by relative path.
 * source: cortex@ed33435 mcp_server/handlers/wiki_api.py (read_wiki_page)
 *
 * precondition:  relPath is a relative filename (no directory traversal).
 * postcondition: returns { content, rel_path } or { error }.
 * FAILS_ON: relPath contains ".." or absolute path components.
 */
function readWikiPage(wikiDir: string, relPath: string): Record<string, unknown> {
  // Security: reject traversal (CWE-22)
  const safe = path.basename(relPath);
  if (!safe || safe.startsWith(".") || safe !== relPath.replace(/^\/+/, "")) {
    return { error: "invalid path" };
  }
  const full = path.join(wikiDir, safe);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(wikiDir))) {
    return { error: "path traversal rejected" };
  }
  try {
    const content = fs.readFileSync(resolved, "utf8");
    return { content, rel_path: safe };
  } catch {
    return { error: "not found", rel_path: safe };
  }
}

/**
 * Save a wiki page.
 * source: cortex@ed33435 mcp_server/handlers/wiki_api.py (save_wiki_page)
 *
 * precondition:  relPath is a valid relative filename; body is UTF-8 text.
 * postcondition: file is written; returns { ok: true, rel_path }.
 * FAILS_ON: permission denied — returns { error: "write failed" }.
 */
function saveWikiPage(
  wikiDir: string,
  relPath: string,
  body: string,
): Record<string, unknown> {
  const safe = path.basename(relPath);
  if (!safe || safe.startsWith(".")) return { error: "invalid path" };
  const full = path.join(wikiDir, safe);
  try {
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(full, body, "utf8");
    return { ok: true, rel_path: safe };
  } catch {
    return { error: "write failed" };
  }
}

// ── Route registration ────────────────────────────────────────────────────────

/**
 * Register all /api/wiki/* routes.
 *
 * precondition:  fastify instance is not yet started.
 * postcondition: seven routes registered.
 */
export async function registerWikiRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/wiki/list
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:49-58
   */
  fastify.get("/api/wiki/list", async (_req, reply) => {
    try {
      const pages = listWikiPages(getWikiDir());
      return reply.send({ pages });
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error; error class name only to avoid leaking internals (CWE-209)
    }
  });

  /**
   * GET /api/wiki/page?path=<relPath>
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:61-69
   */
  fastify.get<{ Querystring: { path?: string } }>("/api/wiki/page", async (req, reply) => {
    try {
      const relPath = req.query.path ?? "";
      return reply.send(readWikiPage(getWikiDir(), relPath));
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error; error class name only to avoid leaking internals (CWE-209)
    }
  });

  /**
   * GET /api/wiki/concepts (stub — full DB-backed impl requires wiki DB)
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:73-107
   */
  fastify.get("/api/wiki/concepts", async (_req, reply) => {
    return reply.send({ concepts: [], total: 0 });
  });

  /**
   * GET /api/wiki/drafts
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:85-92
   */
  fastify.get("/api/wiki/drafts", async (_req, reply) => {
    return reply.send({ drafts: [], total: 0 });
  });

  /**
   * GET /api/wiki/views
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:95-100
   */
  fastify.get("/api/wiki/views", async (_req, reply) => {
    return reply.send({ views: [] });
  });

  /**
   * GET /api/wiki/bibliography?path=<relPath>
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:100-106
   */
  fastify.get<{ Querystring: { path?: string } }>("/api/wiki/bibliography", async (req, reply) => {
    try {
      const relPath = req.query.path ?? "";
      const full = relPath
        ? path.join(getWikiDir(), path.basename(relPath))
        : path.join(getWikiDir(), "bibliography.md");
      try {
        const content = fs.readFileSync(full, "utf8");
        return reply.send({ content, rel_path: path.basename(full) });
      } catch {
        return reply.send({ content: "", rel_path: "bibliography.md" });
      }
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error; error class name only to avoid leaking internals (CWE-209)
    }
  });

  /**
   * POST /api/wiki/save — body: { rel_path: string; body: string }
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py:156-177
   */
  fastify.post<{ Body: { rel_path?: string; body?: string } }>("/api/wiki/save", async (req, reply) => {
    try {
      const relPath = req.body.rel_path ?? "";
      const body = req.body.body ?? "";
      if (!relPath) return reply.status(HTTP_400).send({ error: "rel_path required" }); // source: RFC 7231 §6.5.1 — 400 Bad Request
      return reply.send(saveWikiPage(getWikiDir(), relPath, body));
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error; error class name only to avoid leaking internals (CWE-209)
    }
  });

  /**
   * GET /api/wiki/page_meta?path=<relPath>
   *
   * Returns lightweight page metadata including an optional db_row
   * (the page's entry from the wiki_pages table, if the DB has one).
   * The frontend uses `db_row.id` to fetch memos; if absent the memo
   * section is skipped gracefully.
   *
   * precondition:  path query param is a relative wiki page filename.
   * postcondition: returns { db_row: null } (stub — full implementation
   *   requires a wiki_pages table; this agentic-ai port stores wiki
   *   pages as raw filesystem markdown only, no DB row).
   *
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py (page_meta endpoint)
   *   wiki.js:514 — `pmeta.db_row` is null-checked before use; null is a valid response.
   */
  fastify.get<{ Querystring: { path?: string } }>("/api/wiki/page_meta", async (_req, reply) => {
    // Stub: this server has no wiki_pages DB table.
    // Returning { db_row: null } causes the frontend to skip memo rendering
    // without throwing — the null-guard at wiki.js:526 handles this correctly.
    return reply.send({ db_row: null });
  });

  /**
   * GET /api/wiki/memos?subject_type=page&subject_id=<id>&limit=<n>
   *
   * Returns memos (decision + rationale records) attached to a wiki page.
   * This agentic-ai port has no memos table — return an empty list.
   *
   * precondition:  subject_id is a DB row id (integer string).
   * postcondition: returns { memos: [] } (stub).
   *
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py (memos endpoint)
   *   wiki.js:754 — `data.memos || []` fallback handles empty list gracefully.
   */
  fastify.get("/api/wiki/memos", async (_req, reply) => {
    return reply.send({ memos: [] });
  });

  /**
   * GET /api/wiki/bibliography/read?path=<relPath>
   *
   * Read a bibliography (.bib or .md) file from the wiki directory.
   * Used by the frontend to resolve citation keys.
   *
   * precondition:  path query param is a relative filename within the wiki dir.
   * postcondition: returns { content, rel_path } or { content: "" } if absent.
   * FAILS_ON: path traversal — rejected (CWE-22 guard via path.basename).
   *
   * source: cortex@ed33435 mcp_server/server/http_standalone_wiki.py (bibliography_read)
   *   wiki.js:1171 — `data.content` is null-checked; empty string causes skip.
   */
  fastify.get<{ Querystring: { path?: string } }>("/api/wiki/bibliography/read", async (req, reply) => {
    try {
      const relPath = req.query.path ?? "bibliography.bib";
      const safe = path.basename(relPath);
      if (!safe || safe.startsWith(".")) {
        return reply.send({ content: "", rel_path: "" });
      }
      const full = path.join(getWikiDir(), safe);
      const resolved = path.resolve(full);
      if (!resolved.startsWith(path.resolve(getWikiDir()))) {
        return reply.send({ content: "", rel_path: "" });
      }
      try {
        const content = fs.readFileSync(resolved, "utf8");
        return reply.send({ content, rel_path: safe });
      } catch {
        return reply.send({ content: "", rel_path: safe });
      }
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error
    }
  });

  // ── GET /api/wiki/maintenance ──────────────────────────────────────────────
  //
  // Returns per-project drift + coverage counts so the dashboard's
  // project cards (Phase B) can show maintenance badges. The same
  // engine powers the consolidate tool's pending_drift /
  // pending_coverage fields and the SessionStart preamble's
  // maintenance section.
  //
  // Response shape:
  //   {
  //     totalDrift: number,
  //     totalCoverage: number,
  //     totalPages: number,
  //     perProject: [{ name, drift, coverage, projectRoot }]
  //   }
  //
  // source: packages/memory/src/wiki/maintenance-stats.ts
  fastify.get("/api/wiki/maintenance", async (_req, reply) => {
    try {
      const stats = await computeMaintenanceStatsForDashboard();
      const perProject = Array.from(stats.perProject.entries())
        .map(([name, p]) => ({
          name,
          drift:        p.drift,
          coverage:     p.coverage,
          project_root: p.projectRoot,
        }));
      return reply.send({
        total_drift:    stats.totalDrift,
        total_coverage: stats.totalCoverage,
        total_pages:    stats.totalPages,
        per_project:    perProject,
      });
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error
    }
  });
}

// ── Maintenance-stats glue for the dashboard ────────────────────────────

// Per-project file walk cap for the dashboard's maintenance API. Higher
// than SessionStart (5000) because the dashboard is interactive-but-
// patient — the badge populates after page-load, not in the hot path.
// source: this module — dashboard latency budget vs accuracy trade-off
const DASHBOARD_COVERAGE_MAX_FILES = 10_000;

// Per-source-file size cap during walk — matches codebase_analyze's
// default so coverage and the analyze tool see the same file set.
// source: cortex codebase_analyze.py — max_file_size_kb default = 100
const DASHBOARD_MAX_FILE_KB = 100;
const DASHBOARD_BYTES_PER_KB = 1024; // source: IEC 80000-13:2008 §21-12

// POSIX-style join for wiki rel paths.
function joinWikiPath(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

// Walk wiki directory recursively and return rel-paths of every ``.md``.
// source: packages/memory/src/hooks/session-start.ts::listMdRelPaths — same
function listMdRelPathsForDashboard(root: string): string[] {
  const out: string[] = [];
  function walk(absDir: string, prefix: string): void {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const next = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(absDir, e.name), next);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(next);
    }
  }
  walk(root, "");
  return out;
}

function readWikiPageBody(root: string, rel: string): string | null {
  try { return fs.readFileSync(joinWikiPath(root, rel), "utf-8"); } catch { return null; }
}

const dashboardPageMtime: PageMtimeFn = (absPath: string): number | null => {
  try {
    const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
    return fs.statSync(absPath).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
};

function dashboardProjectFileMtime(projectRoot: string, rel: string): number | null {
  try {
    const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
    return fs.statSync(path.join(projectRoot, rel)).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
}

async function dashboardListSourceFiles(projectRoot: string, maxFiles: number): Promise<string[]> {
  try {
    const abs = collectSourceFiles(
      projectRoot,
      null,
      maxFiles,
      DASHBOARD_MAX_FILE_KB * DASHBOARD_BYTES_PER_KB,
    );
    return abs.map((p) => p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p);
  } catch {
    return [];
  }
}

async function computeMaintenanceStatsForDashboard(): Promise<ReturnType<typeof computeWikiMaintenanceStats> extends Promise<infer R> ? R : never> {
  return computeWikiMaintenanceStats(
    {
      wikiRoot:        getWikiDir(),
      listMdPages:     async (root) => listMdRelPathsForDashboard(root),
      readPage:        async (root, rel) => readWikiPageBody(root, rel),
      pageMtime:       dashboardPageMtime,
      projectRootFor:  autoResolveProjectRoot,
      listSourceFiles: dashboardListSourceFiles,
      fileMtime:       dashboardProjectFileMtime,
      extractDomain:   defaultExtractDomain,
    },
    { maxCoverageFiles: DASHBOARD_COVERAGE_MAX_FILES },
  );
}
