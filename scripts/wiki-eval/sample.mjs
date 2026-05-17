#!/usr/bin/env node
/**
 * Sample N random memories from a Postgres DB and dump (id, content, tags)
 * as JSONL for downstream classification.
 *
 * Usage:
 *   node sample.mjs <db_name> <n> > sample.jsonl
 *
 * Sampling: SELECT … ORDER BY random() LIMIT N is fine for N up to ~100k.
 * The query is deterministic only across a single run; the random seed
 * is not pinned because the goal is cross-DB distribution comparison,
 * not reproducible byte-identical output.
 */

import pg from "pg";

const [, , dbName, nRaw] = process.argv;
if (!dbName || !nRaw) {
  console.error("usage: sample.mjs <db_name> <n>");
  process.exit(2);
}
const n = Number.parseInt(nRaw, 10);
if (!Number.isFinite(n) || n <= 0) {
  console.error(`invalid n: ${nRaw}`);
  process.exit(2);
}

const client = new pg.Client({
  host: "localhost",
  database: dbName,
  user: process.env.USER ?? "postgres",
});
await client.connect();
try {
  const res = await client.query(
    `SELECT id, content, tags
       FROM memories
      WHERE length(content) > 100
      ORDER BY random()
      LIMIT $1`,
    [n],
  );
  for (const row of res.rows) {
    // pg returns JSONB as JS array already
    const tags = Array.isArray(row.tags) ? row.tags : [];
    process.stdout.write(
      JSON.stringify({ id: row.id, content: row.content, tags }) + "\n",
    );
  }
} finally {
  await client.end();
}
