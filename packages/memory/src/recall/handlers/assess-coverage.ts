/**
 * assess-coverage.ts — knowledge completeness evaluation.
 *
 * Evaluates how well the memory store covers the current codebase/project
 * across five axes:
 *   1. File coverage (memories scoped to the project directory)
 *   2. Domain balance (distribution across detected domains)
 *   3. Age distribution (fresh vs stale)
 *   4. Entity density (richness signal)
 *   5. Compression ratio (content loss signal)
 *
 * Returns a 0-100 coverage score and actionable recommendations.
 *
 * Port of: mcp_server/handlers/assess_coverage.py
 *
 * Correctness contract:
 *   pre:  store is a connected MemoryStore with memories + entities tables.
 *   post: returns { coverage_score ∈ [0,100], total_memories, age_distribution,
 *                   entity_density, compression, domain_balance, recommendations,
 *                   directory, domain }.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py
 */

import type { MemoryStore as RecallMemoryStore } from "../port.js";

// ── Constants ─────────────────────────────────────────────────────────────────
// source: parity with mcp_server/handlers/assess_coverage.py

// Milliseconds in one day: 24 * 60 * 60 * 1000.
// source: parity with mcp_server/handlers/assess_coverage.py:91 (timedelta(days=stale_days) converted to ms)
const MILLIS_PER_DAY = 86_400_000;

// Divisor used to derive the fresh-cutoff from stale_days (stale_days // 3).
const FRESH_DIVISOR = 3;

// Rounding multiplier for ratios rounded to 3 decimal places.
const RATIO_ROUNDING_FACTOR = 1000; // source: parity with mcp_server/handlers/assess_coverage.py:118 — round(ratio, 3) → 10^3

// Rounding multiplier for averages rounded to 2 decimal places.
const AVG_ROUNDING_FACTOR = 100; // source: parity with mcp_server/handlers/assess_coverage.py:134 — round(avg, 2) → 10^2

// Denominator for quantity score: memories / 100 capped at 1.
const SCORE_QUANTITY_DIVISOR = 100; // source: parity with mcp_server/handlers/assess_coverage.py:186 — total_memories / 100

// Denominator for entity score: entity_density / 3.0 capped at 1.
const SCORE_ENTITY_DIVISOR = 3.0;

// Weight for compression penalty in coverage score formula.
const SCORE_COMPRESSION_WEIGHT = 0.3;

// Weights for coverage score sub-signals.
// source: parity with mcp_server/handlers/assess_coverage.py:191-196
const SCORE_QUANTITY_WEIGHT = 0.30;
const SCORE_FRESHNESS_WEIGHT = 0.25; // source: parity with mcp_server/handlers/assess_coverage.py:192
const SCORE_ENTITY_WEIGHT = 0.20; // source: parity with mcp_server/handlers/assess_coverage.py:193
const SCORE_BALANCE_WEIGHT = 0.15; // source: parity with mcp_server/handlers/assess_coverage.py:194
const SCORE_BASE_OFFSET = 0.10; // source: parity with mcp_server/handlers/assess_coverage.py:196

// Multiplier to convert [0,1] raw score to [0,100] integer.
const SCORE_SCALE = 100; // source: parity with mcp_server/handlers/assess_coverage.py:198 — min(100, raw * 100)

// Memory count below which bootstrap is recommended.
const BOOTSTRAP_MEMORY_THRESHOLD = 20;

// Fraction of stale memories above which validate_memory is recommended.
const STALE_FRACTION_THRESHOLD = 0.4;

// Entity density below which a low-density warning is emitted.
const LOW_ENTITY_DENSITY_THRESHOLD = 0.5;

// Fraction of compressed memories above which re-seeding is recommended.
const HIGH_COMPRESSION_FRACTION_THRESHOLD = 0.5;

// Balance score below which unbalanced-domain warning is emitted.
const LOW_BALANCE_SCORE_THRESHOLD = 0.4;

// Default stale_days threshold (days since last access to count as stale).
const DEFAULT_STALE_DAYS = 14;

// Maximum number of memories fetched when scoping by domain or globally.
const MEMORY_FETCH_LIMIT = 1000; // source: parity with mcp_server/handlers/assess_coverage.py:241 — limit=1000

// Example values used in the stale_days schema examples array.
const SCHEMA_EXAMPLE_STALE_DAYS_SHORT = 7;
const SCHEMA_EXAMPLE_STALE_DAYS_LONG = 30;

// ── Schema ────────────────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/assess_coverage.py schema

export const schema = {
  title: "Assess coverage",
  description:
    "Score how well the memory store covers a project across five axes: " +
    "file coverage (which key files are remembered), domain balance (per-domain " +
    "memory distribution), age distribution (fresh vs stale), entity density " +
    "(richness signal), and compression ratio (loss signal). Combines into a " +
    "0-100 coverage score and emits actionable recommendations. Use this before " +
    "claiming Cortex `knows` a codebase, or as a milestone-completion check. " +
    "Distinct from `detect_gaps` (lists specific missing connections, no aggregate " +
    "score), `memory_stats` (raw counts, no scoring), and `narrative` (prose " +
    "summary, no numeric coverage). Read-only.",
  inputSchema: {
    type: "object",
    required: [],
    properties: {
      directory: {
        type: "string",
        description:
          "Absolute project directory to assess. Defaults to current working directory.",
        examples: ["/Users/alice/code/cortex"],
      },
      domain: {
        type: "string",
        description:
          "Cognitive domain to assess when 'directory' is not supplied.",
        examples: ["cortex", "auth-service"],
      },
      stale_days: {
        type: "integer",
        description:
          "Days since last access for a memory to count as stale in the age-distribution score.",
        default: 14,
        minimum: 1,
        maximum: 365,
        examples: [SCHEMA_EXAMPLE_STALE_DAYS_SHORT, DEFAULT_STALE_DAYS, SCHEMA_EXAMPLE_STALE_DAYS_LONG],
      },
    },
  },
} as const;

// ── Sub-evaluators ────────────────────────────────────────────────────────────

interface AgeDistribution {
  fresh: number;
  stale: number;
  total: number;
  freshness_ratio: number;
}

/**
 * Compute age distribution: fresh vs stale memories.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:_age_distribution
 */
function ageDistribution(
  memories: Array<{ created_at?: string | null }>,
  staleDays: number,
): AgeDistribution {
  const now = Date.now();
  const staleMs = staleDays * MILLIS_PER_DAY;
  const freshMs = (staleDays / FRESH_DIVISOR) * MILLIS_PER_DAY; // source: assess_coverage.py:92 — Python uses stale_days // 3 (floor); TS port uses float division (pre-existing divergence, tracked for parity follow-up)

  let fresh = 0;
  let stale = 0;
  let total = 0;

  for (const mem of memories) {
    const raw = mem.created_at ?? "";
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) continue;
    total += 1;
    const age = now - parsed;
    if (age <= freshMs) {
      fresh += 1;
    } else if (age > staleMs) {
      stale += 1;
    }
  }

  if (total === 0) {
    return { fresh: 0, stale: 0, total: 0, freshness_ratio: 0.0 };
  }

  return {
    fresh,
    stale,
    total,
    freshness_ratio: Math.round((fresh / total) * RATIO_ROUNDING_FACTOR) / RATIO_ROUNDING_FACTOR,
  };
}

interface EntityDensityResult {
  avg_entities_per_memory: number;
  total_entities: number;
}

/**
 * Compute average entity count per memory (richness).
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:_entity_density
 */
async function entityDensity(
  memories: unknown[],
  store: RecallMemoryStore,
): Promise<EntityDensityResult> {
  if (memories.length === 0) {
    return { avg_entities_per_memory: 0.0, total_entities: 0 };
  }
  try {
    const allEntities = (await store.getEntities?.()) ?? [];
    const total = allEntities.length;
    const avg = total / memories.length;
    return {
      avg_entities_per_memory: Math.round(avg * AVG_ROUNDING_FACTOR) / AVG_ROUNDING_FACTOR,
      total_entities: total,
    };
  } catch {
    return { avg_entities_per_memory: 0.0, total_entities: 0 };
  }
}

interface CompressionResult {
  compressed: number;
  total: number;
  ratio: number;
}

/**
 * Measure how much content has been compressed.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:_compression_ratio
 */
function compressionRatio(
  memories: Array<{ compression_level?: number | null }>,
): CompressionResult {
  if (memories.length === 0) {
    return { compressed: 0, total: 0, ratio: 0.0 };
  }
  const compressed = memories.filter((m) => (m.compression_level ?? 0) > 0).length;
  return {
    compressed,
    total: memories.length,
    ratio: Math.round((compressed / memories.length) * RATIO_ROUNDING_FACTOR) / RATIO_ROUNDING_FACTOR,
  };
}

interface DomainBalanceResult {
  domains: Record<string, number>;
  balance_score: number;
}

/**
 * Evaluate how evenly distributed memories are across domains.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:_domain_balance
 */
function domainBalance(
  memories: Array<{ domain?: string | null }>,
): DomainBalanceResult {
  const domainCounts: Record<string, number> = {};
  for (const mem of memories) {
    const d = mem.domain || "unassigned";
    domainCounts[d] = (domainCounts[d] ?? 0) + 1;
  }

  if (Object.keys(domainCounts).length === 0) {
    return { domains: {}, balance_score: 0.0 };
  }

  const counts = Object.values(domainCounts);
  const avg = counts.reduce((s, c) => s + c, 0) / counts.length;

  let balanceScore = 0.0;
  if (avg > 0) {
    const variance = counts.reduce((s, c) => s + (c - avg) ** 2, 0) / counts.length;
    const cv = Math.sqrt(variance) / avg;
    balanceScore = Math.max(0.0, 1.0 - cv);
  }

  return {
    domains: domainCounts,
    balance_score: Math.round(balanceScore * RATIO_ROUNDING_FACTOR) / RATIO_ROUNDING_FACTOR,
  };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Compute 0-100 coverage score from sub-signals.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:_compute_coverage_score
 */
function computeCoverageScore(
  totalMemories: number,
  freshnessRatio: number,
  entityDensityAvg: number,
  compressionRatioVal: number,
  balanceScore: number,
): number {
  // source: parity with mcp_server/handlers/assess_coverage.py:186-198
  const quantityScore = Math.min(1.0, totalMemories / SCORE_QUANTITY_DIVISOR);
  const entityScore = Math.min(1.0, entityDensityAvg / SCORE_ENTITY_DIVISOR);
  const compressionPenalty = compressionRatioVal * SCORE_COMPRESSION_WEIGHT;

  const raw =
    quantityScore * SCORE_QUANTITY_WEIGHT +
    freshnessRatio * SCORE_FRESHNESS_WEIGHT +
    entityScore * SCORE_ENTITY_WEIGHT +
    balanceScore * SCORE_BALANCE_WEIGHT -
    compressionPenalty +
    SCORE_BASE_OFFSET;

  return Math.max(0, Math.min(SCORE_SCALE, Math.floor(raw * SCORE_SCALE)));
}

// ── Recommendations ───────────────────────────────────────────────────────────

/**
 * Generate actionable recommendations based on the coverage signals.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:_recommendations
 */
function buildRecommendations(
  total: number,
  stale: number,
  entityDensityAvg: number,
  compressed: number,
  balanceScore: number,
): string[] {
  const recs: string[] = [];

  if (total < BOOTSTRAP_MEMORY_THRESHOLD) {
    recs.push("Run `seed_project` to bootstrap memory from the codebase.");
  }
  if (stale > total * STALE_FRACTION_THRESHOLD) {
    recs.push("Run `validate_memory` — more than 40% of memories are stale.");
  }
  if (entityDensityAvg < LOW_ENTITY_DENSITY_THRESHOLD) {
    recs.push("Low entity density. Use `remember` with more specific content.");
  }
  if (compressed > total * HIGH_COMPRESSION_FRACTION_THRESHOLD) {
    recs.push("High compression ratio — consider re-seeding with `seed_project`.");
  }
  if (balanceScore < LOW_BALANCE_SCORE_THRESHOLD) {
    recs.push(
      "Unbalanced domain coverage. Use `remember` with explicit `domain` tags.",
    );
  }
  if (recs.length === 0) {
    recs.push(
      "Coverage looks healthy. Run `consolidate` periodically to maintain quality.",
    );
  }

  return recs;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export interface AssessCoverageResult {
  coverage_score: number;
  total_memories: number;
  age_distribution?: AgeDistribution;
  entity_density?: EntityDensityResult;
  compression?: CompressionResult;
  domain_balance?: DomainBalanceResult;
  recommendations: string[];
  directory?: string;
  domain?: string;
}

/**
 * Assess knowledge coverage completeness.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:handler
 */
export async function assessCoverageHandler(
  args: Record<string, unknown> | null | undefined,
  store: RecallMemoryStore,
): Promise<AssessCoverageResult> {
  const a = args ?? {};
  const directory = String(a["directory"] ?? "").trim();
  const domain = String(a["domain"] ?? "").trim();
  // INTENTIONAL DIVERGENCE from Python source (assess_coverage.py:291): Python does not apply
  // Math.max(1, ...) here because the schema already declares minimum:1 and the Python handler
  // trusts schema validation upstream. The TS port adds this defensive clamp to match the schema
  // contract at the handler boundary, preventing negative or zero stale_days from reaching
  // ageDistribution() if args bypass schema validation.
  const staleDays = Math.max(1, Number(a["stale_days"] ?? DEFAULT_STALE_DAYS));

  // Fetch memories scoped by directory, domain, or global
  let memories: Awaited<ReturnType<typeof store.getHotMemories>> = [];
  try {
    if (directory) {
      memories = await store.getMemoriesForDirectory(directory, 0.0);
    } else if (domain) {
      memories = await store.getMemoriesForDomain(domain, 0.0, MEMORY_FETCH_LIMIT);
    } else {
      memories = await store.getHotMemories(0.0, MEMORY_FETCH_LIMIT);
    }
  } catch {
    memories = [];
  }

  if (memories.length === 0) {
    return {
      coverage_score: 0,
      total_memories: 0,
      recommendations: ["No memories found. Run `seed_project` to bootstrap."],
      directory: directory || undefined,
      domain: domain || undefined,
    };
  }

  const ageDist = ageDistribution(memories, staleDays);
  const densityResult = await entityDensity(memories, store);
  const compressResult = compressionRatio(
    memories.map((m) => ({ compression_level: (m as unknown as Record<string, unknown>)["compression_level"] as number | null })),
  );
  const balanceResult = domainBalance(
    memories.map((m) => ({ domain: m.domain ?? null })),
  );

  const score = computeCoverageScore(
    memories.length,
    ageDist.freshness_ratio,
    densityResult.avg_entities_per_memory,
    compressResult.ratio,
    balanceResult.balance_score,
  );

  const recs = buildRecommendations(
    memories.length,
    ageDist.stale,
    densityResult.avg_entities_per_memory,
    compressResult.compressed,
    balanceResult.balance_score,
  );

  return {
    coverage_score: score,
    total_memories: memories.length,
    age_distribution: ageDist,
    entity_density: densityResult,
    compression: compressResult,
    domain_balance: balanceResult,
    recommendations: recs,
    directory: directory || undefined,
    domain: domain || undefined,
  };
}
