/**
 * Tests for coverage-dashboard.ts — per-project dashboard renderer.
 *
 * source: packages/memory/src/wiki/coverage-dashboard.ts
 */

import { describe, expect, it } from "vitest";
import {
  countCurationGapsInBody,
  renderDashboard,
  renderDashboardIndex,
  type DashboardAdapters,
} from "../../src/wiki/coverage-dashboard.js";
import { MIN_PAGE_BYTES } from "../../src/wiki/scopes.js";

const NOW = 1_700_000_000;
const FRESH = NOW - 30 * 86400;

function emptyAdapters(domain: string): DashboardAdapters {
  return {
    pageStat: () => null,
    countSubstantivePages: () => 0,
    nowSec: NOW,
    fileCoverage: () => ({
      domain,
      sourceRoot: null,
      sourceFileCount: 0,
      coveredFileCount: 0,
      uncoveredFiles: [],
    }),
    kindCounts: () => ({}),
    curationGapCounts: () => ({ totalPages: 0, openGaps: 0 }),
  };
}

describe("renderDashboard", () => {
  it("emits the expected frontmatter for the domain", () => {
    const out = renderDashboard("demo", emptyAdapters("demo"));
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("title: demo — documentation coverage");
    expect(out).toContain("domain: demo");
    expect(out).toContain("scope: coverage-dashboard");
    expect(out).toContain("authored_by: wiki-coverage-dashboard-v1");
  });

  it("renders a scoreboard with 0/15 when nothing exists", () => {
    const out = renderDashboard("demo", emptyAdapters("demo"));
    expect(out).toMatch(/Canonical slots filled:\*\* 0\/15/);
  });

  it("marks scopes covered when their anchor exists", () => {
    const adapters: DashboardAdapters = {
      ...emptyAdapters("demo"),
      pageStat: (rel) =>
        rel === "reference/demo/architecture-overview.md"
          ? { sizeBytes: MIN_PAGE_BYTES + 100, mtimeSec: FRESH }
          : null,
    };
    const out = renderDashboard("demo", adapters);
    // Scoreboard reflects the one covered slot.
    expect(out).toMatch(/Canonical slots filled:\*\* 1\/15/);
    // Architecture row shows the anchor link.
    expect(out).toContain("[`reference/demo/architecture-overview.md`]");
    expect(out).toContain("✅ filled");
  });

  it("lists missing-scope descriptions when scopes are uncovered", () => {
    const out = renderDashboard("demo", emptyAdapters("demo"));
    expect(out).toContain("## What's still missing");
    // Architecture's description should appear (its scope is uncovered).
    expect(out).toContain("Overall design");
  });

  it("renders pages-by-kind breakdown sorted desc", () => {
    const adapters: DashboardAdapters = {
      ...emptyAdapters("demo"),
      kindCounts: () => ({ reference: 10, adr: 3, explanation: 7 }),
    };
    const out = renderDashboard("demo", adapters);
    const refIdx = out.indexOf("| reference | 10 |");
    const expIdx = out.indexOf("| explanation | 7 |");
    const adrIdx = out.indexOf("| adr | 3 |");
    expect(refIdx).toBeGreaterThan(-1);
    expect(expIdx).toBeGreaterThan(refIdx);
    expect(adrIdx).toBeGreaterThan(expIdx);
  });

  it("renders uncovered-files section with cap", () => {
    const uncovered = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
    const adapters: DashboardAdapters = {
      ...emptyAdapters("demo"),
      fileCoverage: () => ({
        domain: "demo",
        sourceRoot: "/tmp/demo",
        sourceFileCount: 100,
        coveredFileCount: 50,
        uncoveredFiles: uncovered,
      }),
    };
    const out = renderDashboard("demo", adapters);
    expect(out).toContain("## Source files not yet referenced anywhere");
    expect(out).toContain("Source files referenced somewhere:** 50/100 (50%)");
    expect(out).toContain("src/file0.ts");
    expect(out).toContain("src/file29.ts");
    expect(out).not.toContain("src/file30.ts"); // capped at 30
    expect(out).toContain("… +20 more");
  });
});

describe("renderDashboardIndex", () => {
  it("emits an alphabetical index of dashboards", () => {
    const out = renderDashboardIndex(["zeta", "alpha", "mike"]);
    const aIdx = out.indexOf("| alpha |");
    const mIdx = out.indexOf("| mike |");
    const zIdx = out.indexOf("| zeta |");
    expect(aIdx).toBeGreaterThan(-1);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
    expect(out).toContain("scope: coverage-index");
  });
});

describe("countCurationGapsInBody", () => {
  it("counts each ``- `` bullet under ``curation_gaps:``", () => {
    const body = [
      "---",
      "title: demo",
      "curation_gaps:",
      "  - purpose",
      "  - public-api",
      "  - tests",
      "---",
      "",
      "Body here.",
    ].join("\n");
    expect(countCurationGapsInBody(body)).toBe(3);
  });

  it("returns 0 when no frontmatter is present", () => {
    expect(countCurationGapsInBody("# A page with no frontmatter\n")).toBe(0);
  });

  it("returns 0 when frontmatter has no curation_gaps key", () => {
    const body = "---\ntitle: demo\nkind: reference\n---\nBody\n";
    expect(countCurationGapsInBody(body)).toBe(0);
  });

  it("stops at the next non-indented key", () => {
    const body = [
      "---",
      "curation_gaps:",
      "  - one",
      "  - two",
      "audience: developer",
      "---",
    ].join("\n");
    expect(countCurationGapsInBody(body)).toBe(2);
  });
});
