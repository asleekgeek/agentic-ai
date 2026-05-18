/**
 * Tests for the low-signal filter in recall.
 *
 * source: cortex@f425157 tests_py/handlers/test_recall_low_signal_filter.py
 */

import { describe, expect, it } from "vitest";
import {
  filterLowSignal,
  LOW_SIGNAL_TAGS,
} from "../../src/recall/recall-helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function mem(id: number, tags: readonly string[] | string | null | undefined): {
  readonly memory_id: number;
  readonly tags: typeof tags;
} {
  return { memory_id: id, tags };
}

// ── Filter behaviour (6 tests) ────────────────────────────────────────────

describe("filterLowSignal — drops auto-captured tool-output", () => {
  it("drops a memory tagged tool:edit", () => {
    const { kept, dropped } = filterLowSignal([mem(1, ["auto-captured", "tool:edit"])]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a memory tagged tool:bash", () => {
    const { kept, dropped } = filterLowSignal([mem(2, ["tool:bash"])]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a memory tagged _backfill", () => {
    const { kept, dropped } = filterLowSignal([mem(3, ["_backfill"])]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a memory tagged imported", () => {
    const { kept, dropped } = filterLowSignal([mem(4, ["imported"])]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a stage-N report (stage-3)", () => {
    const { kept, dropped } = filterLowSignal([mem(5, ["stage-3"])]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("keeps a memory tagged lesson / decision / convention", () => {
    const items = [mem(1, ["lesson"]), mem(2, ["decision"]), mem(3, ["convention"])];
    const { kept, dropped } = filterLowSignal(items);
    expect(kept.map((m) => m.memory_id)).toEqual([1, 2, 3]);
    expect(dropped).toBe(0);
  });
});

// ── Realistic batch (1 test) ──────────────────────────────────────────────

describe("filterLowSignal — realistic batch (the spike scenario)", () => {
  it("surfaces the one curated lesson among four tool captures", () => {
    const batch = [
      mem(1, ["auto-captured", "tool:edit"]),
      mem(2, ["auto-captured", "tool:bash"]),
      mem(3, ["lesson", "wiki"]),
      mem(4, ["auto-captured", "tool:read"]),
      mem(5, ["auto-captured", "tool:grep"]),
    ];
    const { kept, dropped } = filterLowSignal(batch);
    expect(kept.map((m) => m.memory_id)).toEqual([3]);
    expect(dropped).toBe(4);
  });
});

// ── Encoding robustness (3 tests) ─────────────────────────────────────────

describe("filterLowSignal — tag encoding robustness", () => {
  it("parses tags-as-JSON-string", () => {
    const { kept, dropped } = filterLowSignal([mem(1, JSON.stringify(["tool:edit"]))]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("keeps a memory with empty tag array", () => {
    const { kept, dropped } = filterLowSignal([mem(1, [])]);
    expect(kept.map((m) => m.memory_id)).toEqual([1]);
    expect(dropped).toBe(0);
  });

  it("keeps a memory whose tags field is missing", () => {
    const result = filterLowSignal([{ memory_id: 1 }]);
    expect(result.kept.map((m) => m.memory_id)).toEqual([1]);
    expect(result.dropped).toBe(0);
  });
});

// ── Set invariants (2 tests) ──────────────────────────────────────────────

describe("LOW_SIGNAL_TAGS — set invariants", () => {
  it("contains the canonical auto-capture markers", () => {
    expect(LOW_SIGNAL_TAGS.has("auto-captured")).toBe(true);
    expect(LOW_SIGNAL_TAGS.has("tool:edit")).toBe(true);
    expect(LOW_SIGNAL_TAGS.has("tool:bash")).toBe(true);
    expect(LOW_SIGNAL_TAGS.has("_backfill")).toBe(true);
    expect(LOW_SIGNAL_TAGS.has("imported")).toBe(true);
    expect(LOW_SIGNAL_TAGS.has("session-summary")).toBe(true);
  });

  it("does NOT contain knowledge-shaped tags (decision, adr, lesson, …)", () => {
    // Negative pin: if any knowledge tag ever drifts into LOW_SIGNAL_TAGS,
    // recall starts dropping curated content silently. The spike scenario.
    expect(LOW_SIGNAL_TAGS.has("decision")).toBe(false);
    expect(LOW_SIGNAL_TAGS.has("adr")).toBe(false);
    expect(LOW_SIGNAL_TAGS.has("lesson")).toBe(false);
    expect(LOW_SIGNAL_TAGS.has("convention")).toBe(false);
    expect(LOW_SIGNAL_TAGS.has("reference")).toBe(false);
    expect(LOW_SIGNAL_TAGS.has("wiki")).toBe(false);
  });
});
