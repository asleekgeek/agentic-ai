/**
 * Tests for the "Pending Wiki Curation" section in the SessionStart preamble.
 *
 * source: cortex@4883307 mcp_server/hooks/session_start.py:463-479
 */

import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/hooks/session-start-context.js";

describe("buildContext — pending curation section", () => {
  it("does not render the section when pendingCurations is 0", () => {
    const ctx = buildContext([], [], null, [], 0);
    expect(ctx).toBe("");
  });

  it("renders the singular form for exactly one cluster", () => {
    const ctx = buildContext([], [], null, [], 1);
    expect(ctx).toContain("### Pending Wiki Curation");
    expect(ctx).toContain("**1** topic cluster of");
    expect(ctx).toContain("`curate_wiki`");
  });

  it("renders the plural form for >1 clusters", () => {
    const ctx = buildContext([], [], null, [], 7);
    expect(ctx).toContain("**7** topic clusters of");
  });

  it("returns non-empty context when pendingCurations alone is positive", () => {
    // No anchors, no hot, no checkpoint, no team decisions, only curations.
    const ctx = buildContext([], [], null, [], 3);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx).toContain("Cortex Memory Context");
  });
});
