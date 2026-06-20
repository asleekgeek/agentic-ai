/**
 * Zod schemas and TypeScript types for the recall subsystem.
 *
 * Port of: mcp_server/handlers/recall.py (schema block)
 *          mcp_server/core/retrieval_signals.py
 *          mcp_server/core/scoring.py
 *          mcp_server/shared/types.py (MemoryItem fields)
 */

import { z } from "zod";

// ── Query Intent ───────────────────────────────────────────────────────────
// Port of: mcp_server/core/query_intent.py QueryIntent class

export const QueryIntent = {
  TEMPORAL: "temporal",
  CAUSAL: "causal",
  SEMANTIC: "semantic",
  ENTITY: "entity",
  KNOWLEDGE_UPDATE: "knowledge_update",
  MULTI_HOP: "multi_hop",
  INSTRUCTION: "instruction",
  EVENT_ORDER: "event_order",
  SUMMARIZATION: "summarization",
  PREFERENCE: "preference",
  GENERAL: "general",
} as const;

export type QueryIntentValue = (typeof QueryIntent)[keyof typeof QueryIntent];

export const QueryIntentSchema = z.enum([
  "temporal",
  "causal",
  "semantic",
  "entity",
  "knowledge_update",
  "multi_hop",
  "instruction",
  "event_order",
  "summarization",
  "preference",
  "general",
]);

// ── Schema bounds ──────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/handlers/recall.py schema
const MAX_RESULTS_LIMIT = 100;
const MAX_RESULTS_DEFAULT = 10;
const MIN_HEAT_DEFAULT = 0.05; // source: cortex@ed33435 mcp_server/handlers/recall.py schema
const DEFAULT_IMPORTANCE = 0.5; // source: cortex@ed33435 mcp_server/shared/types.py — default importance
// source: cortex@ed33435 mcp_server/handlers/recall_hierarchical.py schema
const MEMORY_IDS_MAX = 5000;
const CLUSTER_THRESHOLD_DEFAULT = 0.6;

// ── Recall request ─────────────────────────────────────────────────────────

export const RecallRequestSchema = z.object({
  query: z.string().min(1),
  domain: z.string().optional(),
  directory: z.string().optional(),
  max_results: z.number().int().min(1).max(MAX_RESULTS_LIMIT).default(MAX_RESULTS_DEFAULT),
  min_heat: z.number().min(0).max(1).default(MIN_HEAT_DEFAULT),
  agent_topic: z.string().optional(),
  // Default false: drop memories tagged as auto-captures (``auto-captured``,
  // ``tool:edit``, ``_backfill``, ``stage-N``, ``session-summary``, …) so
  // curated content (ADRs, lessons, conventions) surfaces in the first
  // few results. Set true for debugging / replay tooling that needs the
  // raw memory feed.
  // source: cortex@f425157 mcp_server/handlers/recall.py — include_low_signal default=False
  include_low_signal: z.boolean().default(false),
  // Default false: when true, inline a one-hop relation walk per recalled
  // memory: ``related.versions`` (supersession-chain neighbors) and
  // ``related.entities`` (directly related entities via the knowledge graph).
  // A cheap mid-tier enrichment between flat recall and the full context
  // assembler. OFF in all benchmark loaders — never touches benchmarked scores.
  // source: cortex@6fbf723d mcp_server/handlers/recall.py — include_related default=False
  // source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:inline_related_neighbors
  include_related: z.boolean().optional().default(false),
});

export type RecallRequest = z.infer<typeof RecallRequestSchema>;

// ── Inline relation-walk types (MEM-G4) ───────────────────────────────────
// source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:_version_neighbors
// source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:_entity_neighbors
// source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:inline_related_neighbors

export const VersionNeighborSchema = z.object({
  memory_id: z.number().int(),
  // "supersedes" | "superseded_by"
  edge: z.string(),
  // first 160 chars of neighbor content
  // source: cortex@6fbf723d recall_helpers.py:_GIST_CHARS = 160
  gist: z.string(),
});

export type VersionNeighbor = z.infer<typeof VersionNeighborSchema>;

export const EntityNeighborGroupSchema = z.object({
  entity: z.string(),
  neighbors: z.array(
    z.object({
      name: z.string().optional(),
      relationship_type: z.string().optional(),
      weight: z.number().optional(),
    }),
  ),
});

export type EntityNeighborGroup = z.infer<typeof EntityNeighborGroupSchema>;

export const RelatedNeighborsSchema = z.object({
  versions: z.array(VersionNeighborSchema),
  entities: z.array(EntityNeighborGroupSchema),
});

export type RelatedNeighbors = z.infer<typeof RelatedNeighborsSchema>;

// ── Single result entry ────────────────────────────────────────────────────

export const RecallResultSchema = z.object({
  memory_id: z.number().int(),
  content: z.string(),
  score: z.number(),
  heat: z.number(),
  domain: z.string(),
  tags: z.array(z.string()),
  store_type: z.string().default("episodic"),
  created_at: z.string(),
  importance: z.number().default(DEFAULT_IMPORTANCE),
  surprise: z.number().default(0.0),
  recency_boost: z.number().default(0.0),
  // Present only when include_related=true (MEM-G4).
  // source: cortex@6fbf723d mcp_server/handlers/recall_helpers.py:inline_related_neighbors
  related: RelatedNeighborsSchema.optional(),
});

export type RecallResult = z.infer<typeof RecallResultSchema>;

// ── Multi-signal signal collection ────────────────────────────────────────
// Port of: mcp_server/handlers/recall_helpers.py collect_signals()

export const MultiSignalSignalsSchema = z.object({
  vector: z.array(z.tuple([z.number().int(), z.number()])),
  fts: z.array(z.tuple([z.number().int(), z.number()])),
  heat: z.array(z.tuple([z.number().int(), z.number()])),
  bm25: z.array(z.tuple([z.number().int(), z.number()])),
  ngram: z.array(z.tuple([z.number().int(), z.number()])),
  // Hopfield/HDC/SR/SA signals are populated only by the Python/PG path
  // (pg_recall_hopfield et al. stored procedures). The TS path leaves these
  // empty and fuses on vector+fts+heat+bm25+ngram.
  // source: cortex@ed33435 mcp_server/core/pg_recall.py:recall
  hopfield: z.array(z.tuple([z.number().int(), z.number()])).default([]),
  hdc: z.array(z.tuple([z.number().int(), z.number()])).default([]),
  sr: z.array(z.tuple([z.number().int(), z.number()])).default([]),
  sa: z.array(z.tuple([z.number().int(), z.number()])).default([]),
});

export type MultiSignalSignals = z.infer<typeof MultiSignalSignalsSchema>;

// ── Enhancements metadata ──────────────────────────────────────────────────

export const RecallEnhancementsSchema = z.object({
  query_expanded: z.boolean(),
  multihop_applied: z.boolean(),
  reranked: z.boolean(),
  knowledge_update_boost: z.boolean(),
  strategic_ordering: z.boolean(),
});

export type RecallEnhancements = z.infer<typeof RecallEnhancementsSchema>;

// ── Recall response ────────────────────────────────────────────────────────

export const RecallResponseSchema = z.object({
  results: z.array(RecallResultSchema),
  total: z.number().int(),
  query_intent: QueryIntentSchema,
  dispatch_tier: z.string(),
  signals: z.record(z.unknown()).default({}),
  enhancements: RecallEnhancementsSchema.optional(),
  // Number of memories filtered as low-signal (auto-captures, backfill
  // imports, stage reports). Surfaced so callers see how much was
  // dropped — useful for debugging "why didn't I get the result I expected".
  // source: cortex@f425157 mcp_server/handlers/recall.py — low_signal_dropped
  low_signal_dropped: z.number().int().default(0),
});

export type RecallResponse = z.infer<typeof RecallResponseSchema>;

// ── Retrieval signal weight map ────────────────────────────────────────────

export const SignalWeightsSchema = z.object({
  vector: z.number(),
  fts: z.number(),
  heat: z.number(),
  temporal: z.number().default(0),
  causal: z.number().default(0),
  entity: z.number().default(0),
  spreading: z.number().default(0),
});

export type SignalWeights = z.infer<typeof SignalWeightsSchema>;

// ── PG-path specific weights ───────────────────────────────────────────────

export const PgWeightsSchema = z.object({
  vector: z.number(),
  fts: z.number(),
  heat: z.number(),
  ngram: z.number(),
  recency: z.number(),
});

export type PgWeights = z.infer<typeof PgWeightsSchema>;

// ── Hierarchical recall request ────────────────────────────────────────────
// Port of: mcp_server/handlers/recall_hierarchical.py schema

export const HierarchicalRecallRequestSchema = z.object({
  query: z.string().min(1),
  domain: z.string().optional(),
  memory_ids: z.array(z.number().int().min(1)).max(MEMORY_IDS_MAX).optional(),
  max_results: z.number().int().min(1).max(MAX_RESULTS_LIMIT).default(MAX_RESULTS_DEFAULT),
  min_heat: z.number().min(0).max(1).default(MIN_HEAT_DEFAULT),
  cluster_threshold: z.number().min(0).max(1).default(CLUSTER_THRESHOLD_DEFAULT),
});

export type HierarchicalRecallRequest = z.infer<
  typeof HierarchicalRecallRequestSchema
>;

// ── Hierarchical result ────────────────────────────────────────────────────

export const HierarchicalResultSchema = z.object({
  memory_id: z.number().int(),
  score: z.number(),
  matched_level: z.string(),
  level_scores: z.record(z.number()).default({}),
  content: z.string(),
  heat: z.number(),
  domain: z.string(),
  tags: z.array(z.string()),
  created_at: z.string(),
});

export type HierarchicalResult = z.infer<typeof HierarchicalResultSchema>;

// ── Hierarchical recall response ───────────────────────────────────────────

export const HierarchicalRecallResponseSchema = z.object({
  results: z.array(HierarchicalResultSchema),
  total: z.number().int(),
  query_word_count: z.number().int().optional(),
  level_weights: z.record(z.number()).optional(),
  hierarchy: z
    .object({
      stats: z.record(z.unknown()).optional(),
    })
    .optional(),
});

export type HierarchicalRecallResponse = z.infer<
  typeof HierarchicalRecallResponseSchema
>;

// ── Memory item for store operations ──────────────────────────────────────
// Minimal interface; full type owned by port/cortex-shared when merged.

export interface MemoryItem {
  id: number;
  content: string;
  heat: number;
  domain: string;
  tags: string[] | string;
  store_type: string;
  created_at: string;
  importance: number;
  surprise_score: number;
  embedding: number[] | null;
  memory_id?: number;
}
