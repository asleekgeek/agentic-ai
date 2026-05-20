/**
 * headless-authoring-pointer.ts — register a PG pointer memory for a
 * wiki page so retrieval can see it.
 *
 * Without this step the grooming agent's disk rewrites are invisible
 * to retrieval — the entity graph and spreading activation can only
 * see what's in PG. ``upsertPointerMemoryBySource`` is idempotent
 * (deletes prior by ``source`` then inserts) so repeated grooming
 * runs keep PG aligned with disk.
 *
 * The function takes a wiki-root + page-path so callers don't have to
 * compute the rel-path / domain themselves. Best-effort: a PG hiccup
 * must never break the disk rewrite.
 *
 * source: cortex@HEAD~ mcp_server/handlers/consolidation/headless_authoring.py:_register_pointer_memory (2026-05-19)
 */

import path from "node:path";

interface PgPointerStore {
  upsertPointerMemoryBySource?: (args: {
    source: string;
    content: string;
    tags: readonly string[];
    domain?: string;
  }) => Promise<number>;
}

let _pgStoreInstance: PgPointerStore | null = null;

async function getPgStore(): Promise<PgPointerStore | null> {
  if (_pgStoreInstance) return _pgStoreInstance;
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) return null;
  try {
    const mod = await import("../remember/storage/pg-store.js");
    _pgStoreInstance = new mod.PgMemoryStore(databaseUrl) as unknown as PgPointerStore;
    return _pgStoreInstance;
  } catch { return null; }
}

/**
 * Upsert a PG pointer memory for the wiki page at ``pagePath``.
 *
 * - ``wikiRoot`` is the wiki tree root; the rel-path is computed from
 *   that (used as ``wiki://<rel-path>`` source key).
 * - The domain is the second path segment (the cortex layout is
 *   ``<kind>/<domain>/<file>.md``).
 * - Tags are ``[wiki, groomed]`` so the recall pipeline's
 *   groomedness-gate filter applies.
 *
 * Non-fatal: returns silently on any failure (no PG, no embedding
 * engine, write error). The disk rewrite is the source of truth; the
 * pointer memory is a retrieval cache.
 */
export async function registerPointerMemory(
  wikiRoot: string,
  pagePath: string,
  body: string,
): Promise<void> {
  try {
    const store = await getPgStore();
    if (!store || !store.upsertPointerMemoryBySource) return;
    const rel = path.relative(wikiRoot, pagePath);
    const parts = rel.split("/");
    const domain = parts.length >= 2 ? (parts[1] ?? "") : "";
    await store.upsertPointerMemoryBySource({
      source: `wiki://${rel}`,
      content: body,
      tags: ["wiki", "groomed"],
      domain,
    });
  } catch {
    // Best-effort: a PG hiccup must never break the disk rewrite.
  }
}
