/**
 * wiki-list-cache.ts — in-memory cache for the wiki page list.
 *
 * The dashboard's ``/api/wiki/list``, ``/api/wiki/projects``, and
 * ``/api/wiki/maintenance`` endpoints all walk the same ~14k-page
 * markdown tree synchronously. Without a cache, every browser
 * refresh / tab-focus event blocks the Fastify event loop for
 * hundreds of milliseconds; concurrent requests serialise behind
 * each other and the dashboard appears hung.
 *
 * Strategy: cache the full ``DashboardWikiPage[]`` snapshot with two
 * invalidation signals:
 *
 *   1. ``WIKI_LIST_TTL_MS`` (default 30s) — bound staleness even if
 *      the directory mtime didn't change (page bodies edited
 *      in-place keep the parent mtime constant).
 *   2. Wiki-root directory mtime — when ``wiki_write`` adds a new
 *      page, the parent kind directory's mtime changes; we detect
 *      that on the cheap and invalidate.
 *
 * source: this module — observed against live wiki, 2026-05-19
 *   (server went unresponsive on tab switch with no cache)
 */

import fs from "node:fs";
import path from "node:path";

// 30s TTL caps staleness even when no directory mtime moved (in-place
// page edits don't touch parent mtimes). Empirically: a 14k-page walk
// takes 200-400 ms on macOS, so 30s is well below the rate at which
// the user would notice freshness lag yet far above the cost of the
// walk.
// source: this module — calibrated against the live wiki walk
const WIKI_LIST_TTL_MS = 30_000;

interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: number;
  readonly rootSig: string;
}

const cache: Map<string, CacheEntry<unknown>> = new Map();

/**
 * Build a cheap signature of the wiki root that changes whenever a
 * kind directory is added/removed or its mtime moves (i.e. a page is
 * added/removed inside it). Walks only the top + one level — O(kinds
 * × domains) directory stats, not O(pages) file reads.
 */
function rootSignature(wikiDir: string): string {
  const parts: string[] = [];
  let kinds: fs.Dirent<string>[];
  try {
    kinds = fs.readdirSync(wikiDir, { withFileTypes: true });
  } catch { return ""; }
  for (const k of kinds) {
    if (!k.isDirectory()) continue;
    if (k.name.startsWith(".")) continue;
    let kStat: fs.Stats;
    try { kStat = fs.statSync(path.join(wikiDir, k.name)); } catch { continue; }
    parts.push(`${k.name}:${kStat.mtimeMs}`);
    // Also stat the immediate <kind>/<domain>/ level so new domain
    // dirs invalidate too. Cheap because there are at most ~30
    // domains per kind.
    let domains: fs.Dirent<string>[];
    try {
      domains = fs.readdirSync(path.join(wikiDir, k.name), { withFileTypes: true });
    } catch { continue; }
    for (const d of domains) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith(".")) continue;
      try {
        const dStat = fs.statSync(path.join(wikiDir, k.name, d.name));
        parts.push(`${k.name}/${d.name}:${dStat.mtimeMs}`);
      } catch { /* skip */ }
    }
  }
  parts.sort();
  return parts.join("|");
}

/**
 * Return a cached value for ``key`` if it's still fresh (TTL +
 * unchanged root signature), otherwise compute via ``produce``, cache
 * the result, and return it.
 *
 * The cache is keyed by ``(wikiDir, key)`` so multiple computed
 * artifacts (list / projects / maintenance) share the same staleness
 * gate without contaminating each other's values.
 *
 * Failures inside ``produce`` propagate up — we never poison the
 * cache with a thrown value.
 */
export function getOrCompute<T>(
  wikiDir: string,
  key: string,
  produce: () => T,
): T {
  const cacheKey = `${wikiDir}::${key}`;
  const sig = rootSignature(wikiDir);
  const now = Date.now();
  const hit = cache.get(cacheKey) as CacheEntry<T> | undefined;
  if (hit && now - hit.storedAt < WIKI_LIST_TTL_MS && hit.rootSig === sig) {
    return hit.value;
  }
  const value = produce();
  cache.set(cacheKey, { value, storedAt: now, rootSig: sig });
  return value;
}

/**
 * Invalidate every cached entry under ``wikiDir``. Called by
 * ``POST /api/wiki/save`` so a freshly-written page surfaces on the
 * very next fetch without waiting for the TTL.
 */
export function invalidate(wikiDir: string): void {
  const prefix = `${wikiDir}::`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}
