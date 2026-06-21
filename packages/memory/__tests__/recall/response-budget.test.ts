/**
 * Core tests for the bounded-IO response budget — port of
 * tests_py/core/test_response_budget.py (Cortex HEAD bc5af469).
 *
 * These pin the pure water-filling / truncation algorithm in
 * src/recall/response-budget.ts to the oracle's behavioral contract:
 * the constants, serialized-length measurement, the weighted water-level
 * solver, and boundPayload's in-place truncate → drop-tail → give-up passes.
 *
 * Source of truth: anthropic-partnership/Cortex/mcp_server/core/response_budget.py
 *                  + tests_py/core/test_response_budget.py
 */

import { describe, it, expect } from "vitest";

import {
  HOST_CAP_CHARS,
  SAFETY_FACTOR,
  MAX_RESPONSE_CHARS,
  serializedLength,
  waterLevel,
  boundPayload,
  listTarget,
  textTarget,
} from "../../src/recall/response-budget.js";

// Mirror of the oracle's _mem helper (test_response_budget.py:25-26):
// a default memory dict is {id, content, score: 0.5} plus extras.
function mem(id: number, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, content, score: 0.5, ...extra };
}

// Deep snapshot for noop/determinism comparisons (JSON-native payloads).
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Constants ──────────────────────────────────────────────────────────────

describe("response-budget constants", () => {
  // Port of: test_default_budget_is_host_cap_times_safety_factor (core L222-227).
  it("default budget is host cap × safety factor", () => {
    expect(HOST_CAP_CHARS).toBe(100_000);
    expect(SAFETY_FACTOR).toBe(0.75);
    expect(MAX_RESPONSE_CHARS).toBe(75_000);
  });
});

// ── serializedLength ─────────────────────────────────────────────────────────

describe("serializedLength", () => {
  // Port of: test_serialized_length_matches_compact_json (core L32-35).
  // The TS measure is the compact JSON string counted by code points.
  it("matches compact JSON (no spaces)", () => {
    const payload = { memories: [mem(1, "héllo\nworld")], count: 1 };
    const expected = [...JSON.stringify(payload)].length;
    expect(serializedLength(payload)).toBe(expected);
    // Compact: no spaces after separators.
    expect(JSON.stringify(payload)).not.toContain(", ");
    expect(JSON.stringify(payload)).not.toContain('": ');
  });

  // Port of: test_serialized_length_counts_chars_not_bytes (core L38-41).
  // 'é' is one code point (not its 2 UTF-8 bytes).
  it("counts characters, not UTF-8 bytes", () => {
    const payload = { content: "é".repeat(10) };
    const expected = ('{"content":"' + "é".repeat(10) + '"}').length;
    expect(serializedLength(payload)).toBe(expected);
  });
});

// ── waterLevel ─────────────────────────────────────────────────────────────

describe("waterLevel — weighted max-min fairness", () => {
  // Port of: test_water_level_single_text (core L47-48).
  it("single text frees exactly `needed`", () => {
    expect(waterLevel([[10, 1.0]], 3)).toBe(7);
  });

  // Port of: test_water_level_cuts_largest_first (core L51-55).
  it("cuts the largest first", () => {
    const level = waterLevel([[10, 1], [4, 1], [2, 1]], 6);
    expect(level).toBe(4);
    const freed = [10, 4, 2].reduce((s, ln) => s + Math.max(0, ln - level), 0);
    expect(freed).toBeGreaterThanOrEqual(6);
  });

  // Port of: test_water_level_spreads_across_ties (core L58-61).
  it("spreads across ties", () => {
    const level = waterLevel([[10, 1.0], [10, 1.0]], 4);
    expect(level).toBe(8);
    const freed = [10, 10].reduce((s, ln) => s + Math.max(0, ln - level), 0);
    expect(freed).toBeGreaterThanOrEqual(4);
  });

  // Port of: test_water_level_zero_when_insufficient (core L64-65).
  it("returns 0 when emptying everything cannot free `needed`", () => {
    expect(waterLevel([[3, 1.0], [2, 1.0]], 100)).toBe(0);
  });

  // Port of: test_water_level_no_cut_needed (core L68-69).
  it("returns max length when nothing needs cutting", () => {
    expect(waterLevel([[5, 1.0], [3, 1.0]], 0)).toBe(5);
  });

  // Port of: test_water_level_weighted_cuts_low_priority_first (core L72-79).
  it("weighted: cuts low-priority (low-weight) first", () => {
    const level = waterLevel([[100, 2.0], [100, 1.0]], 30);
    expect(level).toBe(70);
    expect(Math.trunc(level * 2.0)).toBeGreaterThanOrEqual(100); // heavy keeps all
    expect(Math.trunc(level * 1.0)).toBe(70); // light cut to 70
  });
});

// ── boundPayload ───────────────────────────────────────────────────────────

describe("boundPayload", () => {
  // Port of: test_noop_under_budget (core L85-90).
  it("is a no-op under budget and adds no truncated key", () => {
    const payload = { memories: [mem(1, "x".repeat(100))], count: 1 };
    const before = snapshot(payload);
    const out = boundPayload(payload, [listTarget("memories")], 10_000);
    expect(out).toEqual(before);
    expect(out.memories[0]).not.toHaveProperty("truncated");
  });

  // Port of: test_truncates_to_budget_and_marks_items (core L93-101).
  it("truncates to budget and marks items (id + original length survive)", () => {
    const payload = {
      memories: [mem(1, "a".repeat(50_000)), mem(2, "b".repeat(50_000))],
      count: 2,
    };
    const out = boundPayload(payload, [listTarget("memories")], 5_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(5_000);
    const item = out.memories[0] as Record<string, unknown>;
    expect(item["truncated"]).toBe(true);
    expect(item["content_length"]).toBe(50_000); // ORIGINAL size
    expect([1, 2]).toContain(item["id"]); // id survives for fetch-by-id
  });

  // Port of: test_small_items_survive_intact (core L104-113).
  it("leaves small items intact while truncating fat ones", () => {
    const small = "small content";
    const payload = {
      memories: [mem(1, "a".repeat(50_000)), mem(2, small)],
      count: 2,
    };
    const out = boundPayload(payload, [listTarget("memories")], 5_000);
    expect(out.memories[1]["content"]).toBe(small);
    expect(out.memories[1]).not.toHaveProperty("truncated");
    expect(out.memories[0]["truncated"]).toBe(true);
  });

  // Port of: test_text_target_truncation (core L116-121).
  // TextTarget bookkeeping keys are `<key>_truncated` and `<key>_length`.
  it("truncates a TextTarget with <key>_truncated / <key>_length keys", () => {
    const payload: Record<string, unknown> = { context: "z".repeat(20_000) };
    const out = boundPayload(payload, [textTarget("context")], 2_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(2_000);
    expect(out["context_truncated"]).toBe(true);
    expect(out["context_length"]).toBe(20_000);
  });

  // Port of: test_preset_length_key_is_not_clobbered (core L124-130).
  // wiki_read pre-sets the full page size; truncation must not overwrite it.
  it("never clobbers a caller-preset length key", () => {
    const payload: Record<string, unknown> = {
      content: "y".repeat(10_000),
      content_length: 99_999,
    };
    const out = boundPayload(payload, [textTarget("content")], 1_000);
    expect(out["content_truncated"]).toBe(true);
    expect(out["content_length"]).toBe(99_999); // preserved, NOT 10_000
  });

  // Port of: test_mixed_targets_share_one_budget (core L133-148).
  it("shares one budget across mixed list + text targets", () => {
    const payload = {
      memories: [mem(1, "a".repeat(20_000)), mem(2, "b".repeat(20_000))],
      notes: [{ content: "c".repeat(20_000) }],
      context: "d".repeat(20_000),
    };
    const out = boundPayload(
      payload,
      [listTarget("memories"), listTarget("notes"), textTarget("context")],
      6_000,
    );
    expect(serializedLength(out)).toBeLessThanOrEqual(6_000);
  });

  // Port of: test_drops_tail_items_when_contents_exhausted (core L151-160).
  it("drops tail items when content truncation is exhausted", () => {
    const memories = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      content: "", // nothing to truncate
      note: "n".repeat(100), // un-cuttable metadata; small enough that a few items fit
    }));
    const payload: Record<string, unknown> = { memories };
    const out = boundPayload(payload, [listTarget("memories")], 2_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(2_000);
    expect(out["truncation_dropped"] as number).toBeGreaterThan(0);
    expect((out["memories"] as unknown[]).length).toBeLessThan(50);
    // Head survives, tail dropped first.
    expect((out["memories"] as Array<Record<string, unknown>>)[0]["id"]).toBe(0);
  });

  // Port of: test_metadata_only_overflow_returns_payload_unmasked (core L163-168).
  it("returns the payload unmasked on metadata-only overflow", () => {
    const payload: Record<string, unknown> = {
      blob: "z".repeat(5_000),
      memories: [],
    };
    const out = boundPayload(payload, [listTarget("memories")], 100);
    expect(out["blob"]).toBe("z".repeat(5_000));
  });

  // Port of: test_escaped_content_still_lands_under_budget (core L171-176).
  // Each char serializes to 2 chars; the re-measure loop must converge.
  it("lands under budget even when content escapes to 2× width", () => {
    const payload = { memories: [mem(1, '"\n'.repeat(20_000))], count: 1 };
    const out = boundPayload(payload, [listTarget("memories")], 3_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(3_000);
  });

  // Port of: test_score_weighted_truncation_preserves_relevant_content (L179-199).
  it("score-weighted truncation keeps content proportional to weight", () => {
    const payload = {
      memories: [
        mem(1, "a".repeat(50_000), { score: 0.9 }),
        mem(2, "b".repeat(50_000), { score: 0.1 }),
      ],
      count: 2,
    };
    const out = boundPayload(payload, [listTarget("memories", "content", "score")], 4_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(4_000);
    const keptHigh = (out.memories[0]["content"] as string).length;
    const keptLow = (out.memories[1]["content"] as string).length;
    expect(keptLow).toBeGreaterThan(0); // condensed, not erased
    expect(keptHigh / keptLow).toBeGreaterThanOrEqual(8.0);
    expect(keptHigh / keptLow).toBeLessThanOrEqual(10.0); // ≈ score ratio 9 ± rounding
    expect(out.memories[0]["truncated"]).toBe(true);
    expect(out.memories[1]["truncated"]).toBe(true);
  });

  // Port of: test_degenerate_weights_fall_back_to_equal_shares (core L202-219).
  it("falls back to equal shares for degenerate weights (missing/0/neg/NaN)", () => {
    const payload = {
      memories: [
        { id: 1, content: "a".repeat(20_000) }, // missing score
        { id: 2, content: "b".repeat(20_000), score: 0 }, // zero
        { id: 3, content: "c".repeat(20_000), score: -2.0 }, // negative
        { id: 4, content: "d".repeat(20_000), score: Number.NaN }, // NaN
      ],
    };
    const out = boundPayload(payload, [listTarget("memories", "content", "score")], 4_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(4_000);
    const lengths = (out.memories as Array<Record<string, unknown>>).map(
      (m) => (m["content"] as string).length,
    );
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1); // equal ± floor
  });

  // Port of: test_deterministic (core L230-238).
  it("is deterministic", () => {
    const build = (): Record<string, unknown> => ({
      memories: [mem(1, "a".repeat(50_000)), mem(2, "b".repeat(40_000))],
      count: 2,
    });
    const a = boundPayload(build(), [listTarget("memories", "content", "score")], 5_000);
    const b = boundPayload(build(), [listTarget("memories", "content", "score")], 5_000);
    expect(a).toEqual(b);
  });
});
