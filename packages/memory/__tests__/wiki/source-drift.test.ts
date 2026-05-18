/**
 * Tests for source-drift.ts — mtime-drift detector for wiki pages.
 *
 * source: packages/memory/src/wiki/source-drift.ts
 */

import { describe, expect, it } from "vitest";
import {
  auditPageDrift,
  auditWikiDrift,
  buildDriftRefreshPrompt,
  parseCitations,
  type DriftVerdict,
  type ScanPage,
} from "../../src/wiki/source-drift.js";
import type { PageMtimeFn } from "../../src/wiki/auto-curator.js";

// ── parseCitations ─────────────────────────────────────────────────────

describe("parseCitations", () => {
  it("extracts a path from a ``source: <path>`` line", () => {
    const c = "Lorem ipsum.\nsource: packages/memory/src/foo.ts — explanation\n";
    expect(parseCitations(c)).toEqual(["packages/memory/src/foo.ts"]);
  });

  it("extracts a path from a ``// source: <path>`` inline comment", () => {
    const c = "// source: scripts/build.sh — see README\n";
    expect(parseCitations(c)).toEqual(["scripts/build.sh"]);
  });

  it("extracts paths embedded in a citation line with prose", () => {
    const c = "source: cortex@deadbeef mcp_server/handlers/recall.py — fix #43";
    expect(parseCitations(c)).toEqual(["mcp_server/handlers/recall.py"]);
  });

  it("extracts paths from a frontmatter ``source_files: [a, b]`` list", () => {
    const c = "---\nsource_files: [a.ts, b/c.ts]\n---\nbody";
    expect(parseCitations(c).sort()).toEqual(["a.ts", "b/c.ts"]);
  });

  it("deduplicates the same path appearing in multiple citation lines", () => {
    const c = "source: foo.ts\nsource: bar.ts\n// source: foo.ts\n";
    expect(parseCitations(c).sort()).toEqual(["bar.ts", "foo.ts"]);
  });

  it("ignores absolute paths", () => {
    expect(parseCitations("source: /etc/hosts")).toEqual([]);
  });

  it("ignores URLs", () => {
    expect(parseCitations("source: https://example.com/foo.ts")).toEqual([]);
  });

  it("ignores non-source extensions (e.g. .png, .pdf)", () => {
    expect(parseCitations("source: foo.png").length).toBe(0);
  });

  it("returns empty for content with no citation lines", () => {
    expect(parseCitations("Just prose with no source markers.")).toEqual([]);
  });
});

// ── auditPageDrift ─────────────────────────────────────────────────────

describe("auditPageDrift", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const SECONDS_PER_DAY = 86400;

  it("flags drift when a cited source is newer than the page", () => {
    const mtime: PageMtimeFn = () => nowSec; // source modified now
    const pageMtime = nowSec - 10 * SECONDS_PER_DAY; // page is 10 days old
    const v = auditPageDrift("p.md", "source: foo.ts", pageMtime, mtime);
    expect(v.hasDrift).toBe(true);
    expect(v.resolvedSources).toEqual(["foo.ts"]);
    expect(v.newestSourceMtime).toBe(nowSec);
  });

  it("does not flag drift when sources are older than the page", () => {
    const mtime: PageMtimeFn = () => nowSec - 30 * SECONDS_PER_DAY;
    const pageMtime = nowSec - 5 * SECONDS_PER_DAY;
    const v = auditPageDrift("p.md", "source: foo.ts", pageMtime, mtime);
    expect(v.hasDrift).toBe(false);
  });

  it("does not flag drift when no citation resolves to a real file", () => {
    const mtime: PageMtimeFn = () => null; // every citation missing
    const v = auditPageDrift("p.md", "source: foo.ts", nowSec - SECONDS_PER_DAY, mtime);
    expect(v.hasDrift).toBe(false);
    expect(v.newestSourceMtime).toBeNull();
    expect(v.resolvedSources).toEqual([]);
  });

  it("does not flag drift when the page itself has no mtime", () => {
    const mtime: PageMtimeFn = () => nowSec;
    const v = auditPageDrift("p.md", "source: foo.ts", null, mtime);
    expect(v.hasDrift).toBe(false);
  });

  it("considers the newest of multiple cited sources", () => {
    const mtime: PageMtimeFn = (p) =>
      p === "old.ts" ? nowSec - 30 * SECONDS_PER_DAY :
      p === "new.ts" ? nowSec :
      null;
    const pageMtime = nowSec - 10 * SECONDS_PER_DAY;
    const v = auditPageDrift("p.md", "source: old.ts\nsource: new.ts", pageMtime, mtime);
    expect(v.hasDrift).toBe(true);
    expect(v.newestSourceMtime).toBe(nowSec);
  });
});

// ── auditWikiDrift (aggregate) ──────────────────────────────────────────

describe("auditWikiDrift", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const SECONDS_PER_DAY = 86400;

  it("returns an empty report for an empty page list", () => {
    const report = auditWikiDrift([], () => null);
    expect(report.totalScanned).toBe(0);
    expect(report.totalDrifted).toBe(0);
    expect(report.driftedPages).toEqual([]);
  });

  it("partitions verdicts into drifted vs fresh", () => {
    const pages: readonly ScanPage[] = [
      { path: "fresh.md", mtimeSeconds: nowSec - SECONDS_PER_DAY, content: "source: a.ts" },
      { path: "drift.md", mtimeSeconds: nowSec - 30 * SECONDS_PER_DAY, content: "source: a.ts" },
      { path: "nocite.md", mtimeSeconds: nowSec, content: "no citation" },
    ];
    // a.ts was modified 10 days ago — drifts vs the 30-day-old page, fresh vs the 1-day-old page.
    const mtime: PageMtimeFn = (p) => p === "a.ts" ? nowSec - 10 * SECONDS_PER_DAY : null;
    const report = auditWikiDrift(pages, mtime);
    expect(report.totalScanned).toBe(3);
    expect(report.totalDrifted).toBe(1);
    expect(report.driftedPages.map((v) => v.pagePath)).toEqual(["drift.md"]);
  });
});

// ── buildDriftRefreshPrompt ────────────────────────────────────────────

describe("buildDriftRefreshPrompt", () => {
  function v(over: Partial<DriftVerdict> = {}): DriftVerdict {
    return {
      pagePath: "reference/cortex/memorystore.md",
      pageMtimeSeconds: 1_700_000_000,
      citations: ["packages/memory/src/store.ts"],
      resolvedSources: ["packages/memory/src/store.ts"],
      newestSourceMtime: 1_700_100_000,
      hasDrift: true,
      ...over,
    };
  }

  it("embeds the page path and the drifted source list", () => {
    const p = buildDriftRefreshPrompt(v(), "existing body");
    expect(p).toContain("reference/cortex/memorystore.md");
    expect(p).toContain("- packages/memory/src/store.ts");
  });

  it("falls back to a sentinel when no resolved sources are present", () => {
    const p = buildDriftRefreshPrompt(v({ resolvedSources: [] }), "body");
    expect(p).toContain("synthetic drift flag");
  });

  it("embeds the existing body verbatim (truncated for very large pages)", () => {
    const body = "x".repeat(50_000);
    const p = buildDriftRefreshPrompt(v(), body);
    // Cap is 30 KB — page-of-50K must NOT appear verbatim.
    expect(p.includes(body)).toBe(false);
    // But a substantial prefix must.
    expect(p).toContain("x".repeat(1000));
  });
});
