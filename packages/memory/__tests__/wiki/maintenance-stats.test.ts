/**
 * Tests for maintenance-stats.ts — drift + coverage aggregator.
 *
 * source: packages/memory/src/wiki/maintenance-stats.ts
 */

import { describe, expect, it } from "vitest";
import {
  computeWikiMaintenanceStats,
  defaultExtractDomain,
  type MaintenanceStatsDeps,
} from "../../src/wiki/maintenance-stats.js";

// ── defaultExtractDomain ───────────────────────────────────────────────

describe("defaultExtractDomain", () => {
  it("returns the second path segment for a kind/domain/slug path", () => {
    expect(defaultExtractDomain("reference/agentic-ai/foo.md")).toBe("agentic-ai");
  });

  it("returns null for paths with fewer than 3 segments", () => {
    expect(defaultExtractDomain("INDEX.md")).toBeNull();
    expect(defaultExtractDomain("reference/foo.md")).toBeNull();
  });

  it("returns null for placeholder buckets (leading underscore)", () => {
    expect(defaultExtractDomain("reference/_general/foo.md")).toBeNull();
  });
});

// ── computeWikiMaintenanceStats ────────────────────────────────────────

describe("computeWikiMaintenanceStats", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const SECONDS_PER_DAY = 86400;

  function makeDeps(over: Partial<MaintenanceStatsDeps> = {}): MaintenanceStatsDeps {
    return {
      wikiRoot:        "/tmp/wiki",
      listMdPages:     async () => [],
      readPage:        async () => "",
      pageMtime:       () => null,
      projectRootFor:  () => null,
      listSourceFiles: async () => [],
      fileMtime:       () => null,
      extractDomain:   defaultExtractDomain,
      ...over,
    };
  }

  it("returns zeros when no wiki pages exist", async () => {
    const stats = await computeWikiMaintenanceStats(makeDeps());
    expect(stats.totalDrift).toBe(0);
    expect(stats.totalCoverage).toBe(0);
    expect(stats.totalPages).toBe(0);
    expect(stats.perProject.size).toBe(0);
  });

  it("partitions counts per domain", async () => {
    const stats = await computeWikiMaintenanceStats(
      makeDeps({
        listMdPages: async () => [
          "reference/agentic-ai/a.md",
          "reference/cortex/b.md",
        ],
        readPage: async () => "",
        pageMtime: () => nowSec - 30 * SECONDS_PER_DAY,
        projectRootFor: (d) => d === "agentic-ai" ? "/repo/agentic" : "/repo/cortex",
        listSourceFiles: async () => [],
      }),
    );
    expect(stats.totalPages).toBe(2);
    expect(stats.perProject.size).toBe(2);
    expect(stats.perProject.get("agentic-ai")?.projectRoot).toBe("/repo/agentic");
  });

  it("counts drift when a cited source is newer than the page", async () => {
    const stats = await computeWikiMaintenanceStats(
      makeDeps({
        listMdPages: async () => ["reference/agentic-ai/drift.md"],
        readPage: async () => "source: src/store.ts",
        pageMtime: () => nowSec - 30 * SECONDS_PER_DAY,
        projectRootFor: () => "/repo",
        fileMtime: (_, p) => p === "src/store.ts" ? nowSec : null,
        listSourceFiles: async () => [],
      }),
    );
    expect(stats.totalDrift).toBe(1);
    expect(stats.perProject.get("agentic-ai")?.drift).toBe(1);
  });

  it("counts coverage gap for source files with no page", async () => {
    const stats = await computeWikiMaintenanceStats(
      makeDeps({
        listMdPages: async () => ["reference/proj/known.md"],
        readPage: async () => "",
        pageMtime: () => nowSec,
        projectRootFor: () => "/repo",
        listSourceFiles: async () => ["src/known.ts", "src/missing.ts"],
      }),
    );
    expect(stats.totalCoverage).toBe(1);
    expect(stats.perProject.get("proj")?.coverage).toBe(1);
  });

  it("skips drift+coverage for domains with no project_root", async () => {
    const stats = await computeWikiMaintenanceStats(
      makeDeps({
        listMdPages: async () => ["reference/ghost/a.md"],
        readPage: async () => "source: src/store.ts",
        pageMtime: () => 1,
        projectRootFor: () => null, // no root resolves
        fileMtime: () => nowSec,
        listSourceFiles: async () => ["foo.ts"],
      }),
    );
    expect(stats.totalDrift).toBe(0);
    expect(stats.totalCoverage).toBe(0);
    expect(stats.perProject.get("ghost")?.projectRoot).toBeNull();
  });

  it("ignores adapter throws (best-effort guarantee)", async () => {
    const stats = await computeWikiMaintenanceStats(
      makeDeps({
        listMdPages: async () => ["reference/p/a.md"],
        readPage: async () => { throw new Error("boom"); },
        pageMtime: () => { throw new Error("boom"); },
        projectRootFor: () => "/repo",
        fileMtime: () => { throw new Error("boom"); },
        listSourceFiles: async () => { throw new Error("boom"); },
      }),
    );
    expect(stats.totalDrift).toBe(0);
    expect(stats.totalCoverage).toBe(0);
  });
});
