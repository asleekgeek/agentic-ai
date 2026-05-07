/**
 * handlers/forget.ts — Delete or soft-delete a memory by ID.
 *
 * Ports: handlers/forget.py (117 LOC)
 *
 * Hard delete: permanent row removal + FTS/vec cleanup.
 * Soft delete: set is_stale=true + heat=0 (recoverable via SQL).
 * Protected memories require explicit force=true to remove.
 *
 * Correctness contract:
 *   pre:  memoryId refers to an existing memory row.
 *   post: IF hard → row is deleted atomically (incl. FTS/vec).
 *         IF soft → is_stale=true AND heat_base=0 in one UPDATE each.
 *         IF protected AND NOT force → no mutation, returns error.
 *
 * source: handlers/forget.py
 */

import type { MemoryStore } from "../storage/memory-store.js";

// source: cortex@ed33435 mcp_server/handlers/forget.py — content_preview is first 80 chars
const FORGET_CONTENT_PREVIEW_CHARS = 80;

export interface ForgetRequest {
  memory_id: number;
  soft?: boolean;
  force?: boolean;
}

export interface ForgetResponse {
  deleted: boolean;
  method?: "hard" | "soft";
  memory_id?: number;
  content_preview?: string;
  reason?: string;
}

/**
 * forget — delete or soft-delete a memory.
 *
 * source: handlers/forget.py:handler
 */
export function forget(
  args: ForgetRequest,
  store: MemoryStore,
): ForgetResponse {
  const memoryId = args.memory_id;
  const soft = args.soft ?? false;
  const force = args.force ?? false;

  if (!memoryId || memoryId < 1) {
    return { deleted: false, reason: "no_memory_id" };
  }

  const mem = store.getMemory(memoryId);
  if (mem === null) {
    return { deleted: false, reason: "not_found", memory_id: memoryId };
  }

  if (mem.is_protected && !force) {
    return {
      deleted: false,
      reason: "protected — use force=true to override",
      memory_id: memoryId,
    };
  }

  if (soft) {
    store.markMemoryStale(memoryId, true);
    store.bumpHeatRaw(memoryId, 0.0);
    return {
      deleted: true,
      method: "soft",
      memory_id: memoryId,
      content_preview: mem.content.slice(0, FORGET_CONTENT_PREVIEW_CHARS),
    };
  }

  // Hard delete — atomic in the store (invariant I3).
  const deleted = store.deleteMemory(memoryId);
  return {
    deleted,
    method: "hard",
    memory_id: memoryId,
    content_preview: mem.content.slice(0, FORGET_CONTENT_PREVIEW_CHARS),
  };
}

/**
 * forgetAsync — async variant that calls *Async store methods when available.
 *
 * MCP tool handlers MUST use this when the store may be PgMemoryStore.
 * The sync forget() calls store.getMemory/deleteMemory/bumpHeatRaw which
 * throw at runtime on PgMemoryStore (its _runSync() is intentionally broken).
 *
 * precondition:  same as forget().
 * postcondition: same as forget().
 * source: ADR-0042 — async path required for PG backend.
 */
export async function forgetAsync(
  args: ForgetRequest,
  store: MemoryStore,
): Promise<ForgetResponse> {
  const memoryId = args.memory_id;
  const soft = args.soft ?? false;
  const force = args.force ?? false;

  if (!memoryId || memoryId < 1) {
    return { deleted: false, reason: "no_memory_id" };
  }

  const mem = store.getMemoryAsync
    ? await store.getMemoryAsync(memoryId)
    : store.getMemory(memoryId);

  if (mem === null) {
    return { deleted: false, reason: "not_found", memory_id: memoryId };
  }

  if (mem.is_protected && !force) {
    return {
      deleted: false,
      reason: "protected — use force=true to override",
      memory_id: memoryId,
    };
  }

  if (soft) {
    store.markMemoryStale(memoryId, true);
    if (store.bumpHeatRawAsync) {
      await store.bumpHeatRawAsync(memoryId, 0.0);
    } else {
      store.bumpHeatRaw(memoryId, 0.0);
    }
    return {
      deleted: true,
      method: "soft",
      memory_id: memoryId,
      content_preview: mem.content.slice(0, FORGET_CONTENT_PREVIEW_CHARS),
    };
  }

  const deleted = store.deleteMemoryAsync
    ? await store.deleteMemoryAsync(memoryId)
    : store.deleteMemory(memoryId);

  return {
    deleted,
    method: "hard",
    memory_id: memoryId,
    content_preview: mem.content.slice(0, FORGET_CONTENT_PREVIEW_CHARS),
  };
}
