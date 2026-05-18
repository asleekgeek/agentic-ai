/**
 * Tests for auto-task-record-writer.ts — composes + writes the ADR draft.
 *
 * source: packages/memory/src/wiki/auto-task-record-writer.ts
 * source: cortex@HEAD~ mcp_server/handlers/auto_task_record_writer.py (2026-05-18)
 */

import { describe, expect, it } from "vitest";
import {
  maybeWriteTaskRecord,
  nextAdrNumber,
  type WriteTaskRecordDeps,
} from "../../src/wiki/auto-task-record-writer.js";
import type { SessionCommit, SessionMemory } from "../../src/wiki/auto-task-record.js";

function commit(over: Partial<SessionCommit> = {}): SessionCommit {
  return {
    hash: "abcdef1234567890",
    message: "feat: do the work",
    files: ["src/a.ts"],
    timestamp: "2026-05-18T10:00:00Z",
    ...over,
  };
}

function memory(over: Partial<SessionMemory> = {}): SessionMemory {
  return {
    content: "Memory body",
    tags: ["decision"],
    created_at: "2026-05-18T10:01:00Z",
    ...over,
  };
}

interface WrittenPage {
  readonly path: string;
  readonly body: string;
}

function makeDeps(over: Partial<WriteTaskRecordDeps> = {}): { deps: WriteTaskRecordDeps; written: WrittenPage[] } {
  const written: WrittenPage[] = [];
  const deps: WriteTaskRecordDeps = {
    listAdrFilenames: () => [],
    writePage: async (path, body) => { written.push({ path, body }); },
    gitCommitsInWindow: () => [],
    sessionMemories: async () => [],
    ...over,
  };
  return { deps, written };
}

// ── nextAdrNumber ──────────────────────────────────────────────────────

describe("nextAdrNumber", () => {
  it("returns 1 when the dir is empty", () => {
    expect(nextAdrNumber(() => [], "demo")).toBe(1);
  });

  it("returns max+1 of existing zero-padded ADR ids", () => {
    expect(nextAdrNumber(
      () => ["0001-first.md", "0007-mid.md", "0042-latest.md", "README.md"],
      "demo",
    )).toBe(43);
  });

  it("ignores filenames that don't match the NNNN-*.md pattern", () => {
    expect(nextAdrNumber(
      () => ["random.md", "0005-x.md", "1234-y.txt"],
      "demo",
    )).toBe(6);
  });
});

// ── maybeWriteTaskRecord ──────────────────────────────────────────────

describe("maybeWriteTaskRecord — skip paths", () => {
  it("skips when domain is empty", async () => {
    const { deps, written } = makeDeps();
    const r = await maybeWriteTaskRecord(
      { session_id: "s", domain: "", cwd: null, duration_seconds: null, turn_count: null, tools_used: [] },
      deps,
    );
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("no_domain");
    expect(written).toHaveLength(0);
  });

  it("skips when session isn't substantive", async () => {
    const { deps, written } = makeDeps();
    const r = await maybeWriteTaskRecord(
      { session_id: "s", domain: "demo", cwd: "/r", duration_seconds: 60, turn_count: 1, tools_used: [] },
      deps,
    );
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("not_substantive");
    expect(written).toHaveLength(0);
  });
});

describe("maybeWriteTaskRecord — write path", () => {
  it("writes the draft and returns the path + adr number", async () => {
    const { deps, written } = makeDeps({
      gitCommitsInWindow: () => [commit({ message: "feat: implement scope coverage" })],
      sessionMemories: async () => [memory()],
    });
    const r = await maybeWriteTaskRecord(
      {
        session_id: "sess",
        domain: "demo",
        cwd: "/repos/demo",
        duration_seconds: 600,
        turn_count: 12,
        tools_used: ["a", "b"],
        today: "2026-05-18",
      },
      deps,
    );
    expect(r.status).toBe("written");
    expect(written).toHaveLength(1);
    if (r.status === "written") {
      expect(r.path).toBe("adr/demo/0001-feat-implement-scope-coverage.md");
      expect(r.adr_number).toBe(1);
      expect(r.title).toBe("feat: implement scope coverage");
      expect(r.evidence.commits).toBe(1);
    }
    expect(written[0]?.path).toBe("adr/demo/0001-feat-implement-scope-coverage.md");
    expect(written[0]?.body).toContain("## Entry");
  });

  it("computes the next ADR number from listAdrFilenames", async () => {
    const { deps } = makeDeps({
      listAdrFilenames: () => ["0001-x.md", "0042-y.md"],
      gitCommitsInWindow: () => [commit({ message: "feat: new thing" })],
    });
    const r = await maybeWriteTaskRecord(
      { session_id: "s", domain: "demo", cwd: "/r", duration_seconds: 60, turn_count: 1, tools_used: [], today: "2026-05-18" },
      deps,
    );
    if (r.status !== "written") throw new Error("expected written");
    expect(r.adr_number).toBe(43);
    expect(r.path).toBe("adr/demo/0043-feat-new-thing.md");
  });

  it("dedupes changed files across commits", async () => {
    const { deps } = makeDeps({
      gitCommitsInWindow: () => [
        commit({ hash: "aaaaaaaa", files: ["src/a.ts", "src/b.ts"] }),
        commit({ hash: "bbbbbbbb", files: ["src/b.ts", "src/c.ts"] }),
      ],
    });
    const r = await maybeWriteTaskRecord(
      { session_id: "s", domain: "demo", cwd: "/r", duration_seconds: 60, turn_count: 1, tools_used: [], today: "2026-05-18" },
      deps,
    );
    if (r.status !== "written") throw new Error("expected written");
    expect(r.evidence.changed_files).toBe(3); // a, b, c (b deduped)
  });

  it("returns status=error and does not throw when write fails", async () => {
    const { deps } = makeDeps({
      gitCommitsInWindow: () => [commit()],
      writePage: async () => { throw new TypeError("disk full"); },
    });
    const r = await maybeWriteTaskRecord(
      { session_id: "s", domain: "demo", cwd: "/r", duration_seconds: 60, turn_count: 1, tools_used: [], today: "2026-05-18" },
      deps,
    );
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toContain("disk full");
  });
});

describe("maybeWriteTaskRecord — git window calculation", () => {
  it("uses duration_seconds/60 + margin when duration is known", async () => {
    let observedWindow = 0;
    const { deps } = makeDeps({
      gitCommitsInWindow: (_cwd, w) => { observedWindow = w; return []; },
    });
    await maybeWriteTaskRecord(
      { session_id: "s", domain: "demo", cwd: "/r", duration_seconds: 1800, turn_count: 1, tools_used: [], today: "2026-05-18" },
      deps,
    );
    expect(observedWindow).toBe(1800 / 60 + 5);
  });

  it("uses 60-minute default when duration is null", async () => {
    let observedWindow = 0;
    const { deps } = makeDeps({
      gitCommitsInWindow: (_cwd, w) => { observedWindow = w; return []; },
    });
    await maybeWriteTaskRecord(
      { session_id: "s", domain: "demo", cwd: "/r", duration_seconds: null, turn_count: 1, tools_used: [], today: "2026-05-18" },
      deps,
    );
    expect(observedWindow).toBe(60);
  });
});
