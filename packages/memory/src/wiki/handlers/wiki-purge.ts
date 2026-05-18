/**
 * Handler: wiki-purge — three-axis purge for wiki pages that no longer
 * earn their place.
 *
 * Axes (checked in order — cheapest, most unambiguous first):
 *
 *   1. **stub**              — body is majority placeholder markers
 *                              (``_(to be filled)_`` etc.) produced by
 *                              the groomer or template_v1 synthesis.
 *                              These masquerade as content but carry
 *                              none.
 *   2. **shallow**           — body has too few prose chars to be an
 *                              explanation (default < 500). Typically
 *                              auto-generated file-doc dumps that
 *                              carry only metadata + import lists.
 *   3. **classifier_reject** — the current classifier no longer admits
 *                              the page. Used after tightening rules
 *                              or after a polluting backfill.
 *
 * Cap: ``max_purges`` bounds how many pages this invocation may
 * delete. Acts as a safety rail — a buggy classifier change wipes at
 * most N pages per cycle rather than the whole wiki. Pages beyond
 * the cap surface in ``deferred`` and reappear on the next call so
 * cleanup proceeds gradually.
 *
 * Memories in the PostgreSQL/SQLite store are left untouched — only
 * the markdown files are removed.
 *
 * source: cortex@HEAD~ mcp_server/handlers/wiki_purge.py (2026-05-18 three-axis)
 */

import { classifyMemory } from "../page-classifier.js";
import { parsePage } from "../pages.js";
import {
  DEFAULT_SHALLOW_THRESHOLD,
  DEFAULT_STUB_THRESHOLD,
  isShallow,
  isStub,
  placeholderCount,
} from "../stub-detector.js";
import type { WikiKind } from "../types.js";

const PAGE_DIRS = new Set(["adr", "conventions", "guides", "journal", "lessons", "notes", "reference", "specs"]);

// Cap on the number of deferred paths returned in the response so the
// payload stays bounded; ``deferred`` itself is the total count.
// source: cortex@HEAD~ mcp_server/handlers/wiki_purge.py:_response — deferred_paths[:50]
const DEFERRED_SAMPLE_CAP = 50;

export type PurgeReason = "stub" | "shallow" | "classifier_reject";

export interface WikiPurgeArgs {
  readonly apply?: boolean;
  readonly kind?: WikiKind | null;
  /** Purge majority-placeholder bodies. Default true. */
  readonly purge_stubs?: boolean;
  /** Purge classifier-rejected bodies. Default true. */
  readonly purge_classifier_rejects?: boolean;
  /** Stub threshold (0-1). Default DEFAULT_STUB_THRESHOLD. */
  readonly stub_threshold?: number;
  /** Cap per invocation. 0 / undefined = no cap. */
  readonly max_purges?: number;
  /** Purge pages below the shallow prose-char threshold. Default true. */
  readonly purge_shallow?: boolean;
  /** Shallow prose-char threshold. Default DEFAULT_SHALLOW_THRESHOLD. */
  readonly shallow_threshold?: number;
}

export interface WikiPurgeResult {
  readonly applied: boolean;
  readonly scanned: number;
  readonly kept: number;
  readonly purged: number;
  readonly purged_paths: readonly string[];
  readonly purged_reasons: Readonly<Record<PurgeReason, number>>;
  readonly deferred: number;
  readonly deferred_paths: readonly string[];
  readonly cap_reached: boolean;
  readonly max_purges: number | null;
  readonly placeholder_lines_purged: number;
  readonly errors: readonly string[];
  readonly root: string;
}

export type WikiPurgeResponse = WikiPurgeResult | { readonly error: string };

export interface PageEntry {
  readonly relPath: string;
  readonly content: string;
}

export interface WikiPurgeDeps {
  readonly wikiRoot: string;
  readonly listAllMarkdownFiles: (root: string, kindFilter?: WikiKind | null) => Promise<PageEntry[]>;
  readonly deleteFile: (absPath: string) => Promise<void>;
  readonly removeEmptyDirs?: (root: string) => Promise<void>;
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  const stripped = raw.trim().replace(/^\[|\]$/g, "");
  return stripped.split(",").map((t) => t.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

interface EvalConfig {
  readonly checkClassifier: boolean;
  readonly checkStub: boolean;
  readonly checkShallow: boolean;
  readonly stubThreshold: number;
  readonly shallowThreshold: number;
}

interface EvalResult {
  readonly tags: readonly string[];
  readonly reason: PurgeReason | null;
}

function evaluatePage(content: string, cfg: EvalConfig): EvalResult {
  const doc = parsePage(content);
  const tags = parseTags(doc.frontmatter["tags"]);
  const body = doc.body;

  if (cfg.checkStub && isStub(body, cfg.stubThreshold)) {
    return { tags, reason: "stub" };
  }
  if (cfg.checkShallow && isShallow(body, cfg.shallowThreshold)) {
    return { tags, reason: "shallow" };
  }
  if (cfg.checkClassifier) {
    const lines = body.trim().split("\n");
    const bodyLines = lines[0]?.startsWith("# ") ? lines.slice(1) : lines;
    const bodyText = bodyLines.join("\n").trim() || String(doc.frontmatter["title"] ?? "");
    const decision = classifyMemory(bodyText, tags);
    if (decision === null) return { tags, reason: "classifier_reject" };
  }
  return { tags, reason: null };
}

export async function handler(
  args: WikiPurgeArgs,
  deps: WikiPurgeDeps,
): Promise<WikiPurgeResponse> {
  const apply                  = args.apply ?? false;
  const kindFilter             = args.kind ?? null;
  const purgeStubs             = args.purge_stubs ?? true;
  const purgeClassifierRejects = args.purge_classifier_rejects ?? true;
  const purgeShallow           = args.purge_shallow ?? true;
  const stubThreshold          = args.stub_threshold ?? DEFAULT_STUB_THRESHOLD;
  const shallowThreshold       = args.shallow_threshold ?? DEFAULT_SHALLOW_THRESHOLD;
  const maxPurgesRaw           = args.max_purges;
  const maxPurges =
    maxPurgesRaw !== undefined && maxPurgesRaw > 0 ? maxPurgesRaw : null;

  if (!deps.wikiRoot) return { error: "wiki root not configured" };

  let entries: PageEntry[];
  try {
    entries = await deps.listAllMarkdownFiles(deps.wikiRoot, kindFilter);
  } catch (err) {
    return { error: `wiki root does not exist or cannot be listed: ${String(err)}` };
  }

  const cfg: EvalConfig = {
    checkClassifier: purgeClassifierRejects,
    checkStub: purgeStubs,
    checkShallow: purgeShallow,
    stubThreshold,
    shallowThreshold,
  };

  const kept: string[] = [];
  const purged: string[] = [];
  const deferred: string[] = [];
  const purgedReasons: Record<PurgeReason, number> = {
    stub: 0,
    shallow: 0,
    classifier_reject: 0,
  };
  let placeholderLinesPurged = 0;
  let capReached = false;
  const errors: string[] = [];

  for (const { relPath, content } of entries) {
    const firstSegment = relPath.split("/")[0] ?? "";
    if (!PAGE_DIRS.has(firstSegment)) continue;

    try {
      const { reason } = evaluatePage(content, cfg);
      if (reason !== null) {
        // Cap applies only when actually deleting — dry-run reports
        // the full count so operators see the actual backlog.
        if (apply && maxPurges !== null && purged.length >= maxPurges) {
          deferred.push(relPath);
          capReached = true;
          continue;
        }
        purged.push(relPath);
        purgedReasons[reason] += 1;
        if (reason === "stub") {
          placeholderLinesPurged += placeholderCount(content);
        }
        if (apply) {
          await deps.deleteFile(`${deps.wikiRoot}/${relPath}`).catch((err: unknown) => {
            errors.push(`${relPath}: ${String(err)}`);
          });
        }
      } else {
        kept.push(relPath);
      }
    } catch (err) {
      errors.push(`${relPath}: ${String(err)}`);
    }
  }

  if (apply && purged.length && deps.removeEmptyDirs) {
    await deps.removeEmptyDirs(deps.wikiRoot).catch(() => undefined);
  }

  return {
    applied: apply,
    scanned: kept.length + purged.length + deferred.length,
    kept: kept.length,
    purged: purged.length,
    purged_paths: purged,
    purged_reasons: purgedReasons,
    deferred: deferred.length,
    deferred_paths: deferred.slice(0, DEFERRED_SAMPLE_CAP),
    cap_reached: capReached,
    max_purges: maxPurges,
    placeholder_lines_purged: placeholderLinesPurged,
    errors,
    root: deps.wikiRoot,
  };
}

export const schema = {
  title: "Wiki — purge stale",
  description:
    "Purge wiki pages that no longer earn their place. Three reject " +
    "axes: (1) stub — body is majority placeholder markers; " +
    "(2) shallow — body has too few prose chars to be an explanation; " +
    "(3) classifier_reject — the current classifier no longer admits " +
    "the page. Memories in the store are left untouched; only the " +
    "markdown files are removed. Defaults to dry-run; pass apply=true " +
    "to actually delete. ``max_purges`` caps deletions per cycle as a " +
    "safety rail.",
  inputSchema: {
    type: "object" as const,
    required: [] as const,
    properties: {
      apply: { type: "boolean" as const, default: false },
      kind: { type: "string" as const, enum: [...PAGE_DIRS] as string[] },
      purge_stubs: { type: "boolean" as const, default: true },
      purge_classifier_rejects: { type: "boolean" as const, default: true },
      stub_threshold: {
        type: "number" as const,
        default: DEFAULT_STUB_THRESHOLD,
        minimum: 0,
        maximum: 1,
      },
      max_purges: { type: "integer" as const, minimum: 0 },
      purge_shallow: { type: "boolean" as const, default: true },
      shallow_threshold: {
        type: "integer" as const,
        default: DEFAULT_SHALLOW_THRESHOLD,
        minimum: 0,
      },
    },
  },
} as const;
