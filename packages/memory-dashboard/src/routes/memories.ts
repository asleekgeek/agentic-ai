/**
 * routes/memories.ts — GET /api/memories + GET /api/memories/facets
 *
 * TS port of:
 *   cortex@ed33435 mcp_server/handlers/memories_page.py  (serve)
 *   cortex@ed33435 mcp_server/handlers/memories_facets.py (serve)
 *
 * Keyset-paged memory listing for the Knowledge and Board tabs.
 * /api/memories/facets returns aggregate counts for filter chips.
 *
 * Layer: handlers — reads the memory SQLite directly via better-sqlite3.
 *
 * precondition:  dbPath points to a readable SQLite file with a `memories` table.
 * postcondition: /api/memories returns paginated rows matching workflow_graph.v1
 *   memory-node shape; /api/memories/facets returns the canonical facets shape.
 *
 * RESPONSE SHAPE CONTRACT (derived from Python source, not inferred):
 *   /api/memories  → { items: MemoryNode[], next_cursor: string|null, page_count: int, sort: string }
 *     source: cortex@ed33435 mcp_server/handlers/memories_page.py:_send_json call at end of serve()
 *   /api/memories/facets → { total, domains, stages, emotions, global, protected, hot }
 *     source: cortex@ed33435 mcp_server/handlers/memories_facets.py:payload dict
 *
 * IMPORTANT: the shape mismatch between the original engineer port (which returned
 *   {memories, total, has_more, next_after} and {by_domain, by_stage, totals})
 *   and the JS expectations (items/next_cursor and flat facets) caused silent
 *   failures in the Knowledge and Board tabs. This revision implements the
 *   canonical Python shape.
 */

import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";

// ── Named constants ───────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/memories_page.py:_DEFAULT_LIMIT
const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200; // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_MAX_LIMIT
// source: cortex@ed33435 mcp_server/handlers/memories_facets.py — hot threshold
const HOT_HEAT_THRESHOLD = 0.5;
// source: cortex@ed33435 mcp_server/handlers/memories_facets.py — urgency importance threshold
const URGENT_IMPORTANCE_THRESHOLD = 0.75;
// source: cortex@ed33435 mcp_server/handlers/memories_facets.py — positive/negative valence thresholds
const VALENCE_POS_THRESHOLD = 0.25; // source: cortex@ed33435 mcp_server/handlers/memories_facets.py:e_pos COUNT(*) FILTER (WHERE emotional_valence >= 0.25)
const VALENCE_NEG_THRESHOLD = -0.25; // source: cortex@ed33435 mcp_server/handlers/memories_facets.py:e_neg COUNT(*) FILTER (WHERE emotional_valence <= -0.25)
// source: cortex@ed33435 mcp_server/handlers/memories_facets.py — domain list cap
const DOMAIN_LIMIT = 200; // source: cortex@ed33435 mcp_server/handlers/memories_facets.py:Q1 LIMIT 200
const HTTP_500 = 500; // source: RFC 7231 §6.6 — Internal Server Error
// Emotion bucket thresholds — strong vs weak valence (0.55 / -0.55).
// source: cortex@ed33435 mcp_server/handlers/memories_page.py:_row_to_node
//   val >= 0.55 → "satisfaction"; val <= -0.55 → "frustration"
const VALENCE_STRONG_POS = 0.55; // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_row_to_node (val >= 0.55 → "satisfaction")
const VALENCE_STRONG_NEG = -0.55; // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_row_to_node (val <= -0.55 → "frustration")
// Base64 padding modulus. source: RFC 4648 §4 — base64 groups of 4 characters
const BASE64_BLOCK = 4;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Raw row returned by better-sqlite3 from the memories SELECT. */
interface MemoryRow {
  id: number | string;
  content: string;
  heat: number;              // aliased from heat_base
  importance: number;
  store_type: string | null;
  tags: string | null;
  created_at: string | null;
  domain: string | null;
  emotional_valence: number;
  is_protected: number;
  is_global: number;
  access_count: number;
  useful_count: number;
  consolidation_stage: string | null;
}

/**
 * Shape a memory DB row into the workflow_graph.v1 memory-node format
 * that knowledge.js and timeline.js read directly.
 *
 * source: cortex@ed33435 mcp_server/handlers/memories_page.py:_row_to_node
 *
 * precondition:  m has been populated from the SELECT in buildMemoryQuery.
 * postcondition: returns a plain object with all fields knowledge.js expects:
 *   id, memory_id, type, kind, label, content, domain, domain_id, tags,
 *   heat, importance, stage, consolidationStage, consolidation_stage,
 *   createdAt, lastAccessed, isProtected, is_protected, isGlobal, is_global,
 *   emotion, emotional_valence, store_type, access_count, useful_count.
 */
function rowToNode(m: MemoryRow): Record<string, unknown> {
  const parseTags = (t: string | null): string[] => {
    if (!t) return [];
    if (t.startsWith("[")) { try { return JSON.parse(t) as string[]; } catch { return []; } }
    return [];
  };

  // Compute discrete emotion bucket from emotional_valence + importance.
  // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_row_to_node
  const val = m.emotional_valence ?? 0;
  const imp = m.importance ?? 0;
  let emotion: string | null = null;
  if (val >= VALENCE_STRONG_POS) emotion = "satisfaction";
  else if (val >= VALENCE_POS_THRESHOLD) emotion = "discovery";
  else if (val <= VALENCE_STRONG_NEG) emotion = "frustration";
  else if (val <= VALENCE_NEG_THRESHOLD) emotion = "confusion";
  if (imp >= URGENT_IMPORTANCE_THRESHOLD) emotion = "urgency";

  const domainVal = m.domain ?? "";
  const domainId = `domain:${domainVal || "__global__"}`;

  return {
    id: `memory:${m.id}`,
    memory_id: m.id,
    type: "memory",
    kind: "memory",
    label: m.content ?? "",
    content: m.content ?? "",
    domain: domainVal,
    domain_id: domainId,
    tags: parseTags(m.tags),
    heat: m.heat ?? 0,
    importance: m.importance ?? 0,
    stage: m.consolidation_stage ?? "labile",
    consolidationStage: m.consolidation_stage ?? "labile",
    consolidation_stage: m.consolidation_stage ?? "labile",
    createdAt: m.created_at ?? null,
    lastAccessed: null,                // not in the paged-listing SELECT for performance
    isProtected: Boolean(m.is_protected),
    is_protected: Boolean(m.is_protected),
    isGlobal: Boolean(m.is_global),
    is_global: Boolean(m.is_global),
    emotion,
    emotional_valence: typeof val === "number" ? val : 0,
    store_type: m.store_type ?? "episodic",
    access_count: m.access_count ?? 0,
    useful_count: m.useful_count ?? 0,
  };
}

/**
 * Base64-encode a cursor payload.
 * source: cortex@ed33435 mcp_server/handlers/memories_page.py:_encode_cursor
 */
function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decode a base64 cursor; returns null if malformed.
 * source: cortex@ed33435 mcp_server/handlers/memories_page.py:_decode_cursor
 */
function decodeCursor(s: string | undefined): { k: unknown; id: number } | null {
  if (!s) return null;
  try {
    // Pad to valid base64url before decoding.
    // source: RFC 4648 §4 — base64 block size is 4; padding fills remainder
    const mod = s.length % BASE64_BLOCK;
    const padded = s + "==".slice(mod === 0 ? BASE64_BLOCK : mod);
    const raw = Buffer.from(padded, "base64url").toString("utf8");
    const obj = JSON.parse(raw) as { k: unknown; id: number };
    return obj;
  } catch {
    return null;
  }
}

export interface MemoriesRouteDeps {
  dbPath: string;
}

/**
 * Register /api/memories and /api/memories/facets.
 *
 * precondition:  fastify instance is not yet started.
 * postcondition: two routes registered.
 */
export async function registerMemoriesRoutes(
  fastify: FastifyInstance,
  deps: MemoriesRouteDeps,
): Promise<void> {
  /**
   * GET /api/memories[?cursor=<base64>&limit=<n>&domain=<d>&stage=<s>&sort=heat|recent|oldest
   *                   &emotion=urgent|positive|negative|neutral&min_heat=<f>
   *                   &protected=1&global=1&include_global=1]
   *
   * Keyset-paged listing. Response shape matches Python canonical:
   *   { items: MemoryNode[], next_cursor: string|null, page_count: int, sort: string }
   *
   * source: cortex@ed33435 mcp_server/handlers/memories_page.py:serve + _row_to_node
   */
  fastify.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      domain?: string;
      stage?: string;
      sort?: string;
      search?: string;
      emotion?: string;
      min_heat?: string;
      protected?: string;
      global?: string;
      include_global?: string;
    };
  }>("/api/memories", async (req, reply) => {
    try {
      const {
        cursor: cursorStr,
        limit: limitStr,
        domain,
        stage,
        sort: sortRaw,
        emotion,
        min_heat: minHeatStr,
        protected: protectedFlag,
        global: globalFlag,
        include_global: includeGlobalFlag,
      } = req.query;

      // source: cortex@ed33435 mcp_server/handlers/memories_page.py — valid sort keys
      const SORT_ORDER: Record<string, string> = {
        heat: "heat_base DESC, id DESC",
        recent: "created_at DESC, id DESC",
        oldest: "created_at ASC, id ASC",
      };
      const SORT_KEY_COL: Record<string, string> = {
        heat: "heat_base",
        recent: "created_at",
        oldest: "created_at",
      };
      const SORT_DIR: Record<string, string> = {
        heat: "<",
        recent: "<",
        oldest: ">",
      };

      const sort = (sortRaw && SORT_ORDER[sortRaw]) ? sortRaw : "heat";
      // Over-fetch by 1 so we can detect "more pages exist" without a count query.
      // source: cortex@ed33435 mcp_server/handlers/memories_page.py:params.append(limit + 1)
      const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, parseInt(limitStr ?? String(PAGE_LIMIT_DEFAULT), 10)));
      const cursor = decodeCursor(cursorStr);
      const minHeat = minHeatStr ? parseFloat(minHeatStr) : null;
      const protectedOnly = protectedFlag === "1" || protectedFlag === "true";
      const globalOnly = globalFlag === "1" || globalFlag === "true";
      const includeGlobal = includeGlobalFlag == null || includeGlobalFlag === "1" || includeGlobalFlag === "true";

      const validEmotions = new Set(["urgent", "positive", "negative", "neutral"]);
      const emotionFilter = (emotion && validEmotions.has(emotion)) ? emotion : null;

      const conditions: string[] = ["NOT is_stale"];
      const params: unknown[] = [];

      // Cursor condition for keyset pagination.
      // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_build_query — cursor WHERE clause
      if (cursor !== null) {
        const col = SORT_KEY_COL[sort] ?? "heat_base";
        const op = SORT_DIR[sort] ?? "<";
        conditions.push(`(${col}, id) ${op} (?, ?)`);
        params.push(cursor.k, cursor.id);
      }

      // Domain / global filter.
      // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_build_query
      if (globalOnly) {
        conditions.push("is_global = 1");
      } else if (domain) {
        if (includeGlobal) {
          conditions.push("(domain = ? OR is_global = 1)");
        } else {
          conditions.push("domain = ?");
        }
        params.push(domain);
      }

      if (stage) { conditions.push("consolidation_stage = ?"); params.push(stage); }

      if (minHeat !== null && !isNaN(minHeat)) {
        conditions.push("heat_base >= ?");
        params.push(minHeat);
      }

      // Emotion bucket filter.
      // source: cortex@ed33435 mcp_server/handlers/memories_page.py:_build_query — emotion WHERE
      if (emotionFilter === "urgent") {
        conditions.push(`importance >= ${URGENT_IMPORTANCE_THRESHOLD}`);
      } else if (emotionFilter === "positive") {
        conditions.push(`emotional_valence >= ${VALENCE_POS_THRESHOLD} AND importance < ${URGENT_IMPORTANCE_THRESHOLD}`);
      } else if (emotionFilter === "negative") {
        conditions.push(`emotional_valence <= ${VALENCE_NEG_THRESHOLD} AND importance < ${URGENT_IMPORTANCE_THRESHOLD}`);
      } else if (emotionFilter === "neutral") {
        conditions.push(`emotional_valence > ${VALENCE_NEG_THRESHOLD} AND emotional_valence < ${VALENCE_POS_THRESHOLD} AND importance < ${URGENT_IMPORTANCE_THRESHOLD}`);
      }

      if (protectedOnly) { conditions.push("is_protected = 1"); }

      const where = `WHERE ${conditions.join(" AND ")}`;
      const orderBy = SORT_ORDER[sort] ?? "heat_base DESC, id DESC";

      // Over-fetch by 1 to detect has_more without a separate COUNT.
      // source: cortex@ed33435 mcp_server/handlers/memories_page.py — limit + 1 over-fetch
      const fetchLimit = limit + 1;
      params.push(fetchLimit);

      const db = new Database(deps.dbPath, { readonly: true, fileMustExist: true });

      // heat_base aliased to heat for rowToNode().
      // source: 2026-05-07 schema reconciliation — heat column renamed to heat_base.
      const rows = db.prepare(
        `SELECT id, content, heat_base AS heat, importance, store_type, domain,
                tags, created_at, consolidation_stage, emotional_valence,
                is_protected, is_global, access_count, useful_count
         FROM memories ${where} ORDER BY ${orderBy} LIMIT ?`
      ).all(...params) as MemoryRow[];

      db.close();

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);

      // Build next_cursor from the last item's sort key.
      // source: cortex@ed33435 mcp_server/handlers/memories_page.py — cursor encoding
      let nextCursor: string | null = null;
      if (hasMore && items.length > 0) {
        const last = items[items.length - 1];
        if (last) {
          const sortValue = sort === "heat"
            ? (last.heat ?? 0)
            : (last.created_at ?? "");
          nextCursor = encodeCursor({ k: sortValue, id: last.id });
        }
      }

      return reply.send({
        items: items.map((m) => rowToNode(m)),
        next_cursor: nextCursor,
        page_count: items.length,
        sort,
      });
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error; error class name only to avoid leaking internals (CWE-209)
    }
  });

  /**
   * GET /api/memories/facets — aggregate counts for filter chips.
   *
   * Returns the CANONICAL shape from the Python source:
   *   { total, domains, stages, emotions, global, protected, hot }
   * The earlier port returned {by_domain, by_stage, totals} which does NOT
   * match what knowledge.js and timeline.js read (facets.total, facets.domains,
   * facets.stages, facets.hot etc.). That shape mismatch caused all filter chips
   * to show no counts.
   *
   * source: cortex@ed33435 mcp_server/handlers/memories_facets.py:serve
   *   payload dict keys: total, domains, stages, emotions, global, protected, hot
   */
  fastify.get("/api/memories/facets", async (_req, reply) => {
    try {
      const db = new Database(deps.dbPath, { readonly: true, fileMustExist: true });

      // Q1: per-domain counts (sorted desc), capped at DOMAIN_LIMIT.
      // source: cortex@ed33435 mcp_server/handlers/memories_facets.py:Q1
      interface DomainRow { dom: string; c: number; }
      const domainRows = db.prepare(
        `SELECT COALESCE(NULLIF(domain, ''), '__unknown__') AS dom, COUNT(*) AS c
         FROM memories WHERE NOT is_stale
         GROUP BY dom ORDER BY c DESC LIMIT ${DOMAIN_LIMIT}`
      ).all() as DomainRow[];

      // Q2: all aggregates in a single pass.
      // source: cortex@ed33435 mcp_server/handlers/memories_facets.py:Q2 — single aggregate SELECT
      // SQLite supports COUNT(*) FILTER (WHERE ...) since 3.25 (2018-09-15).
      // source: https://sqlite.org/lang_aggfunc.html#aggfilter — SQLite 3.25.0 release notes
      const agg = db.prepare(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE consolidation_stage = 'labile')          AS s_labile,
           COUNT(*) FILTER (WHERE consolidation_stage = 'early_ltp')       AS s_early,
           COUNT(*) FILTER (WHERE consolidation_stage = 'late_ltp')        AS s_late,
           COUNT(*) FILTER (WHERE consolidation_stage = 'consolidated')    AS s_cons,
           COUNT(*) FILTER (WHERE consolidation_stage = 'reconsolidating') AS s_recon,
           COUNT(*) FILTER (WHERE is_global = 1)     AS n_global,
           COUNT(*) FILTER (WHERE is_protected = 1)  AS n_protected,
           COUNT(*) FILTER (WHERE heat_base >= ${HOT_HEAT_THRESHOLD})     AS n_hot,
           COUNT(*) FILTER (WHERE importance >= ${URGENT_IMPORTANCE_THRESHOLD})  AS e_urgent,
           COUNT(*) FILTER (WHERE emotional_valence >= ${VALENCE_POS_THRESHOLD} AND importance < ${URGENT_IMPORTANCE_THRESHOLD}) AS e_pos,
           COUNT(*) FILTER (WHERE emotional_valence <= ${VALENCE_NEG_THRESHOLD} AND importance < ${URGENT_IMPORTANCE_THRESHOLD}) AS e_neg,
           COUNT(*) FILTER (WHERE emotional_valence > ${VALENCE_NEG_THRESHOLD} AND emotional_valence < ${VALENCE_POS_THRESHOLD} AND importance < ${URGENT_IMPORTANCE_THRESHOLD}) AS e_neutral
         FROM memories WHERE NOT is_stale`
      ).get() as Record<string, number | null> | undefined;

      db.close();

      const a = agg ?? {};
      const n = (k: string): number => Number(a[k] ?? 0);

      // Canonical response shape from Python source.
      // source: cortex@ed33435 mcp_server/handlers/memories_facets.py — payload dict
      return reply.send({
        total: n("total"),
        domains: domainRows.map((r) => ({ name: r.dom, count: Number(r.c) })),
        stages: {
          labile:           n("s_labile"),
          early_ltp:        n("s_early"),
          late_ltp:         n("s_late"),
          consolidated:     n("s_cons"),
          reconsolidating:  n("s_recon"),
        },
        emotions: {
          urgent:   n("e_urgent"),
          positive: n("e_pos"),
          negative: n("e_neg"),
          neutral:  n("e_neutral"),
        },
        global:    n("n_global"),
        protected: n("n_protected"),
        hot:       n("n_hot"),
      });
    } catch (err) {
      return reply.status(HTTP_500).send({ error: err instanceof Error ? err.constructor.name : "UnknownError" }); // source: RFC 7231 §6.6 — 500 Internal Server Error; error class name only to avoid leaking internals (CWE-209)
    }
  });
}
