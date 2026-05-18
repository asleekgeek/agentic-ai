/**
 * Tests for the stub detector — port of cortex_wiki_stub_detector.
 *
 * source: cortex/mcp_server/core/wiki_stub_detector.py + tests_py/core/test_wiki_stub_detector.py
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHALLOW_THRESHOLD,
  DEFAULT_STUB_THRESHOLD,
  isShallow,
  isStub,
  placeholderCount,
  proseCharCount,
  stubScore,
} from "../../src/wiki/stub-detector.js";

// ── stubScore ─────────────────────────────────────────────────────────

describe("stubScore", () => {
  it("returns 0 for an empty body", () => {
    expect(stubScore("")).toBe(0);
  });

  it("returns 0 for a body with no content lines (only headings)", () => {
    // Only headings + blank lines — no content lines means score is 0
    // (per docstring: "Returns 0.0 when the body has no placeholder
    // content or no content at all").
    expect(stubScore("# Title\n\n## Section\n")).toBe(0);
  });

  it("returns 0 for a body of pure prose", () => {
    expect(stubScore("This is a real sentence.\nAnother sentence here.")).toBe(0);
  });

  it("returns 1.0 when every content line is a placeholder", () => {
    const body = "# Title\n\n_(to be filled)_\n\n## Section\n\n_(none identified)_\n";
    expect(stubScore(body)).toBe(1);
  });

  it("returns the correct fraction for mixed content", () => {
    // 2 content lines: 1 real, 1 placeholder → 0.5.
    const body = "# Title\n\nReal prose here.\n\n_(to be filled)_\n";
    expect(stubScore(body)).toBeCloseTo(0.5, 5);
  });

  it("recognises the looser placeholder variants without underscores", () => {
    const body = "# T\n\nTo be written\n";
    expect(stubScore(body)).toBe(1);
  });

  it("recognises bare TBD (uppercase) but not lowercase, mirrors Cortex regex flags", () => {
    // source: cortex/mcp_server/core/wiki_stub_detector.py:46,51 —
    //   ``_TBD_`` is IGNORECASE; bare ``TBD`` is not.
    expect(stubScore("# T\n\nTBD")).toBe(1);
    // Bare lowercase tbd doesn't match — by design.
    expect(stubScore("# T\n\ntbd")).toBe(0);
  });

  it("recognises ``_TBD_`` and ``_tbd_`` (case-insensitive variant)", () => {
    expect(stubScore("# T\n\n_TBD_")).toBe(1);
    expect(stubScore("# T\n\n_tbd_")).toBe(1);
  });

  it("matches a heading-trailing ``(to be filled)``", () => {
    // Embedded in a non-heading content line still matches per the
    // catchall pattern. Headings are excluded from content lines so
    // the heading variant doesn't count here — we put it as prose.
    const body = "Section name (to be filled)";
    expect(stubScore(body)).toBe(1);
  });

  it("ignores code-fence boundary lines", () => {
    // The ``` line itself is not a content line; the inside-fence
    // line IS a content line and contributes (real prose, not placeholder).
    const body = "# T\n\n```\nreal code\n```\n";
    expect(stubScore(body)).toBe(0);
  });
});

// ── isStub ────────────────────────────────────────────────────────────

describe("isStub", () => {
  it("is true when stubScore >= threshold", () => {
    const body = "# T\n\nReal.\n\n_(to be filled)_\n";  // score 0.5
    expect(isStub(body, 0.5)).toBe(true);
    expect(isStub(body, 0.4)).toBe(true);
    expect(isStub(body, 0.6)).toBe(false);
  });

  it("returns true whenever every content line is a placeholder, regardless of threshold", () => {
    const allPlaceholders = "# T\n\n_(to be filled)_\n";
    // Even with an absurdly high threshold, 100% placeholders is a stub.
    expect(isStub(allPlaceholders, 99)).toBe(true);
  });

  it("uses 0.5 as the default threshold", () => {
    expect(DEFAULT_STUB_THRESHOLD).toBe(0.5);
  });

  it("is false for an empty body", () => {
    expect(isStub("")).toBe(false);
  });

  it("is false for a heading-only body", () => {
    expect(isStub("# T\n\n## S\n")).toBe(false);
  });
});

// ── placeholderCount ──────────────────────────────────────────────────

describe("placeholderCount", () => {
  it("counts every placeholder marker line", () => {
    const body = "# T\n_(to be filled)_\n_To be written._\n_TBD_\nreal\n";
    expect(placeholderCount(body)).toBe(3);
  });

  it("returns 0 for an empty body", () => {
    expect(placeholderCount("")).toBe(0);
  });
});

// ── proseCharCount + isShallow ────────────────────────────────────────

describe("proseCharCount", () => {
  it("counts pure prose chars", () => {
    expect(proseCharCount("hello world")).toBe("hello world".length);
  });

  it("ignores blank lines, headings, lists, code fences, KV metadata", () => {
    const body = [
      "# Title",                  // heading — skip
      "",                         // blank — skip
      "Language: python",         // KV metadata — skip
      "- bullet item",            // list — skip
      "1. ordered item",          // list — skip
      "```",                      // fence — skip
      "code line",                // inside fence — skip
      "```",                      // fence — skip
      "Real prose here.",         // counts: 16 chars
    ].join("\n");
    expect(proseCharCount(body)).toBe("Real prose here.".length);
  });
});

describe("isShallow", () => {
  it("is true when proseCharCount < threshold", () => {
    const shortBody = "Short.";
    expect(isShallow(shortBody, 500)).toBe(true);
  });

  it("is false when proseCharCount >= threshold", () => {
    const longBody = "a".repeat(600);
    expect(isShallow(longBody, 500)).toBe(false);
  });

  it("uses 500 as the default threshold", () => {
    expect(DEFAULT_SHALLOW_THRESHOLD).toBe(500);
  });

  it("identifies the canonical shallow file-doc shape as shallow", () => {
    // Same shape as the docstring example.
    const fileDoc = [
      "# File: foo.py",
      "Language: python",
      "Purpose: foo.py — one-liner.",
      "## Imports",
      "- bar",
      "- baz",
      "## Symbols",
      "- foo()",
    ].join("\n");
    expect(isShallow(fileDoc)).toBe(true);
  });

  it("identifies a substantive page as NOT shallow", () => {
    // Long actual prose, no metadata trickery.
    const real = "This module does the thing. It works by ".repeat(60); // ~2400 chars
    expect(isShallow(real)).toBe(false);
  });
});
