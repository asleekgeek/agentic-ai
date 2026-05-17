/* eslint-disable @typescript-eslint/no-magic-numbers -- source: exact port of mcp_server/core/wiki_layout.py; slug length 80 and ADR number padding 4 copied verbatim. */
/**
 * Wiki path contract — pure functions, no I/O.
 *
 * The wiki is an authored long-form Markdown layer. Pages live under a
 * supplied wiki root; this module only computes paths so the core layer
 * stays filesystem-agnostic.
 *
 * Layout:
 *   <root>/adr/NNNN-<slug>.md         architecture decision records
 *   <root>/reference/<slug>.md        authoritative lookup (file-doc target)
 *   <root>/explanation/<slug>.md      concept prose (lessons/conventions/notes)
 *   <root>/rfc/<slug>.md              pre-decision proposal (specs)
 *   <root>/.generated/INDEX.md        auto-regenerated table of contents
 *
 * source: mcp_server/core/wiki_layout.py
 */

import type { WikiKind } from "./types.js";

/**
 * Modern kinds (ADR-2244 §4.1). Each drives a directory under wiki/ for
 * pages classified to that kind. New writes use these names exclusively.
 *
 * source: mcp_server/core/wiki_layout.py MODERN_PAGE_KINDS
 */
export const MODERN_PAGE_KINDS = [
  "tutorial",
  "how-to",
  "reference",
  "explanation",
  "adr",
  "runbook",
  "rfc",
  "journal",
] as const;

/**
 * Legacy kinds — kept in PAGE_KINDS so existing pages remain readable and
 * wiki_list/wiki_read continue to function during the migration window.
 * New code SHOULD NOT route to these. See classification.ts
 * LEGACY_KIND_TO_MODERN for the read-time normalization map.
 *
 * source: mcp_server/core/wiki_layout.py LEGACY_PAGE_KINDS
 */
export const LEGACY_PAGE_KINDS = [
  "specs",
  "guides",
  "conventions",
  "lessons",
  "notes",
  "files",
] as const;

/**
 * Full set accepted by pagePath / domainPagePath — modern + legacy for
 * backward-compat. Validation in higher layers enforces modern-only on write.
 */
export const PAGE_KINDS: readonly string[] = [
  ...MODERN_PAGE_KINDS,
  ...LEGACY_PAGE_KINDS,
] as const;

const _SAFE = /[^a-zA-Z0-9_.\-]+/g;
const _MAX_SLUG_LEN = 80;

/**
 * Trailing extension tokens to strip before slug consumers append ".md".
 * Without this strip, an input title that already looks like a filename
 * (e.g. "001-zero-dependencies.md") produced filenames like
 * "001-zero-dependencies.md.md" because every caller appends ".md"
 * unconditionally.
 */
const _TRAILING_MD_EXT = /(?:\.md)+$/i;

/**
 * Stable filesystem-safe slug. Deterministic, lowercased, length-capped.
 *
 * Postcondition: the returned slug never ends with ``.md`` (or any chain
 * of ``.md`` suffixes). Callers may safely append ``.md`` without risking
 * ``.md.md``.
 */
export function slugify(value: string, maxLen: number = _MAX_SLUG_LEN): string {
  if (!value) return "unknown";
  let cleaned = value.trim().toLowerCase().replace(_SAFE, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "unknown";
  cleaned = cleaned.replace(_TRAILING_MD_EXT, "").replace(/[-.]+$/, "");
  if (!cleaned) return "unknown";
  const trimmed = cleaned.slice(0, maxLen).replace(/[-.]+$/, "");
  return trimmed || "unknown";
}

/**
 * Slugify a source-file path into a single token suitable for reference/.
 */
export function filePathSlug(filePath: string): string {
  return slugify(filePath.replace(/[/\\]/g, "-"));
}

/**
 * Canonical ADR filename: NNNN-slug.md (4-digit zero-padded).
 */
export function adrFilename(number: number, slug: string): string {
  return `${String(number).padStart(4, "0")}-${slug}.md`;
}

/**
 * Generate a domain-scoped page path: <kind>/<domain>/<slug>.md.
 */
export function domainPagePath(kind: string, domain: string, slug: string): string {
  const safeDomain = domain ? slugify(domain, 40) : "_general";
  return `${kind}/${safeDomain}/${slug}.md`;
}

/**
 * Path relative to the wiki root for a page of a given kind.
 */
export function pagePath(kind: string, filename: string): string {
  if (!PAGE_KINDS.includes(kind)) {
    throw new Error(`unknown wiki page kind: ${kind}`);
  }
  return `${kind}/${filename}`;
}

/**
 * Path of the single auto-generated table of contents.
 */
export function indexPath(): string {
  return ".generated/INDEX.md";
}

/**
 * Given a path like ``adr/0001-foo.md`` return ``[kind, filename]``.
 *
 * Returns null for unrecognised paths (including the generated INDEX).
 * Recognises both modern and legacy kinds.
 */
export function parsePagePath(path: string): [string, string] | null {
  const parts = path.split("/");
  if (parts.length < 2) return null;
  const kind = parts[0];
  if (!kind || !PAGE_KINDS.includes(kind)) return null;
  const filename = parts[parts.length - 1];
  if (!filename) return null;
  return [kind, filename];
}

/** True iff the kind belongs to the modern ADR-2244 taxonomy. */
export function isModernKind(kind: string): boolean {
  return (MODERN_PAGE_KINDS as readonly string[]).includes(kind);
}

/** True iff the kind belongs to the legacy pre-ADR-2244 taxonomy. */
export function isLegacyKindDir(kind: string): boolean {
  return (LEGACY_PAGE_KINDS as readonly string[]).includes(kind);
}

/** Backwards-compat re-export. Use `string` in new code. */
export type { WikiKind };
