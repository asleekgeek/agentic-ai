/**
 * wiki.ts — MCP tool adapters for the wiki topic.
 *
 * Tools registered (9 authoring + curate_wiki):
 *   wiki_write, wiki_read, wiki_list, wiki_link, wiki_adr,
 *   wiki_reindex, wiki_purge, wiki_verify, wiki_rename
 *
 * Phase 7 Group D — DI wiring: WikiDeps are constructed from filesystem
 * wiki-store primitives and injected into each handler. No stub paths remain.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md §WikiTools
 * source: packages/memory/src/wiki/handlers/ (all eight handlers)
 * source: packages/memory/src/wiki/storage/wiki-store.ts (filesystem primitives)
 */

import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync, readFileSync } from "node:fs";
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
import { handler as wikiRenameHandler } from "@agentic/memory/wiki/handlers/wiki-rename-handler.js";
import { handler as curateWikiHandler } from "@agentic/memory/wiki/handlers/curate-wiki.js";
import type { CuratorMemory, PageMtimeFn } from "@agentic/memory/wiki/auto-curator.js";
import { autoResolveProjectRoot } from "@agentic/memory/wiki/project-roots.js";
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

// Void-returning write adapter for wiki_rename. WikiRenameDeps.writePage
// is typed ``(...) => Promise<void>`` with mode ``"create" | "replace"``;
// asyncWritePage returns the write metadata, which the rename handler
// ignores. This adapter discards the result so the contract matches
// without leaning on TS return-position bivariance.
async function asyncWritePageVoid(
  root: string,
  relPath: string,
  content: string,
  mode: "create" | "replace",
): Promise<void> {
  await asyncWritePage(root, relPath, content, mode);
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

// ── G12 scope-coverage filesystem adapters ────────────────────────────────────
//
// Wrappers over WIKI_ROOT that let the curator audit per-domain scope
// coverage (audit_all_domains parity). Every call is best-effort: an
// ENOENT or permission error returns []/null/0 so a partial wiki tree
// never throws through the MCP surface.
// source: cortex core/wiki_coverage.py (audit_all_domains, _count_substantive_pages)
// reference impl: packages/memory/src/hooks/consolidate-background.ts:246-276

const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms

// Wiki-page mtime adapter. Resolves seconds-since-epoch or null on
// ENOENT. Used by the curator's recently-authored skip filter (pageMtime).
const mtimeAdapter: PageMtimeFn = (absPath: string): number | null => {
  try {
    return statSync(absPath).mtimeMs / MS_PER_SECOND;
  } catch {
    return null;
  }
};

// List the immediate subdirectories of <WIKI_ROOT>/<relDir>. Used by
// listDomains to discover domain names under each wiki kind bucket.
function wikiListSubdirs(relDir: string): readonly string[] {
  try {
    return readdirSync(join(WIKI_ROOT, relDir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Stat a wiki page at <WIKI_ROOT>/<relPath>. Returns size + mtime or null.
function wikiPageStat(relPath: string): { sizeBytes: number; mtimeSec: number } | null {
  try {
    const s = statSync(join(WIKI_ROOT, relPath));
    return { sizeBytes: s.size, mtimeSec: s.mtimeMs / MS_PER_SECOND };
  } catch {
    return null;
  }
}

// Count substantive (.md, ≥ MIN_PAGE_BYTES) pages directly under
// <WIKI_ROOT>/<relDir>. source: cortex wiki_coverage.py:_count_substantive_pages
function wikiCountSubstantivePages(relDir: string): number {
  // source: cortex core/wiki_coverage.py:_MIN_PAGE_BYTES = 800
  const MIN_PAGE_BYTES = 800;
  try {
    const abs = join(WIKI_ROOT, relDir);
    let count = 0;
    for (const entry of readdirSync(abs)) {
      if (!entry.endsWith(".md")) continue;
      try {
        if (statSync(join(abs, entry)).size >= MIN_PAGE_BYTES) count += 1;
      } catch { /* skip unstatable entries */ }
    }
    return count;
  } catch {
    return 0;
  }
}

// Read a wiki page body at <WIKI_ROOT>/<wikiPath>. Returns null on read
// failure. Used by the reauthor branch's prompt builder.
function wikiReadPageBody(wikiPath: string): string | null {
  try {
    return readFileSync(join(WIKI_ROOT, wikiPath), "utf-8");
  } catch {
    return null;
  }
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
 * Wiki authoring tools (write/read/list/link/adr/reindex/purge/verify/rename)
 * are pure-FS and need no store. The auto-curator (``curate_wiki``) needs a
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
 * Registers all wiki MCP tools (9 authoring tools incl. ``wiki_rename``,
 * plus ``curate_wiki`` when ``deps.store`` is provided).
 *
 * precondition:  WIKI_ROOT directory exists or will be created on first write.
 * postcondition: 9 authoring tools registered; ``curate_wiki`` is registered
 *                when a memory store is injected; each body calls the real
 *                domain handler.
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
        // source: cortex tool_registry_wiki.py:64 (tool_wiki_read signature —
        //   follow_redirects: bool = True)
        follow_redirects: z.boolean().default(true).describe(
          "When true (default) follow redirect stubs to the terminal page. " +
          "When false, return the stub's own body.",
        ),
        // source: cortex wiki_read.py:74-86 (offset: int, default 0, minimum 0)
        offset: z.number().int().min(0).optional().describe(
          "Start the returned content at this character offset. Page through " +
          "pages larger than the response budget: when the response carries " +
          "content_truncated: true, re-call with offset = previous offset + " +
          "length of content received. content_length is the full page size.",
        ),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-read.ts::handler
        const response = await wikiReadHandler(
          {
            path: args.path,
            follow_redirects: args.follow_redirects,
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
          },
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

  // ── wiki_rename ───────────────────────────────────────────────────────────
  //
  // Move a page and leave a redirect stub at the old path. The TS domain
  // handler (wiki-rename-handler.ts) is a 1:1 port of Cortex's
  // handlers/wiki_rename.py; this block is the model-facing registration.
  //
  // source: cortex tool_registry_wiki.py:170-193 (tool_wiki_rename:
  //   from_path, to_path, reason="", overwrite_dest=False)
  server.registerTool(
    "wiki_rename",
    {
      description:
        "Move a wiki page from from_path to to_path and leave a redirect " +
        "stub at the old location pointing to the new one. The move " +
        "preserves inbound links because wiki_read follows redirect stubs " +
        "transparently. Refuses to operate on pages without a stable id " +
        "field, or on existing redirect stubs. Returns {from_path, " +
        "to_path, page_id, stub_created}.",
      inputSchema: {
        from_path:      z.string().min(1).describe("Current wiki-relative path of the page."),
        to_path:        z.string().min(1).describe("Destination wiki-relative path."),
        reason:         z.string().optional().describe("Optional free-form rationale recorded in the redirect stub."),
        overwrite_dest: z.boolean().default(false).describe("When true, overwrite an existing destination."),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/wiki/handlers/wiki-rename-handler.ts::handler
        const response = await wikiRenameHandler(
          {
            from_path:      args.from_path,
            to_path:        args.to_path,
            reason:         args.reason,
            overwrite_dest: args.overwrite_dest,
          },
          { wikiRoot: WIKI_ROOT, readPage: asyncReadPage, writePage: asyncWritePageVoid },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("wiki_rename", err);
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
    // source: cortex curate_wiki.py:148-159 (coverage_jobs_max, default 4) and :173-184 (reauthor_jobs_max, default 3)
    const COVERAGE_JOBS_DEFAULT = 4;
    const REAUTHOR_JOBS_DEFAULT = 3;
    const COVERAGE_JOBS_MAX_CAP = 20; // source: cortex@47b818d original per-call job cap
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
          // source: cortex curate_wiki.py:137-148 (include_coverage, default True)
          include_coverage: z.boolean().default(true).describe(
            "If true, prepend coverage-driven jobs (missing architecture/" +
            "services/api/data-flow/operations pages per project) ahead of " +
            "cluster-driven jobs. Structural scopes get authored before heat " +
            "clusters so a cold reader can navigate the wiki end-to-end.",
          ),
          // source: cortex curate_wiki.py:148-159 (coverage_jobs_max, default 4)
          coverage_jobs_max: z.number().int().min(0).max(COVERAGE_JOBS_MAX_CAP).default(COVERAGE_JOBS_DEFAULT).describe(
            "Cap on how many coverage jobs to return per invocation (default 4).",
          ),
          // source: cortex curate_wiki.py:161-172 (include_reauthor, default True)
          include_reauthor: z.boolean().default(true).describe(
            "Mix in re-authoring jobs for existing pages whose linked source " +
            "files have moved, whose content is older than the freshness " +
            "window, or whose body is off-template.",
          ),
          // source: cortex curate_wiki.py:173-184 (reauthor_jobs_max, default 3)
          reauthor_jobs_max: z.number().int().min(0).default(REAUTHOR_JOBS_DEFAULT).describe(
            "Cap on how many re-author jobs to return per invocation (default 3).",
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

          // Remap the model-facing Cortex param names to the TS handler's
          // internal names: Cortex include_coverage → include_scope_coverage
          // (both = structural per-domain scope-coverage jobs);
          // coverage_jobs_max → scope_coverage_jobs_max.
          // source: cortex curate_wiki.py:245/247 (include_coverage /
          //   include_reauthor); TS handler curate-wiki.ts:123/131.
          const handlerArgs = {
            ...args,
            include_scope_coverage:  args.include_coverage,
            ...(args.coverage_jobs_max !== undefined
              ? { scope_coverage_jobs_max: args.coverage_jobs_max }
              : {}),
            include_reauthor:        args.include_reauthor,
            ...(args.reauthor_jobs_max !== undefined
              ? { reauthor_jobs_max: args.reauthor_jobs_max }
              : {}),
          };

          const response = await curateWikiHandler(handlerArgs, {
            wikiRoot:                    WIKI_ROOT,
            getRecentlyAccessedMemories: getRecent,
            getRecentMemories:           getRecentByHeat,
            listMdPages:                 asyncListPages,
            // G12 scope-coverage adapters — filesystem wrappers over
            // WIKI_ROOT. Best-effort: fs errors short-circuit to
            // empty/null so a partial wiki tree never breaks the tool
            // call. These make include_coverage (Cortex
            // audit_all_domains) functional — the structural-navigation
            // jobs that let a cold reader traverse the wiki.
            // source: cortex curate_wiki.py:289-299 (audit_all_domains);
            //   reference impl mirrors
            //   packages/memory/src/hooks/consolidate-background.ts:246-276
            readPage:              asyncReadPage,
            pageMtime:             mtimeAdapter,
            listSubdirs:           wikiListSubdirs,
            pageStat:              wikiPageStat,
            countSubstantivePages: wikiCountSubstantivePages,
            // Reauthor-only adapters. The reauthor branch additionally
            // gates on a per-call project_root (curate-wiki-scope.ts:229),
            // which Cortex does not expose at the tool surface (it resolves
            // source roots per-domain via _project_source_root inside
            // audit_wiki_drift). Until the TS drift model is reworked to
            // resolve per page-domain, include_reauthor short-circuits to
            // empty here. These adapters are wired so the branch becomes
            // functional the moment that rework lands; no behaviour relies
            // on them today. Flagged to the consolidation group.
            // source: cortex curate_wiki.py:302-316 (per-domain reauthor)
            readWikiPageBody:      wikiReadPageBody,
            sourceRootResolver:    autoResolveProjectRoot,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
        } catch (err) {
          return errorText("curate_wiki", err);
        }
      },
    );
  }
}
