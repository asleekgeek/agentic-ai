/**
 * wiki.ts — MCP tool adapters for the wiki topic.
 *
 * Tools registered (8):
 *   wiki_write, wiki_read, wiki_list, wiki_link, wiki_adr,
 *   wiki_reindex, wiki_purge, wiki_verify
 *
 * Phase 7 Group D — DI wiring: WikiDeps are constructed from filesystem
 * wiki-store primitives and injected into each handler. No stub paths remain.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md §WikiTools
 * source: packages/memory/src/wiki/handlers/ (all eight handlers)
 * source: packages/memory/src/wiki/storage/wiki-store.ts (filesystem primitives)
 */

import { mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handler as wikiWriteHandler } from "@agentic/memory/wiki/handlers/wiki-write.js";
import { handler as wikiReadHandler } from "@agentic/memory/wiki/handlers/wiki-read.js";
import { handler as wikiListHandler } from "@agentic/memory/wiki/handlers/wiki-list.js";
import { handler as wikiLinkHandler } from "@agentic/memory/wiki/handlers/wiki-link.js";
import { handler as wikiAdrHandler } from "@agentic/memory/wiki/handlers/wiki-adr.js";
import { handler as wikiReindexHandler } from "@agentic/memory/wiki/handlers/wiki-reindex.js";
import { handler as wikiPurgeHandler } from "@agentic/memory/wiki/handlers/wiki-purge.js";
import { handler as wikiVerifyHandler } from "@agentic/memory/wiki/handlers/wiki-verify.js";
import { handler as curateWikiHandler } from "@agentic/memory/wiki/handlers/curate-wiki.js";
import type { CuratorMemory, PageMtimeFn } from "@agentic/memory/wiki/auto-curator.js";
import { collectSourceFiles as codebaseCollectSourceFiles } from "@agentic/memory/codebase-analysis/handlers/codebase-analyze-helpers.js";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import {
  readPage as fsReadPage,
  writePage as fsWritePage,
  listPages as fsListPages,
  nextAdrNumber as fsNextAdrNumber,
} from "@agentic/memory/wiki/storage/wiki-store.js";

// ── Wiki root path ────────────────────────────────────────────────────────────
//
// source: cortex@ed33435 mcp_server/infrastructure/config.py
//   WIKI_ROOT = ~/.claude/methodology/wiki
const WIKI_ROOT: string = process.env["CORTEX_WIKI_ROOT"] ??
  join(homedir(), ".claude", "methodology", "wiki");

// ── Sync→async adapters for wiki-store primitives ─────────────────────────────
//
// Wiki handler interfaces expect async deps. The wiki-store primitives are sync.
// These adapters lift sync calls to Promise.resolve() so the handler contracts
// are satisfied without introducing I/O runtime changes.
//
// source: Martin, R. C. (2017). Clean Architecture, Ch. 11 — adapters transform
//   between incompatible interface shapes without changing behaviour.

async function asyncReadPage(root: string, relPath: string): Promise<string | null> {
  return Promise.resolve(fsReadPage(root, relPath));
}

async function asyncWritePage(
  root: string,
  relPath: string,
  content: string,
  mode: string,
): Promise<{ path: string; mode: string; created: boolean; bytes_written: number }> {
  return Promise.resolve(fsWritePage(root, relPath, content, mode));
}

async function asyncListPages(root: string, kind?: string | null): Promise<string[]> {
  return Promise.resolve(fsListPages(root, kind as Parameters<typeof fsListPages>[1]));
}

async function asyncNextAdrNumber(root: string): Promise<number> {
  return Promise.resolve(fsNextAdrNumber(root));
}

async function asyncWriteFile(absPath: string, content: string): Promise<void> {
  const dir = dirname(resolve(absPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, content, "utf-8");
}

async function asyncEnsureDir(absDir: string): Promise<void> {
  mkdirSync(absDir, { recursive: true });
}

async function asyncListAllMarkdownFiles(
  root: string,
  kindFilter?: string | null,
): Promise<Array<{ relPath: string; content: string }>> {
  const paths = await asyncListPages(root, kindFilter);
  const entries: Array<{ relPath: string; content: string }> = [];
  for (const relPath of paths) {
    const content = await asyncReadPage(root, relPath);
    if (content !== null) entries.push({ relPath, content });
  }
  return entries;
}

async function asyncDeleteFile(absPath: string): Promise<void> {
  try { rmSync(absPath); } catch { /* best effort */ }
}

// source: ADR-0046 Phase 2 — AP symbol verification deferred until AP graph is live
// source: docs/ADR/0046-change-impact-analysis.md §Phase 2
const AP_ENABLED = false;

// Phase C — fs adapters for source-drift + file-coverage.
// Failure isolation: every call to fs is wrapped so an ENOENT or
// permission error returns null/[] and the curator treats the page or
// file as "not present, not stale", never throwing through the MCP
// surface.
// source: packages/memory/src/wiki/{source-drift,file-coverage}.ts

// File-size cap for the coverage scan. Mirrors codebase-analyze's
// default (100 KB) since the same predicate filters here.
// source: cortex@2f42428 codebase_analyze.py — max_file_size_kb default = 100
// source: IEC 80000-13 — 1 kibibyte = 1024 bytes
const FILE_SIZE_KB_DEFAULT = 100; // source: cortex@2f42428 codebase_analyze.py
const BYTES_PER_KB = 1024; // source: IEC 80000-13:2008 §21-12
const MAX_FILE_BYTES = FILE_SIZE_KB_DEFAULT * BYTES_PER_KB;

// Wiki-page mtime adapter. Resolves seconds-since-epoch or null on
// ENOENT. Used by the recently-authored skip filter and the drift
// scanner's page-mtime side.
const mtimeAdapter: PageMtimeFn = (absPath: string): number | null => {
  try {
    const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
    return statSync(absPath).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
};

// Project-rooted mtime adapter for source-drift. Resolves relative
// citation paths against the supplied project root. Returns null on
// ENOENT or when projectRoot is absent.
function makeProjectMtime(projectRoot: string | undefined): PageMtimeFn | undefined {
  if (!projectRoot) return undefined;
  return (relPath: string): number | null => {
    try {
      const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms
      return statSync(join(projectRoot, relPath)).mtimeMs / MS_PER_SECOND;
    } catch {
      return null;
    }
  };
}

// Project-rooted file reader for file-coverage prompts.
function makeProjectReader(
  projectRoot: string | undefined,
): ((projectRoot: string, relPath: string) => string | null) | undefined {
  if (!projectRoot) return undefined;
  return (_pr: string, relPath: string): string | null => {
    try {
      return readFileSync(join(projectRoot, relPath), "utf-8");
    } catch {
      return null;
    }
  };
}

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── registerWikiTools ─────────────────────────────────────────────────────────

/**
 * Optional dependencies for the wiki tool surface.
 *
 * Wiki authoring tools (write/read/list/link/adr/reindex/purge/verify) are
 * pure-FS and need no store. The auto-curator (``curate_wiki``) needs a
 * live memory store to draw the cluster pool from — it is registered
 * only when ``deps.store`` is supplied. This keeps the legacy
 * ``registerWikiTools(server)`` call site working while letting the
 * memory MCP server opt the curator in.
 */
export interface WikiToolDeps {
  /**
   * Live MemoryStore (extended interface — needs ``getHotMemories`` and
   * ``getRecentlyAccessedMemories``, both on MemoryStoreExt). When
   * omitted, ``curate_wiki`` is skipped.
   */
  readonly store?: MemoryStoreExt;
}

/**
 * Registers all wiki MCP tools (8 authoring tools, plus ``curate_wiki``
 * when ``deps.store`` is provided).
 *
 * precondition:  WIKI_ROOT directory exists or will be created on first write.
 * postcondition: 8 tools registered; ``curate_wiki`` is registered when a
 *                memory store is injected; each body calls the real domain handler.
 *
 * source: MCP_TOOLS.md §"wiki_write" through §"wiki_verify"
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py (auto-curator)
 */
export function registerWikiTools(server: McpServer, deps?: WikiToolDeps): void {
  // ── wiki_write ────────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_write",
    {
      description: "Author a wiki page (create/append/replace) with provided Markdown.",
      inputSchema: {
        path:    z.string().min(1).describe("Wiki page path (relative)"),
        content: z.string().min(1).describe("Markdown content"),
        mode:    z.enum(["create", "append", "replace"]).default("create").describe("Write mode"),
        tags:    z.array(z.string()).default([]).describe("Page tags"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-write.ts::handler
        const response = await wikiWriteHandler(
          { path: args.path, content: args.content, mode: args.mode, tags: args.tags },
          { wikiRoot: WIKI_ROOT, writePage: asyncWritePage },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_write", err);
      }
    },
  );

  // ── wiki_read ─────────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_read",
    {
      description: "Read the raw Markdown of a wiki page by relative path.",
      inputSchema: {
        path: z.string().min(1).describe("Wiki page path"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-read.ts::handler
        const response = await wikiReadHandler(
          { path: args.path },
          { wikiRoot: WIKI_ROOT, readPage: asyncReadPage },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_read", err);
      }
    },
  );

  // ── wiki_list ─────────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_list",
    {
      description:
        "List authored wiki pages, optionally filtered by kind. " +
        "Redirect stubs and auto-generated pages (provenance: " +
        "auto-generated) are hidden by default — pass " +
        "include_redirects / include_auto_generated to see them.",
      inputSchema: {
        kind: z.string().optional().describe("Page kind filter"),
        include_redirects: z.boolean().optional().describe(
          "Include redirect stubs (default false).",
        ),
        include_auto_generated: z.boolean().optional().describe(
          "Include auto-generated pages (default false).",
        ),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-list.ts::handler
        const response = await wikiListHandler(
          {
            kind: args.kind as Parameters<typeof wikiListHandler>[0]["kind"],
            include_redirects: args.include_redirects,
            include_auto_generated: args.include_auto_generated,
          },
          {
            wikiRoot: WIKI_ROOT,
            listPages: asyncListPages,
            readPage: asyncReadPage,
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_list", err);
      }
    },
  );

  // ── wiki_link ─────────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_link",
    {
      description: "Add a bidirectional link between two wiki pages (creates Related section entry).",
      inputSchema: {
        from_path: z.string().min(1).describe("Source page path"),
        to_path:   z.string().min(1).describe("Target page path"),
        relation:  z.string().min(1).describe("Relationship label"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-link.ts::handler
        const response = await wikiLinkHandler(
          { from_path: args.from_path, to_path: args.to_path, relation: args.relation },
          { wikiRoot: WIKI_ROOT, readPage: asyncReadPage, writePage: asyncWritePage },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_link", err);
      }
    },
  );

  // ── wiki_adr ──────────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_adr",
    {
      description: "Create a numbered ADR (Architecture Decision Record) with auto-incremented sequence.",
      inputSchema: {
        title:        z.string().min(1).describe("ADR title"),
        context:      z.string().min(1).describe("Problem context"),
        decision:     z.string().min(1).describe("Decision made"),
        consequences: z.string().min(1).describe("Consequences"),
        status:       z.enum(["proposed", "accepted", "deprecated", "superseded"]).default("accepted").describe("ADR status"),
        tags:         z.array(z.string()).default([]).describe("Tags"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-adr.ts::handler
        const response = await wikiAdrHandler(
          {
            title:        args.title,
            context:      args.context,
            decision:     args.decision,
            consequences: args.consequences,
            status:       args.status,
            tags:         args.tags,
          },
          {
            wikiRoot:      WIKI_ROOT,
            nextAdrNumber: asyncNextAdrNumber,
            writePage:     asyncWritePage,
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_adr", err);
      }
    },
  );

  // ── wiki_reindex ──────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_reindex",
    {
      description: "Regenerate the wiki table of contents at .generated/INDEX.md.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-reindex.ts::handler
        const response = await wikiReindexHandler(
          {},
          {
            wikiRoot:  WIKI_ROOT,
            listPages: asyncListPages,
            readPage:  asyncReadPage,
            writeFile: asyncWriteFile,
            ensureDir: asyncEnsureDir,
            joinPath:  join,
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_reindex", err);
      }
    },
  );

  // ── wiki_purge ────────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_purge",
    {
      description: "Re-evaluate and purge wiki pages that fail the current classifier.",
      inputSchema: {
        apply: z.boolean().default(false).describe("Apply purge (false = preview only)"),
        kind:  z.string().optional().describe("Page kind to target"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-purge.ts::handler
        const response = await wikiPurgeHandler(
          {
            apply: args.apply,
            kind:  args.kind as Parameters<typeof wikiPurgeHandler>[0]["kind"],
          },
          {
            wikiRoot:             WIKI_ROOT,
            listAllMarkdownFiles: asyncListAllMarkdownFiles,
            deleteFile:           asyncDeleteFile,
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_purge", err);
      }
    },
  );

  // ── wiki_verify ───────────────────────────────────────────────────────────
  server.registerTool(
    "wiki_verify",
    {
      description: "Verify wiki-page symbol citations against AP's code graph (ADR-0046 Phase 2).", // source: docs/ADR/0046-change-impact-analysis.md §Phase 2
      inputSchema: {
        path: z.string().optional().describe("Page path (null = all pages)"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-verify.ts::handler
        // source: docs/ADR/0046-change-impact-analysis.md §Phase 2 — AP disabled
        const response = await wikiVerifyHandler(
          { path: args.path ?? null },
          {
            wikiRoot:      WIKI_ROOT,
            isApEnabled:   () => AP_ENABLED,
            readPage:      asyncReadPage,
            listPages:     asyncListPages,
            // source: docs/ADR/0046-change-impact-analysis.md §Phase 2 — stub until AP live
            verifySymbols: async (_symbols) => ({}),
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_verify", err);
      }
    },
  );

  // ── curate_wiki ───────────────────────────────────────────────────────────
  //
  // Auto-curator — clusters recent PG memories and returns structured
  // authoring jobs the in-session LLM (Opus 4.7) consumes to produce
  // wiki pages. The handler needs a live memory store, so registration
  // is gated on deps.store being supplied.
  //
  // source: cortex@47b818d mcp_server/handlers/curate_wiki.py
  if (deps?.store) {
    const store = deps.store;
    // Per-call upper bound on jobs returned. Cortex@47b818d sets this
    // to 20 — we raise it to 100. Rationale: each job carries a ~30KB
    // structured prompt (≤25 memories × ~1200 chars + frontmatter +
    // instructions); 100 jobs ≈ 3MB, which fits within both the MCP
    // wire budget and an Opus 4.7 turn. Past 100, pagination is the
    // right pattern — consolidate's pending_curations stat and the
    // SessionStart preamble already prod the LLM to keep calling
    // curate_wiki across sessions, so an arbitrarily low cap throttles
    // the "document everything automatically" loop without preventing
    // genuine wire/context blowouts.
    // source: cortex@47b818d set 20; raised here per user feedback
    //         2026-05-18 ("why a limit cap?").
    const MAX_JOBS_PER_CALL = 100; // source: user feedback 2026-05-18 — raised from cortex's 20 to fit MCP wire + Opus 4.7 context
    server.registerTool(
      "curate_wiki",
      {
        description:
          "Auto-curator: emits structured authoring jobs from PG " +
          "memory clusters. Each job carries one cluster's memories, " +
          "the suggested wiki path, related-page cross-links, and a " +
          "complete authoring prompt encoding the wiki conventions. " +
          "The in-session LLM authors the page in Markdown and writes " +
          "it via wiki_write. No external Anthropic key required.",
        inputSchema: {
          domain:           z.string().optional().describe("Restrict to a domain (e.g. 'cortex')."),
          limit:            z.number().int().min(1).max(MAX_JOBS_PER_CALL).optional().describe("Max jobs returned (default 3)."),
          min_memories:     z.number().int().min(1).optional().describe("Minimum memories per cluster."),
          min_avg_heat:     z.number().min(0).max(1).optional().describe("Minimum cluster average heat."),
          recent_only:      z.boolean().optional().describe("Use recently-accessed memories only (default true)."),
          memory_pool_size: z.number().int().min(1).optional().describe("Memory pool size to draw from."),
          // Phase C — drift + coverage. Opt-in via these flags; both
          // require project_root to resolve relative citation paths.
          // source: packages/memory/src/wiki/{source-drift,file-coverage}.ts
          include_drift: z.boolean().optional().describe(
            "Phase C: also emit refresh jobs for pages whose cited " +
            "source files have mtimes later than the page mtime " +
            "(requires project_root).",
          ),
          include_file_coverage: z.boolean().optional().describe(
            "Phase C: also emit authoring jobs for source files that " +
            "have no wiki page yet under reference/<domain>/<slug>.md " +
            "(requires project_root + domain).",
          ),
          project_root: z.string().optional().describe(
            "Absolute path to the project root. Used by Phase C to " +
            "resolve relative citations and walk for uncovered files.",
          ),
          max_files: z.number().int().min(0).optional().describe(
            "Max source files scanned for coverage. 0 (default) = " +
            "unbounded; matches codebase_analyze.",
          ),
        },
      },
      async (args) => {
        try {
          // Adapters — the store returns Record<string, unknown>[]; the
          // handler's CuratorMemory is a strict structural subset, so
          // the cast is type-only. Prefer async paths when the impl
          // exposes them (PG); fall back to the sync interface methods.
          // source: packages/memory/src/wiki/auto-curator.ts::CuratorMemory
          // source: packages/memory/src/remember/storage/pg-store.ts:1083
          //   (getRecentlyAccessedMemoriesAsync exists on PgStore but is
          //    not on the MemoryStore interface — narrow via ``in``.)
          const storeExt = store as MemoryStoreExt & {
            getRecentlyAccessedMemoriesAsync?: (limit: number, minAccessCount: number) => Promise<Record<string, unknown>[]>;
          };
          const getRecent = async (limit: number): Promise<CuratorMemory[]> => {
            const rows = storeExt.getRecentlyAccessedMemoriesAsync
              ? await storeExt.getRecentlyAccessedMemoriesAsync(limit, 1)
              : store.getRecentlyAccessedMemories(limit, 1);
            return rows as CuratorMemory[];
          };
          const getRecentByHeat = async (limit: number): Promise<CuratorMemory[]> => {
            const rows = store.getHotMemoriesAsync
              ? await store.getHotMemoriesAsync(0, limit, false)
              : store.getHotMemories(0, limit, false);
            return rows as CuratorMemory[];
          };

          const response = await curateWikiHandler(args, {
            wikiRoot:                    WIKI_ROOT,
            getRecentlyAccessedMemories: getRecent,
            getRecentMemories:           getRecentByHeat,
            listMdPages:                 asyncListPages,
            // Phase C adapters — only used when args.include_drift /
            // args.include_file_coverage are true and project_root is
            // supplied. Failure isolation: each adapter swallows fs
            // errors and returns null/[] so a single missing file
            // never breaks the whole tool call.
            // source: packages/memory/src/wiki/{source-drift,file-coverage}.ts
            readPage:        asyncReadPage,
            pageMtime:       mtimeAdapter,
            sourceFileMtime: makeProjectMtime(args.project_root),
            readSourceFile:  makeProjectReader(args.project_root),
            listSourceFiles: async (projectRoot, maxFiles) =>
              codebaseCollectSourceFiles(projectRoot, null, maxFiles, MAX_FILE_BYTES)
                .map((abs) => abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs),
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
        } catch (err) {
          return errorText("curate_wiki", err);
        }
      },
    );
  }
}
