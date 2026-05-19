/**
 * domain-coverage.ts — Per-domain scope coverage audit (G6).
 *
 * Pure-logic audit: takes filesystem-shaped adapters and reports which
 * canonical scopes are covered by a substantive, non-stale anchor page.
 * I/O lives in the caller (typically the consolidate handler or the
 * dashboard renderer).
 *
 * source: cortex@4883307 mcp_server/core/wiki_coverage.py:audit_domain
 */

import {
  COVERAGE_THRESHOLDS,
  DEFAULT_MAX_AGE_DAYS,
  MIN_PAGE_BYTES,
  SCOPES,
  type Scope,
  suggestedPathFor,
} from "./scopes.js";

// source: ECMAScript Date timestamps are milliseconds
const MS_PER_SECOND = 1000;
// source: 24 h × 3600 s/h — UTC-anchored day length, not subject to DST
const SECONDS_PER_DAY = 86400;

// ── Adapter shape ──────────────────────────────────────────────────────

/**
 * Filesystem adapter for a single wiki page candidate.
 *
 * Returns ``null`` when the page does not exist OR cannot be statted.
 * ``sizeBytes`` and ``mtimeSec`` mirror the two checks the audit cares
 * about: substance (size threshold) and freshness (mtime within window).
 */
export type PageStatFn = (relPath: string) => { sizeBytes: number; mtimeSec: number } | null;

/**
 * Filesystem adapter for counting ``.md`` files under a directory.
 * Returns 0 when the directory is absent.
 */
export type CountSubstantivePagesFn = (relDir: string) => number;

// ── Result types ───────────────────────────────────────────────────────

export interface ScopeCoverage {
  readonly scope: Scope;
  readonly domain: string;
  readonly covered: boolean;
  readonly pageCount: number;
  readonly anchorPage: string | null;
  readonly suggestedPath: string;
}

export interface DomainCoverage {
  readonly domain: string;
  readonly scopes: readonly ScopeCoverage[];
}

export function coveredCount(c: DomainCoverage): number {
  return c.scopes.reduce((n, s) => n + (s.covered ? 1 : 0), 0);
}

export function missingCount(c: DomainCoverage): number {
  return c.scopes.length - coveredCount(c);
}

export function coverageRatio(c: DomainCoverage): number {
  return c.scopes.length === 0 ? 0 : coveredCount(c) / c.scopes.length;
}

export function missingScopes(c: DomainCoverage): readonly ScopeCoverage[] {
  return c.scopes.filter((s) => !s.covered);
}

// ── Core audit ─────────────────────────────────────────────────────────

interface SubstantiveAnchorOpts {
  readonly directories: readonly string[];
  readonly domain: string;
  readonly anchorFilenames: readonly string[];
  readonly nowSec: number;
  readonly maxAgeDays: number | null;
  readonly pageStat: PageStatFn;
}

/**
 * Return the wiki-relative path of the first substantive anchor page,
 * or null when none qualifies. Substantive = size ≥ MIN_PAGE_BYTES AND
 * (when maxAgeDays is set) mtime within the freshness window.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:_has_substantive_anchor
 */
function hasSubstantiveAnchor(opts: SubstantiveAnchorOpts): string | null {
  for (const dir of opts.directories) {
    for (const filename of opts.anchorFilenames) {
      const rel = `${dir}/${opts.domain}/${filename}`;
      const stat = opts.pageStat(rel);
      if (stat === null) continue;
      if (stat.sizeBytes < MIN_PAGE_BYTES) continue;
      if (opts.maxAgeDays !== null) {
        const ageDays = (opts.nowSec - stat.mtimeSec) / SECONDS_PER_DAY;
        if (ageDays > opts.maxAgeDays) continue;
      }
      return rel;
    }
  }
  return null;
}

function countPagesAcrossDirs(
  directories: readonly string[],
  domain: string,
  count: CountSubstantivePagesFn,
): number {
  let total = 0;
  for (const dir of directories) {
    total += count(`${dir}/${domain}`);
  }
  return total;
}

export interface AuditDomainAdapters {
  readonly pageStat: PageStatFn;
  readonly countSubstantivePages: CountSubstantivePagesFn;
  readonly nowSec?: number;
}

export interface AuditDomainOpts {
  /** Pages older than this count as missing. ``null`` disables freshness. */
  readonly maxAgeDays?: number | null;
}

/**
 * Compute coverage for one domain across all canonical scopes.
 *
 * Coverage rules (1:1 with Cortex):
 *   - Scopes with anchor filenames: substantive anchor present →
 *     covered.
 *   - Scopes without anchor filenames (decisions, prd): substantive
 *     page count ≥ COVERAGE_THRESHOLDS[name] (default 1) → covered.
 *   - maxAgeDays is propagated into the anchor check; pages older
 *     than the window count as missing.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:audit_domain
 */
export function auditDomain(
  domain: string,
  adapters: AuditDomainAdapters,
  opts: AuditDomainOpts = {},
): DomainCoverage {
  const maxAgeDays = opts.maxAgeDays === undefined ? DEFAULT_MAX_AGE_DAYS : opts.maxAgeDays;
  const nowSec = adapters.nowSec ?? Date.now() / MS_PER_SECOND;
  const scopes: ScopeCoverage[] = [];
  for (const scope of SCOPES) {
    const anchor = hasSubstantiveAnchor({
      directories: scope.directories,
      domain,
      anchorFilenames: scope.anchorFilenames,
      nowSec,
      maxAgeDays,
      pageStat: adapters.pageStat,
    });
    const pageCount = countPagesAcrossDirs(scope.directories, domain, adapters.countSubstantivePages);
    const threshold = COVERAGE_THRESHOLDS[scope.name] ?? 1;
    const covered =
      anchor !== null || (scope.anchorFilenames.length === 0 && pageCount >= threshold);
    scopes.push({
      scope,
      domain,
      covered,
      pageCount,
      anchorPage: anchor,
      suggestedPath: suggestedPathFor(scope, domain),
    });
  }
  return { domain, scopes };
}

// ── Domain discovery ───────────────────────────────────────────────────

const KNOWN_KINDS: readonly string[] = [
  "reference", "explanation", "adr", "adrs", "runbook", "specs", "notes",
  "guides", "conventions", "lessons", "rfc", "how-to", "tutorial", "files",
  "architecture",
];

const DOMAIN_REJECT_YEAR_RE = /^\d{4}$/;

/**
 * Filter for ``listDomains`` — accept project names, reject buckets.
 *
 * Rejected: empty, starting with ``.`` or ``_``, bare 4-digit years
 * (these are time buckets, not projects).
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:_is_plausible_domain
 */
export function isPlausibleDomain(name: string): boolean {
  if (!name) return false;
  if (name.startsWith(".") || name.startsWith("_")) return false;
  if (DOMAIN_REJECT_YEAR_RE.test(name)) return false;
  return true;
}

/**
 * Filesystem adapter: list immediate subdirectory names under
 * ``relDir``. Returns empty array when ``relDir`` is absent. Used by
 * ``listDomains`` to count which directories appear under multiple
 * wiki kinds.
 */
export type ListSubdirsFn = (relDir: string) => readonly string[];

/**
 * Discover domains by scanning ``<wiki>/<kind>/<domain>/`` subdirs.
 *
 * A directory is considered a domain when at least two known wiki
 * kinds contain it as a subdirectory. Reserved buckets (``_general``,
 * bare years) are filtered.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:list_domains
 */
export function listDomains(listSubdirs: ListSubdirsFn): string[] {
  const MIN_KIND_HITS = 2; // source: cortex wiki_coverage.py:list_domains — c >= 2
  const counts = new Map<string, number>();
  for (const kind of KNOWN_KINDS) {
    for (const entry of listSubdirs(kind)) {
      if (!isPlausibleDomain(entry)) continue;
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
  }
  const out: string[] = [];
  for (const [d, c] of counts) if (c >= MIN_KIND_HITS) out.push(d);
  out.sort();
  return out;
}

/**
 * Audit every supplied domain. Returns coverage rolls sorted by
 * missing-count desc so the most under-documented projects surface
 * first.
 *
 * Caller controls how the domain list is discovered — pass
 * ``listDomains(listSubdirs)`` for the cortex-parity 2-kind threshold,
 * or pass any custom list (e.g. discovered via page-aggregation walk)
 * to audit a broader set.
 *
 * source: this module — discovery decoupled from audit (2026-05-19)
 */
export function auditDomains(
  domains: readonly string[],
  adapters: AuditDomainAdapters,
  opts: AuditDomainOpts = {},
): DomainCoverage[] {
  const out = domains.map((d) => auditDomain(d, adapters, opts));
  out.sort((a, b) => missingCount(b) - missingCount(a));
  return out;
}

/**
 * Sweep every domain ``listDomains`` discovers (≥2 kind directories).
 * Thin wrapper around ``auditDomains`` for the cortex-parity path.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:audit_all_domains
 */
export function auditAllDomains(
  listSubdirs: ListSubdirsFn,
  adapters: AuditDomainAdapters,
  opts: AuditDomainOpts = {},
): DomainCoverage[] {
  return auditDomains(listDomains(listSubdirs), adapters, opts);
}
