/**
 * Tests for runWikiMaintenance — the consolidate-cycle wiki orchestrator.
 *
 * source: packages/memory/src/wiki/maintenance.ts
 * source: cortex/mcp_server/handlers/consolidation/wiki_maintenance.py
 */

import { describe, expect, it } from "vitest";
import {
  runWikiMaintenance,
  MAX_PURGES_PER_CYCLE,
  type RunWikiMaintenanceDeps,
} from "../../src/wiki/maintenance.js";
import type { MaintenanceStatsDeps } from "../../src/wiki/maintenance-stats.js";
import type { WikiPurgeDeps } from "../../src/wiki/handlers/wiki-purge.js";
import { SCOPES } from "../../src/wiki/scopes.js";

function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  if (rel.startsWith("/")) return rel;
  return root.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
}

function makeStatsDeps(over: Partial<MaintenanceStatsDeps> = {}): MaintenanceStatsDeps {
  return {
    wikiRoot:        "/wiki",
    listMdPages:     async () => [],
    readPage:        async () => null,
    pageMtime:       () => null,
    projectRootFor:  () => null,
    listSourceFiles: async () => [],
    fileMtime:       () => null,
    extractDomain:   () => null,
    ...over,
  };
}

function makePurgeDeps(over: Partial<WikiPurgeDeps> = {}): WikiPurgeDeps {
  return {
    wikiRoot:             "/wiki",
    listAllMarkdownFiles: async () => [],
    deleteFile:           async () => undefined,
    ...over,
  };
}

function makeDeps(over: Partial<RunWikiMaintenanceDeps> = {}): RunWikiMaintenanceDeps {
  return {
    wikiRoot:             "/wiki",
    memories:             [],
    purgeDeps:            makePurgeDeps(),
    maintenanceStatsDeps: makeStatsDeps(),
    listPageBodies:       async () => [],
    deleteFile:           async () => undefined,
    joinPath,
    ...over,
  };
}

describe("runWikiMaintenance — stub axis", () => {
  it("purges placeholder-only pages in apply mode", async () => {
    const deleted: string[] = [];
    const pages = [
      { relPath: "lessons/cortex/stub1.md", content: "# T\n\n_(to be filled)_\n" },
      { relPath: "lessons/cortex/real.md",  content: "# T\n\nReal prose with a sentence." },
      { relPath: "lessons/cortex/stub2.md", content: "# T\n\n_To be written._\n" },
    ];
    const result = await runWikiMaintenance(
      makeDeps({
        listPageBodies: async () => pages,
        deleteFile: async (absPath) => { deleted.push(absPath); },
      }),
      { applyStubs: true, applyClassifierRejects: false, maxPurgesPerAxis: 100 },
    );
    expect(result.stub.purged).toBe(2);
    expect(deleted.length).toBe(2);
    expect(deleted.every((p) => p.includes("stub"))).toBe(true);
  });

  it("counts but does not delete in dry-run mode (applyStubs=false)", async () => {
    const deleted: string[] = [];
    const pages = [
      { relPath: "stub.md", content: "_(to be filled)_" },
      { relPath: "real.md", content: "Real authored content here." },
    ];
    const result = await runWikiMaintenance(
      makeDeps({
        listPageBodies: async () => pages,
        deleteFile: async (p) => { deleted.push(p); },
      }),
      { applyStubs: false, applyClassifierRejects: false },
    );
    expect(result.stub.applied).toBe(false);
    expect(result.stub.purged).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("defers purges over the per-cycle cap", async () => {
    const N = 600;
    const pages = Array.from({ length: N }, (_, i) => ({
      relPath: `stub${i}.md`,
      content: "_(to be filled)_",
    }));
    const result = await runWikiMaintenance(
      makeDeps({ listPageBodies: async () => pages }),
      { applyStubs: true, applyClassifierRejects: false, maxPurgesPerAxis: 100 },
    );
    expect(result.stub.purged).toBe(100);
    expect(result.stub.deferred).toBe(500);
  });

  it("treats deleteFile throws as deferred rather than crashing", async () => {
    const pages = [
      { relPath: "stub.md", content: "_(to be filled)_" },
    ];
    const result = await runWikiMaintenance(
      makeDeps({
        listPageBodies: async () => pages,
        deleteFile: async () => { throw new Error("EACCES"); },
      }),
      { applyStubs: true, applyClassifierRejects: false },
    );
    expect(result.stub.purged).toBe(0);
    expect(result.stub.deferred).toBe(1);
    // Outer status stays "ok" — the deferred-on-delete-fail isn't a global failure.
    expect(result.status).toBe("ok");
  });
});

describe("runWikiMaintenance — backlog count", () => {
  it("aggregates cluster_jobs + coverage_gaps + drifted_pages into pending_total", async () => {
    const result = await runWikiMaintenance(
      makeDeps({
        memories: [
          { id: 1, content: "MemoryStore inserts", tags: [], domain: "cortex",
            effective_heat: 0.6, created_at: "2026-05-17" },
          { id: 2, content: "MemoryStore inserts", tags: [], domain: "cortex",
            effective_heat: 0.6, created_at: "2026-05-17" },
          { id: 3, content: "MemoryStore inserts", tags: [], domain: "cortex",
            effective_heat: 0.6, created_at: "2026-05-17" },
          { id: 4, content: "MemoryStore inserts", tags: [], domain: "cortex",
            effective_heat: 0.6, created_at: "2026-05-17" },
        ],
        maintenanceStatsDeps: makeStatsDeps({
          listMdPages: async () => ["reference/cortex/known.md"],
          readPage:    async () => "source: src/store.ts",
          pageMtime:   () => 1_000_000,
          projectRootFor:  () => "/repo",
          listSourceFiles: async () => ["src/known.ts", "src/uncovered.ts"],
          fileMtime:       (_root, p) => p === "src/store.ts" ? 999_999_999 : null,
          // Domain extractor: pull the project from "<kind>/<domain>/<slug>.md".
          extractDomain:   (path) => path.split("/")[1] ?? null,
        }),
      }),
      { applyStubs: false, applyClassifierRejects: false },
    );
    expect(result.cluster_jobs).toBeGreaterThan(0);
    expect(result.coverage_gaps).toBeGreaterThan(0);
    expect(result.drifted_pages).toBeGreaterThan(0);
    expect(result.pending_total).toBe(
      result.cluster_jobs + result.coverage_gaps + result.drifted_pages,
    );
  });
});

describe("runWikiMaintenance — failure isolation", () => {
  it("returns ok status when everything is empty", async () => {
    const result = await runWikiMaintenance(makeDeps(), {
      applyStubs: false,
      applyClassifierRejects: false,
    });
    expect(result.status).toBe("ok");
    expect(result.stub.purged).toBe(0);
    expect(result.classifier.purged).toBe(0);
  });

  it("respects the MAX_PURGES_PER_CYCLE default when no cap is provided", async () => {
    expect(MAX_PURGES_PER_CYCLE).toBe(500);
  });
});

// ── G6 / G5 — scope-coverage audit + dashboard pass ────────────────────

describe("runWikiMaintenance — scope-coverage audit", () => {
  it("reports zero scope gaps when no G6 adapters wired", async () => {
    const result = await runWikiMaintenance(makeDeps(), {});
    expect(result.scope_coverage_gaps).toBe(0);
    expect(result.dashboards.written).toBe(0);
  });

  it("counts missing scopes per discovered domain", async () => {
    const result = await runWikiMaintenance(makeDeps({
      listSubdirs: (dir) => {
        const subs: Record<string, readonly string[]> = {
          reference: ["alpha", "beta"],
          explanation: ["alpha", "beta"],
        };
        return subs[dir] ?? [];
      },
      pageStat: () => null,            // no anchor pages → every scope missing
      countSubstantivePages: () => 0,
    }), {});
    // 2 domains × SCOPES.length canonical scopes. Asserting against the
    // live constant means new scopes added to the catalogue can't
    // silently break the count contract.
    const expectedGaps = 2 * SCOPES.length;
    expect(result.scope_coverage_gaps).toBe(expectedGaps);
    expect(result.pending_total).toBeGreaterThanOrEqual(expectedGaps);
  });

  it("writes per-project dashboards + index when writer is wired", async () => {
    const writes: Array<{ path: string; body: string }> = [];
    const result = await runWikiMaintenance(makeDeps({
      listSubdirs: (dir) => {
        const subs: Record<string, readonly string[]> = {
          reference: ["alpha"],
          explanation: ["alpha"],
        };
        return subs[dir] ?? [];
      },
      pageStat: () => null,
      countSubstantivePages: () => 0,
      fileCoverageRollup: (d) => ({
        domain: d, sourceRoot: null, sourceFileCount: 0, coveredFileCount: 0, uncoveredFiles: [],
      }),
      kindCounts: () => ({}),
      curationGapCounts: () => ({ totalPages: 0, openGaps: 0 }),
      writeWikiPage: async (path, body) => { writes.push({ path, body }); return true; },
    }), {});
    expect(result.dashboards.written).toBe(1);
    expect(result.dashboards.projects).toEqual(["alpha"]);
    const paths = writes.map((w) => w.path);
    expect(paths).toContain("_dashboards/alpha.md");
    expect(paths).toContain("_dashboards/_index.md");
    const dashboardWrite = writes.find((w) => w.path === "_dashboards/alpha.md");
    expect(dashboardWrite?.body).toContain("alpha — documentation coverage");
  });

  it("isolates per-project dashboard failures", async () => {
    let writeCalls = 0;
    const result = await runWikiMaintenance(makeDeps({
      listSubdirs: (dir) => {
        const subs: Record<string, readonly string[]> = {
          reference: ["alpha", "beta"],
          explanation: ["alpha", "beta"],
        };
        return subs[dir] ?? [];
      },
      pageStat: () => null,
      countSubstantivePages: () => 0,
      fileCoverageRollup: (d) => ({
        domain: d, sourceRoot: null, sourceFileCount: 0, coveredFileCount: 0, uncoveredFiles: [],
      }),
      kindCounts: () => ({}),
      curationGapCounts: () => ({ totalPages: 0, openGaps: 0 }),
      writeWikiPage: async (path) => {
        writeCalls += 1;
        // Fail the first per-project write, succeed the rest.
        if (path === "_dashboards/alpha.md") return false;
        return true;
      },
    }), {});
    expect(writeCalls).toBeGreaterThan(0);
    expect(result.dashboards.written).toBe(1); // only beta succeeded
    expect(result.dashboards.projects).toEqual(["beta"]);
    expect(result.status).toBe("ok"); // partial-failure doesn't taint status
  });
});
