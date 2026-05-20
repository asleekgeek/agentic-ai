/**
 * grooming-background-deps.ts — anchor-pass adapters for the grooming
 * daemon. Extracted so ``grooming-background.ts`` keeps its imports
 * minimal at startup (the daemon runs continuously; a lighter entry
 * keeps Node's resident memory smaller).
 *
 * source: this module — paired with grooming-background.ts (2026-05-20)
 */

import fs from "node:fs";
import path from "node:path";
import type { AnchorAdapters } from "../wiki/headless-authoring-anchors.js";

// MIN_PAGE_BYTES = 800 — cortex-parity threshold for "substantive."
// source: cortex/mcp_server/core/wiki_coverage.py:_MIN_PAGE_BYTES
const MIN_PAGE_BYTES = 800;
// source: ECMAScript Date timestamps are ms
const MS_PER_SECOND = 1000;

/**
 * Build the default filesystem-backed AnchorAdapters for a wiki root.
 * Mirrors the helper inline in ``headless-authoring.ts`` but kept here
 * so the daemon doesn't pull the orchestration module on startup.
 *
 * source: packages/memory/src/wiki/headless-authoring.ts:defaultAnchorAdapters
 */
export function defaultAnchorAdapters(wikiRoot: string): AnchorAdapters {
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
