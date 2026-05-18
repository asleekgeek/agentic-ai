/**
 * Tests for file-coverage.ts — coverage-driven curator jobs.
 *
 * source: packages/memory/src/wiki/file-coverage.ts
 */

import { describe, expect, it } from "vitest";
import {
  buildCoverageJobs,
  buildCoveragePrompt,
  computeCoverageGap,
  fileToWikiPath,
  slugifyFilePath,
} from "../../src/wiki/file-coverage.js";

// ── slugifyFilePath ────────────────────────────────────────────────────

describe("slugifyFilePath", () => {
  it("strips the directory and extension", () => {
    expect(slugifyFilePath("packages/memory/src/wiki/auto-curator.ts")).toBe("auto-curator");
  });

  it("converts snake_case to kebab-case", () => {
    expect(slugifyFilePath("mcp_server/core/predictive_coding_gate.py")).toBe("predictive-coding-gate");
  });

  it("lowercases CamelCase basename", () => {
    expect(slugifyFilePath("packages/foo/MemoryStore.ts")).toBe("memorystore");
  });

  it("falls back to 'untitled' for an empty/punctuation-only stem", () => {
    expect(slugifyFilePath("/.ts")).toBe("untitled");
  });
});

// ── fileToWikiPath ─────────────────────────────────────────────────────

describe("fileToWikiPath", () => {
  it("composes the reference/<project>/<slug>.md shape", () => {
    expect(fileToWikiPath("packages/memory/src/wiki/auto-curator.ts", "agentic-ai"))
      .toBe("reference/agentic-ai/auto-curator.md");
  });
});

// ── computeCoverageGap ─────────────────────────────────────────────────

describe("computeCoverageGap", () => {
  it("emits a gap for a file with no page", () => {
    const gaps = computeCoverageGap(["src/foo.ts"], "proj", []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].suggestedPath).toBe("reference/proj/foo.md");
  });

  it("skips files whose wiki page already exists (with .md suffix)", () => {
    const gaps = computeCoverageGap(
      ["src/foo.ts", "src/bar.ts"],
      "proj",
      ["reference/proj/foo.md"],
    );
    expect(gaps.map((g) => g.sourceFile)).toEqual(["src/bar.ts"]);
  });

  it("skips files whose wiki page already exists (without .md suffix)", () => {
    const gaps = computeCoverageGap(
      ["src/foo.ts"],
      "proj",
      ["reference/proj/foo"],
    );
    expect(gaps).toEqual([]);
  });

  it("deduplicates files that would collide on the same slug", () => {
    // Two files with the same basename map to the same wiki path; the
    // second one is skipped to avoid clobber.
    const gaps = computeCoverageGap(
      ["src/foo.ts", "lib/foo.ts"],
      "proj",
      [],
    );
    expect(gaps).toHaveLength(1);
  });

  it("returns an empty list when every file is covered", () => {
    const gaps = computeCoverageGap(
      ["src/foo.ts"],
      "proj",
      ["reference/proj/foo.md"],
    );
    expect(gaps).toEqual([]);
  });
});

// ── buildCoveragePrompt ────────────────────────────────────────────────

describe("buildCoveragePrompt", () => {
  const gap = {
    sourceFile: "src/foo.ts",
    projectName: "agentic-ai",
    suggestedPath: "reference/agentic-ai/foo.md",
  };

  it("embeds path, project, and file body", () => {
    const p = buildCoveragePrompt(gap, "export const x = 1;", "2026-05-18");
    expect(p).toContain("**Path**: src/foo.ts");
    expect(p).toContain("**Project**: agentic-ai");
    expect(p).toContain("**Suggested wiki path**: reference/agentic-ai/foo.md");
    expect(p).toContain("export const x = 1;");
    expect(p).toContain("created: 2026-05-18");
  });

  it("truncates very large file bodies and notes the truncation", () => {
    const big = "x".repeat(10_000);
    const p = buildCoveragePrompt(gap, big, "2026-05-18");
    expect(p.includes(big)).toBe(false);
    expect(p).toContain("[file truncated");
  });

  it("substitutes today() when omitted", () => {
    const p = buildCoveragePrompt(gap, "body");
    const todayStr = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
    expect(p).toContain(`created: ${todayStr}`);
  });
});

// ── buildCoverageJobs ──────────────────────────────────────────────────

describe("buildCoverageJobs", () => {
  it("emits one job per gap and reads the file body via the adapter", () => {
    const gaps = [
      { sourceFile: "a.ts", projectName: "p", suggestedPath: "reference/p/a.md" },
      { sourceFile: "b.ts", projectName: "p", suggestedPath: "reference/p/b.md" },
    ];
    const reads: string[] = [];
    const reader = (rel: string): string => { reads.push(rel); return `body of ${rel}`; };
    const jobs = buildCoverageJobs(gaps, reader, "2026-05-18");
    expect(jobs.map((j) => j.gap.sourceFile)).toEqual(["a.ts", "b.ts"]);
    expect(reads).toEqual(["a.ts", "b.ts"]);
    expect(jobs[0].prompt).toContain("body of a.ts");
  });

  it("skips gaps whose file body can't be read", () => {
    const gaps = [
      { sourceFile: "ok.ts", projectName: "p", suggestedPath: "reference/p/ok.md" },
      { sourceFile: "gone.ts", projectName: "p", suggestedPath: "reference/p/gone.md" },
    ];
    const reader = (rel: string): string | null => rel === "gone.ts" ? null : "body";
    const jobs = buildCoverageJobs(gaps, reader);
    expect(jobs.map((j) => j.gap.sourceFile)).toEqual(["ok.ts"]);
  });
});
