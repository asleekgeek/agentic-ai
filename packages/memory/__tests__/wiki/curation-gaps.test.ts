/**
 * Tests for curation-gaps.ts — file-doc gap detector + banner.
 *
 * source: packages/memory/src/wiki/curation-gaps.ts
 * source: cortex/mcp_server/core/wiki_curation_gaps.py
 */

import { describe, expect, it } from "vitest";
import {
  FILE_DOC_SECTIONS,
  gapReport,
  missingSections,
  renderGapBanner,
} from "../../src/wiki/curation-gaps.js";

// ── missingSections ────────────────────────────────────────────────

describe("missingSections", () => {
  it("returns every section for an empty body", () => {
    const missing = missingSections("");
    expect(missing.map((s) => s.name).sort()).toEqual(
      FILE_DOC_SECTIONS.map((s) => s.name).sort(),
    );
  });

  it("considers a section present when its probe heading has enough prose", () => {
    // Purpose requires >= 200 chars under "## Purpose" or "## What this file does".
    const body =
      "## Purpose\n\n" +
      "This module is responsible for stub detection. It scores pages by their ratio of placeholder lines to content lines, and reports a boolean above a configurable threshold. The module is pure logic; no I/O is performed. Callers inject filesystem adapters where needed. The detector is reused by the wiki maintenance cycle and by the dashboard's coverage endpoint.\n";
    const missing = missingSections(body).map((s) => s.name);
    expect(missing).not.toContain("purpose");
  });

  it("considers a section MISSING when the heading is present but body is too thin", () => {
    const body = "## Purpose\n\nShort.\n\n## Public API\n\nSome text.";
    const missing = missingSections(body).map((s) => s.name);
    // Purpose body is too short (< 200 chars), so purpose is missing.
    expect(missing).toContain("purpose");
  });

  it("matches alternate probe headings", () => {
    // Purpose has probe ``## What this file does`` too.
    const longProse = "x".repeat(300);
    const body = "## What this file does\n\n" + longProse + "\n";
    const missing = missingSections(body).map((s) => s.name);
    expect(missing).not.toContain("purpose");
  });

  it("ignores bullet lines + code fences when counting prose", () => {
    // Bullets + fence contents don't count toward minCharsUnderHeading;
    // a page that LOOKS substantive but is all bullets is missing.
    const body =
      "## Purpose\n\n" +
      "- bullet 1\n- bullet 2\n```\nlots of code here\nmore code\n```\n";
    const missing = missingSections(body).map((s) => s.name);
    expect(missing).toContain("purpose");
  });
});

// ── gapReport ──────────────────────────────────────────────────────

describe("gapReport", () => {
  it("reports complete=true when every section is covered", () => {
    // Build a body that satisfies every section with substantive prose.
    const sections = FILE_DOC_SECTIONS.map((s) =>
      `${s.heading}\n\n${"x ".repeat(s.minCharsUnderHeading + 50)}\n`,
    ).join("\n");
    const report = gapReport(sections);
    expect(report.complete).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.completion_pct).toBe(1.0);
    expect(report.covered_sections).toBe(FILE_DOC_SECTIONS.length);
  });

  it("reports complete=false with missing list for an empty body", () => {
    const report = gapReport("");
    expect(report.complete).toBe(false);
    expect(report.missing.length).toBe(FILE_DOC_SECTIONS.length);
    expect(report.completion_pct).toBe(0);
    expect(report.covered_sections).toBe(0);
  });

  it("computes completion_pct rounded to two decimals", () => {
    // Cover exactly one section → expected pct = round(1/N, 2) where
    // N = FILE_DOC_SECTIONS.length (12 after the 2026-05-18 expansion).
    const longProse = "x ".repeat(300);
    const body = "## Purpose\n\n" + longProse + "\n";
    const report = gapReport(body);
    expect(report.covered_sections).toBe(1);
    const expectedPct = Math.round(100 / FILE_DOC_SECTIONS.length) / 100;
    expect(report.completion_pct).toBeCloseTo(expectedPct, 2);
  });
});

// ── renderGapBanner ────────────────────────────────────────────────

describe("renderGapBanner", () => {
  it("returns empty string when the page is complete", () => {
    const report = gapReport(
      FILE_DOC_SECTIONS.map((s) =>
        `${s.heading}\n\n${"x ".repeat(s.minCharsUnderHeading + 50)}\n`,
      ).join("\n"),
    );
    expect(renderGapBanner(report)).toBe("");
  });

  it("renders a ⚠ banner with completion percentage", () => {
    const report = gapReport(""); // 0% covered
    const banner = renderGapBanner(report);
    expect(banner).toContain("⚠");
    expect(banner).toContain("0% curated");
    expect(banner).toContain("sections are missing");
  });

  it("lists each missing section with its description as a bullet", () => {
    const report = gapReport(""); // every section missing
    const banner = renderGapBanner(report);
    for (const section of FILE_DOC_SECTIONS) {
      // Headings rendered without leading "## " prefix.
      const stripped = section.heading.replace(/^#+\s*/, "");
      expect(banner).toContain(stripped);
      // Each section's description appears in the banner.
      expect(banner).toContain(section.description.split(".")[0]!);
    }
  });

  it("uses singular wording when exactly one section is missing", () => {
    // Build a body that satisfies all but ``tests``.
    const allButTests = FILE_DOC_SECTIONS
      .filter((s) => s.name !== "tests")
      .map((s) => `${s.heading}\n\n${"x ".repeat(s.minCharsUnderHeading + 50)}\n`)
      .join("\n");
    const report = gapReport(allButTests);
    expect(report.missing).toEqual(["tests"]);
    const banner = renderGapBanner(report);
    // "1 section is" — singular.
    expect(banner).toContain("1 section");
    expect(banner).not.toMatch(/1 sections are/);
  });
});
