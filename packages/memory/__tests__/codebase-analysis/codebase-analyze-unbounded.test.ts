/**
 * Regression tests for collectSourceFiles unbounded mode.
 *
 * Cortex 2026-05-12 fix(#25): max_files<=0 means "no limit" — process
 * every matching file in the tree. Previously, max_files=5000 silently
 * truncated real codebases at exactly the cap (two of the user's repos
 * hit 5000 during a full-scale bootstrap and lost files from the
 * knowledge graph).
 *
 * source: cortex@2f42428 tests_py/handlers/test_codebase_analyze_rglob.py
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSourceFiles } from "../../src/codebase-analysis/handlers/codebase-analyze-helpers.js";

const ONE_KB = 1024;
const ONE_MB = 1024 * 1024;

describe("collectSourceFiles — unbounded mode (max_files<=0)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cb-unbounded-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeFile(rel: string, body = ""): void {
    const full = join(root, rel);
    const dir = full.slice(0, full.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(full, body, "utf8");
  }

  it("returns every matching file when max_files=0 (no cap)", () => {
    const N = 1500;
    for (let i = 0; i < N; i++) writeFile(`pkg/m${i}.ts`, `export const x = ${i};`);
    const result = collectSourceFiles(root, null, 0, ONE_MB);
    expect(result.length).toBe(N);
  });

  it("treats negative max_files the same as 0 (unbounded)", () => {
    const N = 250;
    for (let i = 0; i < N; i++) writeFile(`pkg/m${i}.ts`, `export const x = ${i};`);
    const result = collectSourceFiles(root, null, -1, ONE_MB);
    expect(result.length).toBe(N);
  });

  it("applies language filtering in unbounded mode", () => {
    writeFile("a.ts", "x");
    writeFile("b.py", "x = 1");
    writeFile("c.js", "x");
    writeFile("d.md", "ignored — not a source language");
    const result = collectSourceFiles(root, ["typescript"], 0, ONE_MB);
    expect(result.map((p) => p.split("/").pop()).sort()).toEqual(["a.ts"]);
  });

  it("applies IGNORE_DIRS filtering in unbounded mode (node_modules / dist / .git)", () => {
    writeFile("src/keep.ts", "x");
    writeFile("node_modules/junk.ts", "x");
    writeFile("dist/built.ts", "x");
    writeFile(".git/HEAD", "ref: refs/heads/main");
    const result = collectSourceFiles(root, null, 0, ONE_MB);
    expect(result.map((p) => p.split("/").pop())).toEqual(["keep.ts"]);
  });

  it("applies max_bytes (size) filtering in unbounded mode", () => {
    writeFile("small.ts", "ok");
    writeFile("big.ts", "x".repeat(200 * ONE_KB));
    const result = collectSourceFiles(root, null, 0, 100 * ONE_KB);
    expect(result.map((p) => p.split("/").pop())).toEqual(["small.ts"]);
  });

  it("returns sorted output (deterministic ordering)", () => {
    writeFile("z.ts", "x");
    writeFile("a.ts", "x");
    writeFile("m.ts", "x");
    const result = collectSourceFiles(root, null, 0, ONE_MB);
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  it("bounded mode (max_files>0) still caps the result", () => {
    for (let i = 0; i < 200; i++) writeFile(`pkg/m${i}.ts`, `x${i}`);
    const result = collectSourceFiles(root, null, 50, ONE_MB);
    expect(result.length).toBe(50);
  });
});
