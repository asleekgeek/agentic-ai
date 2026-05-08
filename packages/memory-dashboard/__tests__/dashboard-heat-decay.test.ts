/**
 * dashboard-heat-decay.test.ts — Unit tests for computeEffectiveHeat.
 *
 * Verifies that the TypeScript mirror of the PL/pgSQL effective_heat()
 * function produces correct decay values and matches the PG formula
 * within 1e-6 floating-point tolerance.
 *
 * source: packages/memory-dashboard/src/util/heat.ts:computeEffectiveHeat
 * source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:586-683
 *
 * Smoke test (d) from the task spec:
 *   Seed a memory with created_at 7 days in the past.
 *   Call computeEffectiveHeat(row, now).
 *   Assert result < 1.0 and matches PG formula within 1e-6.
 */

import { describe, it, expect } from "vitest";
import { computeEffectiveHeat, type EffectiveHeatRow } from "../src/util/heat.js";

// ── Constants (mirrored from util/heat.ts for test derivation) ────────────────

// source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:597
const P_FACTOR = 0.99787; // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:597
// source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:646
const EMOTIONAL_DAMPING = 0.30; // source: Yonelinas & Ritchey (2015)
// source: SI — International System of Units
const MS_PER_HOUR = 3_600_000;

/**
 * Reference implementation of effective_heat() — derived directly from the
 * PL/pgSQL formula for cross-check.
 *
 * precondition:  row fields are non-null; tNow is a valid Date.
 * postcondition: result matches computeEffectiveHeat() within floating-point
 *                rounding (< 1e-6 for typical inputs).
 */
function referenceEffectiveHeat(
  heatBase: number,
  hoursElapsed: number,
  stageHours: number,
  stage: string,
  valence: number,
  isProtected: boolean,
  factor = 1.0,
  pFactor = P_FACTOR,
): number {
  if (isProtected) return Math.min(1.0, Math.max(0.0, heatBase * factor));

  const ALPHA: Record<string, number> = {
    labile: 2.0, early_ltp: 1.2, late_ltp: 0.8,
    consolidated: 0.5, reconsolidating: 1.5,
  };
  const FLOOR: Record<string, number> = {
    consolidated: 0.10, late_ltp: 0.05, reconsolidating: 0.05,
  };

  const alpha = ALPHA[stage] ?? 1.0;
  const beta = 1.0 - EMOTIONAL_DAMPING * Math.abs(valence)
    * (1.0 - Math.exp(-Math.min(stageHours, 80.0)));
  const stageFloor = FLOOR[stage] ?? 0.0;

  const decayed = heatBase * factor * Math.pow(pFactor, alpha * beta * hoursElapsed);
  return Math.min(1.0, Math.max(Math.max(stageFloor, 1e-38), decayed));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoMsAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeRow(overrides: Partial<EffectiveHeatRow> = {}): EffectiveHeatRow {
  return {
    heat_base: 1.0,
    heat_base_set_at: null,
    last_accessed: null,
    created_at: null,
    stage_entered_at: null,
    is_protected: 0,
    no_decay: 0,
    consolidation_stage: "labile",
    emotional_valence: 0.0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeEffectiveHeat", () => {

  it("(d) memory created 7 days ago decays below 1.0 — labile stage", () => {
    // Smoke test (d) from the task spec.
    // source: 2026-05-08 task spec — "seed a memory with created_at 7 days in the past"
    const sevenDaysMs = 7 * 24 * MS_PER_HOUR;
    const createdAt = isoMsAgo(sevenDaysMs);
    const row = makeRow({
      heat_base: 1.0,
      heat_base_set_at: createdAt,
      created_at: createdAt,
      consolidation_stage: "labile",
      emotional_valence: 0.0,
    });
    const tNow = new Date();
    const result = computeEffectiveHeat(row, tNow);

    // postcondition: decayed — must be strictly less than 1.0
    expect(result).toBeLessThan(1.0);

    // Cross-check against reference implementation within 1e-6.
    const hoursElapsed = sevenDaysMs / MS_PER_HOUR; // 168 hours
    const ref = referenceEffectiveHeat(1.0, hoursElapsed, hoursElapsed, "labile", 0.0, false);
    expect(Math.abs(result - ref)).toBeLessThan(1e-6);
  });

  it("protected memory does not decay regardless of age", () => {
    // precondition: is_protected = 1
    // postcondition: result = clamp(0, heat_base * factor, 1) — no decay applied
    // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:618-620
    const row = makeRow({
      heat_base: 0.8,
      heat_base_set_at: isoMsAgo(30 * 24 * MS_PER_HOUR), // 30 days ago
      created_at: isoMsAgo(30 * 24 * MS_PER_HOUR),
      is_protected: 1,
      consolidation_stage: "labile",
    });
    const result = computeEffectiveHeat(row, new Date());
    expect(result).toBeCloseTo(0.8, 6);
  });

  it("no_decay flag skips decay", () => {
    // precondition: no_decay = 1
    // postcondition: same as protected — result = heat_base (no power-law applied)
    const row = makeRow({
      heat_base: 0.6,
      heat_base_set_at: isoMsAgo(14 * 24 * MS_PER_HOUR), // 14 days ago
      no_decay: 1,
    });
    const result = computeEffectiveHeat(row, new Date());
    expect(result).toBeCloseTo(0.6, 6);
  });

  it("consolidated memory respects permastore floor of 0.10", () => {
    // Bahrick (1984) — consolidated memories never drop below 0.10.
    // source: Bahrick, H.P. (1984). "Semantic memory content in permastore." JECP 33(3).
    const ageMsOld = 10_000 * 24 * MS_PER_HOUR; // ~27 years — should fully decay to floor
    const row = makeRow({
      heat_base: 1.0,
      heat_base_set_at: isoMsAgo(ageMsOld),
      created_at: isoMsAgo(ageMsOld),
      consolidation_stage: "consolidated",
      emotional_valence: 0.0,
    });
    const result = computeEffectiveHeat(row, new Date());
    expect(result).toBeGreaterThanOrEqual(0.10);
  });

  it("late_ltp memory respects permastore floor of 0.05", () => {
    // source: Benna & Fusi (2016) — late_ltp floor is 0.05
    const ageMsOld = 10_000 * 24 * MS_PER_HOUR;
    const row = makeRow({
      heat_base: 1.0,
      heat_base_set_at: isoMsAgo(ageMsOld),
      created_at: isoMsAgo(ageMsOld),
      consolidation_stage: "late_ltp",
      emotional_valence: 0.0,
    });
    const result = computeEffectiveHeat(row, new Date());
    expect(result).toBeGreaterThanOrEqual(0.05);
  });

  it("labile memory has no permastore floor — can decay to near zero", () => {
    // labile memories have no permastore floor (0.0 floor, minimum 1e-38).
    // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:639-644
    const ageMsOld = 10_000 * 24 * MS_PER_HOUR;
    const row = makeRow({
      heat_base: 1.0,
      heat_base_set_at: isoMsAgo(ageMsOld),
      created_at: isoMsAgo(ageMsOld),
      consolidation_stage: "labile",
      emotional_valence: 0.0,
    });
    const result = computeEffectiveHeat(row, new Date());
    // Must be below 0.10 (the consolidated floor) — far below in practice
    expect(result).toBeLessThan(0.10);
  });

  it("emotional valence reduces decay rate (beta < 1)", () => {
    // Yonelinas & Ritchey (2015) — emotional memories decay more slowly.
    // Higher |valence| → lower beta → slower decay → higher effective_heat.
    // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:635-638
    const sevenDaysMs = 7 * 24 * MS_PER_HOUR;
    const createdAt = isoMsAgo(sevenDaysMs);
    const rowNeutral = makeRow({
      heat_base: 1.0, heat_base_set_at: createdAt, created_at: createdAt,
      consolidation_stage: "labile", emotional_valence: 0.0,
    });
    const rowCharged = makeRow({
      heat_base: 1.0, heat_base_set_at: createdAt, created_at: createdAt,
      consolidation_stage: "labile", emotional_valence: 0.9, // high valence
    });
    const tNow = new Date();
    const neutral = computeEffectiveHeat(rowNeutral, tNow);
    const charged = computeEffectiveHeat(rowCharged, tNow);
    // postcondition: emotionally charged memory decays more slowly → higher heat
    expect(charged).toBeGreaterThan(neutral);
  });

  it("matches PG reference formula within 1e-6 for a 7-day early_ltp memory", () => {
    // Contract verification: TypeScript output = PL/pgSQL output ± floating-point.
    // source: 2026-05-08 task spec — tolerance < 1e-6
    const sevenDaysMs = 7 * 24 * MS_PER_HOUR;
    const createdAt = isoMsAgo(sevenDaysMs);
    const hoursElapsed = sevenDaysMs / MS_PER_HOUR;
    const valence = 0.4;
    const row = makeRow({
      heat_base: 0.75,
      heat_base_set_at: createdAt,
      created_at: createdAt,
      consolidation_stage: "early_ltp",
      emotional_valence: valence,
    });
    const tNow = new Date();
    const result = computeEffectiveHeat(row, tNow);
    const ref = referenceEffectiveHeat(0.75, hoursElapsed, hoursElapsed, "early_ltp", valence, false);
    expect(Math.abs(result - ref)).toBeLessThan(1e-6);
  });

  it("heat_base_set_at is used in preference to last_accessed for hours_elapsed", () => {
    // Coalescing order: heat_base_set_at > last_accessed > created_at.
    // source: cortex@ed33435 mcp_server/infrastructure/pg_schema.py:621-624
    const tNow = new Date();
    const oneHourAgo = new Date(tNow.getTime() - MS_PER_HOUR).toISOString();
    const tenDaysAgo = new Date(tNow.getTime() - 10 * 24 * MS_PER_HOUR).toISOString();

    const rowWithRecent = makeRow({
      heat_base: 1.0,
      heat_base_set_at: oneHourAgo,   // recent heat set → barely decayed
      last_accessed: tenDaysAgo,       // old last_access — should NOT be used
      created_at: tenDaysAgo,
      consolidation_stage: "labile",
    });
    const rowWithoutRecent = makeRow({
      heat_base: 1.0,
      heat_base_set_at: null,
      last_accessed: tenDaysAgo,       // 10 days old — significant decay
      created_at: tenDaysAgo,
      consolidation_stage: "labile",
    });
    const withRecent = computeEffectiveHeat(rowWithRecent, tNow);
    const withoutRecent = computeEffectiveHeat(rowWithoutRecent, tNow);
    // postcondition: using heat_base_set_at (1h ago) gives higher heat than
    //                falling back to last_accessed (10 days ago).
    expect(withRecent).toBeGreaterThan(withoutRecent);
  });

  it("result is always in [0, 1]", () => {
    // Invariant: effective_heat is always a valid probability-like value.
    const cases: EffectiveHeatRow[] = [
      makeRow({ heat_base: 0.0 }),
      makeRow({ heat_base: 1.0 }),
      makeRow({ heat_base: 0.5, consolidation_stage: "consolidated" }),
      makeRow({ heat_base: 1.5, is_protected: 1 }), // over-range input — clamp expected
    ];
    for (const row of cases) {
      const result = computeEffectiveHeat(row, new Date());
      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeLessThanOrEqual(1.0);
    }
  });

});
