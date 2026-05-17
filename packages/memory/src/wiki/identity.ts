/**
 * Stable content IDs for wiki pages — Phase 3 of ADR-2244.
 *
 * Every wiki page carries an immutable identifier in its frontmatter
 * (``id: <uuid>``). Paths become *views* over identifiers, mirroring
 * MediaWiki and TYPO3 conventions. When a page is renamed the identifier
 * travels with the content; a redirect stub at the old path preserves
 * inbound links (see ./redirect.ts).
 *
 * Identifier format: UUID4 (RFC 9562), canonical 36-char hex form.
 *
 * source: mcp_server/core/wiki_identity.py
 */

import { randomUUID } from "node:crypto";

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PageIdentity {
  readonly page_id: string;
  readonly memory_id: number | null;
}

export function isValidPageId(value: string | null | undefined): boolean {
  if (!value) return false;
  return _UUID_RE.test(value);
}

/** Mint a fresh UUID4 in canonical hex form. */
export function generatePageId(): string {
  return randomUUID();
}

/** Return the existing ``id`` field from frontmatter, if valid. */
export function extractPageId(
  frontmatter: Readonly<Record<string, unknown>>,
): string | null {
  const raw = frontmatter.id;
  if (typeof raw !== "string") return null;
  if (!isValidPageId(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Return the page's existing ID or mint a new one. Returns ``[id, minted]``
 * where ``minted`` is true if a new ID was generated.
 */
export function ensurePageId(
  frontmatter: Readonly<Record<string, unknown>>,
): [string, boolean] {
  const existing = extractPageId(frontmatter);
  if (existing !== null) return [existing, false];
  return [generatePageId(), true];
}

/** Return ``memory_id`` field if present and integer-coercible. */
export function extractMemoryId(
  frontmatter: Readonly<Record<string, unknown>>,
): number | null {
  const raw = frontmatter.memory_id;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

export function pageIdentityFromFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
): PageIdentity | null {
  const page_id = extractPageId(frontmatter);
  if (page_id === null) return null;
  return { page_id, memory_id: extractMemoryId(frontmatter) };
}
