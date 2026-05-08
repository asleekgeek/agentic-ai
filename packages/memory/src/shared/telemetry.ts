/**
 * Telemetry — lightweight per-process counters for reads + writes.
 *
 * Port of: cortex@ed33435 mcp_server/core/telemetry.py
 *
 * Captures empirical workload distribution (read/write ratio, latency
 * per op kind, cumulative byte-volume, success/failure split) so the
 * paper's "100x more reads than writes" claim is grounded in measurement,
 * not assertion (Popper C6).
 *
 * Storage:
 *   - In-memory Map (per process) for fast snapshot/inspection.
 *   - Append-only JSONL at ~/.claude/methodology/telemetry.jsonl as the
 *     durable artifact for offline analysis. Restart-loss of the in-memory
 *     counters is acceptable because every call is captured in the JSONL.
 *
 * Contract (record):
 *   precondition:  `op` is a non-empty string; `latencyMs` >= 0;
 *                  byte / count fields are non-negative ints.
 *   postcondition: _counters.get(op) is updated; one JSONL line is
 *                  appended on success or silently dropped on I/O error;
 *                  no exception escapes to the handler.
 *
 * source: cortex@ed33435 mcp_server/core/telemetry.py
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Log path ──────────────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/core/telemetry.py:44 — _LOG_PATH
const METHODOLOGY_DIR = join(homedir(), ".claude", "methodology");
const LOG_PATH = join(METHODOLOGY_DIR, "telemetry.jsonl");

// ── Numeric constants ─────────────────────────────────────────────────────────
// Rounding factor: 1000 = round to 3 decimal places via (x * 1000) / 1000.
// source: cortex@ed33435 mcp_server/core/telemetry.py:104 — round(..., 3) = 3 decimal places
const ROUND_3DP = 1000; // source: cortex@ed33435 mcp_server/core/telemetry.py:104,161-163,167
// Unix timestamp uses seconds (not ms): Date.now() is ms, divide by 1000 to get seconds.
// source: cortex@ed33435 mcp_server/core/telemetry.py:101 — ts: time.time() returns seconds
const MS_PER_SECOND = 1000; // source: standard — 1000ms = 1s

try {
  mkdirSync(METHODOLOGY_DIR, { recursive: true });
} catch {
  // best-effort: directory creation may fail under sandbox
}

// ── Opt-out ───────────────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/core/telemetry.py:56-58 — CORTEX_TELEMETRY_DISABLED
function _disabled(): boolean {
  return process.env["CORTEX_TELEMETRY_DISABLED"] === "1";
}

// ── Counter shape ─────────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/core/telemetry.py:82-90 — counter fields

interface Counter {
  count: number;
  ok: number;
  fail: number;
  bytes_in: number;
  bytes_out: number;
  result_count: number;
  latency_ms_sum: number;
  latency_ms_max: number;
}

// ── In-memory store ───────────────────────────────────────────────────────────
// JS is single-threaded: no lock needed (no race between event-loop ticks).
// source: cortex@ed33435 mcp_server/core/telemetry.py:52-53 — _lock + _counters

const _counters = new Map<string, Counter>();

// ── record ────────────────────────────────────────────────────────────────────

/**
 * Record one operation.
 *
 * `op` is the canonical handler name, e.g. `recall`, `remember`, `forget`.
 * Cheap by design: one Map update + one short JSONL line. Target overhead < 1ms.
 *
 * precondition:  op is non-empty string; latencyMs >= 0.
 * postcondition: counter for op updated; JSONL line appended best-effort.
 *
 * source: cortex@ed33435 mcp_server/core/telemetry.py:61-116 — record()
 */
export function record(
  op: string,
  opts: {
    latencyMs: number;
    bytesIn?: number;
    bytesOut?: number;
    resultCount?: number;
    ok?: boolean;
  },
): void {
  if (_disabled()) return;
  const { latencyMs, bytesIn = 0, bytesOut = 0, resultCount = 0, ok = true } = opts;

  let c = _counters.get(op);
  if (!c) {
    c = { count: 0, ok: 0, fail: 0, bytes_in: 0, bytes_out: 0, result_count: 0, latency_ms_sum: 0, latency_ms_max: 0 };
    _counters.set(op, c);
  }
  c.count++;
  if (ok) c.ok++; else c.fail++;
  c.bytes_in += bytesIn;
  c.bytes_out += bytesOut;
  c.result_count += resultCount;
  c.latency_ms_sum += latencyMs;
  if (latencyMs > c.latency_ms_max) c.latency_ms_max = latencyMs;

  // JSONL append is best-effort — a full disk or permission error must never
  // break the handler. The in-memory counters are already updated.
  // source: cortex@ed33435 mcp_server/core/telemetry.py:111-116 — OSError swallowed
  try {
    const line = JSON.stringify({
      ts:           Date.now() / MS_PER_SECOND, // source: Unix timestamp in seconds, cortex@ed33435 mcp_server/core/telemetry.py:101
      op,
      latency_ms:   Math.round(latencyMs * ROUND_3DP) / ROUND_3DP, // source: cortex@ed33435 mcp_server/core/telemetry.py:104
      bytes_in:     bytesIn,
      bytes_out:    bytesOut,
      result_count: resultCount,
      ok,
    });
    appendFileSync(LOG_PATH, line + "\n", "utf-8");
  } catch {
    // best-effort
  }
}

// ── snapshot ──────────────────────────────────────────────────────────────────

/**
 * Return a copy of the current counters for inspection.
 * source: cortex@ed33435 mcp_server/core/telemetry.py:119-122 — snapshot()
 */
export function snapshot(): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [op, c] of _counters.entries()) {
    result[op] = { ...c };
  }
  return result;
}

// ── Read/write op sets ────────────────────────────────────────────────────────
// source: cortex@ed33435 mcp_server/core/telemetry.py:125-132 — _READ_OPS, _WRITE_OPS

const _READ_OPS = new Set([
  "recall",
  "recall_hierarchical",
  "navigate_memory",
  "get_causal_chain",
  "drill_down",
]);

const _WRITE_OPS = new Set([
  "remember",
  "forget",
  "validate_memory",
  "rate_memory",
]);

// ── ratioReadsWrites ──────────────────────────────────────────────────────────

/**
 * Compute reads / max(writes, 1) over the current counters.
 * source: cortex@ed33435 mcp_server/core/telemetry.py:135-145 — ratio_reads_writes()
 */
export function ratioReadsWrites(snap?: Record<string, Record<string, number>>): number {
  const s = snap ?? snapshot();
  let reads = 0;
  let writes = 0;
  for (const [op, c] of Object.entries(s)) {
    const count = (c["count"] as number) ?? 0;
    if (_READ_OPS.has(op)) reads += count;
    if (_WRITE_OPS.has(op)) writes += count;
  }
  return reads / Math.max(writes, 1);
}

// ── reset ─────────────────────────────────────────────────────────────────────

/**
 * Wipe the in-memory counters. The on-disk JSONL is not touched.
 * source: cortex@ed33435 mcp_server/core/telemetry.py:148-151 — reset()
 */
export function reset(): void {
  _counters.clear();
}

// ── summary ───────────────────────────────────────────────────────────────────

/**
 * Snapshot + computed read/write ratio + per-op average latency.
 * source: cortex@ed33435 mcp_server/core/telemetry.py:154-170 — summary()
 */
export function summary(): {
  counters:             Record<string, Record<string, number>>;
  derived:              Record<string, { avg_latency_ms: number; max_latency_ms: number }>;
  ratio_reads_writes:   number;
  log_path:             string;
  disabled:             boolean;
} {
  const snap = snapshot();
  const derived: Record<string, { avg_latency_ms: number; max_latency_ms: number }> = {};
  for (const [op, c] of Object.entries(snap)) {
    const count = Math.max(c["count"] ?? 0, 1);
    // source: cortex@ed33435 mcp_server/core/telemetry.py:161-163 — round(latency_ms_sum/count, 3), round(max, 3)
    derived[op] = {
      // source: cortex@ed33435 mcp_server/core/telemetry.py:161-162 — round(sum/count, 3), round(max, 3)
      avg_latency_ms: Math.round((c["latency_ms_sum"] ?? 0) / count * ROUND_3DP) / ROUND_3DP,
      max_latency_ms: Math.round((c["latency_ms_max"] ?? 0) * ROUND_3DP) / ROUND_3DP,
    };
  }
  return {
    counters:           snap,
    derived,
    // source: cortex@ed33435 mcp_server/core/telemetry.py:167 — round(ratio_reads_writes, 3)
    ratio_reads_writes: Math.round(ratioReadsWrites(snap) * ROUND_3DP) / ROUND_3DP,
    log_path:           LOG_PATH,
    disabled:           _disabled(),
  };
}
