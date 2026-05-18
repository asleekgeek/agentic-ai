/**
 * Tests for writeProcessPages — empty-process skip behaviour.
 *
 * source: cortex@83a6834 — "skip empty Process pages (symbol_count=0) —
 *         they have no information". Verifies a Process page is NOT
 *         created when symbol_count is 0 or symbols is empty.
 */

import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProcessPages } from "../../src/codebase-analysis/handlers/ingest-codebase-pages.js";

describe("writeProcessPages — skip empty Process pages", () => {
  let wikiRoot: string;

  beforeEach(() => {
    wikiRoot = mkdtempSync(join(tmpdir(), "wiki-empty-proc-"));
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  it("skips a process whose symbol_count is 0", () => {
    const written = writeProcessPages(
      [{ entry_point: "main", symbol_count: 0, symbols: [] }],
      wikiRoot,
    );
    expect(written).toEqual([]);
    expect(existsSync(join(wikiRoot, "reference/codebase/main.md"))).toBe(false);
  });

  it("skips a process whose symbols array is empty even without symbol_count", () => {
    const written = writeProcessPages(
      [{ entry_point: "main", symbols: [] }],
      wikiRoot,
    );
    expect(written).toEqual([]);
  });

  it("writes a process whose symbol_count is positive", () => {
    const written = writeProcessPages(
      [{ entry_point: "main", symbol_count: 3, symbols: ["a", "b", "c"] }],
      wikiRoot,
    );
    expect(written).toEqual(["reference/codebase/main.md"]);
    expect(existsSync(join(wikiRoot, "reference/codebase/main.md"))).toBe(true);
  });

  it("filters a mixed batch, writing only non-empty processes", () => {
    const written = writeProcessPages(
      [
        { entry_point: "a", symbol_count: 0, symbols: [] },
        { entry_point: "b", symbol_count: 2, symbols: ["x", "y"] },
        { entry_point: "c", symbols: [] },
        { entry_point: "d", symbol_count: 1, symbols: ["z"] },
      ],
      wikiRoot,
    );
    expect(written.sort()).toEqual([
      "reference/codebase/b.md",
      "reference/codebase/d.md",
    ]);
    const files = readdirSync(join(wikiRoot, "reference/codebase")).sort();
    expect(files).toEqual(["b.md", "d.md"]);
  });
});
