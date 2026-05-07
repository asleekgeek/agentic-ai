/**
 * PgNarrativeAdapter — adapts a PgMemoryStore to the MemoryPort interface
 * required by narrative and unified-search handlers.
 *
 * LSP-VIOLATION CLOSED (#4): the composition root previously passed `null`
 * to registerNarrativeTools when DATABASE_URL was set (because
 * SqliteNarrativeAdapter requires the `_db` better-sqlite3 field, which is
 * absent on PgMemoryStore). Narrative tools were therefore entirely
 * unavailable on PG.
 *
 * This adapter closes the violation by implementing MemoryPort against
 * PgMemoryStore's typed async methods. All calls are async-bridged in the
 * same pattern as the rest of PgMemoryStore's sync-signature interface.
 *
 * Layer: infrastructure — wraps raw DB access; injected at composition root.
 * source: Martin, R. C. (2017). Clean Architecture, Ch. 22 — composition root
 *   is the only layer that wires core + infrastructure together.
 * source: Liskov, B. H. & Wing, J. M. (1994) — MemoryPort contract must be
 *   satisfied by ALL implementations, including PG.
 *
 * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py
 *   (getMemoriesForDomain, getHotMemories, getMemoriesForDirectory)
 */

import type { MemoryPort } from "./narrative.js";
import type { MemoryRecord } from "../types.js";
import type { PgMemoryStore } from "../../remember/storage/pg-store.js";

// ── Row normalization ──────────────────────────────────────────────────────

interface PgMemoryRow {
  content: unknown;
  tags: unknown;
  importance: unknown;
  heat_base: unknown;
  created_at: unknown;
}

function rowToRecord(row: PgMemoryRow): MemoryRecord {
  let tags: string[];
  const rawTags = row.tags;
  if (Array.isArray(rawTags)) {
    tags = rawTags as string[];
  } else if (typeof rawTags === "string") {
    try {
      const parsed: unknown = JSON.parse(rawTags);
      tags = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      tags = [];
    }
  } else {
    tags = [];
  }
  return {
    content:    String(row.content ?? ""),
    tags,
    importance: typeof row.importance === "number" ? row.importance : 0.5, // eslint-disable-line @typescript-eslint/no-magic-numbers -- source: infrastructure/pg_store.py default importance
    heat:       typeof row.heat_base === "number" ? row.heat_base : 0.0,
    timestamp:  String(row.created_at ?? ""),
    session_id: "",
  };
}

// ── PgNarrativeAdapter ────────────────────────────────────────────────────────

/**
 * Adapts PgMemoryStore to the MemoryPort interface.
 *
 * Precondition:  store is a live PgMemoryStore with an active pool.
 * Postcondition: all MemoryPort methods produce equivalent results to
 *   SqliteNarrativeAdapter for the same store state.
 *
 * LSP contract: this adapter is substitutable for SqliteNarrativeAdapter
 * wherever MemoryPort is expected. Callers must not observe behavioral
 * differences attributable to the backend type.
 *
 * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py
 *   getMemoriesForDomain, getMemoriesForDirectory, getHotMemories
 */
export class PgNarrativeAdapter implements MemoryPort {
  constructor(private readonly _store: PgMemoryStore) {}

  /**
   * Return memories for a directory, ordered by heat descending.
   *
   * Precondition:  directory is a non-empty string; minHeat >= 0.
   * Postcondition: returns memories where directory_context LIKE directory%
   *   AND heat_base >= minHeat, ordered by heat DESC.
   *
   * NOTE: PG uses a LIKE prefix match (same semantics as SQLite adapter).
   * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:30-38
   */
  getMemoriesForDirectory(directory: string, minHeat: number): MemoryRecord[] {
    const raw = this._store.getMemoriesForDirectory(directory, minHeat);
    return raw.map((r) => rowToRecord(r as unknown as PgMemoryRow));
  }

  /**
   * Return up to `limit` memories for a domain, ordered by heat descending.
   *
   * Precondition:  domain is a string; minHeat >= 0; limit > 0.
   * Postcondition: returns at most `limit` rows where domain = domain
   *   AND heat_base >= minHeat, ordered by heat DESC.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:20-28
   */
  getMemoriesForDomain(domain: string, minHeat: number, limit: number): MemoryRecord[] {
    const raw = this._store.getMemoriesForDomain(domain, minHeat, limit);
    return raw.map((r) => rowToRecord(r as unknown as PgMemoryRow));
  }

  /**
   * Return up to `limit` hot memories across all domains.
   *
   * Precondition:  minHeat >= 0; limit > 0.
   * Postcondition: returns at most `limit` rows with heat_base >= minHeat,
   *   ordered by heat DESC.
   *
   * source: cortex@ed33435 mcp_server/infrastructure/pg_store_queries.py:40-61
   */
  getHotMemories(minHeat: number, limit: number): MemoryRecord[] {
    const raw = this._store.getHotMemories(minHeat, limit);
    return raw.map((r) => rowToRecord(r as unknown as PgMemoryRow));
  }
}
