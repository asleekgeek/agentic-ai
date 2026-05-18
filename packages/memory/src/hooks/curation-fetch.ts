/**
 * Cortex hooks — curator-specific memory fetch.
 *
 * Returns the memory snapshot shape the auto-curator consumes:
 * id, content, tags, effective_heat, created_at, domain. Kept
 * separate from db.ts so the SessionStart hook's curation path
 * can evolve without churn on the broader memory helpers.
 *
 * source: cortex@4883307 mcp_server/hooks/session_start.py:219-231
 */

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};

async function openConnection(databaseUrl: string): Promise<PgClient | null> {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    return client as unknown as PgClient;
  } catch {
    return null;
  }
}

/** The shape ``countPendingClusters`` consumes — strict subset of CuratorMemory. */
export interface CuratorMemorySnapshot {
  readonly id: number;
  readonly content: string;
  readonly tags: readonly string[];
  readonly effective_heat: number;
  readonly created_at: string;
  readonly domain: string;
}

/**
 * Fetch a curator-ready memory sample.
 *
 * Returns up to ``limit`` non-stale memories with the fields the
 * auto-curator consumes. Ordered by
 * ``last_accessed DESC NULLS LAST, created_at DESC`` so recently-
 * touched topics dominate the cluster pool.
 *
 * source: cortex@4883307 mcp_server/hooks/session_start.py:219-231
 *         ("SELECT ... FROM memories WHERE NOT is_stale ORDER BY
 *           last_accessed DESC NULLS LAST, created_at DESC LIMIT 500")
 */
export async function fetchRecentMemoriesForCuration(
  databaseUrl: string,
  limit: number,
): Promise<CuratorMemorySnapshot[]> {
  const conn = await openConnection(databaseUrl);
  if (!conn) return [];
  try {
    const { rows } = await conn.query(
      `SELECT id, content, tags, effective_heat, created_at, domain
       FROM memories
       WHERE NOT is_stale
       ORDER BY last_accessed DESC NULLS LAST, created_at DESC
       LIMIT $1`,
      [limit],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id:             Number(r["id"]),
      content:        (r["content"] as string) ?? "",
      tags:           Array.isArray(r["tags"]) ? (r["tags"] as string[]) : [],
      effective_heat: Number(r["effective_heat"] ?? 0),
      created_at:     String(r["created_at"] ?? ""),
      domain:         (r["domain"] as string) ?? "",
    }));
  } catch {
    return [];
  } finally {
    await conn.end();
  }
}
