/**
 * Tests for the auto-curator core (clustering + prompt construction).
 *
 * source: cortex@47b818d mcp_server/core/auto_curator.py
 */

import { describe, expect, it } from "vitest";
import {
  buildAuthoringPrompt,
  buildClusters,
  buildJobs,
  countPendingClusters,
  extractEntitiesFromContent,
  filterAuthoredClusters,
  isPathRecentlyAuthored,
  MAX_MEMORIES_PER_PROMPT,
  MIN_MEMORIES_PER_CLUSTER,
  SKIP_IF_AUTHORED_WITHIN_DAYS,
  type CuratorMemory,
  type PageMtimeFn,
} from "../../src/wiki/auto-curator.js";

// ── extractEntitiesFromContent ────────────────────────────────────────

describe("extractEntitiesFromContent", () => {
  it("strips the extension and directory from a file path", () => {
    // basename must be ≥ 4 chars per MIN_BASENAME_LEN (source: cortex@47b818d:121).
    const ents = extractEntitiesFromContent("see foo/bar/quux.py for details");
    expect(ents).toContain("quux");
  });

  it("picks CamelCase identifiers", () => {
    const ents = extractEntitiesFromContent("the MemoryStore handles inserts");
    expect(ents).toContain("MemoryStore");
  });

  it("picks snake_case identifiers >= 6 chars", () => {
    const ents = extractEntitiesFromContent("call get_recent_memories(limit=200)");
    expect(ents).toContain("get_recent_memories");
  });

  it("skips snake_case shorter than 6 chars", () => {
    const ents = extractEntitiesFromContent("a_b is too short");
    expect(ents.every((e) => e !== "a_b")).toBe(true);
  });

  it("returns empty for prose with no identifiers", () => {
    const ents = extractEntitiesFromContent("the quick brown fox jumps");
    expect(ents).toEqual([]);
  });
});

// ── buildClusters ─────────────────────────────────────────────────────

describe("buildClusters", () => {
  function mem(id: number, content: string, opts: Partial<CuratorMemory> = {}): CuratorMemory {
    return {
      id,
      content,
      tags: opts.tags ?? [],
      domain: opts.domain ?? "cortex",
      effective_heat: opts.effective_heat ?? 0.6,
      created_at: opts.created_at ?? "2026-05-17T00:00:00Z",
      ...opts,
    };
  }

  it("returns empty list for empty input", () => {
    expect(buildClusters([])).toEqual([]);
  });

  it("filters clusters below min_memories", () => {
    const memories = [
      mem(1, "the MemoryStore inserts a row"),
      mem(2, "MemoryStore caches the read"),
    ];
    const clusters = buildClusters(memories, { min_memories: 4 });
    expect(clusters).toEqual([]);
  });

  it("groups memories by dominant entity and emits a cluster when ≥ min_memories", () => {
    const memories = [
      mem(1, "the MemoryStore inserts a row in PG"),
      mem(2, "MemoryStore caches the read of the page"),
      mem(3, "MemoryStore.bumpHeat called on insert"),
      mem(4, "MemoryStore returns the memory_id"),
    ];
    const clusters = buildClusters(memories, { min_memories: 4, min_avg_heat: 0 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].topic).toBe("MemoryStore");
    expect(clusters[0].memory_ids.sort()).toEqual([1, 2, 3, 4]);
  });

  it("filters clusters below min_avg_heat", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "MemoryStore writes the row", { effective_heat: 0.1 }),
    );
    const clusters = buildClusters(memories, { min_memories: 4, min_avg_heat: 0.5 });
    expect(clusters).toEqual([]);
  });

  it("infers kind=adr from a decision tag", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "MemoryStore inserts decision", { tags: ["decision"] }),
    );
    const clusters = buildClusters(memories, { min_memories: 4, min_avg_heat: 0 });
    expect(clusters[0].suggested_kind).toBe("adr");
    expect(clusters[0].suggested_path).toMatch(/^adr\//);
  });

  it("infers kind=lesson from a lesson tag", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "MemoryStore behaviour learned", { tags: ["lesson"] }),
    );
    const clusters = buildClusters(memories, { min_memories: 4, min_avg_heat: 0 });
    expect(clusters[0].suggested_kind).toBe("lesson");
    expect(clusters[0].suggested_path).toMatch(/^lessons\//);
  });

  it("defaults to kind=reference when no decision/lesson tag is present", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "MemoryStore behaviour", { tags: ["note"] }),
    );
    const clusters = buildClusters(memories, { min_memories: 4, min_avg_heat: 0 });
    expect(clusters[0].suggested_kind).toBe("reference");
    expect(clusters[0].suggested_path).toMatch(/^reference\//);
  });

  it("filters by domain when domain is provided", () => {
    const memories = [
      ...Array.from({ length: 4 }, (_, i) =>
        mem(i + 1, "MemoryStore inserts", { domain: "cortex" }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        mem(i + 5, "MemoryStore inserts", { domain: "other" }),
      ),
    ];
    const clusters = buildClusters(memories, { domain: "cortex", min_memories: 4, min_avg_heat: 0 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memory_ids.sort()).toEqual([1, 2, 3, 4]);
  });

  it("sorts clusters by size × avg_heat descending", () => {
    // Cluster A: 4 memories, heat 0.3 → score 1.2
    // Cluster B: 5 memories, heat 0.6 → score 3.0  (should win)
    // CamelCase regex requires ≥ 2 cap-lower segments per cortex@47b818d:93
    // (``[A-Z][a-zA-Z]+(?:[A-Z][a-z]+)+``).
    const memories = [
      ...Array.from({ length: 4 }, (_, i) =>
        mem(i + 1, "AlphaRule does the thing", { effective_heat: 0.3 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        mem(i + 10, "BetaRule rules", { effective_heat: 0.6 }),
      ),
    ];
    const clusters = buildClusters(memories, { min_memories: 4, min_avg_heat: 0 });
    expect(clusters.map((c) => c.topic)).toEqual(["BetaRule", "AlphaRule"]);
  });

  it("skips memories that yield no extractable entity", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "the quick brown fox jumps"),
    );
    expect(buildClusters(memories, { min_memories: 4, min_avg_heat: 0 })).toEqual([]);
  });
});

// ── buildAuthoringPrompt ──────────────────────────────────────────────

describe("buildAuthoringPrompt", () => {
  const cluster = {
    topic: "MemoryStore",
    domain: "cortex",
    suggested_kind: "reference",
    suggested_path: "reference/cortex/memorystore.md",
    memory_ids: [1, 2, 3, 4],
    memory_contents: ["a".repeat(10), "b".repeat(10), "c".repeat(10), "d".repeat(10)],
    memory_tags: [["x"], ["y"], [], ["z", "w"]],
    entities: ["MemoryStore", "PgStore", "SqliteStore"],
    avg_heat: 0.7,
    earliest_at: "2026-05-01T00:00:00Z",
    latest_at: "2026-05-17T00:00:00Z",
  } as const;

  it("embeds the topic, suggested path, domain, and entities", () => {
    const p = buildAuthoringPrompt(cluster, [], "2026-05-17");
    expect(p).toContain("**Topic**: MemoryStore");
    expect(p).toContain("**Suggested wiki path**: reference/cortex/memorystore.md");
    expect(p).toContain("**Domain**: cortex");
    expect(p).toContain("**Top entities in cluster**: MemoryStore, PgStore, SqliteStore");
  });

  it("renders related pages as [[wiki-links]]", () => {
    const p = buildAuthoringPrompt(cluster, ["reference/cortex/pg-store", "reference/cortex/sqlite-store"], "2026-05-17");
    expect(p).toContain("- [[reference/cortex/pg-store]]");
    expect(p).toContain("- [[reference/cortex/sqlite-store]]");
  });

  it("falls back to the no-related-pages sentinel when empty", () => {
    const p = buildAuthoringPrompt(cluster, [], "2026-05-17");
    expect(p).toContain("(none yet — this is a fresh topic)");
  });

  it("caps memory bodies and notes truncation", () => {
    const big = "x".repeat(2000);
    const c2 = { ...cluster, memory_contents: [big, big, big, big] } as const;
    const p = buildAuthoringPrompt(c2, [], "2026-05-17");
    expect(p).toContain("[memory truncated, full content available via recall]");
    // The full 2000-char body must not appear verbatim.
    expect(p.includes(big)).toBe(false);
  });

  it("caps the number of memories included at MAX_MEMORIES_PER_PROMPT", () => {
    const many = Array.from({ length: MAX_MEMORIES_PER_PROMPT + 10 }, (_, i) => `m${i}`);
    const c2 = {
      ...cluster,
      memory_contents: many,
      memory_tags: many.map(() => []),
      memory_ids: many.map((_, i) => i + 1),
    } as const;
    const p = buildAuthoringPrompt(c2, [], "2026-05-17");
    // The (MAX+1)-th memory header must not appear.
    expect(p.includes(`### Memory ${MAX_MEMORIES_PER_PROMPT + 1}`)).toBe(false);
    // The first must.
    expect(p.includes(`### Memory 1`)).toBe(true);
  });

  it("substitutes {today} with the supplied date", () => {
    const p = buildAuthoringPrompt(cluster, [], "2026-05-17");
    expect(p).toContain("created: 2026-05-17");
    expect(p).toContain("last_reviewed: 2026-05-17");
  });

  it("substitutes {today} with today's date when none is supplied", () => {
    const p = buildAuthoringPrompt(cluster, []);
    const todayStr = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
    expect(p).toContain(`created: ${todayStr}`);
  });
});

// ── buildJobs (integration of clusters + prompts) ─────────────────────

describe("buildJobs", () => {
  function makeCluster(topic: string, entities: readonly string[]): {
    readonly topic: string;
    readonly domain: string;
    readonly suggested_kind: string;
    readonly suggested_path: string;
    readonly memory_ids: readonly number[];
    readonly memory_contents: readonly string[];
    readonly memory_tags: readonly (readonly string[])[];
    readonly entities: readonly string[];
    readonly avg_heat: number;
    readonly earliest_at: string;
    readonly latest_at: string;
  } {
    return {
      topic,
      domain: "cortex",
      suggested_kind: "reference",
      suggested_path: `reference/cortex/${topic.toLowerCase()}.md`,
      memory_ids: [1, 2, 3, 4],
      memory_contents: ["x", "y", "z", "w"],
      memory_tags: [[], [], [], []],
      entities,
      avg_heat: 0.5,
      earliest_at: "2026-05-01",
      latest_at:   "2026-05-17",
    } as const;
  }

  it("emits one job per cluster, each with a prompt", () => {
    const c1 = makeCluster("MemoryStore", ["MemoryStore"]);
    const c2 = makeCluster("PageClassifier", ["PageClassifier"]);
    const jobs = buildJobs([c1, c2]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].cluster).toBe(c1);
    expect(jobs[0].prompt.length).toBeGreaterThan(500);
  });

  it("pairs clusters with related pages from the existing-pages index", () => {
    // Topic-token overlap is computed per ``[a-z0-9]+`` run, so multi-word
    // slugs need to share a literal token (e.g. ``memorystore``) with the
    // cluster's topic or entity set. ``pg-store`` won't match
    // ``memorystore`` because no token is shared — that's a fidelity limit
    // of the heuristic, documented in cortex@47b818d::_find_related_pages.
    const c = makeCluster("MemoryStore", ["MemoryStore", "PgStore"]);
    const existing = new Map<string, string[]>([
      ["memorystore-rewrite", ["reference/cortex/memorystore-rewrite"]],
      ["pgstore-driver",      ["reference/cortex/pgstore-driver"]],
    ]);
    const jobs = buildJobs([c], existing, "2026-05-17");
    expect(jobs[0].related_pages).toContain("reference/cortex/memorystore-rewrite");
    expect(jobs[0].related_pages).toContain("reference/cortex/pgstore-driver");
  });

  it("does not include the cluster's own suggested_path as a related page", () => {
    const c = makeCluster("MemoryStore", ["MemoryStore"]);
    const existing = new Map<string, string[]>([
      ["memorystore", [c.suggested_path.replace(/\.md$/, "")]],
    ]);
    const jobs = buildJobs([c], existing, "2026-05-17");
    expect(jobs[0].related_pages).not.toContain(c.suggested_path.replace(/\.md$/, ""));
  });
});

// ── MIN_MEMORIES_PER_CLUSTER default ────────────────────────────────────

describe("module constants", () => {
  it("exports a positive MIN_MEMORIES_PER_CLUSTER", () => {
    expect(MIN_MEMORIES_PER_CLUSTER).toBeGreaterThan(0);
  });

  it("exports MAX_MEMORIES_PER_PROMPT", () => {
    expect(MAX_MEMORIES_PER_PROMPT).toBeGreaterThan(MIN_MEMORIES_PER_CLUSTER);
  });

  it("exports SKIP_IF_AUTHORED_WITHIN_DAYS as a positive integer", () => {
    expect(SKIP_IF_AUTHORED_WITHIN_DAYS).toBeGreaterThan(0);
    expect(Number.isInteger(SKIP_IF_AUTHORED_WITHIN_DAYS)).toBe(true);
  });
});

// ── isPathRecentlyAuthored — skip-already-authored filter ─────────────
// source: cortex@4883307 mcp_server/core/auto_curator.py::is_path_recently_authored

describe("isPathRecentlyAuthored", () => {
  const SECONDS_PER_DAY = 86400;
  const nowSec = Math.floor(Date.now() / 1000);

  function fixedMtime(absPath: string, mtime: number | null): PageMtimeFn {
    return (p) => (p === absPath ? mtime : null);
  }

  it("returns false when the page does not exist", () => {
    const mtime = fixedMtime("/wiki/a.md", null);
    expect(isPathRecentlyAuthored("/wiki/a.md", mtime)).toBe(false);
  });

  it("returns true when the page exists and was modified within the window", () => {
    const fiveDaysAgo = nowSec - 5 * SECONDS_PER_DAY;
    const mtime = fixedMtime("/wiki/a.md", fiveDaysAgo);
    expect(isPathRecentlyAuthored("/wiki/a.md", mtime, 30)).toBe(true);
  });

  it("returns false when the page is older than the window", () => {
    const sixtyDaysAgo = nowSec - 60 * SECONDS_PER_DAY;
    const mtime = fixedMtime("/wiki/a.md", sixtyDaysAgo);
    expect(isPathRecentlyAuthored("/wiki/a.md", mtime, 30)).toBe(false);
  });

  it("uses SKIP_IF_AUTHORED_WITHIN_DAYS as the default window", () => {
    const oneDayAgo = nowSec - 1 * SECONDS_PER_DAY;
    const mtime = fixedMtime("/wiki/a.md", oneDayAgo);
    expect(isPathRecentlyAuthored("/wiki/a.md", mtime)).toBe(true);
  });
});

// ── filterAuthoredClusters — composition ──────────────────────────────

describe("filterAuthoredClusters", () => {
  const SECONDS_PER_DAY = 86400;
  const nowSec = Math.floor(Date.now() / 1000);

  function makeCluster(suggestedPath: string): {
    readonly topic: string;
    readonly domain: string;
    readonly suggested_kind: string;
    readonly suggested_path: string;
    readonly memory_ids: readonly number[];
    readonly memory_contents: readonly string[];
    readonly memory_tags: readonly (readonly string[])[];
    readonly entities: readonly string[];
    readonly avg_heat: number;
    readonly earliest_at: string;
    readonly latest_at: string;
  } {
    return {
      topic: "T", domain: "cortex", suggested_kind: "reference",
      suggested_path: suggestedPath,
      memory_ids: [1, 2, 3, 4],
      memory_contents: ["a", "b", "c", "d"],
      memory_tags: [[], [], [], []],
      entities: [],
      avg_heat: 0.6,
      earliest_at: "", latest_at: "",
    } as const;
  }

  it("drops clusters whose page is fresh (within window)", () => {
    const fresh = makeCluster("reference/cortex/fresh.md");
    const stale = makeCluster("reference/cortex/stale.md");
    const mtime: PageMtimeFn = (p) => {
      if (p.endsWith("fresh.md")) return nowSec - 5 * SECONDS_PER_DAY;
      if (p.endsWith("stale.md")) return nowSec - 60 * SECONDS_PER_DAY;
      return null;
    };
    const kept = filterAuthoredClusters([fresh, stale], "/wiki", mtime);
    expect(kept.map((c) => c.suggested_path)).toEqual(["reference/cortex/stale.md"]);
  });

  it("keeps clusters whose page does not exist", () => {
    const c = makeCluster("reference/cortex/missing.md");
    const mtime: PageMtimeFn = () => null;
    expect(filterAuthoredClusters([c], "/wiki", mtime)).toEqual([c]);
  });
});

// ── countPendingClusters — telemetry entrypoint ───────────────────────

describe("countPendingClusters", () => {
  function mem(id: number, content: string): CuratorMemory {
    return {
      id, content, tags: [], domain: "cortex",
      effective_heat: 0.6, created_at: "2026-05-17T00:00:00Z",
    };
  }

  it("returns 0 for an empty memory pool", () => {
    expect(countPendingClusters([])).toBe(0);
  });

  it("returns the cluster count when no skip filter is wired", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "MemoryStore inserts rows"),
    );
    expect(countPendingClusters(memories, { min_memories: 4, min_avg_heat: 0 })).toBe(1);
  });

  it("applies the skip-already-authored filter when wikiRoot + pageMtime are supplied", () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      mem(i + 1, "MemoryStore inserts rows"),
    );
    // Suggested path is reference/cortex/memorystore.md. Mark it fresh.
    const SECONDS_PER_DAY = 86400;
    const nowSec = Math.floor(Date.now() / 1000);
    const mtime: PageMtimeFn = (p) =>
      p.endsWith("memorystore.md") ? nowSec - 1 * SECONDS_PER_DAY : null;
    expect(countPendingClusters(memories, {
      min_memories: 4, min_avg_heat: 0,
      wikiRoot: "/wiki",
      pageMtime: mtime,
    })).toBe(0);
  });
});
