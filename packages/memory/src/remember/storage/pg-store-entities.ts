/**
 * pg-store-entities.ts — Entity CRUD for PgMemoryStore.
 * source: cortex main mcp_server/infrastructure/pg_store_entities.py
 */
import type { PoolClient } from "pg";

function canonicalize(name: string): string { return name.trim(); }

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:19-37
export async function updateEntitiesHeatBatch(client: PoolClient, updates: Array<[number, number]>): Promise<number> {
  if (updates.length === 0) return 0;
  await client.query(
    `UPDATE entities AS e SET heat = v.new_heat FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::real[]) AS new_heat) AS v WHERE e.id = v.id`,
    [updates.map((u) => u[0]), updates.map((u) => u[1])],
  );
  return updates.length;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:39-48
export async function archiveEntitiesBatch(client: PoolClient, entityIds: number[]): Promise<number> {
  if (entityIds.length === 0) return 0;
  await client.query("UPDATE entities SET heat = 0 WHERE id = ANY($1::int[])", [entityIds]);
  return entityIds.length;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:50-91
export async function insertEntity(
  client: PoolClient,
  data: { name: string; type: string; domain?: string; origin?: string; created_at?: string | null; heat?: number },
): Promise<number> {
  const canonical = canonicalize(data.name);
  let origin = data.origin ?? "text_concept";
  if (origin !== "ast_symbol" && origin !== "text_concept") origin = "text_concept";
  // source: cortex main mcp_server/infrastructure/pg_store_entities.py:65-78 — origin-aware idempotent upsert
  const existing = await client.query<{ id: number; origin: string }>(
    "SELECT id, origin FROM entities WHERE LOWER(name) = LOWER($1) LIMIT 1", [canonical]);
  const existingRow = existing.rows[0];
  if (existingRow != null) {
    // ast_symbol is the safe superset: if any ingestion path marks this name a
    // code symbol, keep it exempt from fuzzy dedup forever.
    if (origin === "ast_symbol" && existingRow.origin !== "ast_symbol") {
      await client.query("UPDATE entities SET origin = 'ast_symbol' WHERE id = $1", [existingRow.id]);
    }
    return existingRow.id;
  }
  const result = await client.query<{ id: number }>(
    `INSERT INTO entities (name, type, domain, origin, created_at, last_accessed, heat)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), NOW(), $6) RETURNING id`,
    [canonical, data.type, data.domain ?? "", origin, data.created_at ?? null, data.heat ?? 1.0],
  );
  const row = result.rows[0];
  if (row == null) throw new Error("insertEntity: no id returned");
  return row.id;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:82-91
export async function getEntityByName(client: PoolClient, name: string): Promise<Record<string, unknown> | null> {
  const result = await client.query("SELECT * FROM entities WHERE LOWER(name) = LOWER($1) LIMIT 1", [name]);
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:93-97
export async function getEntityById(client: PoolClient, entityId: number): Promise<Record<string, unknown> | null> {
  const result = await client.query("SELECT * FROM entities WHERE id = $1", [entityId]);
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Return the highest-heat entities tagged with `domainSlug`.
 *
 * Used by the chain endpoint to seed a domain-level BFS — the domain node
 * itself is not an entity, but its code symbols are. Mirrors the oracle's
 * ORDER BY heat DESC, mention_count DESC exactly.
 *
 * source: cortex main mcp_server/infrastructure/pg_store_entities.py:111-124
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- source: cortex main mcp_server/infrastructure/pg_store_entities.py:112
export async function getTopEntitiesForDomain(client: PoolClient, domainSlug: string, limit = 20): Promise<Record<string, unknown>[]> {
  return (await client.query(
    "SELECT * FROM entities WHERE domain = $1 ORDER BY heat DESC, mention_count DESC LIMIT $2",
    [domainSlug, limit])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:99-111
export async function getAllEntities(client: PoolClient, minHeat = 0.05, includeArchived = false): Promise<Record<string, unknown>[]> { // eslint-disable-line @typescript-eslint/no-magic-numbers
  const q = includeArchived
    ? "SELECT * FROM entities WHERE heat >= $1"
    : "SELECT * FROM entities WHERE heat >= $1 AND NOT archived";
  return (await client.query(q, [minHeat])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:113-115
export async function countEntities(client: PoolClient): Promise<number> {
  return (await client.query<{ c: number }>("SELECT COUNT(*) AS c FROM entities")).rows[0]?.c ?? 0;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:117-121
export async function getEntitiesOfType(client: PoolClient, entityType: string): Promise<Record<string, unknown>[]> {
  return (await client.query("SELECT * FROM entities WHERE type = $1", [entityType])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:123-128
export async function getDomainEntityCounts(client: PoolClient): Promise<Record<string, number>> {
  const result = await client.query<{ domain: string; count: number }>(
    "SELECT domain, COUNT(*) AS count FROM entities WHERE NOT archived GROUP BY domain ORDER BY count DESC");
  const out: Record<string, number> = {};
  for (const row of result.rows) out[row.domain] = row.count;
  return out;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:130-143
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- source: cortex main mcp_server/infrastructure/pg_store_entities.py:130
export async function getIsolatedEntities(client: PoolClient, limit = 20): Promise<Record<string, unknown>[]> {
  return (await client.query(
    `SELECT e.*, COALESCE(r.rel_count, 0) AS relationship_count FROM entities e
     LEFT JOIN (SELECT source_entity_id AS eid, COUNT(*) AS rel_count FROM relationships GROUP BY source_entity_id) r ON r.eid = e.id
     WHERE NOT e.archived ORDER BY relationship_count ASC, e.heat DESC LIMIT $1`,
    [limit],
  )).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:145-150
export async function getResolvedEntityIds(client: PoolClient): Promise<Set<number>> {
  const result = await client.query<{ source_entity_id: number }>(
    "SELECT DISTINCT source_entity_id FROM relationships WHERE relationship_type = 'resolved_by'");
  return new Set(result.rows.map((r) => r.source_entity_id));
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:152-174
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- source: cortex main mcp_server/infrastructure/pg_store_entities.py:152
export async function getMemoriesMentioningEntity(client: PoolClient, entityName: string, limit = 20): Promise<Record<string, unknown>[]> {
  let result = await client.query(
    "SELECT * FROM memories WHERE content_tsv @@ phraseto_tsquery('english', $1) ORDER BY heat_base DESC LIMIT $2",
    [entityName, limit]);
  if (result.rows.length === 0) {
    const escaped = entityName.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    result = await client.query(
      "SELECT * FROM memories WHERE content ILIKE $1 AND NOT is_stale ORDER BY heat_base DESC LIMIT $2",
      [`%${escaped}%`, limit]);
  }
  return result.rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:176-183
export async function insertMemoryEntity(client: PoolClient, memoryId: number, entityId: number): Promise<void> {
  await client.query(
    "INSERT INTO memory_entities (memory_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [memoryId, entityId]);
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:184-198
export async function listMemoryEntityEdges(client: PoolClient): Promise<Array<{ memory_id: number; entity_id: number }>> {
  const result = await client.query<{ memory_id: number; entity_id: number }>(
    "SELECT memory_id, entity_id FROM memory_entities");
  return result.rows.filter((r) => r.memory_id != null && r.entity_id != null);
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:200-208
export async function getEntitiesForMemory(client: PoolClient, memoryId: number): Promise<Record<string, unknown>[]> {
  return (await client.query(
    "SELECT e.* FROM entities e JOIN memory_entities me ON me.entity_id = e.id WHERE me.memory_id = $1 ORDER BY e.heat DESC",
    [memoryId])).rows as Record<string, unknown>[];
}

// Source: Jaccard (1912) set similarity.
// source: cortex main mcp_server/infrastructure/pg_store_entities.py:210-235
export async function getEntityIdsForMemories(client: PoolClient, memoryIds: number[]): Promise<Map<number, Set<number>>> {
  if (memoryIds.length === 0) return new Map();
  const result = await client.query<{ memory_id: number; entity_id: number }>(
    "SELECT memory_id, entity_id FROM memory_entities WHERE memory_id = ANY($1::int[])", [memoryIds]);
  const out = new Map<number, Set<number>>();
  for (const row of result.rows) {
    const set = out.get(row.memory_id) ?? new Set<number>();
    set.add(row.entity_id);
    out.set(row.memory_id, set);
  }
  return out;
}

// source: cortex main mcp_server/infrastructure/pg_store_entities.py:237-245
export async function getMemoriesForEntity(client: PoolClient, entityId: number): Promise<Record<string, unknown>[]> {
  return (await client.query(
    "SELECT m.* FROM memories m JOIN memory_entities me ON me.memory_id = m.id WHERE me.entity_id = $1 ORDER BY m.heat_base DESC",
    [entityId])).rows as Record<string, unknown>[];
}

// source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py:23-56
// No-op when ids match, either entity is missing, or either is an ast_symbol —
// code-symbol identity is structural and must never be fuzzy-merged; defense in
// depth over the core engine's own exclusion.
export interface MergeEntitiesResult {
  merged: boolean;
  survivor_id: number;
  alias_id: number;
  memory_links_moved: number;
  relationships_rewired: number;
}

export async function mergeEntities(
  client: PoolClient,
  survivorId: number,
  aliasId: number,
): Promise<MergeEntitiesResult> {
  // precondition:  survivorId and aliasId are positive integers.
  // postcondition: if merged, alias row archived (archived=true, heat=0);
  //   all memory_entities and relationships rows pointing to alias are
  //   retargeted to survivor; self-loops are deleted; survivor heat/recency
  //   absorbs alias via GREATEST (bounded — never a sum); all in one transaction.
  const result: MergeEntitiesResult = {
    merged: false,
    survivor_id: survivorId,
    alias_id: aliasId,
    memory_links_moved: 0,
    relationships_rewired: 0,
  };

  if (survivorId === aliasId) return result;

  // Require both entities present AND neither an ast_symbol — code symbols are
  // structural identities, never fuzzy-merged.
  // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py:50-56
  const existsResult = await client.query<{ id: number; origin: string }>(
    "SELECT id, origin FROM entities WHERE id = ANY($1::int[])",
    [[survivorId, aliasId]],
  );
  const origins = new Map(existsResult.rows.map((r) => [r.id, r.origin ?? "text_concept"]));
  if (origins.size !== 2 || [...origins.values()].includes("ast_symbol")) return result;

  try {
    await client.query("BEGIN");

    // Rewire memory_entities links: insert survivor links, dedup via ON CONFLICT.
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — INSERT INTO memory_entities
    await client.query(
      "INSERT INTO memory_entities (memory_id, entity_id) " +
        "SELECT memory_id, $1 FROM memory_entities WHERE entity_id = $2 " +
        "ON CONFLICT DO NOTHING",
      [survivorId, aliasId],
    );

    // Delete the alias's memory_entities links.
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — DELETE FROM memory_entities
    const movedResult = await client.query<{ rowcount: number }>(
      "DELETE FROM memory_entities WHERE entity_id = $1",
      [aliasId],
    );
    const moved = movedResult.rowCount ?? 0;

    // Rewire relationship source references.
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — UPDATE relationships source
    const srcResult = await client.query(
      "UPDATE relationships SET source_entity_id = $1 WHERE source_entity_id = $2",
      [survivorId, aliasId],
    );
    // Rewire relationship target references.
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — UPDATE relationships target
    const tgtResult = await client.query(
      "UPDATE relationships SET target_entity_id = $1 WHERE target_entity_id = $2",
      [survivorId, aliasId],
    );

    // Delete self-loops created by the rewire.
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — DELETE self-loops
    await client.query(
      "DELETE FROM relationships WHERE source_entity_id = target_entity_id AND source_entity_id = $1",
      [survivorId],
    );

    // Absorb alias heat/recency into survivor via GREATEST — bounded, not a sum.
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — UPDATE entities heat
    await client.query(
      "UPDATE entities SET " +
        "heat = GREATEST(heat, (SELECT heat FROM entities WHERE id = $1)), " +
        "last_accessed = GREATEST(last_accessed, (SELECT last_accessed FROM entities WHERE id = $1)) " +
        "WHERE id = $2",
      [aliasId, survivorId],
    );

    // Tombstone the alias: archived=true, heat=0 (auditable, NOT deleted).
    // source: cortex main mcp_server/infrastructure/pg_store_entity_merge.py — UPDATE entities tombstone
    await client.query(
      "UPDATE entities SET archived = TRUE, heat = 0 WHERE id = $1",
      [aliasId],
    );

    await client.query("COMMIT");

    result.merged = true;
    result.memory_links_moved = moved;
    result.relationships_rewired = (srcResult.rowCount ?? 0) + (tgtResult.rowCount ?? 0);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  return result;
}
