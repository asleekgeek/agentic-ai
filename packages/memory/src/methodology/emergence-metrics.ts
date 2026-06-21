/**
 * Emergence metrics — forgetting curve fitting and aggregate report.
 *
 * Contains the forgetting curve analysis (log-linear regression) and the
 * aggregate emergence report generator.
 *
 * Pure business logic — no I/O.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */

import type {
  PhaseLockingResult,
  SchemaAccelerationResult,
} from "./emergence-tracker.js";

// ── Forgetting Curve ──────────────────────────────────────────────────────────

/**
 * Bin memories by age and compute average heat per bin.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py:18-39
 */
function binMemoriesByAge(
  memoriesByAge: Array<[number, number]>,
  binWidthHours = 6.0,
): Array<[number, number]> {
  const bins = new Map<number, number[]>();

  for (const [age, heat] of memoriesByAge) {
    const binIdx = Math.max(0, Math.floor(age / binWidthHours));
    if (!bins.has(binIdx)) bins.set(binIdx, []);
    bins.get(binIdx)!.push(heat);
  }

  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, heats]) => [
      idx * binWidthHours + binWidthHours / 2,
      heats.reduce((s, v) => s + v, 0) / heats.length,
    ]);
}

const DEGENERATE_RESULT: ForgettingCurveResult = {
  curve_type: "degenerate",
  r_squared: 0,
  fit_quality: "degenerate" as never,
  half_life_hours: 0,
  retention_at_24h: 0,
};

function olsSums(
  logHeats: Array<[number, number]>,
): [number, number, number, number, number] {
  const n = logHeats.length;
  const sumX = logHeats.reduce((s, [t]) => s + t, 0);
  const sumY = logHeats.reduce((s, [, y]) => s + y, 0);
  const sumXY = logHeats.reduce((s, [t, y]) => s + t * y, 0);
  const sumX2 = logHeats.reduce((s, [t]) => s + t * t, 0);
  return [n, sumX, sumY, sumXY, sumX2];
}

/**
 * Bucket r² into a consumer-friendly quality label.
 *
 * Thresholds:
 *   r² < 0.10 → "poor"  — model explains < 10% of variance
 *   r² < 0.50 → "weak"  — some signal, oversimplification
 *   else      → "good"  — explains >= 50% of variance
 *
 * source: cortex main mcp_server/core/emergence_metrics.py:103-121
 */
function fitQualityFor(rSquared: number): "poor" | "weak" | "good" {
  if (rSquared < 0.1) return "poor";
  if (rSquared < 0.5) return "weak";
  return "good";
}

/**
 * Fit log-linear regression: log(heat) = log(a) - b * age via OLS.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py:63-100
 */
function fitLogLinear(logHeats: Array<[number, number]>): ForgettingCurveResult {
  const [n, sumX, sumY, sumXY, sumX2] = olsSums(logHeats);

  const denom = n * sumX2 - sumX ** 2;
  if (Math.abs(denom) < 1e-10) return { ...DEGENERATE_RESULT };

  const b = -(n * sumXY - sumX * sumY) / denom;
  const logA = (sumY + b * sumX) / n;
  const a = Math.exp(logA);

  const meanY = sumY / n;
  const ssTot = logHeats.reduce((s, [, y]) => s + (y - meanY) ** 2, 0);
  const ssRes = logHeats.reduce(
    (s, [t, y]) => s + (y - (logA - b * t)) ** 2,
    0,
  );
  const r2 = 1.0 - ssRes / Math.max(ssTot, 1e-10);
  const r2Clamped = Math.max(0, r2);

  const halfLife = b > 0 ? Math.log(2) / Math.max(b, 1e-10) : Infinity;
  const retention24h = b > 0 ? a * Math.exp(-b * 24) : a;

  return {
    curve_type: "exponential",
    r_squared: Math.round(r2Clamped * 10000) / 10000,
    fit_quality: fitQualityFor(r2Clamped),
    half_life_hours: Math.round(Math.min(halfLife, 10000) * 10) / 10,
    retention_at_24h: Math.round(Math.max(0, Math.min(1, retention24h)) * 10000) / 10000,
    decay_rate: Math.round(b * 1e6) / 1e6,
    initial_retention: Math.round(Math.min(a, 1) * 10000) / 10000,
  };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface ForgettingCurveResult {
  curve_type: string;
  r_squared: number;
  fit_quality: "poor" | "weak" | "good" | "insufficient_data" | "degenerate";
  half_life_hours: number;
  retention_at_24h: number;
  decay_rate?: number;
  initial_retention?: number;
}

const INSUFFICIENT: ForgettingCurveResult = {
  curve_type: "insufficient_data",
  r_squared: 0,
  fit_quality: "insufficient_data",
  half_life_hours: 0,
  retention_at_24h: 0,
};

/**
 * Fit a forgetting curve to memory age vs heat data.
 *
 * Biology shows power-law forgetting: R(t) = a * t^(-b).
 * If Cortex's mechanisms produce a similar curve, the system behaves realistically.
 *
 * precondition: memoriesByAge is a list of (age_hours, heat) tuples
 * postcondition: r_squared in [0, 1]; half_life_hours >= 0
 *
 * source: cortex main mcp_server/core/emergence_metrics.py:133-171
 */
export function computeForgettingCurve(
  memoriesByAge: Array<[number, number]>,
): ForgettingCurveResult {
  if (memoriesByAge.length < 5) return { ...INSUFFICIENT };

  const binMeans = binMemoriesByAge(memoriesByAge);
  return forgettingFromBinMeans(binMeans, memoriesByAge.length);
}

/**
 * Fit the curve from already-binned (center, mean_heat) data.
 *
 * Shared by computeForgettingCurve (list path) and the streaming emergence
 * report, which accumulates the bins online and so never holds the raw point
 * set.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
function forgettingFromBinMeans(
  binMeans: Array<[number, number]>,
  nPoints: number,
): ForgettingCurveResult {
  if (nPoints < 5) return { ...INSUFFICIENT };
  if (binMeans.length < 3) {
    return {
      curve_type: "insufficient_bins",
      r_squared: 0,
      fit_quality: "insufficient_data",
      half_life_hours: 0,
      retention_at_24h: 0,
    };
  }

  const logHeats: Array<[number, number]> = binMeans
    .filter(([, h]) => h > 0.01)
    .map(([t, h]) => [t, Math.log(Math.max(h, 0.01))]);

  if (logHeats.length < 3) {
    return {
      curve_type: "no_fit",
      r_squared: 0,
      fit_quality: "insufficient_data",
      half_life_hours: 0,
      retention_at_24h: 0,
    };
  }

  return fitLogLinear(logHeats);
}

/**
 * Convert online bin_idx -> [heat_sum, count] to sorted bin means.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
function binsToMeans(bins: Map<number, [number, number]>): Array<[number, number]> {
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, [, cnt]]) => cnt > 0)
    .map(([idx, [hs, cnt]]) => [idx * 6.0 + 3.0, hs / cnt]);
}

// ── Aggregate Report ──────────────────────────────────────────────────────────

interface MemoryForReport {
  hours_in_stage?: number;
  heat?: number;
  schema_match_score?: number;
  theta_phase_at_encoding?: number;
  consolidation_stage?: string;
  interference_score?: number;
}

export interface EmergenceReport {
  timestamp: string;
  memory_count: number;
  forgetting_curve: ForgettingCurveResult;
  schema_acceleration: SchemaAccelerationResult;
  phase_locking: PhaseLockingResult;
  stage_distribution: Record<string, number>;
  avg_interference: number;
}

interface SchemaCohort {
  count: number;
  consolidated: number;
  time_sum: number;
}

interface PhaseAgg {
  count: number;
  heat_sum: number;
  alive: number;
}

/**
 * Generate a full emergence report from an in-memory list.
 *
 * Thin wrapper over generateEmergenceReportStreamed (one chunk) so the list
 * path and the streaming path can never diverge.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
export function generateEmergenceReport(
  memories: MemoryForReport[],
  events: unknown[] | null = null,
): EmergenceReport {
  return generateEmergenceReportStreamed([memories], events);
}

/**
 * schema-acceleration metric from streamed cohort aggregates.
 *
 * Mirrors emergence_tracker.compute_schema_acceleration_metric exactly, but
 * from {count, consolidated, time_sum} per cohort instead of two lists.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
function schemaAccelerationFromAgg(
  cons: SchemaCohort,
  incons: SchemaCohort,
): SchemaAccelerationResult {
  const cCount = cons.count;
  const iCount = incons.count;
  const cTime = cons.consolidated ? cons.time_sum / cons.consolidated : Infinity;
  const iTime = incons.consolidated ? incons.time_sum / incons.consolidated : Infinity;

  let ratioDefined = true;
  let reason = "";
  let ratio: number;
  if (cCount === 0) {
    ratioDefined = false;
    reason = "no_schemas_promoted_yet";
    ratio = 1.0;
  } else if (iCount === 0) {
    ratioDefined = false;
    reason = "no_baseline_population";
    ratio = 1.0;
  } else if (iTime > 0 && cTime < Infinity) {
    ratio = iTime / Math.max(cTime, 0.1);
  } else {
    ratioDefined = false;
    reason = "no_consolidated_memories";
    ratio = 1.0;
  }

  const out: SchemaAccelerationResult = {
    consistent_count: cCount,
    inconsistent_count: iCount,
    consistent_consolidated_fraction:
      Math.round((cCount ? cons.consolidated / cCount : 0.0) * 10000) / 10000,
    inconsistent_consolidated_fraction:
      Math.round((iCount ? incons.consolidated / iCount : 0.0) * 10000) / 10000,
    acceleration_ratio: Math.round(ratio * 10000) / 10000,
    ratio_defined: ratioDefined,
  };
  if (reason) {
    out.reason_for_undefined = reason;
  }
  return out;
}

/**
 * phase-locking metric from streamed per-phase aggregates.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
function phaseLockingFromAgg(enc: PhaseAgg, ret: PhaseAgg): PhaseLockingResult {
  const avg = (d: PhaseAgg): number => (d.count ? d.heat_sum / d.count : 0.0);
  const surv = (d: PhaseAgg): number => (d.count ? d.alive / d.count : 0.0);

  const encHeat = avg(enc);
  const retHeat = avg(ret);
  return {
    encoding_phase_count: enc.count,
    retrieval_phase_count: ret.count,
    encoding_phase_avg_heat: Math.round(encHeat * 10000) / 10000,
    retrieval_phase_avg_heat: Math.round(retHeat * 10000) / 10000,
    phase_benefit: Math.round((encHeat - retHeat) * 10000) / 10000,
    encoding_phase_survival: Math.round(surv(enc) * 10000) / 10000,
    retrieval_phase_survival: Math.round(surv(ret) * 10000) / 10000,
  };
}

/**
 * Constant-memory emergence report: one streaming pass of bounded reducers.
 *
 * Every metric in the legacy report is an aggregate (binned forgetting curve,
 * schema/phase cohort sums, stage counts, interference mean), so the whole
 * report needs only O(num_bins + num_stages) RAM regardless of corpus size.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
export function generateEmergenceReportStreamed(
  memoryChunks: Iterable<MemoryForReport[]>,
  events: unknown[] | null = null,
): EmergenceReport {
  void events;
  const bins = new Map<number, [number, number]>(); // bin_idx -> [heat_sum, count]
  let nAge = 0;
  const cons: SchemaCohort = { count: 0, consolidated: 0, time_sum: 0.0 };
  const incons: SchemaCohort = { count: 0, consolidated: 0, time_sum: 0.0 };
  const enc: PhaseAgg = { count: 0, heat_sum: 0.0, alive: 0 };
  const ret: PhaseAgg = { count: 0, heat_sum: 0.0, alive: 0 };
  const stageDist: Record<string, number> = {};
  let interferenceSum = 0.0;
  let total = 0;

  for (const chunk of memoryChunks) {
    for (const m of chunk) {
      total += 1;
      const heat = m.heat ?? 0;
      if (heat > 0.01) {
        const idx = Math.max(0, Math.floor(((m.hours_in_stage ?? 0) + 1.0) / 6.0));
        let bucket = bins.get(idx);
        if (!bucket) {
          bucket = [0.0, 0];
          bins.set(idx, bucket);
        }
        bucket[0] += heat;
        bucket[1] += 1;
        nAge += 1;
      }
      const score = m.schema_match_score ?? 0;
      const consolidated = m.consolidation_stage === "consolidated";
      if (score >= 0.5) {
        foldSchemaCohort(cons, m, consolidated);
      } else if (score < 0.3) {
        foldSchemaCohort(incons, m, consolidated);
      }
      const phase = (m.theta_phase_at_encoding ?? 0) < 0.5 ? enc : ret;
      phase.count += 1;
      phase.heat_sum += m.heat ?? 0;
      if ((m.heat ?? 0) >= 0.1) {
        phase.alive += 1;
      }
      const stage = m.consolidation_stage ?? "unknown";
      stageDist[stage] = (stageDist[stage] ?? 0) + 1;
      interferenceSum += m.interference_score ?? 0;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    memory_count: total,
    forgetting_curve: forgettingFromBinMeans(binsToMeans(bins), nAge),
    schema_acceleration: schemaAccelerationFromAgg(cons, incons),
    phase_locking: phaseLockingFromAgg(enc, ret),
    stage_distribution: stageDist,
    avg_interference: Math.round((interferenceSum / Math.max(total, 1)) * 10000) / 10000,
  };
}

/**
 * Fold one memory into a schema cohort aggregate.
 *
 * source: cortex main mcp_server/core/emergence_metrics.py
 */
function foldSchemaCohort(
  cohort: SchemaCohort,
  mem: MemoryForReport,
  consolidated: boolean,
): void {
  cohort.count += 1;
  if (consolidated) {
    cohort.consolidated += 1;
    cohort.time_sum += (mem.hours_in_stage ?? 0) + 24.0;
  }
}
