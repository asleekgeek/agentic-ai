/**
 * pg-store-rules.ts — Rule engine and prospective-memory persistence for PG.
 *
 * Implements the 6 MemoryStoreExt rule-engine methods on PostgreSQL.
 * Previously these were SQLite-only, causing silent no-ops on PG
 * (history-constraint LSP violation — Liskov & Wing 1994, §4).
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:9-70
 * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:249-253
 * source: cortex main mcp_server/infrastructure/sqlite_store_auxiliary.py:21-37
 * source: cortex main mcp_server/infrastructure/pg_store_auxiliary.py:22-38
 *   (insertProspectiveMemory PG async already existed; wrapped here for sync parity)
 */

import type { PoolClient } from "pg";

// ── insertRule ────────────────────────────────────────────────────────────────

export interface RuleInsertData {
  rule_type: string;
  scope: string;
  scope_value: string | null;
  condition: string;
  action: string;
  priority: number;
  is_active: boolean;
}

/**
 * Insert a neuro-symbolic rule. Returns the new row id.
 *
 * precondition:  data.condition and data.action are non-empty strings.
 * postcondition: returned id > 0; row exists in memory_rules with
 *   is_active = data.is_active and all supplied fields written.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:14-31
 *   SQL equivalent: INSERT INTO memory_rules (...) VALUES (...)
 * source: PostgreSQL INSERT ... RETURNING id
 *   https://www.postgresql.org/docs/current/sql-insert.html
 */
export async function insertRule(client: PoolClient, data: RuleInsertData): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO memory_rules
       (rule_type, scope, scope_value, condition, action, priority, is_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id`,
    [
      data.rule_type ?? "soft",
      data.scope ?? "global",
      data.scope_value ?? null,
      data.condition,
      data.action,
      data.priority ?? 0,
      data.is_active !== false,
    ],
  );
  const row = result.rows[0];
  if (row == null) throw new Error("insertRule: no id returned from PG");
  return row.id;
}

// ── getAllActiveRules ─────────────────────────────────────────────────────────

/**
 * Return all active rules ordered by scope ASC, priority DESC.
 *
 * postcondition: returns every row where is_active = true.
 *   Returns [] if no rules exist.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:41-45
 *   SQL equivalent: SELECT * FROM memory_rules WHERE is_active ORDER BY scope, priority DESC
 */
export async function getAllActiveRules(client: PoolClient): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    "SELECT * FROM memory_rules WHERE is_active ORDER BY scope, priority DESC",
  );
  return result.rows as Record<string, unknown>[];
}

// ── getRulesForScope ──────────────────────────────────────────────────────────

/**
 * Return active rules matching a specific scope string.
 *
 * postcondition: returns rows where scope = $1 AND is_active = true,
 *   ordered by priority DESC. Returns [] if none exist.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:33-39
 *   SQL equivalent: SELECT * FROM memory_rules WHERE scope = ? AND is_active ORDER BY priority DESC
 */
export async function getRulesForScope(client: PoolClient, scope: string): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    "SELECT * FROM memory_rules WHERE scope = $1 AND is_active ORDER BY priority DESC",
    [scope],
  );
  return result.rows as Record<string, unknown>[];
}

// ── getAllRulesIncludingInactive ───────────────────────────────────────────────

/**
 * Return all rules including inactive (admin/debug listing).
 *
 * postcondition: returns every row in memory_rules ordered by scope ASC,
 *   priority DESC. Returns [] if table is empty.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py
 *   admin listing analogue (no exact Python line — derived from getAllActiveRules
 *   by removing the is_active filter; consistent with SQLite implementation above)
 */
export async function getAllRulesIncludingInactive(client: PoolClient): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    "SELECT * FROM memory_rules ORDER BY scope, priority DESC",
  );
  return result.rows as Record<string, unknown>[];
}

// ── countActiveTriggers ───────────────────────────────────────────────────────

/**
 * Count prospective-memory triggers currently armed (is_active = true).
 *
 * postcondition: returns COUNT(*) WHERE is_active = true.
 *   Returns 0 if table is empty.
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:249-253
 *   SQL equivalent: SELECT COUNT(*) FROM prospective_memories WHERE is_active
 * source: pg-store-stats.ts::countActiveTriggers (already existed as standalone fn)
 */
export async function countActiveTriggers(client: PoolClient): Promise<number> {
  const result = await client.query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM prospective_memories WHERE is_active",
  );
  return result.rows[0]?.c ?? 0;
}

// ── insertProspectiveMemory ───────────────────────────────────────────────────

export interface ProspectiveMemoryInsertData {
  content: string;
  trigger_condition: string;
  trigger_type: string;
  target_directory?: string | null;
  is_active?: boolean;
  triggered_count?: number;
}

/**
 * Schedule a prospective memory (trigger). Returns the new row id.
 *
 * precondition:  data.content, data.trigger_condition, data.trigger_type
 *   are non-empty strings.
 * postcondition: returned id > 0; row exists in prospective_memories
 *   with is_active = data.is_active (default true).
 *
 * source: cortex main mcp_server/infrastructure/sqlite_store_auxiliary.py:21-37
 *   SQL equivalent: INSERT INTO prospective_memories (...) VALUES (...)
 * source: cortex main mcp_server/infrastructure/pg_store_auxiliary.py:22-38
 *   (pre-existing async function; this module re-exports the same SQL with
 *   the typed interface matching the MemoryStoreExt contract)
 */
export async function insertProspectiveMemory(
  client: PoolClient,
  data: ProspectiveMemoryInsertData,
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO prospective_memories
       (content, trigger_condition, trigger_type, target_directory, is_active, triggered_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      data.content,
      data.trigger_condition,
      data.trigger_type,
      data.target_directory ?? null,
      data.is_active !== false,
      data.triggered_count ?? 0,
    ],
  );
  const row = result.rows[0];
  if (row == null) throw new Error("insertProspectiveMemory: no id returned from PG");
  return row.id;
}
