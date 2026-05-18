/**
 * Tests for coverage-jobs.ts — coverage-driven authoring jobs.
 *
 * source: packages/memory/src/wiki/coverage-jobs.ts
 */

import { describe, expect, it } from "vitest";
import {
  buildCoverageJobs,
  buildCoveragePrompt,
  findRelatedPagesForScope,
  sortCoverageJobs,
  type CoverageJob,
} from "../../src/wiki/coverage-jobs.js";
import type { DomainCoverage } from "../../src/wiki/domain-coverage.js";
import { SCOPES, suggestedPathFor } from "../../src/wiki/scopes.js";

function buildDomainCoverage(domain: string, missingScopeNames: string[]): DomainCoverage {
  return {
    domain,
    scopes: SCOPES.map((scope) => ({
      scope,
      domain,
      covered: !missingScopeNames.includes(scope.name),
      pageCount: 0,
      anchorPage: null,
      suggestedPath: suggestedPathFor(scope, domain),
    })),
  };
}

// ── buildCoveragePrompt ────────────────────────────────────────────────

describe("buildCoveragePrompt", () => {
  it("interpolates scope + domain + today into the template", () => {
    const out = buildCoveragePrompt({
      scopeName: "architecture",
      scopeTitle: "Architecture overview",
      scopeDescription: "Overall design + layers.",
      suggestedKind: "explanation",
      suggestedPath: "explanation/demo/architecture-overview.md",
      domain: "demo",
      relatedPages: ["reference/demo/services"],
      supportingMemories: [],
      supportingTags: [],
      today: "2026-05-18",
    });
    expect(out).toContain("project `demo` has no substantive page");
    expect(out).toContain("scope `architecture`");
    expect(out).toContain("Architecture overview");
    expect(out).toContain("Overall design + layers.");
    expect(out).toContain("explanation/demo/architecture-overview.md");
    expect(out).toContain("- [[reference/demo/services]]");
    expect(out).toContain("2026-05-18");
  });

  it("renders ``(none yet — this is a fresh topic)`` when no related pages", () => {
    const out = buildCoveragePrompt({
      scopeName: "api",
      scopeTitle: "Public API",
      scopeDescription: "x",
      suggestedKind: "reference",
      suggestedPath: "reference/demo/api.md",
      domain: "demo",
      relatedPages: [],
      supportingMemories: [],
      supportingTags: [],
      today: "2026-05-18",
    });
    expect(out).toContain("(none yet — this is a fresh topic)");
  });

  it("renders supporting memories with their tags", () => {
    const out = buildCoveragePrompt({
      scopeName: "api",
      scopeTitle: "Public API",
      scopeDescription: "x",
      suggestedKind: "reference",
      suggestedPath: "reference/demo/api.md",
      domain: "demo",
      relatedPages: [],
      supportingMemories: ["Memory body A", "Memory body B"],
      supportingTags: [["api", "design"], ["lesson"]],
      today: "2026-05-18",
    });
    expect(out).toContain("Memory 1 (tags: api, design)");
    expect(out).toContain("Memory body A");
    expect(out).toContain("Memory 2 (tags: lesson)");
    expect(out).toContain("Memory body B");
  });
});

// ── findRelatedPagesForScope ───────────────────────────────────────────

describe("findRelatedPagesForScope", () => {
  it("matches existing pages that mention the domain", () => {
    const index = new Map<string, readonly string[]>([
      ["demo backend", ["reference/demo/backend"]],
      ["unrelated", ["reference/other/page"]],
    ]);
    expect(findRelatedPagesForScope("demo", "api", index)).toEqual(["reference/demo/backend"]);
  });

  it("matches existing pages that mention the scope name", () => {
    const index = new Map<string, readonly string[]>([
      ["architecture overview", ["reference/foo/architecture"]],
      ["unrelated", ["reference/other/page"]],
    ]);
    expect(findRelatedPagesForScope("nothere", "architecture", index)).toEqual([
      "reference/foo/architecture",
    ]);
  });

  it("caps the result to 6 entries", () => {
    const entries: [string, string[]][] = [];
    for (let i = 0; i < 10; i++) {
      entries.push([`demo topic ${i}`, [`reference/demo/topic-${i}`]]);
    }
    const index = new Map<string, readonly string[]>(entries);
    expect(findRelatedPagesForScope("demo", "api", index)).toHaveLength(6);
  });
});

// ── buildCoverageJobs ──────────────────────────────────────────────────

describe("buildCoverageJobs", () => {
  it("emits one job per missing scope per domain", () => {
    const coverages = [buildDomainCoverage("demo", ["architecture", "api"])];
    const jobs = buildCoverageJobs(coverages);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.scope_name).sort()).toEqual(["api", "architecture"]);
    expect(jobs.every((j) => j.domain === "demo")).toBe(true);
  });

  it("skips covered scopes", () => {
    const coverages = [buildDomainCoverage("demo", [])];
    expect(buildCoverageJobs(coverages)).toHaveLength(0);
  });

  it("returns related pages it discovered for each job", () => {
    const coverages = [buildDomainCoverage("demo", ["api"])];
    const index = new Map<string, readonly string[]>([
      ["demo backend", ["reference/demo/backend"]],
    ]);
    const jobs = buildCoverageJobs(coverages, { existingPagesByTopic: index });
    expect(jobs[0]?.related_pages).toEqual(["reference/demo/backend"]);
  });

  it("attaches supporting memory ids when present", () => {
    const coverages = [buildDomainCoverage("demo", ["api"])];
    const mems = new Map([
      ["demo", [{ id: 42, content: "x", tags: ["api"] }, { id: 99, content: "y" }]],
    ]);
    const jobs = buildCoverageJobs(coverages, { supportingMemoriesByDomain: mems });
    expect(jobs[0]?.supporting_memory_ids).toEqual([42, 99]);
  });
});

// ── sortCoverageJobs ───────────────────────────────────────────────────

function mkJob(domain: string, scope_name: string): CoverageJob {
  return {
    domain,
    scope_name,
    scope_title: scope_name,
    suggested_kind: "reference",
    suggested_path: `reference/${domain}/${scope_name}.md`,
    prompt: "",
    related_pages: [],
    supporting_memory_ids: [],
  };
}

describe("sortCoverageJobs", () => {
  it("sorts by structural primacy then domain", () => {
    const jobs = [
      mkJob("zeta", "decisions"),
      mkJob("alpha", "architecture"),
      mkJob("alpha", "data-flow"),
      mkJob("beta", "architecture"),
    ];
    const sorted = sortCoverageJobs(jobs);
    expect(sorted.map((j) => [j.scope_name, j.domain])).toEqual([
      ["architecture", "alpha"],
      ["architecture", "beta"],
      ["data-flow", "alpha"],
      ["decisions", "zeta"],
    ]);
  });

  it("places non-canonical scopes after canonical ones", () => {
    const jobs = [
      mkJob("a", "onboarding"),
      mkJob("a", "architecture"),
    ];
    expect(sortCoverageJobs(jobs)[0]?.scope_name).toBe("architecture");
  });
});
