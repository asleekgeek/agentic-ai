/* eslint-disable @typescript-eslint/no-magic-numbers -- source: FNV-1a hash constants (0x811c9dc5 offset, 0x01000193 prime) per Fowler/Noll/Vo, hex-encoding constants (16 base, 8 width) per UUID/hex output, and 40-char domain slug cap matching mcp_server/core/wiki_layout.py. */
/**
 * Wiki sync — decide whether a stored memory should be promoted to an
 * authored wiki page, and build the page payload.
 *
 * Pure logic, no I/O. The caller (infrastructure) is responsible for
 * writing the returned markdown to disk.
 *
 * Design intent
 * -------------
 * The wiki is an *authored* layer, not a projection of every memory. Only
 * memories that pass the classifier gate are promoted. The promotion
 * produces a kind-routed page per memory.
 *
 * Routing: ADR-2244 §4.1 modern kinds (tutorial, how-to, reference,
 * explanation, adr, runbook, rfc, journal). The legacy directories
 * (notes, specs, conventions, lessons, guides, files) remain readable
 * for back-compat but new writes always route to modern kinds.
 *
 * Filename format: <modern-kind>/<domain>/<memory_id>-<slug>.md.
 *
 * source: mcp_server/core/wiki_sync.py
 */

import {
  classifyMemoryFull,
  deriveTitle,
} from "./page-classifier.js";
import { toFrontmatter } from "./classification.js";
import { generatePageId } from "./identity.js";
import { slugify } from "./layout.js";

// source: mcp_server/core/wiki_sync.py:31
const DECISION_TAGS = new Set([
  "decision",
  "adr",
  "architecture",
  "spec",
  "design",
]);

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * True if the memory's tags warrant a wiki page.
 *
 * source: mcp_server/core/wiki_sync.py:40-44
 */
export function shouldSync(tags: readonly string[] | null | undefined): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some((t) => DECISION_TAGS.has(t.toLowerCase()));
}

/**
 * Format a frontmatter object with deterministic key ordering. Lists
 * render as YAML inline arrays for round-trippability with the redirect/
 * axis-registry parsers.
 */
function formatFrontmatterYaml(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const key of Object.keys(fm).sort()) {
    const value = fm[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const inner = value.map((v) => String(v)).join(", ");
      lines.push(`${key}: [${inner}]`);
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj).sort()) {
        lines.push(`  ${k}: ${String(obj[k] ?? "")}`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Build (relativePath, markdown) for a memory, or null if rejected.
 *
 * Routes via the ADR-2244 4-tuple. The frontmatter carries the full
 * classification (kind, lifecycle, audience, provenance, generator,
 * tags) plus a stable page id (UUID4) so the page can be renamed
 * without rotting inbound links.
 *
 * Precondition: memoryId is positive integer or string; content non-empty.
 * Postcondition: returns [relPath, markdown] if memory is wiki-worthy.
 *   relPath is <modern-kind>/<domain>/<memoryId>-<slug>.md.
 *
 * source: mcp_server/core/wiki_sync.py:67-112
 */
export function buildFromMemory(opts: {
  readonly memory_id: number | string;
  readonly content: string;
  readonly tags?: readonly string[] | null;
  readonly domain?: string;
  readonly wiki_root?: string;
}): [string, string] | null {
  const { memory_id, content, tags, domain = "", wiki_root } = opts;

  const classification = classifyMemoryFull(content, tags ?? null, wiki_root);
  if (classification === null) return null;

  let title = deriveTitle(content, classification.kind, tags ?? null);
  if (!title) {
    // Fallback: FNV-1a style hash prefix (deterministic, no crypto dep)
    let h = 0x811c9dc5;
    const enc = new TextEncoder();
    const bytes = enc.encode(content);
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    title = `memory-${h.toString(16).padStart(8, "0").slice(0, 8)}`;
  }

  const slug = slugify(title);
  const filename = `${memory_id}-${slug}.md`;
  // ADR-2244: route to the modern kind directory directly. No legacy map.
  const dirName = classification.kind;
  const safeDomain = domain ? slugify(domain, 40) : "_general";
  const rel = `${dirName}/${safeDomain}/${filename}`;

  const fm: Record<string, unknown> = {
    id: generatePageId(),
    memory_id,
    title,
    created: nowIso(),
    ...toFrontmatter(classification),
  };

  const markdown = `${formatFrontmatterYaml(fm)}\n\n# ${title}\n\n${content}\n`;

  return [rel, markdown];
}
