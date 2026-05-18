/**
 * Tests for reauthor-jobs.ts — drift-driven re-authoring jobs.
 *
 * source: packages/memory/src/wiki/reauthor-jobs.ts
 */

import { describe, expect, it } from "vitest";
import {
  buildReauthorJobs,
  buildReauthorPrompt,
  type DriftRecord,
} from "../../src/wiki/reauthor-jobs.js";

function mkDrift(over: Partial<DriftRecord> = {}): DriftRecord {
  return {
    wiki_path: "reference/demo/foo.md",
    domain: "demo",
    kind: "reference",
    reasons: ["stale_content"],
    cited_source_files: ["packages/memory/src/wiki/foo.ts"],
    missing_source_files: [],
    age_days: 45,
    last_updated: "2026-04-01",
    ...over,
  };
}

// ── buildReauthorPrompt ────────────────────────────────────────────────

describe("buildReauthorPrompt", () => {
  it("interpolates the page metadata into the prompt", () => {
    const out = buildReauthorPrompt(mkDrift(), "# foo\n\nbody", "/src/demo", "2026-05-18");
    expect(out).toContain("`reference/demo/foo.md`");
    expect(out).toContain("**Kind**: reference");
    expect(out).toContain("**Domain**: demo");
    expect(out).toContain("**Existing `updated`**: 2026-04-01");
    expect(out).toContain("**Drift reasons**: stale_content");
    expect(out).toContain("**Source root for verification**: /src/demo");
    expect(out).toContain("# foo\n\nbody");
    expect(out).toContain("2026-05-18");
  });

  it("renders missing_source_file drift summary with the file list", () => {
    const drift = mkDrift({
      reasons: ["missing_source_file"],
      missing_source_files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    const out = buildReauthorPrompt(drift, "body", null, "2026-05-18");
    expect(out).toContain("Missing source files");
    expect(out).toContain("src/a.ts, src/b.ts, src/c.ts");
  });

  it("renders stale_content drift summary with rounded days", () => {
    const drift = mkDrift({ reasons: ["stale_content"], age_days: 45.7 });
    const out = buildReauthorPrompt(drift, "body", null, "2026-05-18");
    expect(out).toContain("page mtime is 46 days old");
  });

  it("renders off_template drift summary with the kind", () => {
    const drift = mkDrift({ reasons: ["off_template"], kind: "adr" });
    const out = buildReauthorPrompt(drift, "body", null, "2026-05-18");
    expect(out).toContain("Off-template");
    expect(out).toContain("kind `adr`");
  });

  it("renders ``(none recorded)`` for unknown reason codes", () => {
    const drift = mkDrift({ reasons: ["unknown_reason_x"] });
    const out = buildReauthorPrompt(drift, "body", null, "2026-05-18");
    expect(out).toContain("(none recorded)");
  });

  it("falls back to ``(unresolved …)`` when source root is null", () => {
    const out = buildReauthorPrompt(mkDrift(), "body", null, "2026-05-18");
    expect(out).toContain("(unresolved — verify against memory + repo)");
  });

  it("truncates over-long bodies to the cap with a marker", () => {
    const body = "x".repeat(5000);
    const out = buildReauthorPrompt(mkDrift(), body, "/src", "2026-05-18");
    expect(out).toContain("…[truncated]");
    // Body section should be capped at 4000 chars.
    expect(out.indexOf("x".repeat(4001))).toBe(-1);
  });
});

// ── buildReauthorJobs ──────────────────────────────────────────────────

describe("buildReauthorJobs", () => {
  it("emits one job per readable drifted page", () => {
    const drifts = [mkDrift({ wiki_path: "a.md" }), mkDrift({ wiki_path: "b.md" })];
    const jobs = buildReauthorJobs(
      drifts,
      (p) => `body of ${p}`,
      (_d) => "/src/demo",
      "2026-05-18",
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.wiki_path).toBe("a.md");
    expect(jobs[1]?.wiki_path).toBe("b.md");
  });

  it("skips pages whose body cannot be read", () => {
    const drifts = [mkDrift({ wiki_path: "a.md" }), mkDrift({ wiki_path: "b.md" })];
    const jobs = buildReauthorJobs(
      drifts,
      (p) => (p === "a.md" ? null : "body"),
      (_d) => "/src/demo",
    );
    expect(jobs.map((j) => j.wiki_path)).toEqual(["b.md"]);
  });

  it("propagates the resolver's null when a domain has no source root", () => {
    const jobs = buildReauthorJobs(
      [mkDrift({ domain: "stub" })],
      (_p) => "body",
      (_d) => null,
      "2026-05-18",
    );
    expect(jobs[0]?.prompt).toContain("(unresolved — verify against memory + repo)");
  });

  it("preserves cited and missing source files in the emitted job", () => {
    const drift = mkDrift({
      cited_source_files: ["src/a.ts"],
      missing_source_files: ["src/b.ts"],
    });
    const jobs = buildReauthorJobs([drift], (_p) => "body", (_d) => null);
    expect(jobs[0]?.cited_source_files).toEqual(["src/a.ts"]);
    expect(jobs[0]?.missing_source_files).toEqual(["src/b.ts"]);
  });
});
