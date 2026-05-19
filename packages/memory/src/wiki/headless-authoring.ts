/**
 * headless-authoring.ts — orchestrate one autonomous authoring cycle.
 *
 * Meadows' leverage-point audit (2026-05-18) identified the missing
 * actuator: the gap detector knows what's missing; ``curate_wiki``
 * builds prompts; but the loop terminated in a queue waiting for a
 * human Claude Code session to consume the jobs. Drain rate was zero.
 *
 * This worker closes the loop. Per cycle:
 *
 *   1. **Anchor authoring** — for every domain × scope with no covered
 *      anchor, call ``claude -p`` with a project-level context block
 *      and write the response as the new anchor page.
 *   2. **Gap drain** — for every file-doc page with curation_gaps
 *      (frontmatter or live audit), call ``claude -p`` once per page
 *      with ALL gaps, parse the sectioned response, replace markers.
 *
 * Anchors come first because a project missing its
 * architecture/services/api page is more visibly incomplete than a
 * single file-doc with a missing "Callers" section. Within the
 * cycle's wall-clock budget the worker authors anchors until each
 * project has visible progress, then falls through to gaps.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:run_headless_authoring_cycle
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  type CycleSummary,
  type DrainResult,
  MAX_DRAINS_PER_CYCLE,
} from "./headless-authoring-claude.js";
import {
  drainMissingAnchors,
  type AnchorAdapters,
} from "./headless-authoring-anchors.js";
import {
  drainAllGapsOnPage,
  scanPagesWithGaps,
} from "./headless-authoring-gaps.js";

// Anchor authoring runs first and gets its own budget — completing
// the structural backbone before nibbling at per-file gaps.
// source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:run_headless_authoring_cycle
const MAX_ANCHOR_DRAINS_PER_CYCLE = 30;

export type { CycleSummary, DrainResult } from "./headless-authoring-claude.js";
export { MAX_DRAINS_PER_CYCLE, MAX_ANCHOR_DRAINS_PER_CYCLE };

// ── Default fs adapters for the anchor pass ──────────────────────────

function defaultAnchorAdapters(wikiRoot: string): AnchorAdapters {
  // MIN_PAGE_BYTES = 800 — cortex parity threshold for "substantive."
  // source: cortex/mcp_server/core/wiki_coverage.py:_MIN_PAGE_BYTES
  const MIN_PAGE_BYTES = 800;
  // source: ECMAScript Date timestamps are ms
  const MS_PER_SECOND = 1000;
  return {
    listSubdirs: (relDir) => {
      try {
        return fs.readdirSync(path.join(wikiRoot, relDir), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch { return []; }
    },
    pageStat: (rel) => {
      try {
        const s = fs.statSync(path.join(wikiRoot, rel));
        return { sizeBytes: s.size, mtimeSec: s.mtimeMs / MS_PER_SECOND };
      } catch { return null; }
    },
    countSubstantivePages: (relDir) => {
      try {
        const abs = path.join(wikiRoot, relDir);
        let count = 0;
        for (const e of fs.readdirSync(abs)) {
          if (!e.endsWith(".md")) continue;
          try { if (fs.statSync(path.join(abs, e)).size >= MIN_PAGE_BYTES) count += 1; }
          catch { /* skip */ }
        }
        return count;
      } catch { return 0; }
    },
  };
}

// ── Public entry ─────────────────────────────────────────────────────

export interface RunHeadlessOpts {
  readonly wikiRoot?: string;
  readonly maxDrains?: number;
  readonly maxAnchorDrains?: number;
  readonly today?: string;
  readonly adapters?: AnchorAdapters;
}

/**
 * One autonomous authoring cycle.
 *
 * Returns a cycle summary regardless of success / failure — the
 * caller logs it and continues. Failure of one page never blocks the
 * others; the cycle never throws.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:run_headless_authoring_cycle
 */
export function runHeadlessAuthoringCycle(opts: RunHeadlessOpts = {}): CycleSummary {
  const start = performance.now();
  const wikiRoot = opts.wikiRoot ?? path.join(
    process.env["HOME"] ?? "",
    ".claude", "methodology", "wiki",
  );
  const today = opts.today ?? new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const adapters = opts.adapters ?? defaultAnchorAdapters(wikiRoot);

  // Phase 1: anchor pages.
  const anchorResults: DrainResult[] = drainMissingAnchors({
    wikiRoot,
    maxDrains: opts.maxAnchorDrains ?? MAX_ANCHOR_DRAINS_PER_CYCLE,
    today,
    adapters,
  });

  // Phase 2: file-doc gap drain. Sorted by gap-count descending so
  // the most-incomplete pages move fastest.
  const candidates = scanPagesWithGaps(wikiRoot);
  candidates.sort((a, b) => {
    const ag = Array.isArray(a.parsed.meta["curation_gaps"]) ? (a.parsed.meta["curation_gaps"] as readonly unknown[]).length : 0;
    const bg = Array.isArray(b.parsed.meta["curation_gaps"]) ? (b.parsed.meta["curation_gaps"] as readonly unknown[]).length : 0;
    if (ag !== bg) return bg - ag;
    return a.path.localeCompare(b.path);
  });
  const maxDrains = opts.maxDrains ?? MAX_DRAINS_PER_CYCLE;
  const fileResults: DrainResult[] = [];
  for (const c of candidates.slice(0, maxDrains)) {
    fileResults.push(...drainAllGapsOnPage(c.path, c.parsed));
  }

  const allResults: DrainResult[] = [...anchorResults, ...fileResults];
  const filled = allResults.filter((r) => r.status === "filled").length;
  const failed = allResults.filter((r) => r.status === "failed").length;
  return {
    pages_scanned: candidates.length,
    pages_with_gaps: candidates.length,
    drains_attempted: allResults.length,
    drains_filled: filled,
    drains_failed: failed,
    duration_ms: Math.round(performance.now() - start),
    results: allResults,
  };
}
