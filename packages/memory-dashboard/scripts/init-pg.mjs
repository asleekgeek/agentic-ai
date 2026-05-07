#!/usr/bin/env node
/**
 * init-pg.mjs — Idempotent PostgreSQL provisioning script.
 *
 * ADR-0042: provisions the `cortex_agentic` database schema for the
 * agentic-ai memory plugin dashboard.
 *
 * Imports getAllDdl() from @agentic/memory's pg-schema-functions, opens
 * one pg.Client, runs all DDL in a single transaction (BEGIN ... COMMIT).
 * Idempotent: all DDL uses CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/cortex_agentic node scripts/init-pg.mjs
 *
 * source: ADR-0042 §files-to-add — "provisioning script"
 * source: packages/memory/src/remember/storage/pg-schema-functions.ts — getAllDdl()
 */

import pg from "pg";

// Resolve getAllDdl from the built dist (used after pnpm -r build).
// source: packages/memory/src/remember/storage/pg-schema-functions.ts:430
const { getAllDdl } = await import(
  "../../memory/dist/remember/storage/pg-schema-functions.js"
);

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  process.stderr.write(
    "[init-pg] DATABASE_URL is not set. " +
    "Example: DATABASE_URL=postgresql://localhost:5432/cortex_agentic node scripts/init-pg.mjs\n"
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const statements = getAllDdl();
  await client.query("BEGIN");
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    try {
      await client.query(trimmed);
    } catch (err) {
      // Tolerate "already exists" errors for extensions — they are not IF NOT EXISTS-able.
      // source: PostgreSQL docs — CREATE EXTENSION raises 42710 if already installed
      //         without IF NOT EXISTS guard.
      const pgErr = /** @type {any} */ (err);
      if (pgErr?.code === "42710") {
        // duplicate_object — extension already installed; safe to ignore.
        continue;
      }
      throw err;
    }
  }
  await client.query("COMMIT");
  process.stdout.write(`[init-pg] provisioned ${statements.length} DDL statements on ${connectionString}\n`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {/* best-effort */});
  process.stderr.write(`[init-pg] FAILED: ${String(err)}\n`);
  process.exit(1);
} finally {
  await client.end();
}
