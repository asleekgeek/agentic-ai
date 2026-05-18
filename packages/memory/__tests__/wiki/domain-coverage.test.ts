/**
 * Tests for domain-coverage.ts — top-down per-domain scope audit.
 *
 * source: packages/memory/src/wiki/domain-coverage.ts
 */

import { describe, expect, it } from "vitest";
import {
  auditAllDomains,
  auditDomain,
  coverageRatio,
  coveredCount,
  isPlausibleDomain,
  listDomains,
  missingCount,
  missingScopes,
  type PageStatFn,
} from "../../src/wiki/domain-coverage.js";
import { MIN_PAGE_BYTES, SCOPES } from "../../src/wiki/scopes.js";

// ── isPlausibleDomain ──────────────────────────────────────────────────

describe("isPlausibleDomain", () => {
  it("accepts ordinary project names", () => {
    expect(isPlausibleDomain("agentic-ai")).toBe(true);
    expect(isPlausibleDomain("cortex")).toBe(true);
  });

  it("rejects empty / reserved / year buckets", () => {
    expect(isPlausibleDomain("")).toBe(false);
    expect(isPlausibleDomain("_general")).toBe(false);
    expect(isPlausibleDomain(".hidden")).toBe(false);
    expect(isPlausibleDomain("2026")).toBe(false);
    expect(isPlausibleDomain("1999")).toBe(false);
  });
});

// ── listDomains ────────────────────────────────────────────────────────

describe("listDomains", () => {
  it("requires a domain to appear under ≥2 kind directories", () => {
    const subdirs: Record<string, string[]> = {
      reference: ["agentic-ai", "cortex"],
      explanation: ["agentic-ai"],
      // cortex appears only once → filtered out
    };
    const result = listDomains((dir) => subdirs[dir] ?? []);
    expect(result).toEqual(["agentic-ai"]);
  });

  it("returns sorted names", () => {
    const subdirs: Record<string, string[]> = {
      reference: ["zeta", "alpha"],
      explanation: ["zeta", "alpha"],
    };
    expect(listDomains((dir) => subdirs[dir] ?? [])).toEqual(["alpha", "zeta"]);
  });

  it("filters reserved buckets", () => {
    const subdirs: Record<string, string[]> = {
      reference: ["_general", "2026", "real-project"],
      explanation: ["_general", "2026", "real-project"],
    };
    expect(listDomains((dir) => subdirs[dir] ?? [])).toEqual(["real-project"]);
  });
});

// ── auditDomain ────────────────────────────────────────────────────────

const NOW = 1_700_000_000; // arbitrary fixed epoch for deterministic tests
const FRESH = NOW - 60 * 86400; // 60 days ago — within 90-day window
const STALE = NOW - 200 * 86400; // 200 days ago — outside window

describe("auditDomain", () => {
  it("returns one ScopeCoverage per canonical scope", () => {
    const result = auditDomain(
      "demo",
      {
        pageStat: () => null,
        countSubstantivePages: () => 0,
        nowSec: NOW,
      },
    );
    expect(result.domain).toBe("demo");
    expect(result.scopes).toHaveLength(SCOPES.length);
  });

  it("marks scope covered when a substantive anchor exists", () => {
    const pageStat: PageStatFn = (rel) =>
      rel === "reference/demo/architecture-overview.md"
        ? { sizeBytes: MIN_PAGE_BYTES + 10, mtimeSec: FRESH }
        : null;
    const result = auditDomain(
      "demo",
      { pageStat, countSubstantivePages: () => 0, nowSec: NOW },
    );
    const arch = result.scopes.find((s) => s.scope.name === "architecture");
    expect(arch?.covered).toBe(true);
    expect(arch?.anchorPage).toBe("reference/demo/architecture-overview.md");
  });

  it("treats stale anchors as missing when maxAgeDays is set", () => {
    const pageStat: PageStatFn = () =>
      ({ sizeBytes: MIN_PAGE_BYTES + 10, mtimeSec: STALE });
    const result = auditDomain(
      "demo",
      { pageStat, countSubstantivePages: () => 0, nowSec: NOW },
      { maxAgeDays: 90 },
    );
    expect(result.scopes.every((s) => !s.covered || s.scope.anchorFilenames.length === 0))
      .toBe(true);
  });

  it("honors maxAgeDays=null to disable freshness", () => {
    const pageStat: PageStatFn = (rel) =>
      rel === "reference/demo/architecture-overview.md"
        ? { sizeBytes: MIN_PAGE_BYTES + 10, mtimeSec: STALE }
        : null;
    const result = auditDomain(
      "demo",
      { pageStat, countSubstantivePages: () => 0, nowSec: NOW },
      { maxAgeDays: null },
    );
    const arch = result.scopes.find((s) => s.scope.name === "architecture");
    expect(arch?.covered).toBe(true);
  });

  it("rejects anchors below the substantive size threshold", () => {
    const pageStat: PageStatFn = () =>
      ({ sizeBytes: MIN_PAGE_BYTES - 1, mtimeSec: FRESH });
    const result = auditDomain(
      "demo",
      { pageStat, countSubstantivePages: () => 0, nowSec: NOW },
    );
    const arch = result.scopes.find((s) => s.scope.name === "architecture");
    expect(arch?.covered).toBe(false);
  });

  it("covers decisions scope when any substantive page exists", () => {
    const result = auditDomain(
      "demo",
      {
        pageStat: () => null,
        countSubstantivePages: (relDir) => (relDir === "adr/demo" ? 5 : 0),
        nowSec: NOW,
      },
    );
    const dec = result.scopes.find((s) => s.scope.name === "decisions");
    expect(dec?.covered).toBe(true);
    expect(dec?.pageCount).toBe(5);
  });
});

// ── Roll-up helpers ────────────────────────────────────────────────────

describe("roll-up helpers", () => {
  it("coveredCount / missingCount / coverageRatio sum to total", () => {
    const result = auditDomain(
      "demo",
      { pageStat: () => null, countSubstantivePages: () => 0, nowSec: NOW },
    );
    expect(coveredCount(result) + missingCount(result)).toBe(result.scopes.length);
    expect(coverageRatio(result)).toBeCloseTo(coveredCount(result) / result.scopes.length);
  });

  it("missingScopes returns only the uncovered slots", () => {
    const result = auditDomain(
      "demo",
      { pageStat: () => null, countSubstantivePages: () => 0, nowSec: NOW },
    );
    const missed = missingScopes(result);
    expect(missed.every((s) => !s.covered)).toBe(true);
  });
});

// ── auditAllDomains ────────────────────────────────────────────────────

describe("auditAllDomains", () => {
  it("sorts by missing-count desc", () => {
    const subdirs: Record<string, string[]> = {
      reference: ["alpha", "beta"],
      explanation: ["alpha", "beta"],
    };
    // ``alpha`` has the architecture anchor; ``beta`` has nothing.
    const pageStat: PageStatFn = (rel) =>
      rel === "reference/alpha/architecture-overview.md"
        ? { sizeBytes: MIN_PAGE_BYTES + 10, mtimeSec: FRESH }
        : null;
    const rolls = auditAllDomains(
      (dir) => subdirs[dir] ?? [],
      { pageStat, countSubstantivePages: () => 0, nowSec: NOW },
    );
    expect(rolls.map((r) => r.domain)).toEqual(["beta", "alpha"]);
    expect(missingCount(rolls[0]!)).toBeGreaterThan(missingCount(rolls[1]!));
  });
});
