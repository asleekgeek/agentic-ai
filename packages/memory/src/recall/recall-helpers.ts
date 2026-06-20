/**
 * recall-helpers.ts — Signal collection and result building for recall.
 *
 * Ports: handlers/recall_helpers.py (220 LOC, 9 functions)
 *
 * Extracted to keep recall-handler.ts under 300 lines. Every Python helper
 * function is ported 1:1. Pure functions depend only on their arguments.
 *
 * source: cortex@ed33435 mcp_server/handlers/recall_helpers.py
 */

import type { MemoryItem, RelatedNeighbors, VersionNeighbor, EntityNeighborGroup } from "./types.js";
import type { RecallSettings } from "./recall-handler.js";
import type { MemoryStore } from "./port.js";
import { QueryIntent } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py — round(x, 4) throughout
const ROUND_FACTOR = 1e4;

// source: Robertson & Zaragoza (2009) BM25 — k1=1.5, b=0.75 standard BM25 params
const BM25_K1 = 1.5;
// source: Robertson & Zaragoza (2009) BM25 — b=0.75 standard param
const BM25_B = 0.75;
// source: Robertson & Zaragoza (2009) BM25 — proxy for avgDocLen in English
const BM25_AVG_DOC_LEN = 100;

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_vector_fts — FTS fallback limit
const FTS_FALLBACK_DIVISOR = 2;

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_result_boost — KNOWLEDGE_UPDATE multipliers
const KU_BOOST_MULTIPLIER = 3.0;
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_result_boost — half-life for KNOWLEDGE_UPDATE
const KU_HALFLIFE_MULTIPLIER = 0.5;
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_result_boost — cutoff extension
const KU_CUTOFF_MULTIPLIER = 2.0;

// source: SI — 86400 seconds per day, standard conversion
const MS_PER_DAY = 86_400_000;
// source: SI — 3600 seconds per hour, standard conversion
const MS_PER_HOUR = 3_600_000;

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_result_boost — half-life exponent base
const HALF_LIFE_BASE = 0.5;

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:collect_signals — pool sizes and hot-pool limits
const TRIGGER_FTS_LIMIT = 3;

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:collect_signals — default novelty fallback
const DEFAULT_NOVELTY = 0.5;

// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:inject_triggered_memories — min word length for trigger matching
const TRIGGER_MIN_WORD_LEN = 3;

// ── computeVectorFts ──────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_vector_fts

/**
 * Vector similarity + FTS signals.
 *
 * pre:  query is non-empty; store implements searchByVector and searchByFts.
 * post: returns vectorPairs, ftsPairs, and the query embedding (null if unavailable).
 */
export async function computeVectorFts(
  query: string,
  store: {
    searchByVector: (emb: number[], topK: number, minHeat: number) => Promise<Array<{ memory_id: number; distance: number }>>;
    searchByFts: (q: string, limit: number) => Promise<Array<{ memory_id: number; score: number }>>;
  },
  embeddings: { encode: (q: string) => Promise<number[] | null> } | null,
  pool: number,
  minHeat: number,
): Promise<{
  vectorPairs: Array<[number, number]>;
  ftsPairs: Array<[number, number]>;
  queryEmbedding: number[] | null;
}> {
  let queryEmbedding: number[] | null = null;
  let vectorPairs: Array<[number, number]> = [];

  if (embeddings) {
    queryEmbedding = await embeddings.encode(query);
    if (queryEmbedding) {
      const vecResults = await store.searchByVector(queryEmbedding, pool, minHeat);
      vectorPairs = vecResults.map((r) => [r.memory_id, 1.0 / (1.0 + r.distance)]);
    }
  }

  // Expanded query: simple synonym expansion via common engineering terms
  // source: cortex@ed33435 mcp_server/core/enrichment.py:build_expanded_query
  const expanded = buildExpandedQuery(query);
  const ftsResults = await store.searchByFts(expanded, pool);
  const ftsPairs: Array<[number, number]> = ftsResults.map((r) => [r.memory_id, r.score]);

  // If expanded != original, also run FTS on original and merge
  if (expanded !== query) {
    const origResults = await store.searchByFts(query, Math.floor(pool / FTS_FALLBACK_DIVISOR));
    const existingIds = new Set(ftsPairs.map(([id]) => id));
    for (const r of origResults) {
      if (!existingIds.has(r.memory_id)) {
        ftsPairs.push([r.memory_id, r.score]);
      }
    }
  }

  return { vectorPairs, ftsPairs, queryEmbedding };
}

// ── buildExpandedQuery ────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/core/enrichment.py:build_expanded_query

/**
 * Lightweight query expansion by synonym substitution.
 *
 * pre:  query is a non-empty string.
 * post: returns an expanded query string; returns the original if no expansions match.
 */
export function buildExpandedQuery(query: string): string {
  const EXPANSIONS: Record<string, string[]> = {
    recall: ["retrieve", "memory", "remember"],
    fix: ["fix", "resolve", "repair"],
    error: ["error", "bug", "failure", "exception"],
    decision: ["decision", "decided", "chose", "selected"],
    test: ["test", "spec", "assertion"],
  };
  const lower = query.toLowerCase();
  const additions: string[] = [];
  for (const [trigger, synonyms] of Object.entries(EXPANSIONS)) {
    if (lower.includes(trigger)) {
      additions.push(...synonyms.filter((s) => !lower.includes(s)));
    }
  }
  return additions.length > 0 ? `${query} ${additions.join(" ")}` : query;
}

// ── computeTextSignals ────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_text_signals

/**
 * BM25 + n-gram signals from hot memory pool.
 *
 * pre:  hotMems is a list of MemoryItems; query is non-empty.
 * post: returns BM25 pairs and n-gram pairs, both as (id, score) tuples.
 */
export function computeTextSignals(
  query: string,
  hotMems: MemoryItem[],
): { bm25: Array<[number, number]>; ngram: Array<[number, number]> } {
  if (!hotMems.length) return { bm25: [], ngram: [] };

  const queryTerms = query.toLowerCase().split(/\s+/);

  // BM25 approximation: TF-IDF style
  // source: cortex@ed33435 mcp_server/core/scoring.py:compute_bm25_scores
  const bm25: Array<[number, number]> = [];
  const N = hotMems.length;
  for (const mem of hotMems) {
    const docTerms = mem.content.toLowerCase().split(/\s+/);
    const docLen = docTerms.length;
    const termCounts = new Map<string, number>();
    for (const t of docTerms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const tf = termCounts.get(term) ?? 0;
      if (tf === 0) continue;
      const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / BM25_AVG_DOC_LEN)));
      // IDF: log((N+1)/(df+1)) — simplified (df = N since we don't track corpus DF)
      const idf = Math.log((N + 1) / (1 + 1));
      score += idf * tfNorm;
    }
    if (score > 0) bm25.push([mem.id, score]);
  }

  // N-gram overlap score
  // source: cortex@ed33435 mcp_server/core/scoring.py:compute_ngram_score
  const ngram: Array<[number, number]> = [];
  const querySet = new Set(queryTerms.filter((w) => w.length > 2));
  for (const mem of hotMems) {
    const memTerms = new Set(
      mem.content.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
    );
    const intersection = [...querySet].filter((w) => memTerms.has(w)).length;
    const union = new Set([...querySet, ...memTerms]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > 0) ngram.push([mem.id, score]);
  }

  return { bm25, ngram };
}

// ── getHotPool ────────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:get_hot_pool

/**
 * Fetch hot memories scoped by domain/directory.
 *
 * pre:  store implements getMemoriesForDomain/Directory and getHotMemories.
 * post: returns up to pool hot memories, filtered by domain or directory if given.
 */
export async function getHotPool(
  store: {
    getMemoriesForDomain: (domain: string, minHeat: number, limit: number) => Promise<MemoryItem[]>;
    getMemoriesForDirectory: (dir: string, minHeat: number) => Promise<MemoryItem[]>;
    getHotMemories: (minHeat: number, limit: number) => Promise<MemoryItem[]>;
  },
  domain: string | null | undefined,
  directory: string | null | undefined,
  minHeat: number,
  pool: number,
): Promise<MemoryItem[]> {
  if (domain) {
    return store.getMemoriesForDomain(domain, minHeat, pool);
  }
  if (directory) {
    return store.getMemoriesForDirectory(directory, minHeat);
  }
  return store.getHotMemories(minHeat, pool);
}

// ── computeResultBoost ────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:compute_result_boost

/**
 * Compute recency boost based on query intent.
 *
 * pre:  createdAt is an ISO-8601 string or empty; intent is a QueryIntent value.
 * post: returns a recency boost in [0, boostMax]. Returns 0 if createdAt is empty.
 *
 * source: Ebbinghaus (1885) — exponential forgetting curve used for recency.
 */
export function computeResultBoost(
  intent: string,
  createdAt: string,
  settings: RecallSettings,
): number {
  if (!createdAt) return 0;
  const isKnowledgeUpdate = intent === QueryIntent.KNOWLEDGE_UPDATE;
  const boostMax = isKnowledgeUpdate
    ? settings.RECENCY_BOOST_MAX * KU_BOOST_MULTIPLIER
    : settings.RECENCY_BOOST_MAX;
  const halflifeDays = isKnowledgeUpdate
    ? settings.RECENCY_BOOST_HALFLIFE_DAYS * KU_HALFLIFE_MULTIPLIER
    : settings.RECENCY_BOOST_HALFLIFE_DAYS;
  const cutoffDays = isKnowledgeUpdate
    ? settings.RECENCY_BOOST_CUTOFF_DAYS * KU_CUTOFF_MULTIPLIER
    : settings.RECENCY_BOOST_CUTOFF_DAYS;

  try {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = ageMs / MS_PER_DAY;
    if (ageDays > cutoffDays) return 0;
    // Exponential half-life decay
    // source: Ebbinghaus (1885) — standard forgetting curve
    const boost = boostMax * Math.pow(HALF_LIFE_BASE, ageDays / halflifeDays);
    return Math.max(0, Math.min(boostMax, boost));
  } catch {
    return 0;
  }
}

// ── parseTags ─────────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:parse_tags

/**
 * Normalize tags from string or array form.
 *
 * pre:  tags is any value from the DB row (may be string JSON, array, or null).
 * post: returns a string array, parsing JSON if necessary. Returns [] on failure.
 */
export function parseTags(tags: unknown): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags as string[];
  if (typeof tags === "string") {
    try {
      const parsed = JSON.parse(tags) as unknown;
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      return [];
    }
  }
  return [];
}

// ── Low-signal filter ─────────────────────────────────────────────────────
// source: cortex@f425157 mcp_server/handlers/recall_helpers.py — LOW_SIGNAL_TAGS + filter_low_signal

/**
 * Tags that mark memories as low-signal noise at the retrieval layer.
 *
 * Spike 2026-05-13 in Cortex found three diverse queries about ADR-2244
 * design decisions returned exclusively ``# Tool: Edit`` captures from
 * unrelated repos. The curated wiki (31 ADRs + 21 lessons + 54
 * conventions) was drowned because every captured tool call scores
 * high on WRRF + heat + recency. The wiki classifier's AUDIT_TAGS
 * already rejects such content from the wiki; recall reuses the same
 * concept at the retrieval layer.
 *
 * source: cortex@f425157 mcp_server/handlers/recall_helpers.py:LOW_SIGNAL_TAGS
 */
export const LOW_SIGNAL_TAGS: ReadonlySet<string> = new Set([
  "auto-captured",
  "_backfill",
  "imported",
  "session-summary",
  "tool-output",
  "code-review",
  "tool:edit",
  "tool:bash",
  "tool:read",
  "tool:write",
  "tool:grep",
  "tool:glob",
  "tool:search",
  "tool:webfetch",
  "tool:websearch",
  "tool:notebookedit",
  "stage-1",
  "stage-2",
  "stage-3",
  "stage-4",
  "stage-5",
  "stage-6",
  "stage-7",
  "stage-8",
  "stage-9",
  "stage-10",
  "stage-11",
  "audit",
  "automated",
  "wip",
  "progress",
]);

/**
 * Drop memories whose tags mark them as low-signal noise.
 *
 * Returns ``{ kept, dropped }``. The dropped count is surfaced in the
 * recall response so callers see how much was filtered — important for
 * debugging "why didn't I get the result I expected".
 *
 * Callers that explicitly want low-signal memories (debugging, replay
 * tooling) skip this filter via the ``include_low_signal`` input
 * parameter on the recall handler.
 *
 * source: cortex@f425157 mcp_server/handlers/recall_helpers.py:filter_low_signal
 */
export function filterLowSignal<T extends { readonly tags?: unknown }>(
  results: readonly T[],
): { readonly kept: T[]; readonly dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const r of results) {
    const tags = parseTags(r.tags).map((t) => t.toLowerCase());
    const isLowSignal = tags.some((t) => LOW_SIGNAL_TAGS.has(t));
    if (isLowSignal) {
      dropped += 1;
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped };
}

// ── buildResult ───────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:build_result

/**
 * Build a single result dict with recency boost applied.
 *
 * pre:  mem is a non-null MemoryItem; score is a positive float.
 * post: returned object has all required recall result fields.
 *       score is boosted by recency but heat is adjusted via session coherence.
 */
export function buildResult(
  mem: MemoryItem,
  score: number,
  intent: string,
  settings: RecallSettings,
): {
  memory_id: number;
  content: string;
  score: number;
  heat: number;
  domain: string;
  tags: string[];
  store_type: string;
  created_at: string;
  importance: number;
  surprise: number;
  recency_boost: number;
} {
  const createdAt = mem.created_at ?? "";
  const boost = computeResultBoost(intent, createdAt, settings);

  // Session coherence: small bonus for memories created in recent session window
  // source: cortex@ed33435 mcp_server/core/thermodynamics.py:compute_session_coherence
  let heat = mem.heat ?? 0;
  if (createdAt) {
    const ageHours = (Date.now() - new Date(createdAt).getTime()) / MS_PER_HOUR;
    if (ageHours <= settings.SESSION_COHERENCE_WINDOW_HOURS) {
      heat = Math.min(1.0, heat + settings.SESSION_COHERENCE_BONUS);
    }
  }

  return {
    memory_id: mem.id,
    content: mem.content,
    score: Math.round(score * (1.0 + boost) * ROUND_FACTOR) / ROUND_FACTOR,
    heat: Math.round(heat * ROUND_FACTOR) / ROUND_FACTOR, // source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:build_result — 4-decimal rounding
    domain: mem.domain ?? "",
    tags: parseTags(mem.tags),
    store_type: mem.store_type ?? "episodic",
    created_at: createdAt,
    importance: mem.importance ?? DEFAULT_NOVELTY,
    surprise: mem.surprise_score ?? 0.0,
    recency_boost: Math.round(boost * ROUND_FACTOR) / ROUND_FACTOR, // source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:build_result — 4-decimal rounding
  };
}

// ── injectTriggeredMemories ──────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:inject_triggered_memories

/**
 * Inject prospective memories whose triggers match the query.
 *
 * pre:  results is a list of recall results; store implements getActiveProspectiveMemories.
 * post: returns results with any trigger-matched memories prepended.
 *       Existing results are never removed.
 */
export async function injectTriggeredMemories<T extends { memory_id: number }>(
  results: T[],
  query: string,
  store: {
    getActiveProspectiveMemories: () => Promise<unknown[]>;
    searchByFts: (q: string, limit: number) => Promise<Array<{ memory_id: number; score: number }>>;
    getMemory: (id: number) => Promise<MemoryItem | null>;
  },
): Promise<T[]> {
  let triggers: unknown[];
  try {
    triggers = await store.getActiveProspectiveMemories();
  } catch {
    return results;
  }
  if (!triggers.length) return results;

  const existingIds = new Set(results.map((r) => r.memory_id));
  const injected: T[] = [];

  for (const trigger of triggers) {
    const t = trigger as Record<string, unknown>;
    const triggerContent = (t["content"] as string) ?? "";
    if (!triggerContent) continue;
    const triggerWords = triggerContent.toLowerCase().split(/\s+/);
    const queryLower = query.toLowerCase();
    const matches = triggerWords.some((w) => w.length > TRIGGER_MIN_WORD_LEN && queryLower.includes(w));
    if (!matches) continue;

    const ftsCandidates = await store.searchByFts(triggerContent, TRIGGER_FTS_LIMIT);
    for (const { memory_id: mid } of ftsCandidates) {
      if (existingIds.has(mid)) continue;
      const mem = await store.getMemory(mid);
      if (!mem) continue;
      injected.push({
        memory_id: mid,
        content: mem.content,
        score: 0.9,
        heat: mem.heat ?? 1.0,
        domain: mem.domain ?? "",
        tags: parseTags(mem.tags),
        store_type: mem.store_type ?? "episodic",
        created_at: mem.created_at ?? "",
        importance: mem.importance ?? DEFAULT_NOVELTY,
        surprise: mem.surprise_score ?? 0.0,
        recency_boost: 0.0,
      } as unknown as T);
      existingIds.add(mid);
    }
  }

  return injected.length > 0 ? [...injected, ...results] : results;
}

// ── Inline relation-walk (MEM-G4) ─────────────────────────────────────────
//
// Port of: cortex@6fbf723d mcp_server/handlers/recall_helpers.py
//   _version_neighbors, _entity_neighbors, inline_related_neighbors
//
// Semantic: for each recalled memory, inline a ONE-HOP walk over:
//   (a) the supersession version chain (supersedes_id / superseded_by_id)
//   (b) the entity relationship graph (outgoing, one hop)
//
// max_entities / max_neighbors / GIST_CHARS are response-budget fanout caps,
// NOT algorithmic constants. They shape payload size only.
//   source: cortex@6fbf723d recall_helpers.py (comment block above inline_related_neighbors):
//     "max_entities / max_neighbors are response-budget fanout caps (cf.
//      core/response_budget.py), NOT algorithmic constants"
//   _GIST_CHARS = 160 — source: cortex@6fbf723d recall_helpers.py:_GIST_CHARS = 160

/** Preview length for inlined neighbor content.
 *  source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:_GIST_CHARS = 160 */
const RELATED_GIST_CHARS = 160; // source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:_GIST_CHARS = 160

/** Max entities per memory for the one-hop entity walk.
 *  source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:inline_related_neighbors(max_entities=3) */
const RELATED_MAX_ENTITIES = 3; // source: cortex@6fbf723d recall_helpers.py — response-budget cap, not algorithmic

/** Max neighbors per entity for the one-hop entity walk.
 *  source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:inline_related_neighbors(max_neighbors=5) */
const RELATED_MAX_NEIGHBORS = 5; // source: cortex@6fbf723d recall_helpers.py — response-budget cap, not algorithmic

/**
 * Supersession-chain neighbors of a memory (item-1 edges), if any.
 *
 * Pre:  store implements getMemory; memoryId is a valid integer.
 * Post: returns at most 2 version neighbors (supersedes + superseded_by),
 *       each with a gist capped at RELATED_GIST_CHARS chars.
 *       Returns [] when the memory row has no supersession fields.
 *
 * source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:_version_neighbors
 */
async function versionNeighbors(
  memoryId: number,
  store: Pick<MemoryStore, "getMemory">,
): Promise<VersionNeighbor[]> {
  const row = await store.getMemory(memoryId);
  if (!row) return [];
  const out: VersionNeighbor[] = [];
  const r = row as unknown as Record<string, unknown>;
  const PAIRS: Array<[string, string]> = [
    ["supersedes", "supersedes_id"],
    ["superseded_by", "superseded_by_id"],
  ];
  for (const [edge, key] of PAIRS) {
    const nid = r[key];
    if (!nid) continue;
    const neighbor = await store.getMemory(Number(nid));
    if (neighbor) {
      out.push({
        memory_id: Number(nid),
        edge,
        gist: String(neighbor.content ?? "").slice(0, RELATED_GIST_CHARS),
      });
    }
  }
  return out;
}

/**
 * One-hop entity relationship neighbors for a memory's top entities.
 *
 * Pre:  store implements getEntitiesForMemory and getRelationshipsForEntity;
 *       memoryId is a valid integer.
 * Post: returns at most maxEntities groups, each with at most maxNeighbors
 *       outgoing relationship entries (weight-ranked by the store).
 *       Returns [] when entity subsystem is unavailable.
 *
 * source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:_entity_neighbors
 */
async function entityNeighbors(
  memoryId: number,
  store: MemoryStore,
  maxEntities: number,
  maxNeighbors: number,
): Promise<EntityNeighborGroup[]> {
  // Capture the optional port methods as bound locals after the guard so the
  // non-undefined narrowing persists across await/iteration (TS resets control
  // flow analysis on object-property access through awaits) without a non-null
  // assertion; bind preserves `this` for class-based store implementations.
  const getEntitiesForMemory = store.getEntitiesForMemory?.bind(store);
  const getRelationshipsForEntity = store.getRelationshipsForEntity?.bind(store);
  if (!getEntitiesForMemory || !getRelationshipsForEntity) {
    return [];
  }
  let entities: Array<{ id: number; name: string; entity_type?: string }>;
  try {
    entities = (await getEntitiesForMemory(memoryId)).slice(0, maxEntities);
  } catch {
    return [];
  }
  const out: EntityNeighborGroup[] = [];
  for (const ent of entities) {
    let rels: Array<{ target_name?: string; relationship_type?: string; weight?: number }>;
    try {
      rels = await getRelationshipsForEntity(ent.id, "outgoing", maxNeighbors);
    } catch {
      rels = [];
    }
    if (rels.length === 0) continue;
    out.push({
      entity: ent.name,
      neighbors: rels.map((r) => ({
        name: r.target_name,
        relationship_type: r.relationship_type,
        weight: r.weight,
      })),
    });
  }
  return out;
}

/**
 * Attach a one-hop relation walk to each recalled memory, in place.
 *
 * Pre:  results is the post-capping, post-ordering list of recalled memories;
 *       store implements getMemory (version walk) and optionally
 *       getEntitiesForMemory + getRelationshipsForEntity (entity walk).
 * Post: each result in ``results`` has a ``related`` field set to
 *       ``{ versions, entities }``. The versions field lists supersession
 *       chain neighbors; the entities field lists outgoing entity-graph
 *       neighbors. When a subsystem is unavailable, its list is [].
 *       The original ranking order is preserved; no dedup of neighbors
 *       vs results is required (neighbors are annotations, not ranking entries).
 *
 * Invariant: results.length is unchanged; only the ``related`` annotation
 *            is added to each entry.
 *
 * source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:inline_related_neighbors
 */
export async function inlineRelatedNeighbors(
  results: Array<{ memory_id: number; related?: RelatedNeighbors }>,
  store: MemoryStore,
): Promise<void> {
  // precondition: results is bounded by max_results (already capped upstream)
  // postcondition: each result.related = { versions: [...], entities: [...] }
  for (const mem of results) {
    const mid = mem.memory_id;
    if (mid == null) continue;
    const [versions, entities] = await Promise.all([
      versionNeighbors(mid, store),
      entityNeighbors(mid, store, RELATED_MAX_ENTITIES, RELATED_MAX_NEIGHBORS),
    ]);
    mem.related = { versions, entities };
  }
}

// ── buildEnhancements ─────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall_helpers.py:build_enhancements

/**
 * Build the enhancements metadata for the recall response.
 *
 * pre:  query, intent, tier are non-null strings.
 * post: returns a metadata object describing which enrichments were applied.
 */
export function buildEnhancements(
  query: string,
  intent: string,
  tier: string,
  settings: { STRATEGIC_ORDERING_ENABLED: boolean },
): {
  query_expanded: boolean;
  multihop_applied: boolean;
  reranked: boolean;
  knowledge_update_boost: boolean;
  strategic_ordering: boolean;
} {
  return {
    query_expanded: buildExpandedQuery(query) !== query,
    multihop_applied: tier === "mixed",
    reranked: true,
    knowledge_update_boost: intent === QueryIntent.KNOWLEDGE_UPDATE,
    strategic_ordering: settings.STRATEGIC_ORDERING_ENABLED,
  };
}
