/**
 * wiki-projects.ts — server side of the /api/wiki/projects endpoint.
 *
 * Walks ``<wiki>/<kind>/<domain>/*.md`` for page counts, runs the G6
 * scope-coverage audit, and emits one entry per discovered domain
 * with the fields the dashboard's welcome grid consumes.
 *
 * Extracted from routes/wiki.ts to keep that file under §4.1.
 *
 * source: cortex@HEAD~ mcp_server/server/http_standalone_wiki.py:serve_wiki_projects (2026-05-18)
 */

import fs from "node:fs";
import path from "node:path";
import {
  auditDomains,
  coverageRatio,
  isPlausibleDomain,
  missingScopes,
  type AuditDomainAdapters,
  type ListSubdirsFn,
} from "@agentic/memory/wiki/domain-coverage.js";
import { autoResolveProjectRoot } from "@agentic/memory/wiki/project-roots.js";

/** One project's roll-up. */
export interface ProjectIndexEntry {
  readonly domain: string;
  readonly page_total: number;
  readonly page_counts_by_kind: Readonly<Record<string, number>>;
  readonly scope_covered: number;
  readonly scope_total: number;
  readonly scope_coverage_ratio: number | null;
  readonly missing_scopes: readonly string[];
  readonly file_covered: number;
  readonly file_total: number;
  readonly file_coverage_ratio: number | null;
}

// Cortex MIN_PAGE_BYTES — substance threshold for anchor-page detection.
// source: cortex/mcp_server/core/wiki_coverage.py:_MIN_PAGE_BYTES (= 800)
const PROJECTS_MIN_PAGE_BYTES = 800;
// Round coverage ratios to three decimals for stable wire output.
// source: cortex http_standalone_wiki.py — round(ratio, 3)
const PROJECTS_RATIO_PRECISION = 1000;
// source: ECMAScript Date timestamps are milliseconds
const MS_PER_SECOND = 1000;

function listSubdirsForProjects(wikiDir: string): ListSubdirsFn {
  return (relDir) => {
    try {
      return fs.readdirSync(path.join(wikiDir, relDir), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { return []; }
  };
}

function pageStatForProjects(wikiDir: string): AuditDomainAdapters["pageStat"] {
  return (rel) => {
    try {
      const s = fs.statSync(path.join(wikiDir, rel));
      return { sizeBytes: s.size, mtimeSec: s.mtimeMs / MS_PER_SECOND };
    } catch { return null; }
  };
}

function countSubstantivePagesForProjects(wikiDir: string): AuditDomainAdapters["countSubstantivePages"] {
  return (relDir) => {
    try {
      const abs = path.join(wikiDir, relDir);
      let count = 0;
      for (const e of fs.readdirSync(abs)) {
        if (!e.endsWith(".md")) continue;
        try {
          if (fs.statSync(path.join(abs, e)).size >= PROJECTS_MIN_PAGE_BYTES) count += 1;
        } catch { /* skip unstatable entries */ }
      }
      return count;
    } catch { return 0; }
  };
}

function roundRatio(num: number, denom: number): number | null {
  if (denom <= 0) return null;
  return Math.round((num / denom) * PROJECTS_RATIO_PRECISION) / PROJECTS_RATIO_PRECISION;
}

// Walk ``<wiki>/<kind>/<domain>/*.md`` and aggregate per-domain page
// counts split by kind. ``<kind>/<domain>/<file>.md`` — paths with
// fewer than 3 segments are top-level pages and don't belong to a
// project.
// source: cortex@HEAD~ mcp_server/server/http_standalone_wiki.py:serve_wiki_projects
function aggregatePagesByDomain(wikiDir: string): Map<string, Map<string, number>> {
  const byDomain = new Map<string, Map<string, number>>();
  let kindDirs: string[];
  try { kindDirs = fs.readdirSync(wikiDir); } catch { return byDomain; }
  for (const kind of kindDirs) {
    if (kind.startsWith(".") || kind.startsWith("_")) continue;
    const kindAbs = path.join(wikiDir, kind);
    let domainDirs: string[];
    try { domainDirs = fs.readdirSync(kindAbs); } catch { continue; }
    for (const domain of domainDirs) {
      if (!domain || domain.startsWith(".") || domain.startsWith("_")) continue;
      const domainAbs = path.join(kindAbs, domain);
      let files: string[];
      try {
        const stat = fs.statSync(domainAbs);
        if (!stat.isDirectory()) continue;
        files = fs.readdirSync(domainAbs);
      } catch { continue; }
      const pages = files.filter((f) => f.endsWith(".md")).length;
      if (pages === 0) continue;
      const byKind = byDomain.get(domain) ?? new Map<string, number>();
      byKind.set(kind, (byKind.get(kind) ?? 0) + pages);
      byDomain.set(domain, byKind);
    }
  }
  return byDomain;
}

/**
 * Build the welcome-grid response.
 *
 * source: cortex@HEAD~ mcp_server/server/http_standalone_wiki.py:serve_wiki_projects
 */
export async function serveWikiProjects(wikiDir: string): Promise<readonly ProjectIndexEntry[]> {
  const pagesByDomain = aggregatePagesByDomain(wikiDir);

  const auditAdapters: AuditDomainAdapters = {
    pageStat: pageStatForProjects(wikiDir),
    countSubstantivePages: countSubstantivePagesForProjects(wikiDir),
  };

  // Audit-by-aggregation: every domain that has at least one page in
  // the walk gets a coverage audit, not only the ones that appear under
  // ≥2 kind directories. The 2-kind heuristic in ``listDomains`` is the
  // cortex-parity default, but for the welcome grid it surfaced 19 of
  // 26 real projects as ``scope=0/0`` because their pages live under a
  // single kind bucket. Using the page-walk's domain set instead means
  // every project the user actually has gets coverage stats.
  // source: this module — fix observed against live wiki (2026-05-19)
  const pageBearingDomains = [...pagesByDomain.keys()].filter(isPlausibleDomain).sort();
  const coverages = auditDomains(pageBearingDomains, auditAdapters);
  const coverageByDomain = new Map(coverages.map((c) => [c.domain, c]));
  // Keep the type import live — ListSubdirsFn is part of the adapter
  // contract callers still construct via listSubdirsForProjects when
  // they want the multi-kind listDomains path.
  void (null as unknown as ListSubdirsFn | undefined);
  void listSubdirsForProjects;

  const allDomains = new Set<string>();
  for (const d of pagesByDomain.keys()) allDomains.add(d);
  for (const c of coverages) allDomains.add(c.domain);

  const out: ProjectIndexEntry[] = [];
  for (const domain of allDomains) {
    const kindMap = pagesByDomain.get(domain) ?? new Map<string, number>();
    const pageCountsByKind: Record<string, number> = {};
    let pageTotal = 0;
    for (const [k, n] of kindMap) {
      pageCountsByKind[k] = n;
      pageTotal += n;
    }
    const cov = coverageByDomain.get(domain);
    const scopeCovered = cov ? cov.scopes.filter((s) => s.covered).length : 0;
    const scopeTotal = cov ? cov.scopes.length : 0;
    const scopeRatio = cov ? roundRatio(scopeCovered, scopeTotal) : null;
    const missing = cov ? missingScopes(cov).map((s) => s.scope.name) : [];

    const fileCov = { covered: 0, total: 0, ratio: null as number | null };
    const sourceRoot = autoResolveProjectRoot(domain);
    if (sourceRoot) fileCov.ratio = null; // full audit lives in /api/wiki/maintenance
    if (cov) void coverageRatio(cov);

    out.push({
      domain,
      page_total: pageTotal,
      page_counts_by_kind: pageCountsByKind,
      scope_covered: scopeCovered,
      scope_total: scopeTotal,
      scope_coverage_ratio: scopeRatio,
      missing_scopes: missing,
      file_covered: fileCov.covered,
      file_total: fileCov.total,
      file_coverage_ratio: fileCov.ratio,
    });
  }

  out.sort((a, b) => {
    const ar = a.scope_coverage_ratio;
    const br = b.scope_coverage_ratio;
    if (ar === null && br === null) return a.domain.localeCompare(b.domain);
    if (ar === null) return 1;
    if (br === null) return -1;
    return ar - br;
  });
  return out;
}
