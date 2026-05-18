/**
 * Tests for the curate-wiki handler — composition of the auto-curator
 * with the memory store and the wiki listing.
 *
 * source: cortex@47b818d mcp_server/handlers/curate_wiki.py
 */

import { describe, expect, it } from "vitest";
import {
  handler,
  scanExistingPages,
  type CurateWikiDeps,
} from "../../src/wiki/handlers/curate-wiki.js";
import type { CuratorMemory } from "../../src/wiki/auto-curator.js";

// ── scanExistingPages — topic-key derivation ──────────────────────────

describe("scanExistingPages", () => {
  it("indexes a page by its slug topic", () => {
    const idx = scanExistingPages(["reference/cortex/memorystore.md"]);
    expect(idx.get("memorystore")).toEqual(["reference/cortex/memorystore"]);
  });

  it("strips a numeric ID prefix from the slug", () => {
    const idx = scanExistingPages(["adr/cortex/305772-page-classifier.md"]);
    expect(idx.get("page-classifier")).toEqual(["adr/cortex/305772-page-classifier"]);
  });

  it("strips kind prefixes (decision-, lesson-, convention-, spec-, reference-)", () => {
    const idx = scanExistingPages([
      "lessons/cortex/lesson-bash-timeouts.md",
      "adr/cortex/decision-no-mocks.md",
    ]);
    expect(idx.get("bash-timeouts")).toEqual(["lessons/cortex/lesson-bash-timeouts"]);
    expect(idx.get("no-mocks")).toEqual(["adr/cortex/decision-no-mocks"]);
  });

  it("skips dot- and underscore-prefixed top-level directories", () => {
    const idx = scanExistingPages([".generated/INDEX.md", "_drafts/wip.md", "reference/keep.md"]);
    expect(idx.has("index")).toBe(false);
    expect(idx.has("wip")).toBe(false);
    expect(idx.has("keep")).toBe(true);
  });

  it("groups multiple pages under the same topic slug", () => {
    const idx = scanExistingPages([
      "reference/cortex/curator.md",
      "lessons/cortex/curator.md",
    ]);
    expect(idx.get("curator")?.sort()).toEqual([
      "lessons/cortex/curator",
      "reference/cortex/curator",
    ]);
  });
});

// ── handler — composition ─────────────────────────────────────────────

describe("curate-wiki handler", () => {
  function makeMemory(id: number, content: string): CuratorMemory {
    return {
      id,
      content,
      tags: ["wiki"],
      domain: "cortex",
      effective_heat: 0.6,
      created_at: "2026-05-17T00:00:00Z",
    };
  }

  function makeDeps(
    memories: CuratorMemory[],
    pages: string[] = [],
    today = "2026-05-17",
  ): CurateWikiDeps {
    return {
      wikiRoot: "/tmp/wiki",
      getRecentlyAccessedMemories: async () => memories,
      listMdPages: async () => pages,
      today: () => today,
    };
  }

  it("returns an empty job list when no memories are available", async () => {
    const res = await handler({}, makeDeps([]));
    if ("error" in res) throw new Error("unexpected error");
    expect(res.jobs).toEqual([]);
    expect(res.total_clusters_eligible).toBe(0);
    expect(res.memory_pool_size).toBe(0);
    expect(res.instructions).toContain("No memories");
  });

  it("produces one job per cluster up to `limit`", async () => {
    const memories = Array.from({ length: 6 }, (_, i) =>
      makeMemory(i + 1, "MemoryStore handles row writes"),
    );
    const res = await handler({ limit: 1, min_memories: 4, min_avg_heat: 0 }, makeDeps(memories));
    if ("error" in res) throw new Error("unexpected error");
    expect(res.jobs).toHaveLength(1);
    expect(res.total_clusters_eligible).toBe(1);
    expect(res.jobs[0].topic).toBe("MemoryStore");
    expect(res.jobs[0].suggested_path).toBe("reference/cortex/memorystore.md");
  });

  it("rounds avg_heat to 3 decimals on the wire", async () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      makeMemory(i + 1, "MemoryStore inserts"),
    );
    const res = await handler({ min_memories: 4, min_avg_heat: 0 }, makeDeps(memories));
    if ("error" in res) throw new Error("unexpected error");
    // All four have heat 0.6 → avg exactly 0.6. Round preserves it.
    expect(res.jobs[0].avg_heat).toBe(0.6);
  });

  it("includes the LLM-instructions when at least one job is returned", async () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      makeMemory(i + 1, "MemoryStore handles row writes"),
    );
    const res = await handler({ min_memories: 4, min_avg_heat: 0 }, makeDeps(memories));
    if ("error" in res) throw new Error("unexpected error");
    expect(res.instructions).toContain("wiki_write");
    expect(res.instructions).toContain("Author the page in Markdown");
  });

  it("returns the 'no eligible clusters' instruction when memories exist but cluster too small", async () => {
    const memories = [makeMemory(1, "OneOff entity rarely seen")];
    const res = await handler({ min_memories: 4, min_avg_heat: 0 }, makeDeps(memories));
    if ("error" in res) throw new Error("unexpected error");
    expect(res.jobs).toEqual([]);
    expect(res.instructions).toContain("relax");
  });

  it("propagates domain filter when supplied", async () => {
    const memories = [
      ...Array.from({ length: 4 }, (_, i) => ({ ...makeMemory(i + 1, "MemoryStore"), domain: "cortex" })),
      ...Array.from({ length: 4 }, (_, i) => ({ ...makeMemory(i + 10, "MemoryStore"), domain: "agentic-ai" })),
    ];
    const res = await handler(
      { domain: "agentic-ai", min_memories: 4, min_avg_heat: 0 },
      makeDeps(memories),
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.domain_filter).toBe("agentic-ai");
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].memory_ids.sort()).toEqual([10, 11, 12, 13]);
  });

  it("passes related-page candidates from listMdPages into the prompt", async () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      makeMemory(i + 1, "MemoryStore handles row writes"),
    );
    const res = await handler(
      { min_memories: 4, min_avg_heat: 0 },
      makeDeps(memories, ["reference/cortex/memorystore-rewrite.md"]),
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.jobs[0].related_pages).toContain("reference/cortex/memorystore-rewrite");
    expect(res.jobs[0].prompt).toContain("[[reference/cortex/memorystore-rewrite]]");
  });

  it("excludes the cluster's own page from the related-pages set", async () => {
    const memories = Array.from({ length: 4 }, (_, i) =>
      makeMemory(i + 1, "MemoryStore handles row writes"),
    );
    // The own path appears in listMdPages — must NOT be a related cross-link.
    const res = await handler(
      { min_memories: 4, min_avg_heat: 0 },
      makeDeps(memories, ["reference/cortex/memorystore.md"]),
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.jobs[0].related_pages).not.toContain("reference/cortex/memorystore");
  });
});

// ── Phase C: drift + coverage integration ─────────────────────────────

describe("curate-wiki handler — Phase C (drift + coverage)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const SECONDS_PER_DAY = 86400;

  function memWithEntity(id: number): CuratorMemory {
    return {
      id,
      content: "MemoryStore handles row writes",
      tags: ["wiki"],
      domain: "cortex",
      effective_heat: 0.6,
      created_at: "2026-05-17T00:00:00Z",
    };
  }

  it("returns drift_jobs and coverage_jobs as empty by default", async () => {
    const memories = Array.from({ length: 4 }, (_, i) => memWithEntity(i + 1));
    const res = await handler(
      { min_memories: 4, min_avg_heat: 0 },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () => memories,
        listMdPages: async () => [],
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.drift_jobs).toEqual([]);
    expect(res.coverage_jobs).toEqual([]);
    expect(res.total_drifted).toBe(0);
    expect(res.total_coverage_gap).toBe(0);
  });

  it("emits a drift job when a cited source is newer than the page", async () => {
    const drifted = "reference/cortex/memorystore.md";
    const res = await handler(
      {
        include_drift: true,
        project_root: "/repo",
        min_memories: 4,
        min_avg_heat: 0,
      },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () => [memWithEntity(1), memWithEntity(2), memWithEntity(3), memWithEntity(4)],
        listMdPages: async () => [drifted],
        readPage: async () => "title\nsource: src/store.ts\nbody",
        pageMtime: () => nowSec - 20 * SECONDS_PER_DAY,
        sourceFileMtime: () => nowSec, // src/store.ts modified just now
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.drift_jobs).toHaveLength(1);
    expect(res.drift_jobs[0].page_path).toBe(drifted);
    expect(res.drift_jobs[0].cited_sources_drifted).toEqual(["src/store.ts"]);
    expect(res.drift_jobs[0].prompt).toContain("source: src/store.ts");
    expect(res.total_drifted).toBe(1);
  });

  it("does NOT emit drift jobs when include_drift is false", async () => {
    const res = await handler(
      { include_drift: false, project_root: "/repo", min_memories: 4, min_avg_heat: 0 },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () => [memWithEntity(1), memWithEntity(2), memWithEntity(3), memWithEntity(4)],
        listMdPages: async () => ["reference/cortex/foo.md"],
        readPage: async () => "source: src/store.ts",
        pageMtime: () => 1,
        sourceFileMtime: () => nowSec,
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.drift_jobs).toEqual([]);
  });

  it("does NOT emit drift jobs when project_root is missing", async () => {
    const res = await handler(
      { include_drift: true, min_memories: 4, min_avg_heat: 0 },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () => [memWithEntity(1), memWithEntity(2), memWithEntity(3), memWithEntity(4)],
        listMdPages: async () => ["reference/cortex/foo.md"],
        readPage: async () => "source: src/store.ts",
        pageMtime: () => 1,
        sourceFileMtime: () => nowSec,
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.drift_jobs).toEqual([]);
    expect(res.total_drifted).toBe(0);
  });

  it("emits a coverage job for a source file with no wiki page", async () => {
    const res = await handler(
      {
        include_file_coverage: true,
        project_root: "/repo",
        domain: "agentic-ai",
        min_memories: 4,
        min_avg_heat: 0,
      },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () =>
          Array.from({ length: 4 }, (_, i) => ({ ...memWithEntity(i + 1), domain: "agentic-ai" })),
        listMdPages: async () => [], // no pages exist
        listSourceFiles: async () => ["src/foo.ts", "src/bar.ts"],
        readSourceFile: () => "export const x = 1;",
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.coverage_jobs).toHaveLength(2);
    expect(res.coverage_jobs[0].source_file).toBe("src/foo.ts");
    expect(res.coverage_jobs[0].suggested_path).toBe("reference/agentic-ai/foo.md");
    expect(res.coverage_jobs[0].prompt).toContain("export const x = 1;");
    expect(res.total_coverage_gap).toBe(2);
  });

  it("does NOT emit coverage jobs when domain is missing", async () => {
    const res = await handler(
      { include_file_coverage: true, project_root: "/repo", min_memories: 4, min_avg_heat: 0 },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () => [memWithEntity(1), memWithEntity(2), memWithEntity(3), memWithEntity(4)],
        listMdPages: async () => [],
        listSourceFiles: async () => ["src/foo.ts"],
        readSourceFile: () => "body",
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.coverage_jobs).toEqual([]);
  });

  it("skips coverage for files whose wiki page already exists", async () => {
    const res = await handler(
      {
        include_file_coverage: true,
        project_root: "/repo",
        domain: "agentic-ai",
        min_memories: 4,
        min_avg_heat: 0,
      },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () =>
          Array.from({ length: 4 }, (_, i) => ({ ...memWithEntity(i + 1), domain: "agentic-ai" })),
        listMdPages: async () => ["reference/agentic-ai/foo.md"],
        listSourceFiles: async () => ["src/foo.ts", "src/bar.ts"],
        readSourceFile: () => "body",
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.coverage_jobs.map((j) => j.source_file)).toEqual(["src/bar.ts"]);
  });

  it("instructions mention drift + coverage when jobs are present", async () => {
    const res = await handler(
      {
        include_drift: true,
        include_file_coverage: true,
        project_root: "/repo",
        domain: "agentic-ai",
        min_memories: 4,
        min_avg_heat: 0,
      },
      {
        wikiRoot: "/tmp/wiki",
        getRecentlyAccessedMemories: async () =>
          Array.from({ length: 4 }, (_, i) => ({ ...memWithEntity(i + 1), domain: "agentic-ai" })),
        listMdPages: async () => ["reference/agentic-ai/drifted.md"],
        readPage: async () => "source: src/store.ts",
        pageMtime: () => nowSec - 30 * SECONDS_PER_DAY,
        sourceFileMtime: () => nowSec,
        listSourceFiles: async () => ["src/foo.ts"],
        readSourceFile: () => "body",
        today: () => "2026-05-18",
      },
    );
    if ("error" in res) throw new Error("unexpected error");
    expect(res.instructions).toContain("Drift refresh");
    expect(res.instructions).toContain("Coverage");
  });
});
