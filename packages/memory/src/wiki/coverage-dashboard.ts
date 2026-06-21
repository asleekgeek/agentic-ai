/**
 * coverage-dashboard.ts — Per-project documentation coverage dashboard (G5).
 *
 * Meadows leverage-point Level 6 (information flows): the system knows
 * what's missing — ``curation_gaps`` per page, the scope audit per
 * project — but the user doesn't unless they drill into hundreds of
 * file-docs one by one. The dashboard surfaces the gap report as a
 * single readable page per project so the reader sees at a glance
 * what's covered, what's empty, and what's queued.
 *
 * Each dashboard lives at ``wiki/_dashboards/<domain>.md``. Generated
 * content — NOT human-authored. Regenerated on every ``consolidate``
 * cycle so it stays current.
 *
 * Pure logic (rendering + composition). Two thin adapters for the I/O
 * the renderer cannot avoid:
 *   - kindCounts: walk ``<wiki>/<kind>/<domain>/`` and count pages.
 *   - curationGapsCount: parse YAML frontmatter ``curation_gaps`` lists
 *     across a domain's pages and sum the open gaps.
 *
 * source: cortex main mcp_server/core/wiki_coverage_dashboard.py
 */

import type {
  AuditDomainAdapters,
  DomainCoverage,
  ScopeCoverage,
} from "./domain-coverage.js";
import { auditDomain } from "./domain-coverage.js";

// ── Adapter shapes ─────────────────────────────────────────────────────

/**
 * Per-domain file-level coverage roll-up. Caller supplies the result
 * of file-coverage.ts (already runs in the consolidate cycle) so the
 * dashboard renderer doesn't re-walk the filesystem.
 */
export interface FileCoverageRollup {
  readonly domain: string;
  readonly sourceRoot: string | null;
  readonly sourceFileCount: number;
  readonly coveredFileCount: number;
  readonly uncoveredFiles: readonly string[];
}

/**
 * Returns ``{kind: page_count}`` for every kind directory that contains
 * the domain. Returns empty map when nothing matches.
 */
export type KindPageCountsFn = (domain: string) => Readonly<Record<string, number>>;

/**
 * Returns ``{totalPages, openGaps}`` for the domain's wiki subtree.
 * Walks every kind directory's ``<kind>/<domain>/**`` and tallies
 * frontmatter ``curation_gaps`` list entries.
 */
export type CurationGapCountsFn = (domain: string) => { totalPages: number; openGaps: number };

export interface DashboardAdapters extends AuditDomainAdapters {
  readonly fileCoverage: (domain: string) => FileCoverageRollup;
  readonly kindCounts: KindPageCountsFn;
  readonly curationGapCounts: CurationGapCountsFn;
}

// ── Constants ──────────────────────────────────────────────────────────

const PCT_SCALE = 100; // source: percent definition — value/total × 100
// Cap the uncovered-file list shown on the dashboard so the page stays
// readable. The full list lives in the audit; the dashboard surfaces
// the top of it.
// source: cortex/mcp_server/core/wiki_coverage_dashboard.py:render_dashboard — [:30]
const UNCOVERED_DISPLAY_LIMIT = 30;

// ── Helpers ────────────────────────────────────────────────────────────

function pct(num: number, denom: number): number {
  return denom === 0 ? 0 : Math.round((num / denom) * PCT_SCALE);
}

function renderFrontmatter(domain: string): string {
  return [
    "---",
    `title: ${domain} — documentation coverage`,
    "kind: reference",
    `domain: ${domain}`,
    "scope: coverage-dashboard",
    "provenance: auto-generated",
    "authored_by: wiki-coverage-dashboard-v1",
    "lifecycle: living",
    "---",
  ].join("\n");
}

function renderScoreboard(
  cov: DomainCoverage,
  fileCov: FileCoverageRollup,
  totalPages: number,
  totalGaps: number,
): string {
  const covered = cov.scopes.filter((s) => s.covered).length;
  const total = cov.scopes.length;
  const slotPct = pct(covered, total);
  const lines = ["## Coverage at a glance", ""];
  lines.push(`* **Canonical slots filled:** ${covered}/${total} (${slotPct}%)`);
  if (fileCov.sourceRoot) {
    const fPct = pct(fileCov.coveredFileCount, fileCov.sourceFileCount);
    lines.push(
      `* **Source files referenced somewhere:** ${fileCov.coveredFileCount}/${fileCov.sourceFileCount} (${fPct}%)`,
    );
  } else {
    lines.push("* **Source files referenced somewhere:** _(no source root resolved)_");
  }
  lines.push(`* **Total wiki pages for this project:** ${totalPages}`);
  lines.push(`* **Open curation gaps awaiting LLM authoring:** ${totalGaps}`);
  lines.push("");
  return lines.join("\n");
}

function renderSlotTable(scopes: readonly ScopeCoverage[]): string {
  const lines = ["## Canonical slots", "", "| Slot | Status | Anchor page |", "|---|---|---|"];
  for (const s of scopes) {
    let badge: string;
    let anchor: string;
    if (s.covered) {
      badge = "✅ filled";
      anchor = s.anchorPage
        ? `[\`${s.anchorPage}\`](../${s.anchorPage})`
        : `(${s.pageCount} pages)`;
    } else {
      badge = "✗ **missing — queued**";
      anchor = `_(will be authored at \`${s.suggestedPath}\`)_`;
    }
    lines.push(`| **${s.scope.title}** | ${badge} | ${anchor} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderMissingDescriptions(scopes: readonly ScopeCoverage[]): string {
  const missing = scopes.filter((s) => !s.covered);
  if (missing.length === 0) return "";
  const lines = ["## What's still missing — and what should be in each", ""];
  for (const s of missing) {
    lines.push(`### ${s.scope.title}`, "");
    lines.push(s.scope.description, "");
    lines.push(
      `_Will be authored at \`${s.suggestedPath}\` by the autonomous worker. Status: queued._`,
      "",
    );
  }
  return lines.join("\n");
}

function renderKindCounts(kindCounts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(kindCounts);
  if (entries.length === 0) return "";
  entries.sort((a, b) => b[1] - a[1]);
  const lines = ["## Pages by kind", "", "| Kind | Pages |", "|---|---|"];
  for (const [kind, cnt] of entries) lines.push(`| ${kind} | ${cnt} |`);
  lines.push("");
  return lines.join("\n");
}

function renderUncoveredFiles(fileCov: FileCoverageRollup): string {
  if (!fileCov.sourceRoot || fileCov.uncoveredFiles.length === 0) return "";
  const lines = ["## Source files not yet referenced anywhere", ""];
  lines.push(
    `_${fileCov.uncoveredFiles.length} files don't appear in any anchor ` +
    "page yet. The autonomous worker will surface them as it authors " +
    "the **services** and **architecture** slots._",
    "",
    "```",
  );
  const shown = fileCov.uncoveredFiles.slice(0, UNCOVERED_DISPLAY_LIMIT);
  for (const f of shown) lines.push(f);
  if (fileCov.uncoveredFiles.length > UNCOVERED_DISPLAY_LIMIT) {
    lines.push(`… +${fileCov.uncoveredFiles.length - UNCOVERED_DISPLAY_LIMIT} more`);
  }
  lines.push("```", "");
  return lines.join("\n");
}

// ── Public renderer ────────────────────────────────────────────────────

/**
 * Render the dashboard Markdown for one project.
 *
 * Output structure:
 *   1. Frontmatter (kind/domain/scope/provenance).
 *   2. Lead paragraph naming the generator.
 *   3. Coverage-at-a-glance scoreboard.
 *   4. Canonical-slot fill table (one row per scope).
 *   5. Missing-slot descriptions (one section per uncovered scope).
 *   6. Pages-by-kind breakdown.
 *   7. Uncovered source files (capped at UNCOVERED_DISPLAY_LIMIT).
 *
 * source: cortex/mcp_server/core/wiki_coverage_dashboard.py:render_dashboard
 */
export function renderDashboard(domain: string, adapters: DashboardAdapters): string {
  const cov = auditDomain(domain, adapters);
  const fileCov = adapters.fileCoverage(domain);
  const { totalPages, openGaps } = adapters.curationGapCounts(domain);
  const kindCounts = adapters.kindCounts(domain);

  const parts: string[] = [];
  parts.push(renderFrontmatter(domain));
  parts.push("");
  parts.push(`# ${domain} — documentation coverage`);
  parts.push("");
  parts.push(
    `_This page is auto-generated by the consolidate cycle. It shows ` +
    `what's documented for **${domain}** and what isn't yet. Nothing ` +
    `here is hand-edited — the headless authoring worker drains the ` +
    `gaps below cycle by cycle._`,
  );
  parts.push("");
  parts.push(renderScoreboard(cov, fileCov, totalPages, openGaps));
  parts.push(renderSlotTable(cov.scopes));
  const missingDescs = renderMissingDescriptions(cov.scopes);
  if (missingDescs) parts.push(missingDescs);
  const kindSection = renderKindCounts(kindCounts);
  if (kindSection) parts.push(kindSection);
  const uncoveredSection = renderUncoveredFiles(fileCov);
  if (uncoveredSection) parts.push(uncoveredSection);

  // Strip trailing blanks the section helpers may have left, then add
  // the canonical trailing newline.
  return parts.join("\n").replace(/\n+$/, "") + "\n";
}

// ── Dashboard index renderer ───────────────────────────────────────────

/**
 * Render the per-project dashboard index page that lives at
 * ``wiki/_dashboards/_index.md``. Lists every domain with a clickable
 * link to its dashboard.
 *
 * source: cortex/mcp_server/core/wiki_coverage_dashboard.py:write_dashboards (index portion)
 */
export function renderDashboardIndex(domains: readonly string[]): string {
  const lines = [
    "---",
    "title: Coverage dashboards",
    "kind: reference",
    "scope: coverage-index",
    "provenance: auto-generated",
    "---",
    "",
    "# Coverage dashboards",
    "",
    "_One page per project, regenerated on every consolidate cycle._",
    "",
    "| Project | Dashboard |",
    "|---|---|",
  ];
  for (const d of [...domains].sort()) {
    lines.push(`| ${d} | [\`_dashboards/${d}.md\`](_dashboards/${d}.md) |`);
  }
  return lines.join("\n") + "\n";
}

// ── Frontmatter ``curation_gaps`` parser ───────────────────────────────

/**
 * Count the entries of a page's YAML frontmatter ``curation_gaps``
 * list. Returns 0 when no frontmatter or no ``curation_gaps`` key.
 *
 * Implements the same lightweight YAML walk Cortex uses — full YAML
 * parsing would pull a dependency for one shape.
 *
 * source: cortex/mcp_server/core/wiki_coverage_dashboard.py:_count_curation_gaps_under
 */
// YAML frontmatter delimiter ``---`` is exactly three hyphens.
// source: YAML 1.2 spec §9.1.1 — directives-end marker is "---"
const FM_DELIM_LEN = 3;

export function countCurationGapsInBody(body: string): number {
  if (!body.startsWith("---")) return 0;
  const end = body.indexOf("\n---", FM_DELIM_LEN);
  if (end < 0) return 0;
  const block = body.slice(FM_DELIM_LEN, end);
  let inList = false;
  let gaps = 0;
  for (const line of block.split("\n")) {
    if (line.startsWith("curation_gaps:")) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const isIndented = line.startsWith(" ") || line.startsWith("\t");
    const stripped = line.replace(/^\s+/, "");
    if (isIndented && stripped.startsWith("- ")) {
      gaps += 1;
    } else {
      inList = false;
    }
  }
  return gaps;
}
