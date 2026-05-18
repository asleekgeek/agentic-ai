/**
 * Tests for wiki-purge.ts — three-axis purge handler.
 *
 * source: packages/memory/src/wiki/handlers/wiki-purge.ts
 * source: cortex@HEAD~ mcp_server/handlers/wiki_purge.py (2026-05-18)
 */

import { describe, expect, it } from "vitest";
import {
  handler as wikiPurgeHandler,
  type PageEntry,
  type WikiPurgeDeps,
  type WikiPurgeResult,
} from "../../src/wiki/handlers/wiki-purge.js";

function deps(entries: readonly PageEntry[]): WikiPurgeDeps {
  return {
    wikiRoot: "/wiki",
    listAllMarkdownFiles: async () => [...entries],
    deleteFile: async () => undefined,
  };
}

// ── Stub axis ───────────────────────────────────────────────────────────

describe("wiki-purge — stub axis", () => {
  it("flags pages whose body is majority placeholder markers", async () => {
    const stubBody = [
      "---",
      "title: Stub",
      "---",
      "# Stub",
      "",
      "## Purpose",
      "_(to be filled)_",
      "",
      "## Public API",
      "_To be written._",
      "",
      "## How it works",
      "_(none identified)_",
    ].join("\n");
    const result = await wikiPurgeHandler({}, deps([{ relPath: "reference/demo/stub.md", content: stubBody }]));
    const r = result as WikiPurgeResult;
    expect(r.purged).toBe(1);
    expect(r.purged_reasons.stub).toBe(1);
    expect(r.placeholder_lines_purged).toBeGreaterThan(0);
  });

  it("keeps pages with substantial prose body", async () => {
    const realBody = [
      "---",
      "title: Real",
      "---",
      "# Real",
      "",
      "## Purpose",
      "This file owns the lifecycle of authoring jobs from cluster ",
      "discovery through prompt construction. It is invoked by the ",
      "consolidate handler on each cycle. It maintains the invariant ",
      "that no cluster produces a job for a page that already exists ",
      "within the freshness window. Tests exercise both paths with ",
      "deterministic clock injection so the recently-authored filter ",
      "can be observed without sleeping. The handler also serialises ",
      "every cluster job through the wire-shape contract defined in ",
      "the auto-curator module. Coverage jobs follow a similar path ",
      "but use a different prompt template tailored for structural ",
      "scope authoring rather than topical synthesis from memories.",
    ].join("\n");
    const result = await wikiPurgeHandler(
      { purge_classifier_rejects: false },
      deps([{ relPath: "reference/demo/real.md", content: realBody }]),
    );
    const r = result as WikiPurgeResult;
    expect(r.kept).toBe(1);
    expect(r.purged).toBe(0);
  });
});

// ── Shallow axis ────────────────────────────────────────────────────────

describe("wiki-purge — shallow axis", () => {
  it("flags pages with fewer than shallow_threshold prose chars", async () => {
    const tinyBody = "---\ntitle: Tiny\n---\n\nhi";
    const result = await wikiPurgeHandler(
      { purge_stubs: false, purge_classifier_rejects: false },
      deps([{ relPath: "reference/demo/tiny.md", content: tinyBody }]),
    );
    const r = result as WikiPurgeResult;
    expect(r.purged_reasons.shallow).toBe(1);
  });
});

// ── Cap behaviour ───────────────────────────────────────────────────────

describe("wiki-purge — max_purges cap", () => {
  const stubBody = [
    "---", "title: stub", "---",
    "# stub",
    "## Purpose", "_(to be filled)_",
    "## How it works", "_To be written._",
  ].join("\n");

  it("defers pages beyond max_purges when apply=true", async () => {
    const entries: PageEntry[] = Array.from({ length: 5 }, (_, i) => ({
      relPath: `reference/demo/stub-${i}.md`,
      content: stubBody,
    }));
    const result = await wikiPurgeHandler(
      { apply: true, max_purges: 2 },
      deps(entries),
    );
    const r = result as WikiPurgeResult;
    expect(r.purged).toBe(2);
    expect(r.deferred).toBe(3);
    expect(r.cap_reached).toBe(true);
    expect(r.scanned).toBe(5);
  });

  it("dry-run ignores the cap so operators see the full backlog", async () => {
    const entries: PageEntry[] = Array.from({ length: 5 }, (_, i) => ({
      relPath: `reference/demo/stub-${i}.md`,
      content: stubBody,
    }));
    const result = await wikiPurgeHandler(
      { apply: false, max_purges: 2 },
      deps(entries),
    );
    const r = result as WikiPurgeResult;
    expect(r.purged).toBe(5);
    expect(r.deferred).toBe(0);
    expect(r.cap_reached).toBe(false);
  });

  it("0 / undefined max_purges disables the cap", async () => {
    const entries: PageEntry[] = Array.from({ length: 3 }, (_, i) => ({
      relPath: `reference/demo/stub-${i}.md`,
      content: stubBody,
    }));
    const result = await wikiPurgeHandler(
      { apply: true, max_purges: 0 },
      deps(entries),
    );
    const r = result as WikiPurgeResult;
    expect(r.purged).toBe(3);
    expect(r.deferred).toBe(0);
    expect(r.max_purges).toBeNull();
  });
});

// ── Axis gating ─────────────────────────────────────────────────────────

describe("wiki-purge — axis gating", () => {
  it("respects purge_stubs=false", async () => {
    const stubBody = "---\ntitle: x\n---\n## Purpose\n_(to be filled)_\n## How\n_To be written._";
    const result = await wikiPurgeHandler(
      { purge_stubs: false, purge_shallow: false, purge_classifier_rejects: false },
      deps([{ relPath: "reference/demo/x.md", content: stubBody }]),
    );
    const r = result as WikiPurgeResult;
    expect(r.purged).toBe(0);
    expect(r.kept).toBe(1);
  });
});
