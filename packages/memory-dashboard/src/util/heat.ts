/**
 * util/heat.ts — computeEffectiveHeat: TypeScript mirror of the PL/pgSQL
 * effective_heat() stored procedure.
 *
 * This function is used by the SQLite route path (graph.ts, memories.ts) to
 * produce decayed heat values that match what the PG path produces via the
 * SQL function. The PG path calls effective_heat(memories, NOW()) directly in
 * SQL; the SQLite path calls this function post-row-read.
 *
 * Layer: shared/util — pure function, no I/O, no side effects.
 *
 * source: packages/memory/src/remember/storage/pg-schema-functions.ts:EFFECTIVE_HEAT_FN
 * source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:586-683
 *
 * precondition:  row fields are numeric (or null) as returned from SQLite /
 *                normalised from PG; tNow is a valid Date.
 * postcondition: returned value is in [stage_floor, 1.0] clamped, where
 *                stage_floor is 0.10 for consolidated, 0.05 for late_ltp /
 *                reconsolidating, 0.0 otherwise. Value matches the PL/pgSQL
 *                output within floating-point rounding (< 1e-6 for typical
 *                inputs).
 */

// ── Constants (mirrored from pg-schema-functions.ts) ─────────────────────────

// source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:597
// 0.95^(1/24) ≈ 0.99787 — converts daily decay factor to per-hour rate.
// source: docs/program/phase-3-a3-migration-design.md §2.
const PG_P_FACTOR_DEFAULT = 0.99787; // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:597

// source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:646
// Yonelinas & Ritchey (2015) emotional enhancement coefficient = 0.30.
const PG_EMOTIONAL_DAMPING = 0.30; // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:646

// source: Bahrick, H.P. (1984). "Semantic memory content in permastore." JECP 33(3).
const PERMASTORE_FLOOR_CONSOLIDATED = 0.10; // source: Bahrick (1984) — consolidated permastore floor

// source: Benna, M.K. & Fusi, S. (2016). "Computational principles of synaptic memory." Nature Neurosci 19(12).
const PERMASTORE_FLOOR_LATE = 0.05; // source: Benna & Fusi (2016) — late_ltp / reconsolidating floor

// source: SI — International System of Units
const MS_PER_HOUR = 3_600_000; // source: SI — milliseconds per hour

// Upper bound for stage_hours in beta calculation — prevents numerical overflow
// in the exp() call for very old memories. PL/pgSQL uses LEAST(stage_hours, 80).
// source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:637
const BETA_STAGE_HOURS_CAP = 80.0; // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:637

// Minimum floor to prevent REAL underflow on cast — mirrors PG GREATEST(stage_floor, 1e-38).
// source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:677
const REAL_UNDERFLOW_FLOOR = 1e-38; // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:677 — IEEE 754 REAL minimum positive normal is ~1.18e-38

// ── Input shape ───────────────────────────────────────────────────────────────

/**
 * EffectiveHeatRow — minimal fields required by computeEffectiveHeat.
 *
 * All timestamp fields are ISO-8601 strings (as returned by SQLite TEXT
 * columns) or null. Numeric fields may be null when the row was inserted by
 * an older schema version.
 */
export interface EffectiveHeatRow {
  heat_base: number | null;
  heat_base_set_at: string | null;
  last_accessed: string | null;
  created_at: string | null;
  stage_entered_at: string | null;
  is_protected: number | boolean | null;
  no_decay: number | boolean | null;
  consolidation_stage: string | null;
  emotional_valence: number | null;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * computeEffectiveHeat — TypeScript mirror of the PL/pgSQL effective_heat().
 *
 * Algorithm (mirrors pg-schema-functions.ts:EFFECTIVE_HEAT_FN):
 *
 *   1. If is_protected OR no_decay: return clamp(0, heat_base * factor, 1).
 *   2. hours_elapsed = max(0, (tNow - coalesce(heat_base_set_at,
 *        last_accessed, created_at)) / 3_600_000)
 *   3. stage_hours  = max(0, (tNow - coalesce(stage_entered_at,
 *        created_at)) / 3_600_000)
 *   4. alpha = stage-dependent: labile=2.0, early_ltp=1.2, late_ltp=0.8,
 *              consolidated=0.5, reconsolidating=1.5, else 1.0
 *   5. beta  = 1 - PG_EMOTIONAL_DAMPING * |valence|
 *              * (1 - exp(-min(stage_hours, 80)))
 *   6. stage_floor = consolidated → 0.10, late_ltp/reconsolidating → 0.05,
 *                    else 0.0
 *   7. decayed = heat_base * factor * p_factor^(alpha * beta * hours_elapsed)
 *   8. return clamp(max(stage_floor, 1e-38), decayed, 1.0)
 *
 * precondition:  row has the EffectiveHeatRow fields; tNow is a valid Date.
 * postcondition: result is in [stage_floor, 1.0] and matches the PL/pgSQL
 *                function to within floating-point rounding error (< 1e-6).
 *
 * @param row      — memory row with heat decay fields
 * @param tNow     — the current time (use new Date() in production;
 *                   injectable for deterministic testing)
 * @param factor   — homeostatic scale factor (default 1.0)
 * @param pFactor  — per-hour decay base (default PG_P_FACTOR_DEFAULT)
 */
export function computeEffectiveHeat(
  row: EffectiveHeatRow,
  tNow: Date,
  factor: number = 1.0,
  pFactor: number = PG_P_FACTOR_DEFAULT,
): number {
  const heatBase = row.heat_base ?? 1.0;
  const isProtected = Boolean(row.is_protected);
  const noDecay = Boolean(row.no_decay);

  // Invariant: protected/no-decay memories never decay.
  // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:618-620
  if (isProtected || noDecay) {
    return Math.min(1.0, Math.max(0.0, heatBase * factor));
  }

  const nowMs = tNow.getTime();

  // Timestamp coalescing: heat_base_set_at → last_accessed → created_at.
  // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:621-624
  const heatSetMs = parseIso(row.heat_base_set_at)
    ?? parseIso(row.last_accessed)
    ?? parseIso(row.created_at)
    ?? nowMs;
  const stageSetMs = parseIso(row.stage_entered_at)
    ?? parseIso(row.created_at)
    ?? nowMs;

  // Hours elapsed since heat was last set (clamped to [0, ∞)).
  const hoursElapsed = Math.max(0.0, (nowMs - heatSetMs) / MS_PER_HOUR);
  // Hours in current consolidation stage (clamped to [0, ∞)).
  const stageHours = Math.max(0.0, (nowMs - stageSetMs) / MS_PER_HOUR);

  // Alpha: stage-dependent decay rate multiplier.
  // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:625-634
  const stage = row.consolidation_stage ?? "labile";
  const alpha = ALPHA_BY_STAGE[stage] ?? 1.0;

  // Beta: emotional damping reduces decay for emotionally-charged memories.
  // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:635-638
  // Yonelinas & Ritchey (2015) emotional modulation of memory consolidation.
  const valence = Math.abs(row.emotional_valence ?? 0.0);
  const beta = 1.0 - PG_EMOTIONAL_DAMPING * valence
    * (1.0 - Math.exp(-Math.min(stageHours, BETA_STAGE_HOURS_CAP)));

  // Stage floor: permastore minimum prevents full forgetting of consolidated memories.
  // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:639-644
  const stageFloor = STAGE_FLOOR[stage] ?? 0.0;

  // Decay: power law in hours_elapsed.
  // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:645-650
  const baseScaled = heatBase * factor;
  const decayed = baseScaled * Math.pow(pFactor, alpha * beta * hoursElapsed);

  // Clamp: [max(stage_floor, 1e-38), 1.0].
  const floor = Math.max(stageFloor, REAL_UNDERFLOW_FLOOR);
  return Math.min(1.0, Math.max(floor, decayed));
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Parse an ISO-8601 string to milliseconds since epoch.
 * Returns null for null/empty/unparseable inputs.
 *
 * precondition:  s is null, empty, or a valid ISO-8601 datetime string.
 * postcondition: returns ms since epoch, or null if unparseable.
 */
function parseIso(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Alpha (decay rate multiplier) by consolidation stage.
 * source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:625-634
 */
const ALPHA_BY_STAGE: Record<string, number> = {
  labile:          2.0, // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:627
  early_ltp:       1.2, // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:628
  late_ltp:        0.8, // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:629
  consolidated:    0.5, // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:630
  reconsolidating: 1.5, // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:631
};

/**
 * Stage floor (permastore minimum heat) by consolidation stage.
 * source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:639-644
 */
const STAGE_FLOOR: Record<string, number> = {
  consolidated:    PERMASTORE_FLOOR_CONSOLIDATED, // source: Bahrick (1984)
  late_ltp:        PERMASTORE_FLOOR_LATE,         // source: Benna & Fusi (2016)
  reconsolidating: PERMASTORE_FLOOR_LATE,         // source: Benna & Fusi (2016)
};
