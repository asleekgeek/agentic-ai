/**
 * db-effective-heat.test.ts — Integration test for the B1#2 parity fix.
 *
 * The hooks/db.ts read-paths must compute heat via the effective_heat(m, NOW())
 * PL/pgSQL function (lazy A3 decay), NOT a bare `memories.heat` column — which
 * does not exist, so the pre-fix queries raised "column heat does not exist"
 * and were swallowed by catch{return []}, silently injecting nothing.
 *
 * source: cortex@bc5af469 hooks/{auto_recall,session_start,agent_briefing}.py
 *         (mirrors tests_py/hooks/test_auto_recall.py end-to-end seeded smoke).
 *
 * Gated on a reachable local PostgreSQL (pgvector + pg_trgm). Skips otherwise,
 * so CI without a database is unaffected. Set PG_ADMIN_URL to override.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getAllDdl } from "../../src/remember/storage/pg-schema-functions.js";
import {
  fetchAnchors,
  fetchTeamDecisions,
  ftsRecall,
  fetchAgentMemories,
  fetchTeamDecisionsForAgent,
} from "../../src/hooks/db.js";

const ADMIN_URL =
  process.env.PG_ADMIN_URL ?? "postgres://localhost:5432/postgres";
const TEST_DB = "cortex_b1heat_test";
const TEST_URL = `postgres://localhost:5432/${TEST_DB}`;

interface Pg {
  query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

async function connect(url: string): Promise<Pg | null> {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client as unknown as Pg;
  } catch {
    return null;
  }
}

// Probe once at module load so the whole suite can skip when PG is absent.
const probe = await connect(ADMIN_URL);
const pgReachable = probe !== null;
if (probe) await probe.end();

describe.skipIf(!pgReachable)("hooks/db.ts effective_heat read-paths (B1#2)", () => {
  beforeAll(async () => {
    const admin = await connect(ADMIN_URL);
    if (!admin) throw new Error("admin connection failed");
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    const db = await connect(TEST_URL);
    if (!db) throw new Error("test-db connection failed");
    for (const stmt of getAllDdl()) await db.query(stmt);

    // Seed fresh, hot memories: heat_base=1.0 + heat_base_set_at=NOW() makes
    // effective_heat(m, NOW()) ≈ 1.0 (well above the _MIN_HEAT=0.05 floor).
    // (1) protected anchor for fetchAnchors — NOT auto-captured.
    await db.query(
      `INSERT INTO memories (content, tags, domain, is_protected, is_global, heat_base, heat_base_set_at)
       VALUES ('anchor about the parity port', '["_anchor"]'::jsonb, 'agentic-ai', TRUE, FALSE, 1.0, NOW())`,
    );
    // (2) protected + global team decision with agent_context.
    await db.query(
      `INSERT INTO memories (content, tags, domain, agent_context, is_protected, is_global, heat_base, heat_base_set_at)
       VALUES ('team decided to use effective_heat lazy decay', '[]'::jsonb, 'agentic-ai', 'architect', TRUE, TRUE, 1.0, NOW())`,
    );
    // (3) agent-scoped FTS memory for ftsRecall / fetchAgentMemories.
    await db.query(
      `INSERT INTO memories (content, tags, domain, agent_context, heat_base, heat_base_set_at)
       VALUES ('memory consolidation and recall improvements', '[]'::jsonb, 'agentic-ai', 'engineer', 1.0, NOW())`,
    );
    // (4) an auto-captured protected row that fetchAnchors MUST exclude.
    await db.query(
      `INSERT INTO memories (content, tags, domain, is_protected, is_global, heat_base, heat_base_set_at)
       VALUES ('noisy auto capture', '["_anchor","auto-captured"]'::jsonb, 'agentic-ai', TRUE, FALSE, 1.0, NOW())`,
    );
    await db.end();
  }, 60000);

  afterAll(async () => {
    const admin = await connect(ADMIN_URL);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await admin.end();
    }
  });

  it("fetchAnchors returns the protected _anchor and excludes auto-captured", async () => {
    const rows = await fetchAnchors(TEST_URL, 10);
    expect(rows.length).toBe(1);
    expect(String(rows[0].content)).toContain("anchor about the parity port");
  });

  it("fetchTeamDecisions returns the protected+global decision", async () => {
    const rows = await fetchTeamDecisions(TEST_URL, new Set());
    expect(rows.length).toBeGreaterThan(0);
  });

  it("ftsRecall returns the FTS-matching hot memory", async () => {
    const rows = await ftsRecall(TEST_URL, "consolidation recall", 0.05, 10);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("fetchAgentMemories returns the agent-scoped FTS memory", async () => {
    const rows = await fetchAgentMemories(
      TEST_URL,
      "engineer",
      ["consolidation"],
      0.05,
      10,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("fetchTeamDecisionsForAgent returns decisions from other agents", async () => {
    const rows = await fetchTeamDecisionsForAgent(TEST_URL, "engineer", 10);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("regression: a bare `heat` column does not exist on memories", async () => {
    const db = await connect(TEST_URL);
    if (!db) throw new Error("test-db connection failed");
    try {
      await expect(
        db.query("SELECT heat FROM memories LIMIT 1"),
      ).rejects.toThrow(/column .*heat.* does not exist/);
    } finally {
      await db.end();
    }
  });
});
