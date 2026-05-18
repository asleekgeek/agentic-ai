/**
 * coverage-jobs.ts — Coverage-driven authoring jobs (G12).
 *
 * Counterpart to the cluster-driven jobs in auto-curator.ts. A coverage
 * job exists when a project (domain) is missing a substantive anchor
 * page for a canonical structural scope (architecture / services /
 * api / data-flow / operations / decisions). The downstream LLM
 * authors the missing page from the source tree and any supporting
 * memories.
 *
 * Coverage jobs share the wire shape of curation jobs so the
 * ``curate_wiki`` handler serialises them uniformly under a
 * ``job_type: "coverage"`` discriminator. They differ in semantics:
 * a coverage job is *structural* (something every project needs)
 * while a curation job is *empirical* (this is what the user has
 * been working on).
 *
 * Pure logic — no I/O.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py — coverage section (2026-05-18)
 */

import type { DomainCoverage, ScopeCoverage } from "./domain-coverage.js";
import { MAX_MEMORIES_PER_PROMPT, formatPrompt, memoriesBlock, relatedBlock } from "./prompt-sections.js";

// ── Coverage prompt template ───────────────────────────────────────────

// source: cortex@HEAD~ mcp_server/core/auto_curator.py:WIKI_COVERAGE_PROMPT (2026-05-18)
const WIKI_COVERAGE_PROMPT = `You are Opus 4.7 authoring a structural wiki page for the persistent-memory MCP server.

This is a **coverage-driven** job, not a cluster-driven one: the auto-curator found that the project \`{domain}\` has no substantive page for the scope \`{scope_name}\` ("{scope_title}"), and the wiki contract says every project must document this scope. Author the page from the source tree, the existing related pages, and any memories provided.

# What this scope is

{scope_description}

# Output format

Output **only** the wiki page body, starting with YAML frontmatter, then the body. No preamble, no explanation, no surrounding fences.

# Frontmatter (required)

\`\`\`yaml
---
title: <short specific title — e.g. "{scope_title}: {domain}">
kind: {kind}
domain: {domain}
status: living
authored_by: Opus 4.7
created: {today}
last_reviewed: {today}
audience: [developer, ...]
scope: {scope_name}
---
\`\`\`

# Required structural sections (in this order)

1. **# <title>** — H1 matching frontmatter title.
2. **Lead paragraph** — one paragraph that states the scope of this page and what a reader will learn.
3. **Body sections** specific to the scope. For:
   - \`architecture\` — layers + dependency rule + a Mermaid diagram of the major subsystems; cite the directories that map to each layer.
   - \`services\` — table or list of every major component / handler / module, with one-line responsibility statements and the file paths that define each.
   - \`api\` — exhaustive enumeration of the public surface (CLI flags, HTTP endpoints, MCP tools, library functions) with one-line semantics and a stability flag.
   - \`data-flow\` — a Mermaid sequence or flow diagram of one record's lifecycle through the system, with prose explaining each hop and the file that performs it.
   - \`operations\` — how to deploy, monitor, and recover. Triggers → diagnosis → recovery → rollback. Failure modes with symptoms.
4. **## See also** — cross-links to related pages using \`[[wiki/path]]\` notation.
5. **## Source files** — the files in the codebase a reader should open to verify what this page says. Full paths.

# Conventions

- Walk the source tree if you need to ground the content; the wiki must reflect the codebase as it is, not as it was.
- When a number is given, name its source.
- Don't invent components that don't exist in the repo.
- If a scope has nothing yet (e.g. the project has no HTTP API), say so explicitly with a one-paragraph "currently none" page rather than fabricating endpoints.

# The job

**Domain**: {domain}
**Scope**: {scope_name} — {scope_title}
**Suggested wiki path**: {suggested_path}
**Suggested kind**: {kind}

**Existing related wiki pages** (for cross-linking via \`[[path]]\`):
{related_pages_block}

**Supporting memories** (use as ground truth where they exist; otherwise consult the source tree):

{memories_block}

---

Author the wiki page now. Output only the Markdown body, frontmatter first.
`;

// ── Coverage job type ──────────────────────────────────────────────────

/**
 * One coverage-driven authoring task. Mirrors the wire-shape of
 * ``CurationJob`` so the handler serialises them uniformly.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:CoverageJob
 */
export interface CoverageJob {
  readonly domain: string;
  readonly scope_name: string;
  readonly scope_title: string;
  readonly suggested_kind: string;
  readonly suggested_path: string;
  readonly prompt: string;
  readonly related_pages: readonly string[];
  readonly supporting_memory_ids: readonly number[];
}

// ── Memory snapshot the builder expects ───────────────────────────────

/**
 * Minimal memory shape consumed by ``buildCoverageJobs``. Same as
 * CuratorMemory but optional — callers can pass an empty list when no
 * supporting memories exist (the LLM consults the source tree).
 */
export interface SupportingMemory {
  readonly id?: number;
  readonly content?: string;
  readonly tags?: readonly string[];
}

// ── Coverage prompt builder ───────────────────────────────────────────

export interface BuildCoveragePromptArgs {
  readonly scopeName: string;
  readonly scopeTitle: string;
  readonly scopeDescription: string;
  readonly suggestedKind: string;
  readonly suggestedPath: string;
  readonly domain: string;
  readonly relatedPages: readonly string[];
  readonly supportingMemories: readonly string[];
  readonly supportingTags: readonly (readonly string[])[];
  readonly today?: string;
}

/**
 * Build the LLM prompt for one coverage gap.
 *
 * Unlike cluster-driven jobs, the memory set is small or empty — the
 * LLM is expected to consult the source tree to ground the page.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:build_coverage_prompt
 */
export function buildCoveragePrompt(args: BuildCoveragePromptArgs): string {
  const today = args.today || new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  return formatPrompt(WIKI_COVERAGE_PROMPT, {
    scope_name:        args.scopeName,
    scope_title:       args.scopeTitle,
    scope_description: args.scopeDescription,
    kind:              args.suggestedKind,
    suggested_path:    args.suggestedPath,
    domain:            args.domain,
    today,
    related_pages_block: relatedBlock(args.relatedPages),
    memories_block:      memoriesBlock(args.supportingMemories, args.supportingTags),
  });
}

// ── Coverage job builder ──────────────────────────────────────────────

/**
 * Find existing wiki pages that mention the domain or scope name.
 * Coverage pages benefit from cross-linking so they integrate rather
 * than float alone.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:_find_related_pages_for_scope
 */
export function findRelatedPagesForScope(
  domain: string,
  scopeName: string,
  existingPagesByTopic: ReadonlyMap<string, readonly string[]>,
): string[] {
  const MAX_RELATED_PAGES_PER_SCOPE = 6; // source: cortex auto_curator.py:_find_related_pages_for_scope — [:6]
  const keys = new Set([domain.toLowerCase(), scopeName.toLowerCase()]);
  const related: string[] = [];
  const seen = new Set<string>();
  for (const [topic, paths] of existingPagesByTopic) {
    const t = topic.toLowerCase();
    let matched = false;
    for (const k of keys) {
      if (t.includes(k)) { matched = true; break; }
    }
    if (!matched) continue;
    for (const p of paths) {
      if (!seen.has(p)) {
        related.push(p);
        seen.add(p);
      }
    }
  }
  return related.slice(0, MAX_RELATED_PAGES_PER_SCOPE);
}

export interface BuildCoverageJobsOpts {
  readonly existingPagesByTopic?: ReadonlyMap<string, readonly string[]>;
  readonly supportingMemoriesByDomain?: ReadonlyMap<string, readonly SupportingMemory[]>;
  readonly today?: string;
}

/**
 * Build authoring jobs for every missing scope across every audited
 * domain.
 *
 * Inputs:
 *   - ``coverages`` — list of DomainCoverage from
 *     ``auditAllDomains()`` (domain-coverage.ts).
 *   - ``existingPagesByTopic`` — index used to suggest cross-links.
 *   - ``supportingMemoriesByDomain`` — optional map of domain →
 *     memories the LLM can use to ground the scope page.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:build_coverage_jobs
 */
export function buildCoverageJobs(
  coverages: readonly DomainCoverage[],
  opts: BuildCoverageJobsOpts = {},
): CoverageJob[] {
  const existingPages = opts.existingPagesByTopic ?? new Map<string, readonly string[]>();
  const memsByDomain = opts.supportingMemoriesByDomain ?? new Map<string, readonly SupportingMemory[]>();
  const jobs: CoverageJob[] = [];
  for (const cov of coverages) {
    const domain = cov.domain;
    const mems = memsByDomain.get(domain) ?? [];
    const memContents = mems.slice(0, MAX_MEMORIES_PER_PROMPT).map((m) => m.content ?? "");
    const memTags = mems.slice(0, MAX_MEMORIES_PER_PROMPT).map((m) => m.tags ?? []);
    const memIds = mems
      .map((m) => m.id)
      .filter((id): id is number => typeof id === "number");

    const missing = cov.scopes.filter((s): s is ScopeCoverage => !s.covered);
    for (const m of missing) {
      const scope = m.scope;
      const related = findRelatedPagesForScope(domain, scope.name, existingPages);
      const prompt = buildCoveragePrompt({
        scopeName: scope.name,
        scopeTitle: scope.title,
        scopeDescription: scope.description,
        suggestedKind: scope.suggestedKind,
        suggestedPath: m.suggestedPath,
        domain,
        relatedPages: related,
        supportingMemories: memContents,
        supportingTags: memTags,
        today: opts.today,
      });
      jobs.push({
        domain,
        scope_name: scope.name,
        scope_title: scope.title,
        suggested_kind: scope.suggestedKind,
        suggested_path: m.suggestedPath,
        prompt,
        related_pages: related,
        supporting_memory_ids: memIds,
      });
    }
  }
  return jobs;
}

// ── Coverage job sort ─────────────────────────────────────────────────

// Structural primacy: architecture first so a reader can anchor every
// other scope against it. ``decisions`` last because it accumulates
// organically from task-records.
// source: cortex@HEAD~ mcp_server/core/auto_curator.py:_SCOPE_PRIMACY
const SCOPE_PRIMACY: Readonly<Record<string, number>> = {
  architecture: 0,
  services: 1,
  api: 2,
  "data-flow": 3,
  operations: 4,
  decisions: 5,
};

// Fallback priority for scope names not in the primacy table. Any
// finite-but-large sentinel suffices — these scopes still get authored,
// just after the foundational ones.
// source: cortex@HEAD~ mcp_server/core/auto_curator.py:_SCOPE_PRIMACY.get default = 99
const SCOPE_PRIMACY_FALLBACK = 99;

/**
 * Return ``jobs`` sorted by (scope primacy, domain) so the most
 * foundational scopes are authored first.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:sort_coverage_jobs
 */
export function sortCoverageJobs(jobs: readonly CoverageJob[]): CoverageJob[] {
  return [...jobs].sort((a, b) => {
    const ap = SCOPE_PRIMACY[a.scope_name] ?? SCOPE_PRIMACY_FALLBACK;
    const bp = SCOPE_PRIMACY[b.scope_name] ?? SCOPE_PRIMACY_FALLBACK;
    if (ap !== bp) return ap - bp;
    return a.domain.localeCompare(b.domain);
  });
}
