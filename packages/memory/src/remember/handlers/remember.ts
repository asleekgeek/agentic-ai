/**
 * handlers/remember.ts — Top-level remember handler.
 *
 * Ports: handlers/remember.py + handlers/remember_helpers.py
 *
 * Composition root: validates input, runs write gate, writes to MemoryStore.
 *
 * Correctness contract:
 *   pre:  args.content is non-empty after trimming.
 *   post: IF gate rejects → {stored:false, reason, novelty, importance}.
 *         IF gate passes → {stored:true, action:"stored", memory_id, heat}.
 *         In all code paths, MemoryStore is either written atomically
 *         or not written at all.
 *
 * source: handlers/remember.py
 * source: handlers/remember_helpers.py
 * source: issue #14 P1 (initial_heat override for backfill)
 */

import {
  buildRejectionResponse,
  determineBypass,
  estimateImportance,
  parseHoursSince,
  scoreCandidate,
} from "../write-gate.js";
import { effectiveThreshold, record as calibrationRecord } from "../write-gate-calibration.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { RememberRequest, RememberResponse } from "../types.js";
import { RememberRequestSchema } from "../types.js";
// source: Hutto CJ & Gilbert E (2014) "VADER: A Parsimonious Rule-based Model for
//   Sentiment Analysis of Social Media Text." ICWSM.
// Port of: mcp_server/core/emotional_tagging.py:tag_memory_emotions
import { computeEmotionalValence, detectEmotions } from "../emotional-tagging.js";
// source: packages/memory/src/remember/llm-entity-extractor.ts
// LLM-based entity extraction via MCP sampling/createMessage — closes the
// 106k vs 10k memory_entities gap. Fires after insertMemory, best-effort.
import { extractEntitiesViaLlm } from "../llm-entity-extractor.js";

// ── Surprisal heat boost ─────────────────────────────────────────────────────

// source: thermodynamics.py:apply_surprise_boost (heuristic)
const SURPRISE_BOOST_FACTOR = 0.3; // source: thermodynamics.py:apply_surprise_boost
const RECENT_CONTENTS_LIMIT = 10; // source: cortex@ed33435 mcp_server/handlers/remember.py — structural comparison window
const VECTOR_SEARCH_TOP_K = 5; // source: cortex@ed33435 mcp_server/handlers/remember.py — top-5 similar memories
// source: cortex@ed33435 mcp_server/handlers/remember.py — VADER emotional valence
//   check threshold: memories under 100 chars rarely have enough signal for VADER.
//   Engineering heuristic; same threshold used in llm-entity-extractor MIN_CONTENT_CHARS.
const VADER_MIN_CONTENT_CHARS = 100; // source: engineering heuristic, cortex@ed33435 remember.py
const ENTITY_EXTRACTION_CAP = 20; // source: cortex@ed33435 mcp_server/core/knowledge_graph.py — entity cap per memory

function applySurpriseBoost(
  baseHeat: number,
  noveltyScore: number,
  boostFactor = SURPRISE_BOOST_FACTOR,
): number {
  const boosted = baseHeat + boostFactor * noveltyScore;
  return Math.max(0.0, Math.min(1.0, boosted));
}

// ── Recent contents helper ───────────────────────────────────────────────────

function getRecentContents(store: MemoryStore, domain: string): string[] {
  // We want the most recent 10 memories for structural comparison.
  // The query is best-effort; failures return empty.
  try {
    const rows = (store as unknown as { listRecentContents?: (d: string, n: number) => string[] })
      .listRecentContents?.(domain, RECENT_CONTENTS_LIMIT);
    return rows ?? [];
  } catch {
    return [];
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * remember — store a memory through the predictive-coding write gate.
 *
 * source: handlers/remember.py:handler
 */
export function remember(
  rawArgs: unknown,
  store: MemoryStore,
): RememberResponse {
  // Parse and validate input. Zod throws on invalid input.
  const args: RememberRequest = RememberRequestSchema.parse(rawArgs);

  if (!args.content.trim()) {
    return { stored: false, reason: "no_content" };
  }

  const content = args.content.trim();
  const tags = args.tags;
  const force = args.force;
  const domain = args.domain ?? "";
  const source = args.source;
  const agentTopic = args.agent_topic;
  const isGlobal = args.is_global;

  // Baseline heat: live writes default to 1.0; backfill/import paths
  // override via initial_heat to reflect content age (Ebbinghaus curve).
  // Source: issue #14 P1.
  const baselineHeat =
    args.initial_heat !== undefined ? args.initial_heat : 1.0;

  // Retrieve the top-5 similar memories from the vector store.
  // The write gate needs their similarity scores and creation times.
  const vecHits = store.searchVectors(Buffer.alloc(0), VECTOR_SEARCH_TOP_K, 0.0);
  const similarities: number[] = [];
  let hoursSinceSimilar: number | null = null;

  if (vecHits.length > 0) {
    // Use distances as similarity proxies (1 - distance for cosine).
    for (const [, dist] of vecHits) {
      similarities.push(Math.max(0, 1.0 - dist));
    }
    // Find hours since most similar memory was created.
    const bestId = vecHits[0]?.[0];
    if (bestId !== undefined) {
      const bestMem = store.getMemory(bestId);
      if (bestMem?.created_at) {
        hoursSinceSimilar = parseHoursSince(bestMem.created_at);
      }
    }
  }

  // Extract entity names (best-effort; failures produce empty set).
  let newEntityNames: string[] = [];
  let knownEntityNames = new Set<string>();
  try {
    newEntityNames = extractEntityNamesFromContent(content);
    knownEntityNames = new Set(
      newEntityNames.filter((n) => store.getEntityByName(n) !== null),
    );
  } catch {
    // Entity extraction failures must not block the write path.
  }

  const recentContents = getRecentContents(store, domain);
  const threshold = effectiveThreshold(domain);

  const [bypass] = determineBypass(force, content, tags);

  const score = scoreCandidate({
    content,
    tags,
    force,
    similarities,
    newEntityNames,
    knownEntityNames,
    recentContents,
    hoursSinceSimilar,
    threshold,
  });

  // Record the gate decision for threshold auto-calibration.
  // source: core/write_gate_calibration.py:record (Taleb AF-5)
  calibrationRecord(domain, score.shouldStore);

  if (!score.shouldStore && !bypass) {
    const importance = estimateImportance(content, tags);
    return buildRejectionResponse(score, importance);
  }

  const heat = applySurpriseBoost(baselineHeat, score.combinedNovelty);
  const importance = estimateImportance(content, tags);

  // Compute emotional valence via full VADER pipeline before insert.
  // source: Hutto CJ & Gilbert E (2014) ICWSM.
  // source: mcp_server/core/emotional_tagging.py:tag_memory_emotions — same pipeline
  const emotionalValence = computeEmotionalValence(detectEmotions(content));
  if (emotionalValence === 0.0 && content.length > VADER_MIN_CONTENT_CHARS) {
    process.stderr.write(`[vader] emotionalValence=0 for ${content.length}-char memory (id pending)\n`);
  }

  const memoryId = store.insertMemory({
    content,
    tags,
    source,
    domain,
    heat,
    importance,
    emotional_valence: emotionalValence,
    surprise_score: score.combinedNovelty,
    store_type: "episodic",
    agent_context: agentTopic,
    is_global: isGlobal,
    created_at: args.created_at,
  });

  // Best-effort entity upsert and linking. Failures must not abort the write.
  try {
    for (const entityName of newEntityNames) {
      if (!knownEntityNames.has(entityName)) {
        const entityId = store.upsertEntity(entityName, "concept", domain);
        if (entityId > 0) {
          store.linkMemoryEntity(memoryId, entityId);
        }
      }
    }
  } catch {
    // Entity extraction failures do not abort the write (invariant I3).
  }

  return {
    stored: true,
    action: "stored",
    memory_id: memoryId,
    heat,
    is_global: isGlobal,
  };
}

// ── Async variant (for PgMemoryStore) ───────────────────────────────────────
//
// rememberAsync is identical in logic to remember() but calls the *Async
// methods on MemoryStore when they are available (i.e. PgMemoryStore).
// MCP tool handlers MUST use this function when the store may be a
// PgMemoryStore — the sync remember() will throw at runtime on PG.
//
// precondition:  rawArgs satisfies RememberRequestSchema.
// postcondition: same as remember() — RememberResponse.
// source: ADR-0042 — MCP entry must route writes to PG via async path.

export async function rememberAsync(
  rawArgs: unknown,
  store: MemoryStore,
): Promise<RememberResponse> {
  const args: RememberRequest = RememberRequestSchema.parse(rawArgs);

  if (!args.content.trim()) {
    return { stored: false, reason: "no_content" };
  }

  const content = args.content.trim();
  const tags = args.tags;
  const force = args.force;
  const domain = args.domain ?? "";
  const source = args.source;
  const agentTopic = args.agent_topic;
  const isGlobal = args.is_global;

  const baselineHeat = args.initial_heat !== undefined ? args.initial_heat : 1.0;

  // Vector search: use async variant when available (PG), sync otherwise (SQLite).
  // Empty buffer → no real embedding; PG correctly returns [] for an empty vector.
  // searchVectorsAsync is not on the typed MemoryStore interface; accessed via cast.
  // source: PgMemoryStore.searchVectorsAsync — async pgvector KNN search.
  // source: engineer fix — *Async-when-available, sync-fallback pattern.
  const storeAnyVec = store as unknown as {
    searchVectorsAsync?: (buf: Buffer, k: number, threshold: number) => Promise<Array<[number, number]>>;
  };
  let vecHits: Array<[number, number]> = [];
  try {
    if (storeAnyVec.searchVectorsAsync) {
      vecHits = await storeAnyVec.searchVectorsAsync(Buffer.alloc(0), VECTOR_SEARCH_TOP_K, 0.0);
    } else {
      vecHits = store.searchVectors(Buffer.alloc(0), VECTOR_SEARCH_TOP_K, 0.0);
    }
  } catch {
    // Vector search failure must not block the write path.
    vecHits = [];
  }

  const similarities: number[] = [];
  let hoursSinceSimilar: number | null = null;

  if (vecHits.length > 0) {
    for (const [, dist] of vecHits) {
      similarities.push(Math.max(0, 1.0 - dist));
    }
    const bestId = vecHits[0]?.[0];
    if (bestId !== undefined) {
      // getMemoryAsync is not on the typed interface (PG does not yet expose it);
      // access via cast to avoid TS2551. Falls back to sync getMemory on SQLite.
      // source: engineer fix — *Async-when-available, sync-fallback pattern.
      const storeAny = store as unknown as {
        getMemoryAsync?: (id: number) => Promise<ReturnType<MemoryStore["getMemory"]>>;
      };
      let bestMem: ReturnType<MemoryStore["getMemory"]> = null;
      try {
        bestMem = storeAny.getMemoryAsync
          ? await storeAny.getMemoryAsync(bestId)
          : store.getMemory(bestId);
      } catch {
        bestMem = null;
      }
      if (bestMem?.created_at) {
        hoursSinceSimilar = parseHoursSince(bestMem.created_at);
      }
    }
  }

  let newEntityNames: string[] = [];
  let knownEntityNames = new Set<string>();
  try {
    newEntityNames = extractEntityNamesFromContent(content);
    knownEntityNames = new Set(
      newEntityNames.filter((n) => store.getEntityByName(n) !== null),
    );
  } catch {
    // Entity extraction failures must not block the write path.
  }

  const recentContents = getRecentContents(store, domain);
  const threshold = effectiveThreshold(domain);
  const [bypass] = determineBypass(force, content, tags);

  const score = scoreCandidate({
    content,
    tags,
    force,
    similarities,
    newEntityNames,
    knownEntityNames,
    recentContents,
    hoursSinceSimilar,
    threshold,
  });

  calibrationRecord(domain, score.shouldStore);

  if (!score.shouldStore && !bypass) {
    const importance = estimateImportance(content, tags);
    return buildRejectionResponse(score, importance);
  }

  const heat = applySurpriseBoost(baselineHeat, score.combinedNovelty);
  const importance = estimateImportance(content, tags);

  // Compute emotional valence via full VADER pipeline before insert.
  // source: Hutto CJ & Gilbert E (2014) ICWSM.
  // source: mcp_server/core/emotional_tagging.py:tag_memory_emotions — same pipeline
  const emotionalValenceAsync = computeEmotionalValence(detectEmotions(content));
  if (emotionalValenceAsync === 0.0 && content.length > VADER_MIN_CONTENT_CHARS) {
    process.stderr.write(`[vader] emotionalValence=0 for ${content.length}-char memory (id pending)\n`);
  }

  const insertData = {
    content,
    tags,
    source,
    domain,
    heat,
    importance,
    emotional_valence: emotionalValenceAsync,
    surprise_score: score.combinedNovelty,
    store_type: "episodic" as const,
    agent_context: agentTopic,
    is_global: isGlobal,
    created_at: args.created_at,
  };

  let memoryId: number;
  if (store.insertMemoryAsync) {
    memoryId = await store.insertMemoryAsync(insertData);
  } else {
    memoryId = store.insertMemory(insertData);
  }

  // ── Regex entity upsert (fast path) ────────────────────────────────────────
  // Best-effort entity upsert and linking. Uses *Async when available (PG path).
  // source: ADR-0042 — async path required for PG entity writes.
  // source: liskov@24cb6e2 — *Async-when-available, sync-fallback pattern.
  const _storeEntityAsync = store as unknown as {
    upsertEntityAsync?: (name: string, type: string, domain: string) => Promise<number>;
    linkMemoryEntityAsync?: (memId: number, entId: number) => Promise<void>;
  };
  for (const entityName of newEntityNames) {
    if (knownEntityNames.has(entityName)) continue;
    try {
      const entityId = _storeEntityAsync.upsertEntityAsync
        ? await _storeEntityAsync.upsertEntityAsync(entityName, "concept", domain)
        : store.upsertEntity(entityName, "concept", domain);
      if (entityId > 0) {
        if (_storeEntityAsync.linkMemoryEntityAsync) {
          await _storeEntityAsync.linkMemoryEntityAsync(memoryId, entityId);
        } else {
          store.linkMemoryEntity(memoryId, entityId);
        }
      }
    } catch {
      // Entity extraction failures do not abort the write (invariant I3).
    }
  }

  // ── LLM entity extraction via MCP sampling (semantic enrichment) ─────────
  // Fire-and-forget: the write is already committed; failures must not abort.
  // source: packages/memory/src/remember/llm-entity-extractor.ts
  // source: MCP sampling spec — https://modelcontextprotocol.io/docs/concepts/sampling
  // source: Cortex Python mcp_server/core/write_post_store.py:persist_entities —
  //   the Python knowledge_graph.extract_entities is regex only; the LLM path
  //   here extends coverage to persons, projects, and tools.
  //   Called only for content > 100 chars (MIN_CONTENT_CHARS in extractor).
  void (async () => {
    try {
      const llmEntities = await extractEntitiesViaLlm(content);
      for (const ent of llmEntities) {
        // Upsert entity with the LLM-detected type (not forced to "concept").
        const storeAnyAsync = store as unknown as {
          upsertEntityAsync?: (name: string, type: string, domain: string) => Promise<number>;
          linkMemoryEntityAsync?: (memId: number, entId: number) => Promise<void>;
        };
        const entityId = storeAnyAsync.upsertEntityAsync
          ? await storeAnyAsync.upsertEntityAsync(ent.name, ent.type, domain)
          : store.upsertEntity(ent.name, ent.type, domain);
        if (entityId > 0) {
          if (storeAnyAsync.linkMemoryEntityAsync) {
            await storeAnyAsync.linkMemoryEntityAsync(memoryId, entityId);
          } else {
            store.linkMemoryEntity(memoryId, entityId);
          }
        }
      }
      if (llmEntities.length > 0) {
        process.stderr.write(
          `[llm-entity-extractor] memory ${memoryId}: extracted ${llmEntities.length} entities via sampling\n`,
        );
      }
    } catch (err) {
      // invariant I3: LLM entity extraction failures must not abort the write.
      process.stderr.write(
        `[llm-entity-extractor] post-write extraction failed for memory ${memoryId}: ${(err as Error).message}\n`,
      );
    }
  })();

  return {
    stored: true,
    action: "stored",
    memory_id: memoryId,
    heat,
    is_global: isGlobal,
  };
}

// ── Lightweight entity name extraction ──────────────────────────────────────
// Extracts capitalized tokens as entity candidates, mirroring the regex
// branch of knowledge_graph.extract_entities. The spaCy NER branch is not
// available in the TS runtime.
// source: cortex@ed33435 mcp_server/core/knowledge_graph.py:extract_entities

function extractEntityNamesFromContent(content: string): string[] {
  const names = new Set<string>();
  // Capitalized words that are not common stopwords.
  const STOPWORDS = new Set([
    "The", "A", "An", "I", "It", "This", "That", "We", "They", "He", "She",
    "Is", "Are", "Was", "Were", "Be", "Has", "Have", "Had",
  ]);
  const tokens = content.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  for (const t of tokens) {
    if (!STOPWORDS.has(t)) names.add(t);
  }
  return [...names].slice(0, ENTITY_EXTRACTION_CAP);
}
