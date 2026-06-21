/**
 * Entity-merge cycle: collapse fuzzy-duplicate concept entities into canonical survivors.
 *
 * Two halves, cleanly split: `deduplicateEntities` plans the merge (pure, no I/O —
 * 3-pass exact/MinHash-LSH/Jaro-Winkler) and `port.mergeEntities` performs it
 * (atomic rewire). This stage is the composition root that wires the two together.
 *
 * Ablation-gated by `Mechanism.ENTITY_DEDUP` so a benchmark A/B can run the
 * no-regression gate with the merge disabled (CORTEX_ABLATE_ENTITY_DEDUP=1)
 * versus enabled, isolating its retrieval impact.
 *
 * Port of: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py
 */

import { Mechanism, isMechanismDisabled } from "../ablation.js";
import { deduplicateEntities, type EntityInput } from "../entity-merge/entity-dedup.js";

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * Narrow store interface required by runEntityMergeCycle.
 *
 * Only the two operations the cycle actually uses are declared here,
 * mirroring the dependency-inversion pattern used by all other stage files
 * (e.g., compression.ts CompressionStore, pruning.ts PruningStore).
 */
export interface EntityMergePort {
  /**
   * Return all entities with heat >= 0 (including archived if present,
   * as the dedup engine must see all concept entities).
   *
   * postcondition: returns an array; empty DB → empty array (not null/throw).
   */
  getAllEntities(opts: { minHeat: number }): Promise<Record<string, unknown>[]>;

  /**
   * Collapse alias into survivor atomically.
   *
   * postcondition: returns { merged } indicating whether the operation
   *   ran (true) or was a no-op (false, e.g. equal ids or missing entity).
   *
   * source: cortex bc5af469 mcp_server/infrastructure/pg_store_entity_merge.py
   * source: cortex bc5af469 mcp_server/infrastructure/sqlite_store_entity_merge.py
   */
  mergeEntities(survivorId: number, aliasId: number): Promise<{ merged: boolean; [k: string]: unknown }>;
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface EntityMergeCycleResult {
  merges_applied: number;
  pairs_planned: number;
  ablated?: boolean;
}

// ── Cycle ─────────────────────────────────────────────────────────────────────

/**
 * Collapse near-duplicate concept entities into canonical survivors.
 *
 * precondition:  port.getAllEntities and port.mergeEntities are functional.
 * postcondition: result.merges_applied <= result.pairs_planned;
 *   each applied merge has updated the DB atomically via port.mergeEntities.
 *   Errors are non-fatal: the cycle logs and returns {merges_applied:0}.
 *
 * Port of: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py::run_entity_merge_cycle
 */
export async function runEntityMergeCycle(port: EntityMergePort): Promise<EntityMergeCycleResult> {
  // Ablation gate: CORTEX_ABLATE_ENTITY_DEDUP=1 → skip entire cycle.
  // source: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py — is_mechanism_disabled gate
  if (isMechanismDisabled(Mechanism.ENTITY_DEDUP)) {
    return { merges_applied: 0, pairs_planned: 0, ablated: true };
  }

  try {
    // source: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py — get_all_entities(min_heat=0.0)
    const entities = await port.getAllEntities({ minHeat: 0 });

    if (entities.length <= 1) {
      return { merges_applied: 0, pairs_planned: 0 };
    }

    // Invoke the pure dedup engine (Phase A).
    // source: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py — deduplicate_entities(entities)
    const result = deduplicateEntities(entities as EntityInput[]);
    const remap = result.remap;

    // Apply each alias→survivor pair where BOTH keys are digit strings.
    // source: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py — _apply_merges
    let applied = 0;
    for (const [aliasKey, survivorKey] of Object.entries(remap)) {
      // Only proceed when both keys are numeric: live DB rows always carry an id;
      // name-only keys appear in legacy/test inputs without ids — skip them.
      if (!/^\d+$/.test(aliasKey) || !/^\d+$/.test(survivorKey)) continue;

      // Invariant: both keys are non-empty digit strings, so Number() is safe.
      const outcome = await port.mergeEntities(Number(survivorKey), Number(aliasKey));
      if (outcome.merged) applied++;
    }

    return { merges_applied: applied, pairs_planned: Object.keys(remap).length };
  } catch {
    // Non-fatal: a failing entity-merge cycle must not abort the full consolidation run.
    // source: cortex bc5af469 mcp_server/handlers/consolidation/entity_merge.py — except Exception: logger.debug
    return { merges_applied: 0, pairs_planned: 0 };
  }
}
