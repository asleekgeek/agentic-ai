/**
 * Compression cycle: compress aging memories along the rate-distortion curve.
 *
 * Memories progress through levels: full text (0) -> gist (1) -> tag (2).
 * Protected and semantic memories are skipped.
 *
 * Based on rate-distortion theory — higher fidelity costs more bits;
 * as memories age and lose access heat, fewer bits are worth spending.
 * // source: Toth et al. (PLoS Comp Bio, 2020) — memory fidelity degradation
 * // source: Tishby N et al. (1999) The information bottleneck method.
 *
 * Port of:
 *   mcp_server/handlers/consolidation/compression.py
 *   mcp_server/core/compression.py (inline — no separate TS core file exists)
 */

import { Mechanism, isMechanismDisabled } from "../ablation.js";

// ── Named constants ───────────────────────────────────────────────────────────

// Milliseconds in one hour — arithmetic identity, no citation needed.
const MS_PER_HOUR = 3_600_000;

// Compression resistance thresholds and multipliers.
// Qualitative direction (important/surprising/frequently-accessed memories
// resist compression longer) is grounded in rate-distortion and memory-
// importance literature (Tishby 1999; Toth et al. 2020), but the specific
// thresholds and multipliers are engineering choices requiring ablation
// calibration. See mcp_server/core/compression.py _compute_resistance docstring.
// source: engineering choice — see mcp_server/core/compression.py _compute_resistance docstring
const IMPORTANCE_DEFAULT = 0.5;
const IMPORTANCE_HIGH_THRESHOLD = 0.7;
const IMPORTANCE_HIGH_MULTIPLIER = 2.0; // source: engineering choice — calibration pending ablation
const SURPRISE_HIGH_THRESHOLD = 0.6;
const SURPRISE_HIGH_MULTIPLIER = 1.5; // source: engineering choice — von Restorff 1933 (qualitative), calibration pending
const CONFIDENCE_HIGH_THRESHOLD = 0.8;
const CONFIDENCE_HIGH_MULTIPLIER = 1.3; // source: engineering choice — calibration pending ablation
const ACCESS_COUNT_HIGH_THRESHOLD = 10;
const ACCESS_COUNT_HIGH_MULTIPLIER = 1.5; // source: engineering choice — calibration pending ablation

// Sentence scoring weights (information density heuristics).
// These are engineering choices; no paper specifies these exact values.
// source: engineering choice — see mcp_server/core/compression.py _score_sentence
const SCORE_FILE_PATH = 3.0;
const SCORE_ERROR = 4.0;
const SCORE_DECISION = 3.0;
const SCORE_NUMBER_VERSION = 2.0;
const SCORE_CAMELCASE = 2.0;
const SCORE_BACKTICK = 2.0;

// Primacy-recency scoring bonuses for gist selection.
// source: port of mcp_server/core/compression.py:163-165 (score += 10.0 # Primacy,
//   score += 8.0 # Recency). Engineering bonuses; the source of truth cites no paper.
const SCORE_PRIMACY_BONUS = 10.0;
const SCORE_RECENCY_BONUS = 8.0;

// Gist extraction parameters.
// source: engineering choice — see mcp_server/core/compression.py extract_gist
const GIST_TARGET_RATIO = 0.3;         // target ~30% of original length
const GIST_MIN_LENGTH = 50;            // minimum gist character length floor
const GIST_SHORT_SENTENCE_MAX = 3;    // use all sentences when count <= this

// Tag generation parameters.
// source: engineering choice — see mcp_server/core/compression.py _extract_tag_entities / _truncate_tag_repr
const TAG_MAX_ENTITIES = 5;            // max entities in tag
const TAG_MAX_LENGTH = 200;            // maximum tag character length
const TAG_TRUNCATE_LENGTH = 197;       // TAG_MAX_LENGTH - 3 (room for "...")
const TAG_AVAILABLE_THRESHOLD = 10;   // min available chars before fallback truncation
const TAG_SUMMARY_FALLBACK_LEN = 30;  // summary prefix length under fallback truncation
const TAG_ENTITIES_FALLBACK_COUNT = 2; // entity count under fallback truncation

// YYYY-MM-DD date prefix length = 10 characters.
// source: port of mcp_server/core/compression.py:234 (created[:10]); plain string
//   slice in the source of truth — no standard or paper cited.
const ISO_DATE_PREFIX_LEN = 10;

// Ellipsis string length used when slicing to fit within TAG_MAX_LENGTH.
// source: engineering choice — "..." is 3 characters; see mcp_server/core/compression.py _truncate_tag_repr
const ELLIPSIS_LEN = 3;

// Fallback summary length when no sentences are available in generateTag.
// source: engineering choice — see mcp_server/core/compression.py generate_tag (content[:80])
const TAG_SUMMARY_NO_SENTENCE_LEN = 80;

// ── Regex patterns (from mcp_server/core/compression.py) ─────────────────────

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const FILE_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.\w+/g;
const ERROR_RE = /\b\w*(?:Error|Exception|Traceback)\b/;
const DECISION_RE =
  /\b(?:decided|chose|choosing|using|switched|migrated|replaced|selected|adopted)\b/i;
const NUMBER_VERSION_RE = /\b\d+(?:\.\d+)+\b/;
const CAMELCASE_RE = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

// ── Store / Engine interfaces ─────────────────────────────────────────────────

export interface CompressionStore {
  getAllMemoriesForDecay(): Promise<Record<string, unknown>[]>;
  insertArchive(row: Record<string, unknown>): Promise<void>;
  updateMemoryCompression(
    id: number,
    content: string,
    embedding: number[],
    compressionLevel: number,
    opts?: { originalContent?: string },
  ): Promise<void>;
}

export interface CompressionEmbeddingEngine {
  encode(text: string): Promise<number[]>;
}

export interface CompressionSettings {
  COMPRESSION_GIST_AGE_HOURS: number;
  COMPRESSION_TAG_AGE_HOURS: number;
}

export interface CompressionStageResult {
  compressed_to_gist: number;
  compressed_to_tag: number;
  protected_skipped: number;
  semantic_skipped: number;
  rows_scanned: number;
  duration_ms?: number;
}

// ── Core: schedule computation ────────────────────────────────────────────────

/**
 * Parse ingest timestamp for cadence reasoning.
 *
 * Compression cadence asks "has this memory had time to be revisited
 * in MY system" — elapsed time since ingest, NOT since the original event.
 * Backfilled/imported memories carry a backdated created_at (e.g. a 2023
 * conversation imported in 2026); using created_at would compress them on
 * the first consolidation pass, before retrieval ever runs.
 * // source: tasks/e1-v3-locomo-smoke-finding.md
 *
 * Falls back to created_at for legacy rows that predate ingested_at.
 *
 * Precondition: memory is a dict-like object.
 * Postcondition: returns a Date or null.
 */
function parseIngestedAt(memory: Record<string, unknown>): Date | null {
  const raw = (memory["ingested_at"] ?? memory["created_at"]) as string | Date | undefined;
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  try {
    const dt = new Date(raw);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

/**
 * Compute compression resistance multiplier from memory attributes.
 *
 * Precondition: memory carries optional importance, surprise_score, confidence, access_count.
 * Postcondition: returns a float >= 1.0.
 */
function computeResistance(memory: Record<string, unknown>): number {
  let resistance = 1.0;
  if (((memory["importance"] as number | undefined) ?? IMPORTANCE_DEFAULT) > IMPORTANCE_HIGH_THRESHOLD) resistance *= IMPORTANCE_HIGH_MULTIPLIER;
  if (((memory["surprise_score"] as number | undefined) ?? 0.0) > SURPRISE_HIGH_THRESHOLD) resistance *= SURPRISE_HIGH_MULTIPLIER;
  if (((memory["confidence"] as number | undefined) ?? 1.0) > CONFIDENCE_HIGH_THRESHOLD) resistance *= CONFIDENCE_HIGH_MULTIPLIER;
  if (((memory["access_count"] as number | undefined) ?? 0) > ACCESS_COUNT_HIGH_THRESHOLD) resistance *= ACCESS_COUNT_HIGH_MULTIPLIER;
  return resistance;
}

/**
 * Calculate target compression level based on age and importance.
 *
 * Precondition: memory carries ingested_at or created_at; settings has gist/tag age hours.
 * Postcondition: returns 0 (full fidelity), 1 (gist), or 2 (tag).
 */
function getCompressionSchedule(
  memory: Record<string, unknown>,
  gistAgeHours: number,
  tagAgeHours: number,
): number {
  // Ablation gate: CORTEX_ABLATE_COMPRESSION=1 skips compression entirely —
  // every memory stays at full fidelity (level 0). Mirrors the Python gate so
  // an A/B benchmark can disable compression with no other behavior change.
  // source: cortex bc5af469 mcp_server/core/compression.py:127 — is_mechanism_disabled(Mechanism.COMPRESSION) → return 0
  if (isMechanismDisabled(Mechanism.COMPRESSION)) return 0;
  if (memory["is_protected"]) return 0;
  if ((memory["store_type"] as string | undefined) === "semantic") return 0;

  const ingestedAt = parseIngestedAt(memory);
  if (!ingestedAt) return 0;

  const hoursElapsed = (Date.now() - ingestedAt.getTime()) / MS_PER_HOUR;
  const resistance = computeResistance(memory);

  if (hoursElapsed < gistAgeHours * resistance) return 0;
  if (hoursElapsed < tagAgeHours * resistance) return 1;
  return 2;
}

// ── Core: sentence utilities ──────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  const raw = text.split(SENTENCE_SPLIT_RE);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

function scoreSentence(sentence: string): number {
  let score = 0.0;
  if (FILE_PATH_RE.test(sentence)) score += SCORE_FILE_PATH;
  FILE_PATH_RE.lastIndex = 0;
  if (ERROR_RE.test(sentence)) score += SCORE_ERROR;
  if (DECISION_RE.test(sentence)) score += SCORE_DECISION;
  if (NUMBER_VERSION_RE.test(sentence)) score += SCORE_NUMBER_VERSION;
  if (CAMELCASE_RE.test(sentence)) score += SCORE_CAMELCASE;
  CAMELCASE_RE.lastIndex = 0;
  if (sentence.includes("`")) score += SCORE_BACKTICK;
  return score;
}

function selectGistSentences(
  sentences: string[],
  codeBlocks: string[],
  targetLength: number,
): string[] {
  // Invariant: always include first and last sentence (primacy-recency effect).
  const scored: Array<[number, string, number]> = sentences.map((sent, i) => {
    let score = scoreSentence(sent);
    if (i === 0) score += SCORE_PRIMACY_BONUS; // primacy
    if (i === sentences.length - 1) score += SCORE_RECENCY_BONUS; // recency
    return [i, sent, score];
  });
  scored.sort((a, b) => b[2] - a[2]);

  const selected = new Set<number>([0, sentences.length - 1]);
  let currentLength = codeBlocks.reduce((s, cb) => s + cb.length, 0);
  for (const [idx, sent] of scored) {
    if (currentLength >= targetLength) break;
    selected.add(idx);
    currentLength += sent.length;
  }

  return [...selected].sort((a, b) => a - b).map((i) => sentences[i]!);
}

// ── Core: gist extraction ─────────────────────────────────────────────────────

/**
 * Extract gist from full content (compression level 1).
 *
 * Strategy:
 *   1. Preserve all code blocks verbatim
 *   2. Score sentences by information density
 *   3. Keep first + last sentences (primacy-recency effect)
 *   4. Target ~30% of original length
 *
 * Precondition: content is a non-empty string.
 * Postcondition: returns a string <= content.length (usually ~30% of original).
 */
function extractGist(content: string, targetRatio = GIST_TARGET_RATIO): string {
  const codeBlocks = content.match(CODE_BLOCK_RE) ?? [];
  CODE_BLOCK_RE.lastIndex = 0;
  const textWithoutCode = content.replace(CODE_BLOCK_RE, "");
  CODE_BLOCK_RE.lastIndex = 0;

  const sentences = splitSentences(textWithoutCode);
  if (!sentences.length) {
    return codeBlocks.length > 0 ? codeBlocks.join("\n\n") : content;
  }

  if (sentences.length <= GIST_SHORT_SENTENCE_MAX) {
    return [...sentences, ...codeBlocks].join("\n");
  }

  const targetLength = Math.max(content.length * targetRatio, GIST_MIN_LENGTH);
  const gistSentences = selectGistSentences(sentences, codeBlocks, targetLength);
  return [...gistSentences, ...codeBlocks].join("\n");
}

// ── Core: tag generation ──────────────────────────────────────────────────────

function extractTagEntities(content: string, memory: Record<string, unknown>): string[] {
  const entities = new Set<string>();
  const camelMatches = content.match(CAMELCASE_RE) ?? [];
  CAMELCASE_RE.lastIndex = 0;
  for (const m of camelMatches) entities.add(m);
  const fileMatches = content.match(FILE_PATH_RE) ?? [];
  FILE_PATH_RE.lastIndex = 0;
  for (const m of fileMatches) entities.add(m);

  const memTags = memory["tags"];
  if (Array.isArray(memTags)) {
    for (const t of memTags) {
      if (typeof t === "string") entities.add(t);
    }
  }
  return [...entities].sort().slice(0, TAG_MAX_ENTITIES);
}

function formatCreatedDate(memory: Record<string, unknown>): string {
  const created = memory["created_at"];
  if (!created) return "unknown";
  try {
    const dt = typeof created === "string" ? new Date(created) : (created as Date);
    if (isNaN(dt.getTime())) return String(created).slice(0, ISO_DATE_PREFIX_LEN);
    return dt.toISOString().slice(0, ISO_DATE_PREFIX_LEN);
  } catch {
    return String(created).slice(0, ISO_DATE_PREFIX_LEN);
  }
}

function truncateTagRepr(
  summary: string,
  tagPart: string,
  dateStr: string,
  entityList: string[],
): string {
  let tagRepr = `${summary} | Tags: ${tagPart} | Created: ${dateStr}`;
  if (tagRepr.length > TAG_MAX_LENGTH) {
    const suffix = ` | Tags: ${tagPart} | Created: ${dateStr}`;
    const available = TAG_MAX_LENGTH - suffix.length;
    let s = summary;
    let tp = tagPart;
    if (available > TAG_AVAILABLE_THRESHOLD) {
      s = summary.slice(0, available - ELLIPSIS_LEN) + "...";
    } else {
      s = summary.slice(0, TAG_SUMMARY_FALLBACK_LEN) + "...";
      tp = entityList.length > 0 ? entityList.slice(0, TAG_ENTITIES_FALLBACK_COUNT).join(", ") : "general";
    }
    tagRepr = `${s} | Tags: ${tp} | Created: ${dateStr}`;
  }
  if (tagRepr.length > TAG_MAX_LENGTH) tagRepr = tagRepr.slice(0, TAG_TRUNCATE_LENGTH) + "...";
  return tagRepr;
}

/**
 * Generate tag representation (compression level 2).
 *
 * Format: "[summary] | Tags: [entities] | Created: [date]"
 * Target: < 200 characters.
 *
 * Precondition: content is a non-empty string; memory carries optional tags/created_at.
 * Postcondition: returns a string <= 200 characters.
 */
function generateTag(content: string, memory: Record<string, unknown>): string {
  const entityList = extractTagEntities(content, memory);
  const sentences = splitSentences(content);
  const summary = sentences[0] ?? content.slice(0, TAG_SUMMARY_NO_SENTENCE_LEN);
  const dateStr = formatCreatedDate(memory);
  const tagPart = entityList.length > 0 ? entityList.join(", ") : "general";
  return truncateTagRepr(summary, tagPart, dateStr, entityList);
}

// ── Handler: per-memory compression ──────────────────────────────────────────

/**
 * Compress from full text (level 0) to gist (level 1).
 *
 * Returns the freshly computed (gist, gistEmbedding) so a caller advancing
 * straight to level 2 can reuse them instead of re-encoding.
 *
 * Precondition: mem["content"] is the original full text; mem is at level 0.
 * Postcondition (target_level == 1): memory written at level 1; 1 encode() call.
 * Postcondition (target_level >= 2): caller may pass gist+gistEmb to the tag step;
 *   total encode() calls = 2 (one for gist, one for tag).
 */
async function compressFullToGist(
  store: CompressionStore,
  embeddings: CompressionEmbeddingEngine,
  mem: Record<string, unknown>,
  stats: CompressionStageResult,
): Promise<[string, number[]]> {
  const original = mem["content"] as string;
  const gist = extractGist(original);
  const newEmb = await embeddings.encode(gist);

  await store.insertArchive({
    original_memory_id: mem["id"],
    content: original,
    embedding: mem["embedding"],
    archive_reason: "compression_gist",
  });
  await store.updateMemoryCompression(mem["id"] as number, gist, newEmb, 1, {
    originalContent: original,
  });
  stats.compressed_to_gist++;
  return [gist, newEmb];
}

/**
 * Continue compression from a freshly created gist to tag (level 2).
 *
 * Precondition: either both gist and gistEmb supplied (fast path,
 *   threaded through from compressFullToGist — no re-encode), or neither
 *   supplied (legacy path; recompute gist and encode for archive row).
 *
 * Postcondition — fast path: exactly 1 encode() call here (for the tag).
 *   Gist embedding is reused for archive row (was 3 encodes → now 2).
 * Postcondition — legacy path: 2 encodes (one for gist archive, one for tag).
 */
async function compressToTagFromGist(
  store: CompressionStore,
  embeddings: CompressionEmbeddingEngine,
  mem: Record<string, unknown>,
  stats: CompressionStageResult,
  opts: { gist?: string; gistEmb?: number[] } = {},
): Promise<void> {
  let { gist, gistEmb } = opts;
  if (!gist || !gistEmb) {
    gist = extractGist(mem["content"] as string);
    gistEmb = await embeddings.encode(gist);
  }

  const tag = generateTag(gist, mem);
  const tagEmb = await embeddings.encode(tag);

  await store.insertArchive({
    original_memory_id: mem["id"],
    content: gist,
    embedding: gistEmb,
    archive_reason: "compression_tag",
  });
  await store.updateMemoryCompression(mem["id"] as number, tag, tagEmb, 2);
  stats.compressed_to_tag++;
}

/**
 * Compress from gist (level 1) to tag (level 2).
 *
 * Precondition: mem is already at compression level 1.
 * Postcondition: memory written at level 2; exactly 1 encode() call.
 */
async function compressGistToTag(
  store: CompressionStore,
  embeddings: CompressionEmbeddingEngine,
  mem: Record<string, unknown>,
  stats: CompressionStageResult,
): Promise<void> {
  const tag = generateTag(mem["content"] as string, mem);
  const tagEmb = await embeddings.encode(tag);

  await store.insertArchive({
    original_memory_id: mem["id"],
    content: mem["content"],
    embedding: mem["embedding"],
    archive_reason: "compression_tag",
  });
  await store.updateMemoryCompression(mem["id"] as number, tag, tagEmb, 2);
  stats.compressed_to_tag++;
}

/**
 * Compress a single memory to the target level.
 *
 * Precondition: mem is not protected and not semantic (caller checks this).
 * Postcondition: stats updated; store updated if targetLevel > currentLevel.
 */
async function compressMemory(
  store: CompressionStore,
  settings: CompressionSettings,
  embeddings: CompressionEmbeddingEngine,
  mem: Record<string, unknown>,
  stats: CompressionStageResult,
): Promise<void> {
  const currentLevel = (mem["compression_level"] as number | undefined) ?? 0;
  const targetLevel = getCompressionSchedule(
    mem,
    settings.COMPRESSION_GIST_AGE_HOURS,
    settings.COMPRESSION_TAG_AGE_HOURS,
  );

  if (targetLevel <= currentLevel) return;

  try {
    if (targetLevel >= 1 && currentLevel === 0) {
      const [gist, gistEmb] = await compressFullToGist(store, embeddings, mem, stats);
      if (targetLevel >= 2) {
        await compressToTagFromGist(store, embeddings, mem, stats, { gist, gistEmb });
      }
    } else if (targetLevel >= 2 && currentLevel === 1) {
      await compressGistToTag(store, embeddings, mem, stats);
    }
  } catch {
    // non-fatal: individual compression failure must not block the cycle
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compress aging memories along the rate-distortion curve.
 *
 * `memories` may be pre-loaded by the consolidate handler (issue #13).
 * When null, loads all memories for decay from the store.
 *
 * Precondition: store is a valid CompressionStore; embeddings provides encode().
 * Postcondition: returned stats are non-negative; memories progressed from
 *   level 0 → 1 (gist) or 0 → 2 / 1 → 2 (tag) based on schedule.
 *   Protected and semantic memories are counted in skipped fields.
 */
export async function runCompressionCycle(
  store: CompressionStore,
  settings: CompressionSettings,
  embeddings: CompressionEmbeddingEngine,
  memories: readonly Record<string, unknown>[] | null = null,
): Promise<CompressionStageResult> {
  const mems = memories !== null ? memories : await store.getAllMemoriesForDecay();

  const stats: CompressionStageResult = {
    compressed_to_gist: 0,
    compressed_to_tag: 0,
    protected_skipped: 0,
    semantic_skipped: 0,
    rows_scanned: mems.length,
  };

  for (const mem of mems) {
    if (mem["is_protected"]) {
      stats.protected_skipped++;
      continue;
    }
    if ((mem["store_type"] as string | undefined) === "semantic") {
      stats.semantic_skipped++;
      continue;
    }

    await compressMemory(store, settings, embeddings, mem, stats);
  }

  return stats;
}
