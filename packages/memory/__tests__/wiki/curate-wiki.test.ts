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
