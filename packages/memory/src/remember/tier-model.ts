/**
 * tier-model.ts — Two-tier memory model predicates.
 *
 * "State goes in the block; facts go to archival; never both." §8b
 *
 * Ports (faithful 1:1 translations):
 *   _is_tier_noise        → handlers/checkpoint.py:198-214
 *   _partition_hot_memories → handlers/checkpoint.py:217-234
 *   _is_promotion_noise   → handlers/consolidation/cls.py:39-57
 *
 * All three functions are **pure** (no I/O, no side effects).
 * They belong in the core layer: they define business invariants that must
 * hold across every write path and every consolidation cycle.
 *
 * contract: zetetic-team-subagents memory/contract.md §8b
 */

import { parseTags } from "../recall/recall-helpers.js";

// ── Tier-noise predicates ─────────────────────────────────────────────────────

/**
 * isTierNoise — Return true when the memory is auto-captured tool noise or a
 * block replica.
 *
 * Precondition:  mem has a 'tags' key (list, JSON-string, or absent).
 * Postcondition: true iff tags contain 'auto-captured' OR 'memory-replica'.
 *
 * Handles tags stored as a JSON string (DB serialisation), a plain array,
 * or absent/null — identical to the Python source.
 *
 * source: mcp_server/handlers/checkpoint.py:198-214
 * contract: zetetic-team-subagents memory/contract.md §8b
 */
export function isTierNoise(mem: Record<string, unknown>): boolean {
  const rawTags = mem["tags"];
  const tagArr = parseTags(rawTags);
  const tagSet = new Set(tagArr.map((t) => String(t)));
  return tagSet.has("auto-captured") || tagSet.has("memory-replica");
}

// ── CLS promotion-noise predicate ─────────────────────────────────────────────

/**
 * isPromotionNoise — Return true when the memory must not be promoted to a
 * semantic pattern during the CLS consolidation cycle.
 *
 * Tool-output captures and block-replica snapshots are not reasoning episodes
 * and produce incoherent semantic patterns when consolidated.
 *
 * Precondition:  mem has a 'tags' key (list, JSON-string, or absent).
 * Postcondition: true iff tags contain 'auto-captured' OR 'memory-replica'.
 *
 * Identical predicate to isTierNoise — extracted to a separate name so each
 * call site reads intent clearly (checkpoint injection vs CLS promotion).
 *
 * source: mcp_server/handlers/consolidation/cls.py:39-57
 * contract: zetetic-team-subagents memory/contract.md §8b
 */
export function isPromotionNoise(mem: Record<string, unknown>): boolean {
  // Precondition and tag-parsing are identical to isTierNoise;
  // delegating avoids duplication without hiding the distinction in call sites.
  return isTierNoise(mem);
}
