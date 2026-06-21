/**
 * Wiring tests for bounded-IO at the four read boundaries (A6#1) — port of the
 * in-scope subset of tests_py/handlers/test_response_budget_wiring.py
 * (Cortex HEAD bc5af469).
 *
 * Covered surfaces: recall, unified_search, wiki_read, query_methodology.
 * Each test drives the real TS handler with content that overflows the
 * production budget (MAX_RESPONSE_CHARS = 75 000) and asserts the response
 * lands under budget with the oracle's truncation bookkeeping.
 *
 * OUT OF SCOPE (separate work items, not yet ported):
 *   - recall fetch-by-id + content_offset paging (A6#6): the TS recall handler
 *     has no memory_id path, so test_recall_fetch_by_id_* are deferred.
 *   - query_methodology hotMemories pressure: hotMemories are populated by an
 *     infrastructure layer not yet ported, so they stay []; the meaningful
 *     bound here is on the assembled `context` string (TextTarget("context")).
 *
 * Source of truth: anthropic-partnership/Cortex/tests_py/handlers/test_response_budget_wiring.py
 */

import { describe, it, expect } from "vitest";

import {
  serializedLength,
  MAX_RESPONSE_CHARS,
} from "../../src/recall/response-budget.js";
import { recallHandler } from "../../src/recall/recall-handler.js";
import { unifiedSearchHandler } from "../../src/narrative/handlers/unified-search.js";
import { handler as wikiReadHandler } from "../../src/wiki/handlers/wiki-read.js";
import type { WikiReadResult, WikiReadDeps } from "../../src/wiki/handlers/wiki-read.js";
import { queryMethodology } from "../../src/methodology/handlers/query-methodology.js";
import type { ProfilesStore } from "../../src/methodology/types.js";
import {
  InMemoryStore,
  makeSeedMemory,
  NullEmbeddingEngine,
} from "./memory-store-stub.js";

// A single fat memory body that, replicated, overflows the 75 000-char budget.
const FAT = "a".repeat(20_000);

function fatStore(n: number): InMemoryStore {
  // tags: [] so the low-signal filter (which unified_search cannot bypass)
  // keeps every memory. content is exactly FAT so content_length pins to 20 000.
  const seeds = Array.from({ length: n }, (_, i) =>
    makeSeedMemory(i + 1, FAT, { heat: 0.8, tags: [] }),
  );
  return new InMemoryStore(seeds);
}

// ── recall ───────────────────────────────────────────────────────────────────

describe("wiring: recall", () => {
  // Port of: test_recall_response_fits_budget (wiring L89-103).
  it("bounds the response and marks oversized memories truncated", async () => {
    const store = fatStore(5);
    const result = await recallHandler(
      { query: "aaaa", max_results: 5, min_heat: 0.05, include_low_signal: true },
      store,
      new NullEmbeddingEngine(),
    );

    expect(serializedLength(result)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(result.count).toBe(result.memories.length);

    const truncated = result.memories.filter(
      (m) => (m as Record<string, unknown>)["truncated"] === true,
    );
    expect(truncated.length).toBeGreaterThan(0);
    for (const m of truncated) {
      expect(m.memory_id).not.toBeNull(); // retrievable by id
      expect((m as Record<string, unknown>)["content_length"]).toBe(20_000); // ORIGINAL size
    }
  });
});

// ── unified_search ─────────────────────────────────────────────────────────

describe("wiring: unified_search", () => {
  // Port of: test_unified_search_response_fits_budget (wiring L149-166).
  it("bounds results, recomputes counts.fused, preserves fusion ids", async () => {
    const store = fatStore(5);
    const response = await unifiedSearchHandler(
      { recallStore: store, embedder: null },
      { query: "aaaa", max_results: 5 },
    );

    expect(serializedLength(response)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(response.counts.fused).toBe(response.results.length);
    expect(response.results.some((r) => r["truncated"] === true)).toBe(true);
    for (const r of response.results) {
      expect(String(r["id"]).startsWith("memory:")).toBe(true); // fusion id survives
    }
  });
});

// ── wiki_read ────────────────────────────────────────────────────────────────

function asResult(r: WikiReadResult | { error: string }): WikiReadResult {
  if ("error" in r) throw new Error(`unexpected wiki_read error: ${r.error}`);
  return r;
}

describe("wiring: wiki_read", () => {
  // Distinct digits so offset slices are position-dependent (not all-identical).
  const body = Array.from({ length: 80_000 }, (_, i) => String(i % 10)).join("");
  const deps: WikiReadDeps = {
    wikiRoot: "/wiki",
    readPage: async () => body,
  };

  // Port of: test_wiki_read_pages_large_page_via_offset (wiring L171-191).
  it("pages a large page via offset; content_length stays the full size", async () => {
    const first = asResult(
      await wikiReadHandler({ path: "notes/big.md", follow_redirects: false }, deps),
    );
    expect(serializedLength(first)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(first.content_truncated).toBe(true);
    expect(first.content_length).toBe(80_000); // FULL page size
    expect(first.offset).toBe(0);
    expect(body.startsWith(first.content)).toBe(true);

    const offset = first.content.length;
    const second = asResult(
      await wikiReadHandler({ path: "notes/big.md", follow_redirects: false, offset }, deps),
    );
    expect(second.content).toBe(body.slice(offset, offset + second.content.length));
    expect(second.content_length).toBe(80_000); // still FULL
    expect(second.offset).toBe(offset);
  });

  // Port of: test_wiki_read_small_page_untruncated (wiring L194-203).
  it("returns a small page untruncated (content_length set, no truncated flag)", async () => {
    const smallDeps: WikiReadDeps = { wikiRoot: "/wiki", readPage: async () => "tiny" };
    const resp = asResult(
      await wikiReadHandler({ path: "notes/small.md", follow_redirects: false }, smallDeps),
    );
    expect(resp.content).toBe("tiny");
    expect(resp.content_length).toBe(4);
    expect(resp.content_truncated).toBeUndefined();
  });
});

// ── query_methodology ────────────────────────────────────────────────────────

describe("wiring: query_methodology", () => {
  // Port of: test_query_methodology_response_fits_budget (wiring L209-234),
  // adapted: hotMemories population is deferred (stays []), so the budget
  // pressure is the assembled `context`. We inflate `profile.label` — it flows
  // into `context` via generateContext but is NOT itself a response field, so
  // `context` is the ONLY oversized key and TextTarget("context") can bound it.
  it("bounds an oversized context string", () => {
    const hugeLabel = "L".repeat(90_000);
    const profiles: ProfilesStore = {
      domains: {
        cortex: {
          id: "cortex",
          label: hugeLabel,
          projects: ["-Users-alice-code-cortex"],
          categories: {},
          topKeywords: [],
          entryPoints: [],
          recurringPatterns: [],
          toolPreferences: {},
          sessionShape: {
            avgDuration: 900_000,
            avgTurns: 15,
            avgMessages: 10,
            burstRatio: 0.2,
            explorationRatio: 0.4,
            dominantMode: "mixed",
          },
          connectionBridges: [],
          blindSpots: [],
          metacognitive: { activeReflective: 0, sensingIntuitive: 0, sequentialGlobal: 0 },
          confidence: 0.8,
          sessionCount: 40,
          lastUpdated: "2026-04-20T10:00:00Z",
          firstSeen: "2026-01-01T10:00:00Z",
          categoryDistribution: {},
        },
      },
    };

    const result = queryMethodology(
      { cwd: "/Users/alice/code/cortex", project: "-Users-alice-code-cortex" },
      profiles,
    );
    const bag = result as unknown as Record<string, unknown>;

    expect(result.coldStart).toBe(false);
    expect(serializedLength(result)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(bag["context_truncated"]).toBe(true);
    expect(bag["context_length"] as number).toBeGreaterThanOrEqual(90_000); // full size preserved
  });
});
