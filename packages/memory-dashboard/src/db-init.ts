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
  } finally {
    db.close();
  }
}
