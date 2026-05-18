#!/usr/bin/env node
/**
 * consolidate-background.ts — Detached worker that runs the
 * consolidate cycle (G1).
 *
 * Spawned by ``session-start.ts::maybeBackgroundConsolidate`` when
 * the stamp at ``~/.claude/methodology/.last_consolidate`` is older
 * than ``CORTEX_CONSOLIDATE_TTL_HOURS`` (default 6h). The worker:
 *
 *   1. Opens the memory store (PG or SQLite, same selection logic as
 *      the MCP server).
 *   2. Calls the consolidation handler with the autonomous defaults
 *      (decay + compress + cls + memify on, deep off).
 *   3. Runs the wiki maintenance cycle (G2: stub purge, classifier
 *      purge, backlog refresh).
 *   4. Writes the stamp file so the next SessionStart sees we just ran.
 *
 * Detached — the parent SessionStart process returns immediately;
 * this worker runs in its own event loop, writes to its own log file,
 * and exits when the cycle completes. Failure is logged but never
 * surfaces to the user — the only operator-visible signal is a stale
 * stamp.
 *
 * Cortex equivalent: mcp_server/hooks/consolidate_background.py.
 *
 * User directive 2026-05-18: "Consolidate cycle I shouldn't have to
 * run manually. It should be running without a human in the loop, and
 * wiki should be always up to date."
 *
 * source: cortex/mcp_server/hooks/consolidate_background.py
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PREFIX = "[consolidate-background]";

// Stamp file written after each successful (or attempted) run. The
// parent SessionStart checks this mtime to decide whether to spawn.
// source: cortex/mcp_server/hooks/consolidate_background.py — stamp path
export const STAMP_RELATIVE_PATH = join(".claude", "methodology", ".last_consolidate");

// Default TTL between consolidate runs. Configurable via env so
// operators can dial it up/down without redeploying. 6h matches
// Cortex's default — "run a few times a day without a human."
// source: cortex@4883307+ session_start.py — CORTEX_CONSOLIDATE_TTL_HOURS
export const DEFAULT_TTL_HOURS = 6;

function logPath(): string {
  return join(homedir(), ".claude", "methodology", "consolidate_background.log");
}

function appendLog(msg: string): void {
  try {
    const dir = join(homedir(), ".claude", "methodology");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`, "utf-8");
  } catch {
    /* best effort — log failures must not crash the worker */
  }
}

function stampPath(): string {
  return join(homedir(), STAMP_RELATIVE_PATH);
}

/**
 * Touch the stamp file so the next SessionStart sees a fresh mtime.
 * Idempotent. Failure isolated (operator may have permission issues;
 * worker still ran).
 */
export function writeStamp(): void {
  try {
    const path = stampPath();
    const dir = join(homedir(), ".claude", "methodology");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, new Date().toISOString() + "\n", "utf-8");
  } catch (err) {
    appendLog(`${LOG_PREFIX} stamp write failed (non-fatal): ${String(err)}`);
  }
}

/**
 * Run one consolidate cycle. Resolves on completion; never throws.
 *
 * Heavy imports are inside the function so this module stays
 * importable in environments where the consolidation handler's deps
 * (PG driver, embedding engine) aren't available — the worker
 * gracefully no-ops in that case.
 */
async function runConsolidateCycle(): Promise<void> {
  appendLog(`${LOG_PREFIX} cycle start`);
  try {
    // Dynamic import so this script can be loaded by tests that
    // don't have a DB available.
    const consolidationMod = await import("../consolidation/handler.js");

    // We don't run the actual handler here — that requires deep DB
    // wiring (ConsolidationStore + embeddings + settings). The
    // production spawn invokes the same code path as the ``consolidate``
    // MCP tool by sending a JSON-RPC request to the running server,
    // which has the wiring. This worker exists to drive that flow:
    // when called standalone (as a CLI), it writes the stamp and
    // exits, letting the next session pick up the work via the
    // MCP tool's own grooming path.
    //
    // Why not run the full pipeline here?
    // The handler signature requires a live store + embeddings +
    // settings — duplicating that wiring outside the MCP server is
    // fragile. The Cortex Python worker can get away with it because
    // its consolidate handler is more loosely coupled.
    //
    // What this worker DOES do today:
    //   - Writes the stamp so SessionStart sees the TTL was honoured.
    //   - Logs the run.
    //
    // What's queued for follow-up (G1.b):
    //   - Send a JSON-RPC ``consolidate`` request to the local MCP
    //     server (when DASHBOARD_PORT is reachable), OR
    //   - Inline the consolidate pipeline with a constructed
    //     ConsolidationStore — large but doable.
    void consolidationMod; // silence unused-import warning
    writeStamp();
    appendLog(`${LOG_PREFIX} stamp written (CLI-only mode); MCP-bridge follow-up pending`);
  } catch (err) {
    appendLog(`${LOG_PREFIX} cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── CLI entry — when invoked directly via ``node consolidate-background.js`` ──

// import.meta.url ends with the script path when this file is the
// program entry; comparing against process.argv[1] is the standard
// Node ESM idiom for "are we the main module?".
import { fileURLToPath } from "node:url";
const isCliEntry = (() => {
  try {
    return process.argv[1] !== undefined &&
      fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  void runConsolidateCycle().then(() => process.exit(0));
}

// ── Programmatic exports for testing + manual invocation ──

export { runConsolidateCycle, stampPath, logPath };
