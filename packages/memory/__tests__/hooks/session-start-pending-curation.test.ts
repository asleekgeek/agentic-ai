/**
 * Tests for the "Pending Wiki Maintenance" section in the SessionStart preamble.
 *
 * Phase C consolidated curation + drift + coverage into a single
 * section. The renderer fires when ANY of the three counts is
 * positive.
 *
 * source: cortex@4883307 mcp_server/hooks/session_start.py:463-479
 * source: packages/memory/src/wiki/maintenance-stats.ts (Phase C)
 */

import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/hooks/session-start-context.js";

describe("buildContext — pending maintenance section", () => {
  it("does not render the section when every count is 0", () => {
    expect(buildContext([], [], null, [], 0, 0, 0)).toBe("");
  });

  it("renders singular cluster wording for exactly one curation", () => {
    const ctx = buildContext([], [], null, [], 1, 0, 0);
    expect(ctx).toContain("### Pending Wiki Maintenance");
    expect(ctx).toContain("**1** topic cluster ");
    expect(ctx).toContain("`curate_wiki`");
  });

  it("renders plural cluster wording for >1 curations", () => {
    const ctx = buildContext([], [], null, [], 7, 0, 0);
    expect(ctx).toContain("**7** topic clusters ");
  });

  it("renders the drift line when pendingDrift > 0", () => {
    const ctx = buildContext([], [], null, [], 0, 3, 0);
    expect(ctx).toContain("### Pending Wiki Maintenance");
    expect(ctx).toContain("**3** pages cite source files newer than the page");
    expect(ctx).toContain("include_drift: true");
  });

  it("renders singular drift wording for exactly one drift", () => {
    const ctx = buildContext([], [], null, [], 0, 1, 0);
    expect(ctx).toContain("**1** page cite ");
  });

  it("renders the coverage line when pendingCoverage > 0", () => {
    const ctx = buildContext([], [], null, [], 0, 0, 12);
    expect(ctx).toContain("### Pending Wiki Maintenance");
    expect(ctx).toContain("**12** source files have no wiki page");
    expect(ctx).toContain("include_file_coverage: true");
  });

  it("combines all three counts in one section", () => {
    const ctx = buildContext([], [], null, [], 2, 3, 4);
    expect(ctx).toContain("**2** topic clusters");
    expect(ctx).toContain("**3** pages cite");
    expect(ctx).toContain("**4** source files");
  });

  it("returns non-empty context when any maintenance count is positive", () => {
    expect(buildContext([], [], null, [], 0, 0, 1).length).toBeGreaterThan(0);
    expect(buildContext([], [], null, [], 0, 1, 0).length).toBeGreaterThan(0);
    expect(buildContext([], [], null, [], 1, 0, 0).length).toBeGreaterThan(0);
  });
});
