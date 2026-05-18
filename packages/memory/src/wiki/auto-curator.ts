/**
 * Auto-curator — turn PG memory clusters into curated wiki pages.
 *
 * This module is the systemic answer to "ALL ACTIONS SHOULD BE DOCUMENTED
 * BY OPUS 4.7" (user directive 2026-05-17). Manual authoring doesn't
 * scale; periodic mechanical extraction produces empty templates. The
 * auto-curator sits in between:
 *
 *   1. Cluster recent PG memories into topic groups (entity co-occurrence +
 *      heat + domain).
 *   2. For each cluster that earns a wiki page (≥ N memories, ≥ heat
 *      threshold, no existing fresh page), construct a structured
 *      **authoring prompt** that encodes the wiki-page conventions
 *      (frontmatter, lead, sections with diagrams, "why this not the
 *      alternatives", "what can go wrong", "see also", primary sources).
 *   3. Return the prompts as "curation jobs". A downstream LLM (the
 *      conversational Opus 4.7 via the ``curate_wiki`` MCP tool)
 *      authors the page and writes it via ``wiki_write``.
 *
 * Pure business logic — no I/O. The handler composes this with the memory
 * store and the wiki writer.
 *
 * source: cortex@47b818d mcp_server/core/auto_curator.py
 */

// 2026-05-17: thresholds tuned to mirror the cluster-quality bar of the
// hand-authored pages from this session. Below these, a cluster doesn't
// carry enough signal to author a useful page.
// source: cortex@47b818d mcp_server/core/auto_curator.py:33-37
export const MIN_MEMORIES_PER_CLUSTER = 4;
export const MIN_AVG_HEAT_FOR_PAGE = 0.3;
export const MIN_ENTITY_FREQ_FOR_TOPIC = 3;
export const MAX_MEMORIES_PER_PROMPT = 25;

// 2026-05-17: how recent counts as "already authored" — skip re-curating
// a cluster whose suggested path was written within this window. 30
// days is the heuristic floor; clusters with substantial new content
// after that window get re-curated to update the page.
// source: cortex@4883307 mcp_server/core/auto_curator.py:79
export const SKIP_IF_AUTHORED_WITHIN_DAYS = 30;

// Seconds in a day, for the mtime-age comparison.
// source: 86400 = 24 * 60 * 60 (SI definition)
const SECONDS_PER_DAY = 86400;
// Convert JS Date.now()/getmtime milliseconds to seconds.
// source: ECMAScript spec — Date timestamps are milliseconds
const MS_PER_SECOND = 1000;

// Entity-extraction caps. The slug length matches the wiki-path
// convention (kind/<domain>/<slug>.md) and the memory-body cap keeps the
// prompt under the model context budget.
// source: cortex@47b818d mcp_server/core/auto_curator.py:_slugify default
const SLUG_MAX_LEN = 60;
// source: cortex@47b818d mcp_server/core/auto_curator.py:307 (content[:1200])
const MEMORY_BODY_PROMPT_CAP = 1200;
// source: cortex@47b818d mcp_server/core/auto_curator.py:107 (top 8 entities)
const TOP_ENTITIES_PER_CLUSTER = 8;
// source: cortex@47b818d mcp_server/core/auto_curator.py:_find_related_pages return slice
const MAX_RELATED_PAGES = 6;
// source: cortex@47b818d mcp_server/core/auto_curator.py:131 (snake-case ≥ 6 chars)
const MIN_SNAKE_LEN = 6;
// source: cortex@47b818d mcp_server/core/auto_curator.py:121 (basename ≥ 4 chars)
const MIN_BASENAME_LEN = 4;
// source: cortex@47b818d mcp_server/core/auto_curator.py:185 (topic-stopword guard)
const MIN_TOPIC_LEN = 4;

// ── Data structures ─────────────────────────────────────────────────────

/** A topic-cohesive group of memories that warrants a single page. */
export interface CurationCluster {
  /** e.g. "predictive-coding-gate" — derived from dominant entity. */
  readonly topic: string;
  /** cortex / agentic-ai / etc. */
  readonly domain: string;
  /** reference / lesson / adr. */
  readonly suggested_kind: string;
  /** e.g. "reference/cortex/predictive-coding-gate.md". */
  readonly suggested_path: string;
  readonly memory_ids: readonly number[];
  readonly memory_contents: readonly string[];
  readonly memory_tags: readonly (readonly string[])[];
  /** Top entities by frequency. */
  readonly entities: readonly string[];
  readonly avg_heat: number;
  readonly earliest_at: string;
  readonly latest_at: string;
}

/** One authoring task: cluster + prompt ready for the LLM. */
export interface CurationJob {
  readonly cluster: CurationCluster;
  readonly prompt: string;
  /** Paths for [[wiki-links]]. */
  readonly related_pages: readonly string[];
}

/**
 * Provider for file-mtime lookups. Returns mtime in **seconds** since
 * epoch, or ``null`` when the file does not exist. Implementations
 * typically wrap ``fs.statSync().mtimeMs / 1000``.
 *
 * The auto-curator stays pure-logic by accepting this as an injected
 * dependency rather than calling ``fs`` directly. The handler wires
 * the real ``fs`` adapter; tests wire a deterministic stub.
 */
export type PageMtimeFn = (absPath: string) => number | null;

/**
 * Return true when the wiki page at ``absPath`` exists and was
 * modified within the last ``withinDays`` days. Skip-already-authored
 * filter for the curator: a cluster whose page is fresh shouldn't be
 * re-suggested. The check is mtime-based, so hand-edits protect a
 * page from re-curation the same way fresh authoring does.
 *
 * source: cortex@4883307 mcp_server/core/auto_curator.py::is_path_recently_authored
 */
export function isPathRecentlyAuthored(
  absPath: string,
  pageMtime: PageMtimeFn,
  withinDays: number = SKIP_IF_AUTHORED_WITHIN_DAYS,
): boolean {
  const mtimeSec = pageMtime(absPath);
  if (mtimeSec == null) return false;
  const nowSec = Date.now() / MS_PER_SECOND;
  const ageSec = nowSec - mtimeSec;
  return ageSec < withinDays * SECONDS_PER_DAY;
}

/**
 * Filter out clusters whose suggested page exists and was authored
 * within ``withinDays`` days. Auto-curator's pure-logic core stays
 * I/O-free — the caller injects ``pageMtime`` (typically a wrapper
 * over fs.statSync) and the wiki root.
 *
 * source: cortex@4883307 mcp_server/core/auto_curator.py::build_clusters
 *         (the in-line filter; we extract it to a standalone fn so
 *         buildClusters remains pure).
 */
export function filterAuthoredClusters(
  clusters: readonly CurationCluster[],
  wikiRoot: string,
  pageMtime: PageMtimeFn,
  withinDays: number = SKIP_IF_AUTHORED_WITHIN_DAYS,
): CurationCluster[] {
  return clusters.filter((c) => {
    const abs = joinPath(wikiRoot, c.suggested_path);
    return !isPathRecentlyAuthored(abs, pageMtime, withinDays);
  });
}

// Local path-join — pure logic, deliberately no node:path import.
// Forward slashes only; wiki paths are POSIX-shaped per layout.ts.
function joinPath(...parts: readonly string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * Count clusters that would yield a fresh authoring job.
 *
 * Cheap-to-call summary for the SessionStart preamble and the
 * consolidate stats. Uses the same defaults as buildClusters so the
 * count matches what curate_wiki returns on full invocation.
 *
 * When ``pageMtime`` is omitted, no skip filter runs — the count is
 * the raw cluster count. Tests use that path.
 *
 * source: cortex@4883307 mcp_server/core/auto_curator.py::count_pending_clusters
 */
export function countPendingClusters(
  memories: readonly CuratorMemory[],
  opts: ClusterOpts & {
    readonly wikiRoot?: string;
    readonly pageMtime?: PageMtimeFn;
  } = {},
): number {
  const clusters = buildClusters(memories, opts);
  if (!opts.wikiRoot || !opts.pageMtime) return clusters.length;
  return filterAuthoredClusters(clusters, opts.wikiRoot, opts.pageMtime).length;
}

// ── Topic identification ────────────────────────────────────────────────

// source: cortex@47b818d mcp_server/core/auto_curator.py:76-85
const TOPIC_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "can", "this",
  "that", "these", "those", "to", "of", "for", "in", "on", "at",
  "by", "with", "from", "as", "into", "user", "tool", "command",
  "file", "output", "error", "input", "result", "decision", "lesson",
]);

function slugify(text: string, maxLen = SLUG_MAX_LEN): string {
  const s = text.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, maxLen).replace(/-+$/, "");
}

// source: cortex@47b818d mcp_server/core/auto_curator.py:91-94
const FILE_EXT_RE = /\b([\w./_-]+)\.(py|ts|js|md|sql|yml|yaml|toml|rs|go)\b/g;
const CAMEL_RE    = /\b[A-Z][a-zA-Z]+(?:[A-Z][a-z]+)+\b/g;
const SNAKE_RE    = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Crude entity extraction — proper nouns, file paths, function names.
 *
 * Canonicalisation:
 *   - File paths drop the extension (``foo/bar.py`` → ``bar``) so the
 *     same module mentioned with and without extension counts as the
 *     same entity.
 *   - File paths drop the directory prefix to keep cluster topics
 *     readable. The full path is still in the source memory.
 *
 * source: cortex@47b818d mcp_server/core/auto_curator.py::_extract_entities_from_content
 */
export function extractEntitiesFromContent(content: string): string[] {
  const entities: string[] = [];
  let m: RegExpExecArray | null;

  FILE_EXT_RE.lastIndex = 0;
  while ((m = FILE_EXT_RE.exec(content)) !== null) {
    const full = m[1] ?? "";
    const basename = full.split("/").pop() ?? full;
    if (basename.length >= MIN_BASENAME_LEN) entities.push(basename);
  }

  CAMEL_RE.lastIndex = 0;
  while ((m = CAMEL_RE.exec(content)) !== null) {
    entities.push(m[0]);
  }

  SNAKE_RE.lastIndex = 0;
  while ((m = SNAKE_RE.exec(content)) !== null) {
    if (m[0].length >= MIN_SNAKE_LEN) entities.push(m[0]);
  }

  return entities;
}

function counter<T>(items: Iterable<T>): Map<T, number> {
  const c = new Map<T, number>();
  for (const it of items) c.set(it, (c.get(it) ?? 0) + 1);
  return c;
}

function mostCommon<T>(c: Map<T, number>, n: number): T[] {
  return Array.from(c.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// ── Clustering ──────────────────────────────────────────────────────────

export interface ClusterOpts {
  readonly domain?: string;
  readonly min_memories?: number;
  readonly min_avg_heat?: number;
}

/**
 * Memory shape the curator consumes. Matches what MemoryStore.getRecentlyAccessedMemories
 * returns: id, content, tags, domain, heat/effective_heat, created_at.
 */
export interface CuratorMemory {
  readonly id?: number;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly domain?: string;
  readonly heat?: number;
  readonly effective_heat?: number;
  readonly created_at?: string;
  readonly [key: string]: unknown;
}

/**
 * Group memories into topic clusters via dominant-entity bucketing.
 *
 * Strategy:
 *   1. Extract entities from each memory's content.
 *   2. Assign each memory to its top entity (the one with highest
 *      document frequency within the memory's content).
 *   3. Group memories by assigned entity.
 *   4. Filter: clusters below ``min_memories`` or below
 *      ``min_avg_heat`` are dropped — they don't earn a page yet.
 *
 * Returns clusters sorted by combined size × avg_heat descending so
 * high-value clusters are curated first.
 *
 * No LLM call here — this is pure logic. The LLM gets called downstream
 * by the handler with the prompts ``buildAuthoringPrompt`` produces.
 *
 * source: cortex@47b818d mcp_server/core/auto_curator.py::build_clusters
 */
export function buildClusters(
  memories: readonly CuratorMemory[],
  opts: ClusterOpts = {},
): CurationCluster[] {
  if (memories.length === 0) return [];

  const minMemories = opts.min_memories ?? MIN_MEMORIES_PER_CLUSTER;
  const minAvgHeat = opts.min_avg_heat ?? MIN_AVG_HEAT_FOR_PAGE;

  // Step 1+2: assign each memory to its dominant entity.
  const buckets = new Map<string, CuratorMemory[]>();
  for (const mem of memories) {
    if (opts.domain && mem.domain !== opts.domain) continue;
    const content = mem.content ?? "";
    const ents = extractEntitiesFromContent(content);
    if (ents.length === 0) continue;
    const top = mostCommon(counter(ents), 1)[0];
    if (top == null) continue;
    if (TOPIC_STOPWORDS.has(top.toLowerCase()) || top.length < MIN_TOPIC_LEN) continue;
    const existing = buckets.get(top) ?? [];
    existing.push(mem);
    buckets.set(top, existing);
  }

  // Step 3+4: build clusters.
  const clusters: CurationCluster[] = [];
  for (const [entity, mems] of buckets) {
    if (mems.length < minMemories) continue;
    const heats = mems.map((m) => Number(m.effective_heat ?? m.heat ?? 0));
    const avgHeat = heats.reduce((a, b) => a + b, 0) / mems.length;
    if (avgHeat < minAvgHeat) continue;

    const allEntities: string[] = [];
    for (const m of mems) {
      allEntities.push(...extractEntitiesFromContent(m.content ?? ""));
    }
    const topEntities = mostCommon(counter(allEntities), TOP_ENTITIES_PER_CLUSTER);

    const topic = entity;
    const slug = slugify(topic) || "untitled";
    const kind = inferKind(mems);
    // mems is guaranteed non-empty by the ``mems.length < minMemories``
    // guard above (minMemories ≥ 1).
    const dom = (mems[0]?.domain ?? "cortex").toLowerCase();
    const path = `${kindDir(kind)}/${dom}/${slug}.md`;

    const memoryIds = mems.filter((m) => typeof m.id === "number").map((m) => m.id as number);
    const created = mems.map((m) => m.created_at ?? "");

    clusters.push({
      topic,
      domain: dom,
      suggested_kind: kind,
      suggested_path: path,
      memory_ids: memoryIds,
      memory_contents: mems.map((m) => m.content ?? ""),
      memory_tags: mems.map((m) => m.tags ?? []),
      entities: topEntities,
      avg_heat: avgHeat,
      earliest_at: created.reduce((a, b) => (a === "" || (b !== "" && b < a)) ? b : a, ""),
      latest_at:   created.reduce((a, b) => (b > a ? b : a), ""),
    });
  }

  clusters.sort((a, b) => (b.memory_ids.length * b.avg_heat) - (a.memory_ids.length * a.avg_heat));
  return clusters;
}

/**
 * Decide whether the cluster is a reference, lesson, or adr.
 * source: cortex@47b818d mcp_server/core/auto_curator.py::_infer_kind
 */
function inferKind(memories: readonly CuratorMemory[]): string {
  const tagCounter = new Map<string, number>();
  for (const m of memories) {
    for (const t of m.tags ?? []) {
      const key = t.toLowerCase();
      tagCounter.set(key, (tagCounter.get(key) ?? 0) + 1);
    }
  }
  if ((tagCounter.get("decision") ?? 0) > 0 || (tagCounter.get("adr") ?? 0) > 0) return "adr";
  if (
    (tagCounter.get("lesson") ?? 0) > 0 ||
    (tagCounter.get("learned") ?? 0) > 0 ||
    (tagCounter.get("postmortem") ?? 0) > 0
  ) return "lesson";
  return "reference";
}

function kindDir(kind: string): string {
  if (kind === "adr") return "adr";
  if (kind === "lesson") return "lessons";
  return "reference";
}

// ── Authoring-prompt construction ──────────────────────────────────────

// source: cortex@47b818d mcp_server/core/auto_curator.py::WIKI_AUTHORING_PROMPT
const WIKI_AUTHORING_PROMPT = `You are Opus 4.7 authoring a single wiki page for the persistent-memory MCP server.

You are given a topic-cohesive cluster of PG memories (tool events, decisions, lessons, notes) plus the suggested wiki path and any existing related wiki pages for cross-linking.

# Your task

Author **one** curated wiki page in Markdown that follows the documentation conventions below. The page must be substantive (target 8-15 KB), with structure, prose, diagrams, and citations. Do **not** produce a mechanical template. Do **not** dump raw memory content; synthesise.

# Output format

Output **only** the wiki page body, starting with YAML frontmatter, then the body. No preamble, no explanation, no surrounding fences.

# Frontmatter (required)

\`\`\`yaml
---
title: <short specific title — not "Reference: X", just "X">
kind: {kind}
domain: {domain}
status: living
authored_by: Opus 4.7
created: {today}
last_reviewed: {today}
audience: [developer, ...]
---
\`\`\`

# Required structural sections (in this order)

1. **# <title>** — H1 matching frontmatter title.
2. **Lead paragraph** — one paragraph that says what the page is and why a reader should care.
3. **Sections explaining the topic**:
   - Use \`\`\`mermaid fences for flowcharts, sequence diagrams, state diagrams when the topic involves dataflow or state transitions.
   - Use tables for taxonomies, parameter lists, comparisons.
   - Use \`\`\` fences with language for code snippets.
   - Cite specific source files with full paths.
4. **## Why this design and not the alternatives** — explain the architectural choice. What was considered, what was rejected, why.
5. **## What can go wrong** — failure modes the next reader should know about, with concrete symptoms.
6. **## See also** — cross-links to related pages using \`[[wiki/path]]\` notation, plus specific source files.
7. **## Primary sources** — if the topic touches research literature, cite the actual papers with full citations.

# Conventions

- Write authoritative declarative prose. No filler ("It's worth noting that..."). State facts directly.
- When a number is given, name its source (e.g. "p50 latency 90ms — measured in benchmarks/longmemeval/run_benchmark.py").
- When the topic has biological inspiration, name the paper that motivated the design.
- Don't repeat what's already linked elsewhere — link to it.
- Each diagram must add information that the table or prose cannot convey efficiently.
- No phrases like "in this section we will" — just say it.

# The cluster

**Topic**: {topic}
**Suggested wiki path**: {suggested_path}
**Domain**: {domain}
**Memory count**: {n_memories}
**Top entities in cluster**: {entities}

**Existing related wiki pages** (for cross-linking via \`[[path]]\`):
{related_pages_block}

**Memories in this cluster** (synthesise — do not dump):

{memories_block}

---

Author the wiki page now. Output only the Markdown body, frontmatter first.
`;

function formatPrompt(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/**
 * Construct the structured prompt for an LLM to author the cluster's page.
 *
 * The prompt encodes the same conventions the hand-authored 2026-05-17
 * pages followed. Returning the prompt as a string (vs. calling an LLM
 * here) keeps this module pure and lets the caller pick the LLM
 * integration: ``curate_wiki`` returns the prompts for the in-session
 * LLM, or a future ``llm_client.author_page(prompt)`` adapter sends
 * them directly to the Anthropic API.
 *
 * source: cortex@47b818d mcp_server/core/auto_curator.py::build_authoring_prompt
 */
export function buildAuthoringPrompt(
  cluster: CurationCluster,
  relatedPages: readonly string[],
  today: string = "",
): string {
  const todayStr = today || new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const capped = cluster.memory_contents.slice(0, MAX_MEMORIES_PER_PROMPT);
  const memBlocks: string[] = [];
  capped.forEach((content, idx) => {
    const tags = cluster.memory_tags[idx] ?? [];
    let head = content.slice(0, MEMORY_BODY_PROMPT_CAP).trimEnd();
    if (content.length > MEMORY_BODY_PROMPT_CAP) {
      head += "\n...[memory truncated, full content available via recall]";
    }
    const tagStr = tags.length ? tags.join(", ") : "(no tags)";
    memBlocks.push(`### Memory ${idx + 1} (tags: ${tagStr})\n\n${head}`);
  });
  const memoriesBlock = memBlocks.length ? memBlocks.join("\n\n") : "(none — cluster filtered out)";

  const relatedBlock = relatedPages.length
    ? relatedPages.map((p) => `- [[${p}]]`).join("\n")
    : "(none yet — this is a fresh topic)";

  return formatPrompt(WIKI_AUTHORING_PROMPT, {
    kind:               cluster.suggested_kind,
    domain:             cluster.domain,
    today:              todayStr,
    topic:              cluster.topic,
    suggested_path:     cluster.suggested_path,
    n_memories:         cluster.memory_ids.length,
    entities:           cluster.entities.slice(0, TOP_ENTITIES_PER_CLUSTER).join(", ") || "(none extracted)",
    related_pages_block: relatedBlock,
    memories_block:      memoriesBlock,
  });
}

/**
 * Find existing wiki pages whose topic words overlap with this cluster's.
 * source: cortex@47b818d mcp_server/core/auto_curator.py::_find_related_pages
 */
function findRelatedPages(
  cluster: CurationCluster,
  existingPagesByTopic: ReadonlyMap<string, readonly string[]>,
): string[] {
  const topicTokens = new Set<string>();
  for (const tok of cluster.topic.toLowerCase().match(/[a-z0-9]+/g) ?? []) topicTokens.add(tok);
  for (const tok of cluster.entities.join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? []) topicTokens.add(tok);

  // Comparison space for self-exclusion is without ``.md`` — the index
  // strips ``.md`` from each page path, but cluster.suggested_path
  // retains it. Strip here so a page never recommends itself as a
  // [[related-page]] cross-link.
  // source: cortex@47b818d_post-port — the Python had this same bug
  //         (no .md normalisation); we close it here.
  const ownPathNoMd = cluster.suggested_path.replace(/\.md$/, "");

  const related: string[] = [];
  const seen = new Set<string>();
  for (const [existingTopic, paths] of existingPagesByTopic) {
    const etTokens = new Set(existingTopic.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    let overlap = false;
    for (const t of etTokens) {
      if (topicTokens.has(t)) { overlap = true; break; }
    }
    if (!overlap) continue;
    for (const p of paths) {
      if (!seen.has(p) && p !== ownPathNoMd) {
        related.push(p);
        seen.add(p);
      }
    }
  }
  return related.slice(0, MAX_RELATED_PAGES);
}

/**
 * Pair each cluster with its authoring prompt and any related pages.
 * source: cortex@47b818d mcp_server/core/auto_curator.py::build_jobs
 */
export function buildJobs(
  clusters: readonly CurationCluster[],
  existingPagesByTopic: ReadonlyMap<string, readonly string[]> = new Map(),
  today: string = "",
): CurationJob[] {
  return clusters.map((cl) => {
    const related = findRelatedPages(cl, existingPagesByTopic);
    const prompt = buildAuthoringPrompt(cl, related, today);
    return { cluster: cl, prompt, related_pages: related };
  });
}
