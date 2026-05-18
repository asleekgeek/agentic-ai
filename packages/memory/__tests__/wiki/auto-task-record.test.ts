/**
 * Tests for auto-task-record.ts — pure-logic task-record composer.
 *
 * source: packages/memory/src/wiki/auto-task-record.ts
 * source: cortex@HEAD~ mcp_server/core/auto_task_record.py (2026-05-18)
 */

import { describe, expect, it } from "vitest";
import {
  buildTaskRecord,
  isSubstantive,
  type SessionCommit,
  type SessionMemory,
  type TaskRecordInputs,
} from "../../src/wiki/auto-task-record.js";

function mkCommit(over: Partial<SessionCommit> = {}): SessionCommit {
  return {
    hash: "abcdef1234567890",
    message: "feat: add the thing",
    files: ["src/a.ts"],
    timestamp: "2026-05-18T10:00:00Z",
    ...over,
  };
}

function mkMemory(over: Partial<SessionMemory> = {}): SessionMemory {
  return {
    content: "Memory body line\nmore",
    tags: ["decision"],
    created_at: "2026-05-18T10:01:00Z",
    ...over,
  };
}

function mkInputs(over: Partial<TaskRecordInputs> = {}): TaskRecordInputs {
  return {
    session_id: "sess-1",
    domain: "demo",
    cwd: "/repos/demo",
    duration_seconds: 600,
    turn_count: 12,
    commits: [],
    memories: [],
    changed_files: [],
    tools_used: [],
    ...over,
  };
}

// ── isSubstantive ──────────────────────────────────────────────────────

describe("isSubstantive", () => {
  it("returns true with at least one commit", () => {
    expect(isSubstantive(mkInputs({ commits: [mkCommit()] }))).toBe(true);
  });

  it("returns true with ≥2 memories AND ≥5 tools", () => {
    expect(isSubstantive(mkInputs({
      memories: [mkMemory(), mkMemory()],
      tools_used: ["a", "b", "c", "d", "e"],
    }))).toBe(true);
  });

  it("returns false with 1 memory + 5 tools", () => {
    expect(isSubstantive(mkInputs({
      memories: [mkMemory()],
      tools_used: ["a", "b", "c", "d", "e"],
    }))).toBe(false);
  });

  it("returns false with 2 memories + 4 tools", () => {
    expect(isSubstantive(mkInputs({
      memories: [mkMemory(), mkMemory()],
      tools_used: ["a", "b", "c", "d"],
    }))).toBe(false);
  });

  it("returns false for read-only browse", () => {
    expect(isSubstantive(mkInputs())).toBe(false);
  });
});

// ── buildTaskRecord ────────────────────────────────────────────────────

describe("buildTaskRecord — title derivation", () => {
  it("derives title from first commit subject", () => {
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit({ message: "feat: implement widget" })] }),
      { adrNumber: 7, today: "2026-05-18" },
    );
    expect(r.title).toBe("feat: implement widget");
  });

  it("uses first decision/lesson memory when no commits", () => {
    const r = buildTaskRecord(
      mkInputs({ memories: [mkMemory({ content: "Decision: use PG", tags: ["decision"] })] }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.title).toBe("Decision: use PG");
  });

  it("falls back to ``Session work — <cwd>``", () => {
    const r = buildTaskRecord(mkInputs(), { adrNumber: 1, today: "2026-05-18" });
    expect(r.title).toMatch(/^Session work — /);
  });

  it("truncates over-long titles to 120 chars", () => {
    const longMsg = "feat: " + "x".repeat(200);
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit({ message: longMsg })] }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.title.length).toBe(120);
  });
});

describe("buildTaskRecord — path + frontmatter", () => {
  it("zero-pads the ADR number to 4 digits", () => {
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit({ message: "feat: x" })] }),
      { adrNumber: 7, today: "2026-05-18" },
    );
    expect(r.suggested_path).toMatch(/^adr\/demo\/0007-/);
    expect(r.frontmatter["id"]).toBe("0007");
  });

  it("uses ``adr/<domain>/<id>-<slug>.md`` layout", () => {
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit({ message: "Fix the bug!" })] }),
      { adrNumber: 42, today: "2026-05-18" },
    );
    expect(r.suggested_path).toBe("adr/demo/0042-fix-the-bug.md");
  });

  it("sets lifecycle to draft + provenance to auto-generated", () => {
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit()] }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.frontmatter["lifecycle"]).toBe("draft");
    expect(r.frontmatter["provenance"]).toBe("auto-generated");
    expect(r.frontmatter["status"]).toBe("proposed");
    expect(r.frontmatter["domain"]).toBe("demo");
    expect(r.frontmatter["session_id"]).toBe("sess-1");
  });
});

describe("buildTaskRecord — body sections", () => {
  it("emits every mandatory ADR section", () => {
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit()] }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.body).toContain("## Status");
    expect(r.body).toContain("## Entry");
    expect(r.body).toContain("## Mandatory elements");
    expect(r.body).toContain("## How");
    expect(r.body).toContain("## Result");
    expect(r.body).toContain("## Serves");
    expect(r.body).toContain("## Alternatives considered");
    expect(r.body).toContain("## References");
  });

  it("lists commits in How section", () => {
    const r = buildTaskRecord(
      mkInputs({
        commits: [
          mkCommit({ hash: "aaaaaaaa1111", message: "first" }),
          mkCommit({ hash: "bbbbbbbb2222", message: "second" }),
        ],
        changed_files: ["src/a.ts", "src/b.ts"],
      }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.body).toContain("`aaaaaaaa` — first");
    expect(r.body).toContain("`bbbbbbbb` — second");
    expect(r.body).toContain("`src/a.ts`");
    expect(r.body).toContain("`src/b.ts`");
  });

  it("caps commits at 10 in How section with overflow note", () => {
    const commits = Array.from({ length: 15 }, (_, i) =>
      mkCommit({ hash: `h${i.toString().padStart(7, "0")}`, message: `c${i}` }),
    );
    const r = buildTaskRecord(
      mkInputs({ commits }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.body).toContain("… and 5 more commits.");
  });

  it("notes ``read-only`` when no commits + no files", () => {
    const r = buildTaskRecord(
      mkInputs({
        memories: [mkMemory(), mkMemory()],
        tools_used: ["a", "b", "c", "d", "e"],
      }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.body).toContain("session was likely");
    expect(r.body).toContain("read-only");
  });

  it("renders ``no memories`` references block when memories empty", () => {
    const r = buildTaskRecord(
      mkInputs({ commits: [mkCommit()] }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.body).toContain("no memories captured");
  });

  it("renders memory References block when memories present", () => {
    const r = buildTaskRecord(
      mkInputs({
        commits: [mkCommit()],
        memories: [mkMemory({ content: "Memory one", created_at: "2026-05-17T10:00:00Z" })],
      }),
      { adrNumber: 1, today: "2026-05-18" },
    );
    expect(r.body).toContain("Memories captured during this session:");
    expect(r.body).toContain("`2026-05-17` — Memory one");
  });
});
