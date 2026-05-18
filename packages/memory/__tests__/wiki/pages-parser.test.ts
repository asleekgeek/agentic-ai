/**
 * Tests for parsePage YAML block-list parsing.
 *
 * source: packages/memory/src/wiki/pages.ts
 * source: cortex@HEAD~ mcp_server/core/wiki_pages.py:parse_page (2026-05-18)
 */

import { describe, expect, it } from "vitest";
import { parsePage } from "../../src/wiki/pages.js";

describe("parsePage — inline lists", () => {
  it("parses inline ``tags: [a, b, c]`` form", () => {
    const text = "---\ntags: [a, b, c]\n---\nbody\n";
    const doc = parsePage(text);
    expect(doc.frontmatter["tags"]).toEqual(["a", "b", "c"]);
  });

  it("parses scalar values as strings", () => {
    const text = "---\ntitle: My Page\nstatus: living\n---\nbody\n";
    const doc = parsePage(text);
    expect(doc.frontmatter["title"]).toBe("My Page");
    expect(doc.frontmatter["status"]).toBe("living");
  });
});

describe("parsePage — block lists (2026-05-18 fix)", () => {
  it("parses block-list under an empty-valued key", () => {
    const text = [
      "---",
      "curation_gaps:",
      "  - purpose",
      "  - public-api",
      "  - tests",
      "---",
      "body",
    ].join("\n");
    const doc = parsePage(text);
    expect(doc.frontmatter["curation_gaps"]).toEqual(["purpose", "public-api", "tests"]);
  });

  it("strips surrounding double quotes from items", () => {
    const text = [
      "---",
      "tags:",
      '  - "with quotes"',
      "  - 'single quotes'",
      "  - bare",
      "---",
      "body",
    ].join("\n");
    const doc = parsePage(text);
    expect(doc.frontmatter["tags"]).toEqual(["with quotes", "single quotes", "bare"]);
  });

  it("stops the block list at the next non-indented key", () => {
    const text = [
      "---",
      "tags:",
      "  - a",
      "  - b",
      "audience: developer",
      "---",
      "body",
    ].join("\n");
    const doc = parsePage(text);
    expect(doc.frontmatter["tags"]).toEqual(["a", "b"]);
    expect(doc.frontmatter["audience"]).toBe("developer");
  });

  it("treats an empty-valued key with no indented items as empty string", () => {
    const text = [
      "---",
      "tags:",
      "title: Hello",
      "---",
      "body",
    ].join("\n");
    const doc = parsePage(text);
    expect(doc.frontmatter["tags"]).toBe("");
    expect(doc.frontmatter["title"]).toBe("Hello");
  });

  it("stops the block list at the closing frontmatter delimiter", () => {
    const text = [
      "---",
      "tags:",
      "  - a",
      "  - b",
      "---",
      "body",
    ].join("\n");
    const doc = parsePage(text);
    expect(doc.frontmatter["tags"]).toEqual(["a", "b"]);
    expect(doc.body).toBe("body");
  });
});
