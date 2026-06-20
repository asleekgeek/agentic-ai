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
// source: mcp_server/handlers/remember_helpers.py:242-328 try_block_replica_upsert
import {
  tryBlockReplicaUpsert,
  type BlockReplicaStore,
} from "./block-replica-upsert.js";
// source: mcp_server/handlers/remember_helpers.py:try_curation — curation-on-write (MEM-G1)
import {
  applyModulations,
  tryCurationAsync,
  updateUserMoodEma,
  type CurationDecision,
  type WriteEmbedder,
} from "./remember-helpers.js";
// source: shared/content_hardening.harden_content — ingestion-boundary hardening
//   (NFC normalize, control/bidi strip, byte cap). remember.py:272-276.
import { hardenContent } from "../../shared/content-hardening.js";
// source: handlers/remember.py:200-220 _resolve_domain — git-root/hint/profile resolution.
import { resolveDomain } from "../domain-resolution.js";
// source: handlers/remember.py:338-341 detect_global — auto-detect global scope.
import { detectGlobal } from "../../recall/global-detector.js";
import type { WriteGateScore } from "../types.js";
// Re-export so the MCP composition root can type RememberDeps.embedder without
// reaching into the helpers module directly.
export type { WriteEmbedder } from "./remember-helpers.js";

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

// ── Novelty surfacing ────────────────────────────────────────────────────────
// Predictive-coding gate signals copied into the response on the store path so
// it matches Cortex gate output (the rejection path already surfaces these via
// buildRejectionResponse).
// source: remember.py:302-314 + remember_helpers.py:223-233 _enrich_mod_with_gate

function noveltyFromScore(score: WriteGateScore): {
  embedding_novelty: number;
  entity_novelty: number;
  temporal_novelty: number;
  structural_novelty: number;
  combined_novelty: number;
} {
  return {
    embedding_novelty: score.embeddingNovelty,
    entity_novelty: score.entityNovelty,
    temporal_novelty: score.temporalNovelty,
    structural_novelty: score.structuralNovelty,
    combined_novelty: score.combinedNovelty,
  };
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

  // Harden user-controlled content at the ingestion boundary (NFC normalize,
  // control/bidi strip, byte cap); empty-after-harden is rejected.
  // source: remember.py:272-276
  const content = hardenContent(args.content);
  if (!content) {
    return { stored: false, reason: "no_content" };
  }

  const tags = args.tags;
  const force = args.force;
  // Resolve the domain (git-root/cwd → hint → profile) instead of taking
  // args.domain verbatim. source: remember.py:298 _resolve_domain.
  const domain = resolveDomain(args.directory, args.domain);
  const source = args.source;
  const agentTopic = args.agent_topic;
  let isGlobal = args.is_global;

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

  const baseHeat = applySurpriseBoost(baselineHeat, score.combinedNovelty);
  const baseImportance = estimateImportance(content, tags);

  // Compute emotional valence via full VADER pipeline before insert.
  // source: Hutto CJ & Gilbert E (2014) ICWSM.
  // source: mcp_server/core/emotional_tagging.py:tag_memory_emotions — same pipeline
  const emotionalValence = computeEmotionalValence(detectEmotions(content));
  if (emotionalValence === 0.0 && content.length > VADER_MIN_CONTENT_CHARS) {
    process.stderr.write(`[vader] emotionalValence=0 for ${content.length}-char memory (id pending)\n`);
  }

  // Apply oscillatory/emotional/thermodynamic modulations, then insert the
  // modulated heat/importance/valence (not the raw values).
  // source: remember.py:324-334 apply_modulations
  const mod = applyModulations(content, tags, baseHeat, baseImportance, emotionalValence);
  const heat = mod.heat;

  // Auto-detect global when not explicitly set. source: remember.py:338-341
  let globalReason = "explicit";
  if (!isGlobal) {
    const [g, , reason] = detectGlobal(content, tags);
    isGlobal = g;
    globalReason = reason;
  }

  const memoryId = store.insertMemory({
    content,
    tags,
    source,
    domain,
    heat,
    importance: mod.importance,
    emotional_valence: mod.valence,
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
        const entityId = store.upsertEntity(entityName, entityTypeFor(entityName), domain);
        if (entityId > 0) {
          store.linkMemoryEntity(memoryId, entityId);
        }
      }
    }
  } catch {
    // Entity extraction failures do not abort the write (invariant I3).
  }

  // Post-write mood EMA (user-authored content only; self-guards on store).
  // source: remember.py:398-399 update_user_mood_ema
  updateUserMoodEma(content, source, store);

  const response: RememberResponse = {
    stored: true,
    action: "stored",
    memory_id: memoryId,
    heat,
    is_global: isGlobal,
    novelty: noveltyFromScore(score),
  };
  if (isGlobal) response.global_reason = globalReason;
  return response;
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
  embedder?: WriteEmbedder | null,
): Promise<RememberResponse> {
  const args: RememberRequest = RememberRequestSchema.parse(rawArgs);

  // Harden content at the ingestion boundary; empty-after-harden is rejected.
  // source: remember.py:272-276
  const content = hardenContent(args.content);
  if (!content) {
    return { stored: false, reason: "no_content" };
  }

  const tags = args.tags;
  const force = args.force;
  // Resolve domain (git-root/cwd → hint → profile). source: remember.py:298.
  const domain = resolveDomain(args.directory, args.domain);
  const source = args.source;
  const agentTopic = args.agent_topic;
  let isGlobal = args.is_global;

  const baselineHeat = args.initial_heat !== undefined ? args.initial_heat : 1.0;

  // Encode the content ONCE and reuse the embedding for BOTH the predictive-coding
  // gate (embedding-novelty signal) AND active curation — exactly as Cortex
  // remember.py:299 computes `embedding = emb_engine.encode(content)` and passes
  // the same vector to evaluate_gate and try_curation. The embedder is the
  // process-wide engine wired at the MCP composition root; it is null only for
  // non-MCP callers / tests, where the write path degrades to no curation —
  // matching Cortex when encode() yields nothing (remember_helpers.py:41,342).
  // source: cortex@ed33435 mcp_server/handlers/remember.py:299
  let embedding: Buffer | null = null;
  if (embedder) {
    try {
      const vec = await embedder.encode(content);
      if (vec && vec.length > 0) {
        embedding = Buffer.from(new Float32Array(vec).buffer);
      }
    } catch {
      // Embedding failure must not block the write path; degrade to no curation.
      embedding = null;
    }
  }

  // Gate vector search: use the real query embedding (Cortex compute_similarities:
  // `if embedding: vec_hits = store.search_vectors(embedding, top_k=5, min_heat=0.0)`).
  // With no embedder the search is skipped — Cortex likewise yields no neighbours
  // when embedding is falsy. *Async-when-available (PG), sync fallback (SQLite).
  // source: cortex@ed33435 mcp_server/handlers/remember_helpers.py:41-42
  const storeAnyVec = store as unknown as {
    searchVectorsAsync?: (buf: Buffer, k: number, threshold: number) => Promise<Array<[number, number]>>;
  };
  let vecHits: Array<[number, number]> = [];
  if (embedding) {
    try {
      vecHits = storeAnyVec.searchVectorsAsync
        ? await storeAnyVec.searchVectorsAsync(embedding, VECTOR_SEARCH_TOP_K, 0.0)
        : store.searchVectors(embedding, VECTOR_SEARCH_TOP_K, 0.0);
    } catch {
      // Vector search failure must not block the write path.
      vecHits = [];
    }
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

  const baseHeat = applySurpriseBoost(baselineHeat, score.combinedNovelty);
  const baseImportance = estimateImportance(content, tags);

  // Compute emotional valence via full VADER pipeline before insert.
  // source: Hutto CJ & Gilbert E (2014) ICWSM.
  // source: mcp_server/core/emotional_tagging.py:tag_memory_emotions — same pipeline
  const emotionalValenceAsync = computeEmotionalValence(detectEmotions(content));
  if (emotionalValenceAsync === 0.0 && content.length > VADER_MIN_CONTENT_CHARS) {
    process.stderr.write(`[vader] emotionalValence=0 for ${content.length}-char memory (id pending)\n`);
  }

  // Apply oscillatory/emotional/thermodynamic modulations; insert the
  // modulated heat/importance/valence. source: remember.py:324-334.
  const mod = applyModulations(content, tags, baseHeat, baseImportance, emotionalValenceAsync);
  const heat = mod.heat;

  // Auto-detect global when not explicitly set. source: remember.py:338-341.
  let globalReason = "explicit";
  if (!isGlobal) {
    const [g, , reason] = detectGlobal(content, tags);
    isGlobal = g;
    globalReason = reason;
  }

  const insertData = {
    content,
    tags,
    source,
    domain,
    heat,
    importance: mod.importance,
    emotional_valence: mod.valence,
    surprise_score: score.combinedNovelty,
    store_type: "episodic" as const,
    agent_context: agentTopic,
    is_global: isGlobal,
    created_at: args.created_at,
  };

  // ── Block-replica upsert (§8b) ─────────────────────────────────────────────
  // Before inserting, check whether this write is a memory-replica block and
  // whether an existing row with the same vpath: tag already exists in PG.
  // If so, update that row in-place (preserving heat_base and is_protected)
  // and return early — no new row, no duplicate archival.
  // source: mcp_server/handlers/remember_helpers.py:242-328 try_block_replica_upsert
  // contract: zetetic-team-subagents memory/contract.md §8b
  const blockReplicaStore = store as unknown as BlockReplicaStore;
  if (
    typeof blockReplicaStore.runAsync === "function" &&
    Array.isArray(tags) &&
    tags.includes("memory-replica")
  ) {
    const [upserted, uid] = await tryBlockReplicaUpsert(
      content,
      null,
      tags,
      source ?? "",
      blockReplicaStore,
    );
    if (upserted && uid !== null) {
      return {
        stored: true,
        action: "stored",
        memory_id: uid,
        heat,
        is_global: isGlobal,
      };
    }
  }

  // ── Curation-on-write (MEM-G1) ─────────────────────────────────────────────
  // Reuses the single embedding computed above — Cortex passes the same
  // `embedding` to evaluate_gate and try_curation (remember.py:299,359-361).
  // try_curation short-circuits to "create" when embedding is falsy or force is
  // set (remember_helpers.py:342); otherwise it scans the top-3 neighbours and
  // may merge, link, or — on a contradicting near-duplicate (negation mismatch /
  // action divergence) — supersede, retaining both rows. Benchmark loaders bypass
  // remember() (ingestMemoriesBatch), so curation never perturbs LoCoMo /
  // LongMemEval / BEAM. tryCurationAsync wraps its own try/catch (except→create).
  // source: cortex@ed33435 mcp_server/handlers/remember_helpers.py:try_curation (341-367)
  let curation: CurationDecision = { action: "create", targetId: null };
  if (embedding && !force) {
    curation = await tryCurationAsync(content, embedding, force, store, embedder ?? null, tags, mod.heat);
  }
  if (curation.action === "merge" && curation.targetId !== null) {
    // Near-duplicate merged into the existing row in-place; no new row inserted.
    // Mood signal still updates on merge — the user authored the content.
    // source: remember.py:363-365 update_user_mood_ema on merge.
    updateUserMoodEma(content, source, store);
    return {
      stored: true,
      action: "merged",
      memory_id: curation.targetId,
      merged_with: curation.targetId,
      heat,
      is_global: isGlobal,
    };
  }

  // Supersede writes the forward edge at insert; the back-pointer is closed below.
  const insertPayload =
    curation.action === "supersede" && curation.targetId !== null
      ? { ...insertData, supersedes_id: curation.targetId }
      : insertData;

  let memoryId: number;
  if (store.insertMemoryAsync) {
    memoryId = await store.insertMemoryAsync(insertPayload);
  } else {
    memoryId = store.insertMemory(insertPayload);
  }

  // Persist the embedding for the freshly inserted row so that subsequent writes'
  // gate and curation searches can find it as a near-neighbour. Cortex stores the
  // embedding inside insert_memory (record["embedding"]); the TS stores split it
  // into a dedicated upsert (PG: UPDATE ... SET embedding; SQLite: memories_vec).
  // Best-effort: the row is already committed, so a persistence failure only means
  // this memory won't be a future vector-search candidate.
  // source: cortex@ed33435 mcp_server/handlers/remember_helpers.py:_build_insert_record (embedding field)
  // source: cortex@ed33435 mcp_server/infrastructure/pg_store.py:insert_memory (embedding column)
  if (embedding) {
    const storeAnyEmb = store as unknown as {
      upsertEmbedding?: (id: number, emb: Buffer) => void | Promise<void>;
    };
    if (typeof storeAnyEmb.upsertEmbedding === "function") {
      try {
        await storeAnyEmb.upsertEmbedding(memoryId, embedding);
      } catch {
        // Embedding persistence is best-effort; the row is already committed.
      }
    }
  }

  if (curation.action === "supersede" && curation.targetId !== null) {
    // Phase 2 (MEM-G1): stamp old.superseded_by_id = newId. Async-when-available (PG).
    // source: cortex@ed33435 mcp_server/handlers/remember_helpers.py:351-362
    const storeAnySup = store as unknown as {
      setSupersededByAsync?: (oldId: number, newId: number) => Promise<void>;
    };
    try {
      if (storeAnySup.setSupersededByAsync) {
        await storeAnySup.setSupersededByAsync(curation.targetId, memoryId);
      } else {
        store.setSupersededBy(curation.targetId, memoryId);
      }
    } catch {
      // Back-pointer failure leaves the forward edge intact; logged, not fatal.
      process.stderr.write(
        `[remember] setSupersededBy failed (${curation.targetId} -> ${memoryId})\n`,
      );
    }
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
      const entityType = entityTypeFor(entityName);
      const entityId = _storeEntityAsync.upsertEntityAsync
        ? await _storeEntityAsync.upsertEntityAsync(entityName, entityType, domain)
        : store.upsertEntity(entityName, entityType, domain);
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

  // Post-write mood EMA (user-authored content only; self-guards on store).
  // source: remember.py:398-399 update_user_mood_ema on stored.
  updateUserMoodEma(content, source, store);

  // action "superseded" (MEM-G1) when curation inserted this row as the successor
  // of a contradicting near-duplicate; otherwise the normal "stored".
  // source: cortex@ed33435 mcp_server/handlers/remember_response.py — supersede→"superseded"
  const response: RememberResponse = {
    stored: true,
    action: curation.action === "supersede" ? "superseded" : "stored",
    memory_id: memoryId,
    heat,
    is_global: isGlobal,
    novelty: noveltyFromScore(score),
  };
  if (isGlobal) response.global_reason = globalReason;
  if (curation.action === "supersede" && curation.targetId !== null) {
    response.merged_with = curation.targetId;
  }
  return response;
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

// CamelCase identifiers → "technology" type (multi-hump pattern).
// source: cortex@ed33435 mcp_server/core/knowledge_graph.py:74,129-132 — _CAMELCASE_RE matches multi-hump CamelCase, type=technology
const _CAMELCASE_RE = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/;

function entityTypeFor(name: string): "technology" | "concept" {
  return _CAMELCASE_RE.test(name) ? "technology" : "concept";
}
