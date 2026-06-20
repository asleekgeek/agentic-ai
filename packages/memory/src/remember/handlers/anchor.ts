/**
 * handlers/anchor.ts — Mark a memory as compaction-resistant.
 *
 * Ports: handlers/anchor.py (156 LOC)
 *
 * Anchored memories survive context compaction and heat decay:
 *   - heat_base set to 1.0 (maximum)
 *   - no_decay = true (bypasses effective_heat decay)
 *   - is_protected = true (blocks forget + compression)
 *   - importance set to 1.0
 *   - _anchor tag added
 *
 * Correctness contract:
 *   pre:  memoryId refers to an existing memory row.
 *   post: memories row has heat_base=1.0, no_decay=true, is_protected=true,
 *         importance=1.0, and includes the _anchor tag.
 *         The write is atomic: either all fields update or none do.
 *
 * source: handlers/anchor.py
 * source: phase-3-a3-migration-design.md §3.3. Phase 5: pooled write.
 */

import type { MemoryStore } from "../storage/memory-store.js";

// source: cortex@f2b9f99 mcp_server/handlers/anchor.py:102 — reason tag capped at 40 chars
const ANCHOR_REASON_TAG_MAX_CHARS = 40;

// source: cortex@f2b9f99 mcp_server/handlers/anchor.py:155 — content_preview is first 120 chars
const ANCHOR_CONTENT_PREVIEW_CHARS = 120;

export interface AnchorRequest {
  memory_id: number;
  reason?: string;
  is_global?: boolean;
}

export interface AnchorResponse {
  anchored: boolean;
  memory_id?: number;
  reason?: string;
  is_global?: boolean;
  tags?: string[];
  content_preview?: string;
  error?: string;
}

/**
 * Build the updated tag list with anchor tags appended.
 *
 * precondition:  existingTags is an array of strings.
 * postcondition: returned list contains '_anchor'; contains '_anchor:<reason>'
 *   iff reason is non-empty; no duplicate entries.
 *
 * source: handlers/anchor.py:_build_anchor_tags
 */
function buildAnchorTags(existingTags: string[], reason: string): string[] {
  const tags = [...existingTags];
  if (!tags.includes("_anchor")) tags.push("_anchor");
  if (reason) {
    const anchorTag = `_anchor:${reason.slice(0, ANCHOR_REASON_TAG_MAX_CHARS)}`;
    if (!tags.includes(anchorTag)) tags.push(anchorTag);
  }
  return tags;
}

/**
 * Apply anchor prefix to content if reason is given.
 *
 * source: handlers/anchor.py:_build_anchor_content
 */
function buildAnchorContent(content: string, reason: string): string {
  if (reason && !content.startsWith("[ANCHOR:")) {
    return `[ANCHOR: ${reason}] ${content}`;
  }
  return content;
}

/**
 * anchor — make a memory compaction-resistant.
 *
 * source: handlers/anchor.py:handler
 */
export function anchor(
  args: AnchorRequest,
  store: MemoryStore,
): AnchorResponse {
  const memoryId = args.memory_id;
  const reason = (args.reason ?? "").trim();
  const isGlobal = args.is_global ?? false;

  if (!memoryId || memoryId < 1) {
    return { anchored: false, error: "memory_id is required and must be >= 1" };
  }

  const mem = store.getMemory(memoryId);
  if (mem === null) {
    return { anchored: false, error: `memory not found: ${memoryId}` };
  }

  const tags = buildAnchorTags(mem.tags, reason);
  const content = buildAnchorContent(mem.content, reason);

  // A3 canonical anchor write: a single atomic UPDATE setting
  // heat_base=1.0, heat_base_set_at=NOW(), no_decay=TRUE, is_protected=TRUE,
  // importance=1.0, tags, content, is_global — exactly the Cortex
  // acquire_interactive() single statement. Replaces the four prior
  // non-atomic writes (which also never set no_decay=TRUE).
  // source: handlers/anchor.py:141-147 (single UPDATE in acquire_interactive)
  if (store.anchorMemory) {
    store.anchorMemory({ memoryId, content, tags, isGlobal });
  } else {
    throw new Error("store does not implement anchorMemory");
  }

  return {
    anchored: true,
    memory_id: memoryId,
    reason: reason || "no reason given",
    is_global: isGlobal,
    tags,
    content_preview: content.slice(0, ANCHOR_CONTENT_PREVIEW_CHARS),
  };
}

/**
 * anchorAsync — async variant that calls *Async store methods when available.
 *
 * MCP tool handlers MUST use this when the store may be PgMemoryStore.
 * anchor() calls store.getMemory / store.bumpHeatRaw which throw at runtime
 * on PgMemoryStore.
 *
 * precondition:  same as anchor().
 * postcondition: same as anchor().
 * source: ADR-0042 — async path required for PG backend.
 */
export async function anchorAsync(
  args: AnchorRequest,
  store: MemoryStore,
): Promise<AnchorResponse> {
  const memoryId = args.memory_id;
  const reason = (args.reason ?? "").trim();
  const isGlobal = args.is_global ?? false;

  if (!memoryId || memoryId < 1) {
    return { anchored: false, error: "memory_id is required and must be >= 1" };
  }

  const mem = store.getMemoryAsync
    ? await store.getMemoryAsync(memoryId)
    : store.getMemory(memoryId);

  if (mem === null) {
    return { anchored: false, error: `memory not found: ${memoryId}` };
  }

  const tags = buildAnchorTags(mem.tags, reason);
  const content = buildAnchorContent(mem.content, reason);

  // Single atomic UPDATE — Async variant when available (PG), sync otherwise.
  // Replaces the four prior non-atomic writes and sets no_decay=TRUE.
  // source: handlers/anchor.py:141-147 (single UPDATE in acquire_interactive)
  if (store.anchorMemoryAsync) {
    await store.anchorMemoryAsync({ memoryId, content, tags, isGlobal });
  } else if (store.anchorMemory) {
    store.anchorMemory({ memoryId, content, tags, isGlobal });
  } else {
    throw new Error("store does not implement anchorMemory");
  }

  return {
    anchored: true,
    memory_id: memoryId,
    reason: reason || "no reason given",
    is_global: isGlobal,
    tags,
    content_preview: content.slice(0, ANCHOR_CONTENT_PREVIEW_CHARS),
  };
}
