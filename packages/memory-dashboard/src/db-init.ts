/**
 * db-init.ts — Apply the canonical SQLite schema at dashboard startup.
 *
 * Layer: handlers (composition root) — opens the DB read-write once to
 *   ensure all tables exist, then closes. Routes open it read-only.
 *
 * precondition:  dbPath points to an existing or creatable SQLite file.
 * postcondition: every table and index from getAllDdl() + MIGRATIONS exists
 *   in the DB; subsequent read-only opens will not fail due to missing tables.
 *
 * Invariant: this function is idempotent — CREATE TABLE/INDEX IF NOT EXISTS
 *   and ALTER TABLE ADD COLUMN (caught on duplicate) make repeated calls safe.
 *
 * source: cortex@ed33435 mcp_server/infrastructure/sqlite_schema.py:263-299
 *   (getAllDdl + migrations applied at server startup)
 */

import Database from "better-sqlite3";
import { getAllDdl, MIGRATIONS } from "@agentic/memory/schema";

/**
 * Compatibility migrations for SQLite files seeded by Cortex's Python
 * writer (different column names than agentic-ai's canonical schema).
 *
 * The dashboard's queries expect ``heat_base`` / ``heat_base_set_at``
 * / ``no_decay``; Cortex stores those signals as ``heat`` /
 * ``last_accessed`` and has no ``no_decay`` column at all. Adding
 * VIRTUAL generated columns gives the dashboard the names it needs
 * without storing anything new and without breaking Cortex's writes
 * (Cortex never references these aliases).
 *
 * Each entry is a CREATE statement we wrap in try/catch so it's a
 * silent no-op when the column already exists (which is the case
 * for agentic-ai's native schema where heat_base is a real column).
 *
 * source: cortex SQLite schema mcp_server/infrastructure/sqlite_schema.py
 *   — stores heat, last_accessed; no heat_base, no no_decay.
 * source: this dashboard's db-adapter.ts effective_heat() UDF signature
 *   — heat_base, heat_base_set_at, last_accessed, created_at,
 *     stage_entered_at, consolidation_stage, emotional_valence,
 *     is_protected, no_decay.
 */
const COMPAT_MIGRATIONS: ReadonlyArray<readonly [string, string, string]> = [
  // heat_base ← heat. The canonical agentic-ai column is REAL DEFAULT 0;
  // when missing we expose Cortex's ``heat`` (REAL DEFAULT 1.0) verbatim.
  ["memories", "heat_base",        "REAL GENERATED ALWAYS AS (heat) VIRTUAL"],
  // heat_base_set_at ← last_accessed. Cortex doesn't track a separate
  // "heat was set at" timestamp; last_accessed is the closest proxy
  // and is what Cortex's own decay scoring uses.
  ["memories", "heat_base_set_at", "TEXT GENERATED ALWAYS AS (last_accessed) VIRTUAL"],
  // no_decay defaults to 0 (decay applies). Cortex doesn't carry this
  // flag; the dashboard's effective_heat() UDF uses it only to skip
  // the decay multiplier for protected memories, which already have
  // is_protected=1 separately.
  ["memories", "no_decay",         "INTEGER GENERATED ALWAYS AS (0) VIRTUAL"],
];

/**
 * Ensure the schema is up-to-date in the SQLite file at dbPath.
 *
 * precondition:  dbPath is a valid filesystem path (file need not exist yet).
 * postcondition: all DDL tables/indexes from getAllDdl() exist; all MIGRATIONS
 *   columns are present (ALTER TABLE is skipped silently if already present).
 */
export function ensureSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const ddl of getAllDdl()) {
      // Each statement in getAllDdl() uses CREATE TABLE/INDEX IF NOT EXISTS.
      // Split on ";" to handle multi-statement DDL strings (INDEXES_DDL).
      for (const stmt of ddl.split(";").map((s) => s.trim()).filter(Boolean)) {
        try {
          db.exec(stmt);
        } catch {
          // Tolerate: virtual table already exists, extension not loaded, etc.
        }
      }
    }
    for (const [table, col, def] of MIGRATIONS) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      } catch {
        // Column already exists — expected on re-init.
      }
    }
    // Compat migrations — add virtual aliases for Cortex-shaped DBs.
    // No-op when the agentic-ai canonical column already exists.
    // source: see COMPAT_MIGRATIONS definition above
    for (const [table, col, def] of COMPAT_MIGRATIONS) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      } catch {
        // Either the column already exists, or the source column
        // (heat / last_accessed) is itself missing because this DB
        // has a totally different schema. Both are non-fatal.
      }
    }
  } finally {
    db.close();
  }
}
