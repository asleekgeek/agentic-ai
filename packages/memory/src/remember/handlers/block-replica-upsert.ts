/**
 * block-replica-upsert.ts — Upsert a memory-replica block by vpath identity.
 *
 * Extracted from remember-helpers.ts to keep that file under the 500-line cap
 * (§4.1 coding-standards.md).
 *
 * "State goes in the block; facts go to archival; never both." §8b
 *
 * source: mcp_server/handlers/remember_helpers.py:242-328 try_block_replica_upsert
 * contract: zetetic-team-subagents memory/contract.md §8b
 */

// ── BlockReplicaStore ─────────────────────────────────────────────────────────

/**
 * Minimal store capability required by tryBlockReplicaUpsert.
 *
 * The concrete PgMemoryStore satisfies this via its public runAsync method.
 * Isolated here so the upsert function does not take a wide MemoryStore
 * dependency (Interface Segregation Principle, §1.4).
 */
export interface BlockReplicaStore {
  runAsync<T>(
    fn: (client: {
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    }) => Promise<T>,
  ): Promise<T>;
}

// ── tryBlockReplicaUpsert ─────────────────────────────────────────────────────

/**
 * tryBlockReplicaUpsert — Upsert a memory-replica block by its vpath: identity
 * tag. Prevents duplicate rows when the post-tool-capture hook re-writes
 * the same block file.
 *
 * Precondition:  tags contains 'memory-replica' AND at least one tag starting
 *                with 'vpath:'.
 * Postcondition: if an existing row with the same vpath: tag exists, that
 *                row's content, embedding, tags, source, and last_accessed are
 *                refreshed in-place; is_protected and heat_base are preserved.
 *                Returns [true, existingId].
 *                If no existing row, returns [false, null] so the caller
 *                proceeds with a normal insert.
 * Invariant:     non-replica writes (tags without 'memory-replica') never
 *                reach this branch; one row per block file is maintained.
 *
 * source: mcp_server/handlers/remember_helpers.py:242-328
 * contract: zetetic-team-subagents memory/contract.md §8b
 */
export async function tryBlockReplicaUpsert(
  content: string,
  embedding: number[] | null,
  tags: string[],
  source: string,
  store: BlockReplicaStore,
): Promise<[boolean, number | null]> {
  const tagSet = new Set(tags.map((t) => String(t)));
  if (!tagSet.has("memory-replica")) return [false, null];

  const vpathTags = tags.filter((t) => t.startsWith("vpath:"));
  if (vpathTags.length === 0) return [false, null];

  const vpathTag = vpathTags[0]; // single vpath: per block

  try {
    const result = await store.runAsync(async (client) => {
      // JSONB containment query: find row that carries both memory-replica
      // and the specific vpath: tag.
      // source: mcp_server/handlers/remember_helpers.py:281-288
      const selectResult = await client.query(
        `SELECT id FROM memories
         WHERE tags @> $1::jsonb
           AND tags @> '["memory-replica"]'::jsonb
         LIMIT 1`,
        [JSON.stringify([vpathTag])],
      );
      const rows = selectResult.rows as Array<{ id: number } | unknown[]>;
      if (rows.length === 0) return [false, null] as [boolean, number | null];

      const firstRow = rows[0];
      const existingId: number =
        typeof firstRow === "object" && firstRow !== null && "id" in firstRow
          ? (firstRow as { id: number }).id
          : ((firstRow as unknown[])[0] as number);

      // Refresh content, tags, source, last_accessed; preserve heat_base and
      // is_protected (thermal state of the block must not be reset).
      // source: mcp_server/handlers/remember_helpers.py:296-324
      if (embedding !== null && embedding.length > 0) {
        await client.query(
          `UPDATE memories
           SET content = $1,
               embedding = $2::vector,
               tags = $3::jsonb,
               source = $4,
               last_accessed = NOW()
           WHERE id = $5`,
          [
            content,
            JSON.stringify(embedding),
            JSON.stringify(tags),
            source,
            existingId,
          ],
        );
      } else {
        await client.query(
          `UPDATE memories
           SET content = $1,
               tags = $2::jsonb,
               source = $3,
               last_accessed = NOW()
           WHERE id = $4`,
          [content, JSON.stringify(tags), source, existingId],
        );
      }

      return [true, existingId] as [boolean, number];
    });
    return result;
  } catch {
    // Treat any DB error as "no existing row" so the caller falls through
    // to the normal insert path. This is the same behaviour as the Python
    // source (except KeyError on missing id).
    // source: mcp_server/handlers/remember_helpers.py:289 + 325-326
    return [false, null];
  }
}
