/**
 * Handler: wiki-read — fetch the raw markdown of a wiki page.
 *
 * Phase 3.2 of ADR-2244: when the requested page is a redirect stub,
 * walk the redirect chain (up to MAX_REDIRECT_DEPTH hops) and return
 * the terminal page's content. The result includes ``resolved_path``
 * + ``redirect_hops`` so callers can tell when a follow occurred.
 *
 * source: mcp_server/handlers/wiki_read.py
 */

import { isRedirect, parseFrontmatter, resolveChain } from "../redirect.js";

export interface WikiReadArgs {
  readonly path: string;
  readonly follow_redirects?: boolean;
  // Start the returned content at this character offset. content_length
  // always carries the full page size so callers can page through pages
  // larger than the response budget.
  // source: cortex wiki_read.py:74-86 (offset, default 0, minimum 0)
  readonly offset?: number;
}

export interface WikiReadResult {
  readonly path: string;
  readonly content: string;
  // Full page size BEFORE any offset slice — lets callers page.
  // source: cortex wiki_read.py:92-106 (_bounded sets content_length)
  readonly content_length: number;
  readonly offset: number;
  readonly root: string;
  readonly resolved_path: string;
  readonly redirect_hops: number;
}

export type WikiReadResponse = WikiReadResult | { readonly error: string };

export interface WikiReadDeps {
  readonly wikiRoot: string;
  readonly readPage: (root: string, relPath: string) => Promise<string | null>;
}

export async function handler(
  args: WikiReadArgs,
  deps: WikiReadDeps,
): Promise<WikiReadResponse> {
  const relPath = (args.path ?? "").trim();
  if (!relPath) return { error: "path is required" };
  const followRedirects = args.follow_redirects !== false; // default true
  // source: cortex wiki_read.py:74-86 (offset default 0, minimum 0)
  const offset = Math.max(0, args.offset ?? 0);

  let content: string | null;
  try {
    content = await deps.readPage(deps.wikiRoot, relPath);
  } catch (err) {
    return { error: `read failed: ${String(err)}` };
  }
  if (content === null) return { error: `page not found: ${relPath}` };

  if (!followRedirects) {
    return {
      path: relPath,
      content: offset > 0 ? content.slice(offset) : content,
      content_length: content.length,
      offset,
      root: deps.wikiRoot,
      resolved_path: relPath,
      redirect_hops: 0,
    };
  }

  // Cache reads so each path is fetched at most once during chain
  // resolution. The reader callback must be synchronous, so we
  // pre-fetch eagerly: read the entry page, then if it's a redirect
  // we walk via fetched cache by re-running with already-fetched data.
  // Because resolveChain is synchronous, we implement an async walker
  // here directly to keep the I/O in async land.
  const cache = new Map<string, string | null>();
  cache.set(relPath, content);

  let current = relPath;
  const chain: string[] = [current];
  const seen = new Set<string>([current]);
  const MAX_DEPTH = 5;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const cached = cache.get(current);
    if (cached === undefined) {
      try {
        const fetched = await deps.readPage(deps.wikiRoot, current);
        cache.set(current, fetched);
      } catch {
        cache.set(current, null);
      }
    }
    const text = cache.get(current);
    if (!text) {
      return { error: `redirect target missing: ${current}` };
    }
    const fm = parseFrontmatter(text);
    if (!isRedirect(fm)) {
      return {
        path: relPath,
        content: offset > 0 ? text.slice(offset) : text,
        content_length: text.length,
        offset,
        root: deps.wikiRoot,
        resolved_path: current,
        redirect_hops: chain.length - 1,
      };
    }
    const rawPath = fm.redirect_to;
    const nextPath = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!nextPath) {
      return {
        error: `id-only redirect at ${current} cannot be followed without id index`,
      };
    }
    if (seen.has(nextPath)) {
      return { error: `redirect cycle detected at ${current} → ${nextPath}` };
    }
    chain.push(nextPath);
    seen.add(nextPath);
    current = nextPath;
  }

  return { error: `redirect depth exceeded (>${MAX_DEPTH} hops) from ${relPath}` };
}

// Imported only to satisfy the unused-import linter — kept for symmetry
// with the Python handler structure even though resolveChain is unused
// here because the async walker above replaces it.
void resolveChain;

export const schema = {
  title: "Wiki — read page",
  description:
    "Fetch the raw markdown source of one wiki page by its wiki-relative " +
    "path. Path resolution is sandboxed under the wiki root. Redirect " +
    "stubs are followed transparently up to 5 hops; pass " +
    "follow_redirects: false to read a stub's own body. Read-only; never " +
    "mutates state. Returns {path, content, root, resolved_path, " +
    "redirect_hops}.",
  inputSchema: {
    type: "object" as const,
    required: ["path"] as const,
    properties: {
      path: {
        type: "string" as const,
        description: "Wiki-relative path of the page to read.",
        examples: ["adr/example-decision.md", "reference/cortex/recall.md"],
      },
      follow_redirects: {
        type: "boolean" as const,
        default: true,
        description:
          "When true (default) follow redirect stubs to the terminal page. " +
          "When false, return the stub's own body.",
      },
    },
  },
} as const;
