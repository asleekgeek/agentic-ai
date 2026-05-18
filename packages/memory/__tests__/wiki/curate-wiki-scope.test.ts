/**
 * Tests for curate-wiki-scope.ts — scope-coverage + reauthor branches.
 *
 * source: packages/memory/src/wiki/handlers/curate-wiki-scope.ts
 */

import { describe, expect, it } from "vitest";
import {
  computeReauthorJobs,
  computeScopeCoverageJobs,
  type ReauthorBranchDeps,
  type ScopeCoverageDeps,
} from "../../src/wiki/handlers/curate-wiki-scope.js";
import { MIN_PAGE_BYTES } from "../../src/wiki/scopes.js";

const NOW = 1_700_000_000;
const FRESH = NOW - 30 * 86400;

function baseDeps(): ScopeCoverageDeps {
  return {
    wikiRoot: "/wiki",
    listSubdirs: (dir) => {
      const subs: Record<string, string[]> = {
        reference: ["demo"],
        explanation: ["demo"],
      };
      return subs[dir] ?? [];
    },
    auditAdapters: {
      pageStat: () => null,
      countSubstantivePages: () => 0,
      nowSec: NOW,
    },
  };
}

// ── computeScopeCoverageJobs ───────────────────────────────────────────

describe("computeScopeCoverageJobs", () => {
  it("returns empty when include_scope_coverage is false", () => {
    const result = computeScopeCoverageJobs(
      { include_scope_coverage: false, scope_coverage_jobs_max: 5 },
      baseDeps(),
      [],
      new Map(),
    );
    expect(result.jobs).toEqual([]);
    expect(result.summary).toEqual([]);
  });

  it("returns empty when scope_coverage_jobs_max is 0", () => {
    const result = computeScopeCoverageJobs(
      { include_scope_coverage: true, scope_coverage_jobs_max: 0 },
      baseDeps(),
      [],
      new Map(),
    );
    expect(result.jobs).toEqual([]);
  });

  it("emits scope-coverage jobs for uncovered scopes, sorted by primacy", () => {
    const result = computeScopeCoverageJobs(
      { include_scope_coverage: true, scope_coverage_jobs_max: 3, today: "2026-05-18" },
      baseDeps(),
      [],
      new Map(),
    );
    expect(result.jobs.length).toBe(3);
    // architecture should be first by primacy.
    expect(result.jobs[0]?.scope_name).toBe("architecture");
    expect(result.jobs[0]?.job_type).toBe("scope-coverage");
    expect(result.jobs[0]?.prompt).toContain("2026-05-18");
  });

  it("filters to the requested domain", () => {
    const deps: ScopeCoverageDeps = {
      ...baseDeps(),
      listSubdirs: (dir) => {
        const subs: Record<string, string[]> = {
          reference: ["alpha", "beta"],
          explanation: ["alpha", "beta"],
        };
        return subs[dir] ?? [];
      },
    };
    const result = computeScopeCoverageJobs(
      { domain: "alpha", include_scope_coverage: true, scope_coverage_jobs_max: 100 },
      deps,
      [],
      new Map(),
    );
    expect(result.jobs.every((j) => j.domain === "alpha")).toBe(true);
    expect(result.summary.map((s) => s.domain)).toEqual(["alpha"]);
  });

  it("populates supporting memories per domain", () => {
    const result = computeScopeCoverageJobs(
      { include_scope_coverage: true, scope_coverage_jobs_max: 1 },
      baseDeps(),
      [{ id: 7, content: "demo memory", domain: "demo", tags: ["architecture"] }],
      new Map(),
    );
    expect(result.jobs[0]?.supporting_memory_ids).toEqual([7]);
    expect(result.jobs[0]?.prompt).toContain("demo memory");
  });

  it("emits per-domain summary rows with covered/missing counts", () => {
    const deps: ScopeCoverageDeps = {
      ...baseDeps(),
      // Mark architecture as covered for demo via the page-stat adapter.
      auditAdapters: {
        pageStat: (rel) =>
          rel === "reference/demo/architecture-overview.md"
            ? { sizeBytes: MIN_PAGE_BYTES + 100, mtimeSec: FRESH }
            : null,
        countSubstantivePages: () => 0,
        nowSec: NOW,
      },
    };
    const result = computeScopeCoverageJobs(
      { include_scope_coverage: true, scope_coverage_jobs_max: 100 },
      deps,
      [],
      new Map(),
    );
    expect(result.summary[0]?.domain).toBe("demo");
    expect(result.summary[0]?.covered).toBe(1);
    expect(result.summary[0]?.missing).toBe(14); // 15 total scopes − 1 covered
    expect(result.summary[0]?.missing_scopes).not.toContain("architecture");
  });
});

// ── computeReauthorJobs (gated by adapters) ────────────────────────────

describe("computeReauthorJobs", () => {
  it("returns empty when include_reauthor is false", async () => {
    const deps: ReauthorBranchDeps = { ...baseDeps() };
    const jobs = await computeReauthorJobs(
      { include_reauthor: false, reauthor_jobs_max: 5, project_root: "/p" },
      deps,
    );
    expect(jobs).toEqual([]);
  });

  it("returns empty when required adapters are missing", async () => {
    const deps: ReauthorBranchDeps = { ...baseDeps() };
    const jobs = await computeReauthorJobs(
      { include_reauthor: true, reauthor_jobs_max: 5, project_root: "/p" },
      deps,
    );
    expect(jobs).toEqual([]);
  });

  it("emits reauthor jobs when drift exists and all adapters wired", async () => {
    const pageMtimeSec = NOW - 60 * 86400;
    const sourceMtimeSec = NOW - 10 * 86400; // newer than page → drift
    const deps: ReauthorBranchDeps = {
      ...baseDeps(),
      pageMtime: () => pageMtimeSec,
      sourceFileMtime: () => sourceMtimeSec,
      readPage: async () => "source: packages/demo/foo.ts\n\nbody",
      listMdPages: async () => ["reference/demo/foo.md"],
      readWikiPageBody: () => "source: packages/demo/foo.ts\n\nbody",
      sourceRootResolver: () => "/src/demo",
    };
    const jobs = await computeReauthorJobs(
      {
        include_reauthor: true,
        reauthor_jobs_max: 5,
        project_root: "/p",
        today: "2026-05-18",
      },
      deps,
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.job_type).toBe("reauthor");
    expect(jobs[0]?.suggested_path).toBe("reference/demo/foo.md");
    expect(jobs[0]?.domain).toBe("demo");
    expect(jobs[0]?.suggested_kind).toBe("reference");
    expect(jobs[0]?.prompt).toContain("Re-author the page");
  });
});
