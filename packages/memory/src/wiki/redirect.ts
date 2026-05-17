/**
 * Redirect stubs for renamed wiki pages — Phase 3 of ADR-2244.
 *
 * When a page is renamed the wiki leaves a *redirect stub* at the old
 * path. The stub has minimal body and a frontmatter declaration that
 * points readers at the new path (MediaWiki #REDIRECT convention).
 *
 * Stub frontmatter shape:
 *   ---
 *   redirect_to: <new wiki-relative path>
 *   redirect_id: <UUID4 of the target page>
 *   redirect_reason: <free-form, optional>
 *   created: <ISO-8601 UTC>
 *   ---
 *
 * Either ``redirect_to`` or ``redirect_id`` is sufficient. When both are
 * present, the ID wins.
 *
 * Pure logic — no I/O. Callers read the on-disk content and pass it in.
 *
 * source: mcp_server/core/wiki_redirect.py
 */

import { isValidPageId } from "./identity.js";

export const MAX_REDIRECT_DEPTH = 5;

export interface Redirect {
  readonly target_path: string;
  readonly target_id: string | null;
  readonly reason: string;
}

export interface ResolvedTarget {
  readonly final_path: string;
  readonly hops: number;
  readonly chain: readonly string[];
}

export type FrontmatterReader = (
  path: string,
) => Readonly<Record<string, unknown>>;

/**
 * Construct + validate a Redirect.
 */
export function makeRedirect(opts: {
  target_path?: string;
  target_id?: string | null;
  reason?: string;
}): Redirect {
  const target_path = (opts.target_path ?? "").trim();
  const target_id = opts.target_id ?? null;
  const reason = (opts.reason ?? "").trim();
  if (!target_path && !target_id) {
    throw new Error("Redirect requires at least one of target_path or target_id");
  }
  if (target_id !== null && !isValidPageId(target_id)) {
    throw new Error(`invalid redirect_id: ${JSON.stringify(target_id)}; expected UUID4`);
  }
  return { target_path, target_id, reason };
}

/** True iff redirect points at a stable ID (preferred form). */
export function isIdBased(r: Redirect): boolean {
  return r.target_id !== null;
}

/**
 * Extract a Redirect from frontmatter, or null if the page is not a stub.
 *
 * Recognises ``redirect_to`` (path) and ``redirect_id`` (UUID).
 */
export function parseRedirect(
  frontmatter: Readonly<Record<string, unknown>>,
): Redirect | null {
  const rawPath = frontmatter.redirect_to;
  const rawId = frontmatter.redirect_id;
  const targetPath = typeof rawPath === "string" ? rawPath.trim() : "";
  const targetIdStr = typeof rawId === "string" ? rawId.trim() : "";

  if (!targetPath && !targetIdStr) return null;

  let targetId: string | null = targetIdStr || null;
  if (targetId !== null && !isValidPageId(targetId)) {
    // Malformed ID — treat as path-only if path present, else no redirect.
    targetId = null;
    if (!targetPath) return null;
  }

  const reasonRaw = frontmatter.redirect_reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";

  return { target_path: targetPath, target_id: targetId, reason };
}

export function isRedirect(
  frontmatter: Readonly<Record<string, unknown>>,
): boolean {
  return parseRedirect(frontmatter) !== null;
}

/**
 * Walk redirect frontmatter until we reach a non-redirect page.
 *
 * Returns null on cycle / depth exhaustion / missing target.
 */
export function resolveChain(
  startPath: string,
  reader: FrontmatterReader,
  maxDepth: number = MAX_REDIRECT_DEPTH,
): ResolvedTarget | null {
  const chain: string[] = [startPath];
  const seen = new Set<string>([startPath]);
  let current = startPath;

  for (let i = 0; i < maxDepth; i++) {
    const fm = reader(current);
    const redirect = parseRedirect(fm);
    if (redirect === null) {
      return {
        final_path: current,
        hops: chain.length - 1,
        chain: [...chain],
      };
    }
    const nextPath = redirect.target_path;
    if (!nextPath) {
      // ID-only redirect — caller must resolve IDs externally.
      return null;
    }
    if (seen.has(nextPath)) {
      // Cycle.
      return null;
    }
    chain.push(nextPath);
    seen.add(nextPath);
    current = nextPath;
  }

  return null;
}

/**
 * Render the markdown for a redirect stub.
 *
 * source: mcp_server/core/wiki_redirect.py:190
 */
export function buildRedirectStub(opts: {
  target_path?: string;
  target_id?: string | null;
  target_title?: string;
  reason?: string;
  created_at?: string;
}): string {
  const targetPath = opts.target_path ?? "";
  const targetId = opts.target_id ?? null;
  const targetTitle = opts.target_title ?? "";
  const reason = opts.reason ?? "";
  const createdAt = opts.created_at ?? "";

  if (!targetPath && !targetId) {
    throw new Error("buildRedirectStub requires target_path or target_id");
  }
  if (targetId !== null && !isValidPageId(targetId)) {
    throw new Error(`invalid target_id: ${JSON.stringify(targetId)}`);
  }

  const lines: string[] = ["---"];
  if (targetPath) lines.push(`redirect_to: ${targetPath}`);
  if (targetId !== null) lines.push(`redirect_id: ${targetId}`);
  if (reason) lines.push(`redirect_reason: ${reason}`);
  if (createdAt) lines.push(`created: ${createdAt}`);
  lines.push("---");
  lines.push("");
  lines.push("# Moved");
  lines.push("");
  if (targetPath) {
    const linkText = targetTitle || targetPath;
    lines.push(`This page has moved to [${linkText}](${targetPath}).`);
  } else if (targetId !== null) {
    const linkText = targetTitle || `page id:${targetId}`;
    lines.push(`This page has moved to **${linkText}**.`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── Frontmatter parser shim ──────────────────────────────────────────────

const _FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * Lightweight YAML-ish frontmatter parser. Handles scalar, inline list,
 * and block list shapes. Sufficient for redirect detection.
 *
 * source: mcp_server/core/wiki_redirect.py:248
 */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const m = text.match(_FRONTMATTER_RE);
  if (!m) return {};

  const fm: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  let currentList: string[] = [];

  function closeList(): void {
    if (currentListKey !== null) {
      fm[currentListKey] = currentList;
      currentListKey = null;
      currentList = [];
    }
  }

  for (const raw of (m[1] ?? "").split("\n")) {
    const stripped = raw.trim();
    if (!stripped) {
      closeList();
      continue;
    }
    if (
      currentListKey !== null &&
      raw.startsWith(" ") &&
      stripped.startsWith("- ")
    ) {
      currentList.push(stripped.slice(2).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    closeList();
    if (!stripped.includes(":")) continue;
    const idx = stripped.indexOf(":");
    const key = stripped.slice(0, idx).trim();
    const value = stripped.slice(idx + 1).trim();
    if (value === "") {
      currentListKey = key;
      currentList = [];
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
        .filter((t) => t.length > 0);
      continue;
    }
    fm[key] = value.replace(/^['"]|['"]$/g, "");
  }
  closeList();
  return fm;
}
