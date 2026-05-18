/**
 * Handler: curate-wiki — emit authoring jobs the in-session LLM consumes.
 *
 * Composition root for the auto-curator (../auto-curator.ts).
 *
 * Architecture — why this returns jobs instead of authoring directly:
 *
 * The user's Claude Code session is itself the authoring LLM (Opus 4.7).
 * Rather than calling an external Anthropic API with a separate key
 * (the key is the user's session and exposing it via env is fragile),
 * this handler returns **structured authoring jobs** — clusters of PG
 * memories paired with the structured prompt the LLM should consume.
 * The in-session LLM reads the jobs, authors each page in turn, and
 * writes them via ``wiki_write``.
 *
 * That means the auto-curator's "auto" property comes from two things:
 *
 *   1. The clustering and prompt-construction work happens without a
 *      human deciding what to document — ``curate_wiki`` fetches
 *      recent high-heat clusters, derives topics, and constructs
 *      prompts that embed all the wiki conventions.
 *
 *   2. The trigger is automatic — ``consolidate`` runs the same job-
 *      enqueueing logic on its periodic cycle; ``session_start``
 *      surfaces pending curations to the in-session LLM. The user
 *      never asks for a specific page; the system notices what
 *      deserves documentation and proposes it.
 *
 * The user directive this satisfies (Cortex 2026-05-17):
 *   > "ALL ACTIONS SHOULD DOCUMENTED BY OPUS 4.7, IT'S NOT POSSIBLE THE
 *   > LLM IS NOT ABLE TO PRODUCE A DOCUMENTATION FROM AN ACCESS."
 *   > "The documentation you created now, should be auto created and
 *   > auto curated."
 *   > "the anthropic key should be using the user session"
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py
 */

import {
  buildClusters,
  buildJobs,
  MAX_MEMORIES_PER_PROMPT,
  MIN_AVG_HEAT_FOR_PAGE,
  MIN_MEMORIES_PER_CLUSTER,
  type CuratorMemory,
  type CurationCluster,
  type CurationJob,
} from "../auto-curator.js";

// source: cortex@47b818d mcp_server/handlers/curate_wiki.py — defaults
// for limit, recent_only, memory_pool_size.
const DEFAULT_LIMIT = 3; // source: cortex@47b818d mcp_server/handlers/curate_wiki.py:91 ("limit": {"default": 3})
const DEFAULT_RECENT_ONLY = true; // source: cortex@47b818d mcp_server/handlers/curate_wiki.py:107 ("recent_only": {"default": True})
const DEFAULT_MEMORY_POOL_SIZE = 500; // source: cortex@47b818d mcp_server/handlers/curate_wiki.py:114 ("memory_pool_size": {"default": 500})

// Minimum-pool-for-recent threshold: when the recently-accessed pool is
// too thin (< 2× min_memories), the handler falls back to a broader
// recent-by-creation pool.
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py:139 (`if len(memories) < min_memories * 2`)
const RECENT_POOL_FALLBACK_FACTOR = 2;

// ── Public types ────────────────────────────────────────────────────────

export interface CurateWikiArgs {
  readonly domain?: string;
  readonly limit?: number;
  readonly min_memories?: number;
  readonly min_avg_heat?: number;
  readonly recent_only?: boolean;
  readonly memory_pool_size?: number;
}

export interface CurationJobPayload {
  readonly suggested_path: string;
  readonly suggested_kind: string;
  readonly topic: string;
  readonly domain: string;
  readonly memory_count: number;
  readonly memory_ids: readonly number[];
  readonly top_entities: readonly string[];
  readonly avg_heat: number;
  readonly earliest_memory_at: string;
  readonly latest_memory_at: string;
  readonly related_pages: readonly string[];
  readonly prompt: string;
}

export interface CurateWikiResult {
  readonly jobs: readonly CurationJobPayload[];
  readonly total_clusters_eligible: number;
  readonly returned: number;
  readonly memory_pool_size: number;
  readonly domain_filter: string;
  readonly instructions: string;
}

export type CurateWikiResponse = CurateWikiResult | { readonly error: string };

/**
 * Dependencies for the curate-wiki handler.
 *
 * - ``getRecentlyAccessedMemories`` and ``getRecentMemories`` are
 *   thin adapters over the MemoryStore. ``getRecentMemories`` is the
 *   fallback when access logs are thin (fresh DB); when omitted, the
 *   handler uses ``getRecentlyAccessedMemories`` for both paths.
 * - ``listMdPages`` enumerates wiki pages (as rel paths, including
 *   ``.md``) so the handler can build a topic→[paths] index for
 *   ``[[wiki-link]]`` cross-referencing in the authoring prompt.
 */
export interface CurateWikiDeps {
  readonly wikiRoot: string;
  readonly getRecentlyAccessedMemories: (limit: number) => Promise<CuratorMemory[]>;
  readonly getRecentMemories?: (limit: number) => Promise<CuratorMemory[]>;
  readonly listMdPages: (root: string) => Promise<string[]>;
  /** Override for current-date injection in tests. Returns YYYY-MM-DD. */
  readonly today?: () => string;
}

// ── Existing-page topic index ───────────────────────────────────────────

// Slug-canonicalisation: drop ID prefix ("305772-"), drop kind prefix
// ("decision-", "lesson-", "convention-", "spec-", "reference-"), and
// drop the trailing "-md" that the original Cortex code happened to
// strip after extension removal.
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py::_scan_existing_pages:166-176
const ID_PREFIX_RE = /^\d+-/;
const KIND_PREFIX_RE = /^(decision|lesson|convention|spec|reference)-/;

function pageTopicKey(relPath: string): string | null {
  // Skip dot- and underscore-prefixed top-level dirs (e.g. ``.generated``).
  const parts = relPath.split("/");
  const first = parts[0] ?? "";
  if (!first || first.startsWith(".") || first.startsWith("_")) return null;
  const filename = parts[parts.length - 1] ?? "";
  const stem = filename.replace(/\.md$/, "");
  let slug = stem.replace(ID_PREFIX_RE, "");
  slug = slug.replace(KIND_PREFIX_RE, "");
  slug = slug.replace(/-md$/, "");
  return slug.toLowerCase();
}

/**
 * Build a topic→[paths] index of existing wiki pages.
 *
 * The auto-curator uses this to suggest cross-links via ``[[wiki/path]]``
 * notation in the authoring prompt. Topics are derived from the page
 * path's slug (last component, minus extension, minus ID prefix,
 * minus kind prefix).
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py::_scan_existing_pages
 */
export function scanExistingPages(relPaths: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const rel of relPaths) {
    const topic = pageTopicKey(rel);
    if (topic == null) continue;
    const pathStr = rel.replace(/\.md$/, "");
    const arr = index.get(topic) ?? [];
    arr.push(pathStr);
    index.set(topic, arr);
  }
  return index;
}

// ── Handler ────────────────────────────────────────────────────────────

function defaultToday(): string {
  return new Date().toISOString().slice(0, "YYYY-MM-DD".length);
}

async function fetchMemoryPool(
  deps: CurateWikiDeps,
  recentOnly: boolean,
  poolSize: number,
  minMemories: number,
): Promise<CuratorMemory[]> {
  if (!recentOnly && deps.getRecentMemories) {
    return await deps.getRecentMemories(poolSize);
  }
  const recent = await deps.getRecentlyAccessedMemories(poolSize);
  if (recent.length >= minMemories * RECENT_POOL_FALLBACK_FACTOR) return recent;
  // Recent-access pool too thin (fresh DB) — fall back to broader pool.
  if (deps.getRecentMemories) return await deps.getRecentMemories(poolSize);
  return recent;
}

// Top-N entities serialised per job. Matches the slice taken in the
// authoring prompt; the consumer sees a stable wire field.
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py:_serialise_job:"c.entities[:8]"
const TOP_ENTITIES_PER_JOB = 8;
// avg_heat is rounded to 3 decimals on the wire (1000 = 10^3).
// source: cortex@47b818d mcp_server/handlers/curate_wiki.py:_serialise_job:"round(c.avg_heat, 3)"
const HEAT_ROUND_PRECISION = 1000;

function serialiseJob(job: CurationJob): CurationJobPayload {
  const c = job.cluster;
  return {
    suggested_path:       c.suggested_path,
    suggested_kind:       c.suggested_kind,
    topic:                c.topic,
    domain:               c.domain,
    memory_count:         c.memory_ids.length,
    memory_ids:           c.memory_ids,
    top_entities:         c.entities.slice(0, TOP_ENTITIES_PER_JOB),
    avg_heat:             Math.round(c.avg_heat * HEAT_ROUND_PRECISION) / HEAT_ROUND_PRECISION,
    earliest_memory_at:   c.earliest_at,
    latest_memory_at:     c.latest_at,
    related_pages:        job.related_pages,
    prompt:               job.prompt,
  };
}

function instructionsForLlm(nJobs: number, nEligible: number): string {
  if (nJobs === 0) {
    return (
      `No curation jobs returned. ${nEligible} clusters were eligible. ` +
      "If you expected jobs, relax min_memories or min_avg_heat, or pass " +
      "recent_only=false."
    );
  }
  return (
    `Auto-curator returned ${nJobs} job(s) (of ${nEligible} eligible clusters). ` +
    "For each job in order:\n" +
    "  1. Read `prompt` — it contains the cluster's memories and the " +
    "authoring conventions.\n" +
    "  2. Author the page in Markdown following the conventions " +
    "(frontmatter → lead → sections with diagrams → 'why this not " +
    "alternatives' → 'what can go wrong' → 'see also' → primary " +
    "sources).\n" +
    "  3. Write the page via `wiki_write(path=<job.suggested_path>, " +
    "content=<your authored Markdown>, tags=['wiki', 'llm-authored', " +
    "<topic>, <domain>])`.\n" +
    "  4. Call `curate_wiki` again to fetch the next batch when this " +
    "batch is done.\n" +
    "Do not skip the structure — the conventions are how readers find " +
    "what they need across pages. Do not dump raw memory content; " +
    "synthesise. Each page should be 8-15 KB of substantive authored " +
    "prose, not a template."
  );
}

/**
 * Build authoring jobs from PG memory clusters.
 *
 * precondition:  deps.getRecentlyAccessedMemories and deps.listMdPages
 *                are live.
 * postcondition: returns up to ``limit`` curation jobs; each carries
 *                the full prompt the in-session LLM should author from.
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py::handler
 */
export async function handler(
  args: CurateWikiArgs,
  deps: CurateWikiDeps,
): Promise<CurateWikiResponse> {
  const limit          = args.limit ?? DEFAULT_LIMIT;
  const minMemories    = args.min_memories ?? MIN_MEMORIES_PER_CLUSTER;
  const minAvgHeat     = args.min_avg_heat ?? MIN_AVG_HEAT_FOR_PAGE;
  const recentOnly     = args.recent_only ?? DEFAULT_RECENT_ONLY;
  const memoryPoolSize = args.memory_pool_size ?? DEFAULT_MEMORY_POOL_SIZE;

  const memories = await fetchMemoryPool(deps, recentOnly, memoryPoolSize, minMemories);

  if (memories.length === 0) {
    return {
      jobs: [],
      total_clusters_eligible: 0,
      returned: 0,
      memory_pool_size: 0,
      domain_filter: args.domain ?? "(all)",
      instructions: "No memories available to curate. Use `remember` to seed.",
    };
  }

  const clusters: CurationCluster[] = buildClusters(memories, {
    ...(args.domain != null ? { domain: args.domain } : {}),
    min_memories: minMemories,
    min_avg_heat: minAvgHeat,
  });

  const relPaths = await deps.listMdPages(deps.wikiRoot);
  const existingPages = scanExistingPages(relPaths);
  const today = (deps.today ?? defaultToday)();
  const jobs = buildJobs(clusters, existingPages, today);
  const selected = jobs.slice(0, limit);
  const payload = selected.map(serialiseJob);

  return {
    jobs: payload,
    total_clusters_eligible: clusters.length,
    returned: payload.length,
    memory_pool_size: memories.length,
    domain_filter: args.domain ?? "(all)",
    instructions: instructionsForLlm(payload.length, clusters.length),
  };
}

// ── MCP schema (mirrors Cortex curate_wiki.schema) ─────────────────────

export const schema = {
  title: "Curate wiki",
  description: (
    "Auto-curator: returns structured authoring jobs the in-session " +
    "LLM (Opus 4.7) consumes to author curated wiki pages from PG " +
    "memory clusters. Each job carries one cluster's memories, the " +
    "suggested wiki path, a list of existing related pages for " +
    "cross-linking, and a complete structured prompt that encodes " +
    "the wiki documentation conventions (frontmatter, lead, diagrams, " +
    "'why this not the alternatives', 'what can go wrong', 'see also', " +
    "primary sources). The conversational LLM reads each job, authors " +
    "the page in Markdown, and writes it via `wiki_write`. No external " +
    "Anthropic API key required — the user's existing Claude Code " +
    "session is the authoring LLM."
  ),
  inputSchema: {
    type: "object",
    required: [] as const,
    properties: {
      domain: {
        type: "string",
        description: "Restrict curation to a single domain. Omit to curate across all domains.",
      },
      limit: {
        type: "integer",
        default: DEFAULT_LIMIT,
        minimum: 1,
        maximum: 20,
        description: "Maximum number of authoring jobs to return.",
      },
      min_memories: {
        type: "integer",
        default: MIN_MEMORIES_PER_CLUSTER,
        description: "Minimum memories per cluster to earn a page.",
      },
      min_avg_heat: {
        type: "number",
        default: MIN_AVG_HEAT_FOR_PAGE,
        description: "Minimum average effective_heat of cluster memories.",
      },
      recent_only: {
        type: "boolean",
        default: DEFAULT_RECENT_ONLY,
        description: "If true, only consider recently-accessed memories.",
      },
      memory_pool_size: {
        type: "integer",
        default: DEFAULT_MEMORY_POOL_SIZE,
        description: "Number of memories to draw from before clustering.",
      },
    },
  },
} as const;

// Re-export so MCP tool registration can pick up the canonical default
// without re-declaring them. source: cortex@47b818d (schema field defaults
// derive from auto_curator constants).
export { MAX_MEMORIES_PER_PROMPT, MIN_AVG_HEAT_FOR_PAGE, MIN_MEMORIES_PER_CLUSTER };
