/**
 * reauthor-jobs.ts — Drift-driven re-authoring jobs (G12).
 *
 * When source-drift.ts flags a wiki page whose cited source files are
 * newer than the page mtime, this module builds the LLM prompt that
 * tells Opus 4.7 to refine, verify, and update the existing page so it
 * once again matches the current source tree. The contract is to
 * PRESERVE every accurate claim and replace only the stale ones —
 * pages with historical value stay; pages covering removed features
 * get a deprecated prefix rather than silent deletion.
 *
 * Shares the wire shape of CurationJob / CoverageJob (the handler
 * serialises all three with one helper under a ``job_type:
 * "reauthor"`` discriminator).
 *
 * Pure logic — the wiki-page-body reader is an injected adapter so
 * tests stay deterministic and production wires real fs calls.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py — reauthor section (2026-05-18)
 */

import { formatPrompt } from "./prompt-sections.js";

// ── Re-author prompt template ─────────────────────────────────────────

// source: cortex@HEAD~ mcp_server/core/auto_curator.py:WIKI_REAUTHOR_PROMPT (2026-05-18)
const WIKI_REAUTHOR_PROMPT = `You are Opus 4.7 re-authoring an existing wiki page for the persistent-memory MCP server.

The auto-curator detected drift between this page and the codebase. Your job is to refine, verify, and update the existing page so it once again matches the current source tree. Preserve every accurate claim; replace stale ones; fill gaps; do NOT delete sections the author wrote unless they are demonstrably false.

# What drifted

{drift_summary}

# Your task

Re-author the page in Markdown so:

1. Every cited source file path resolves to an actual file in the codebase. Replace moved paths with current ones; remove citations of deleted files only when the referenced behaviour no longer exists; otherwise update to the new file path.
2. The body matches the current code behaviour — read the cited files (and any new files that have appeared in the same module) before rewriting.
3. Required sections for kind \`{kind}\` are present and substantive. For \`adr\`: Status, Entry, Mandatory elements, How, Result, Serves, Alternatives, References.
4. Update the frontmatter \`updated:\` field to today, and \`last_reviewed: {today}\`.

# Output format

Output ONLY the wiki page body, starting with YAML frontmatter, then the body. No preamble, no surrounding fences, no explanation.

# Existing page (for context — synthesise, do not blindly copy)

\`\`\`markdown
{existing_body}
\`\`\`

# Conventions

- Same conventions as a fresh authoring job: authoritative declarative prose, citations with full paths, mermaid diagrams where dataflow benefits from one, no filler phrases.
- "Refine and verify and update" means: cross-check claims against the current source. If a paragraph says "implemented via X" and X no longer exists, the paragraph is wrong — rewrite it from what actually exists.
- If the page covers a removed feature in its entirety, do NOT silently delete the page. Instead, prefix the title with "(deprecated)" and add a one-paragraph note pointing to whatever replaced it. Pages with historical value stay.

# The job

**Wiki page**: \`{wiki_path}\`
**Kind**: {kind}
**Domain**: {domain}
**Existing \`updated\`**: {last_updated}
**Drift reasons**: {reasons}
**Source root for verification**: {source_root}

---

Re-author the page now. Output only the Markdown body, frontmatter first.
`;

// ── Drift record the builder consumes ─────────────────────────────────

/**
 * Minimal drift-record shape. Lines up with what source-drift.ts emits
 * plus the kind/domain/last_updated fields the handler attaches before
 * passing drifts to this builder.
 *
 * source: cortex@HEAD~ mcp_server/core/wiki_drift.py:DriftRecord
 */
export interface DriftRecord {
  readonly wiki_path: string;
  readonly domain: string;
  readonly kind: string;
  readonly reasons: readonly string[];
  readonly cited_source_files: readonly string[];
  readonly missing_source_files: readonly string[];
  readonly age_days: number;
  readonly last_updated?: string | null;
}

// ── Reauthor job type ─────────────────────────────────────────────────

/**
 * One re-authoring task for an existing wiki page. Mirrors the
 * wire shape of CurationJob / CoverageJob.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:ReauthorJob
 */
export interface ReauthorJob {
  readonly wiki_path: string;
  readonly domain: string;
  readonly kind: string;
  readonly reasons: readonly string[];
  readonly prompt: string;
  readonly cited_source_files: readonly string[];
  readonly missing_source_files: readonly string[];
}

// ── Body cap ──────────────────────────────────────────────────────────

// Cap the existing-body section in the prompt to keep the request
// within Opus 4.7's reasonable budget for one tool call.
// source: cortex@HEAD~ mcp_server/core/auto_curator.py:build_reauthor_prompt — 4000
const EXISTING_BODY_REAUTHOR_CAP = 4000;
const MAX_MISSING_FILES_LISTED = 5; // source: cortex auto_curator.py:build_reauthor_prompt — missing[:5]

// ── Drift summary renderer ────────────────────────────────────────────

function renderDriftSummary(drift: DriftRecord): string {
  const lines: string[] = [];
  for (const r of drift.reasons) {
    if (r === "missing_source_file") {
      const m = drift.missing_source_files.slice(0, MAX_MISSING_FILES_LISTED).join(", ") || "(none listed)";
      lines.push(
        `- **Missing source files** — the page cites these but they don't ` +
        `exist under the current source root: ${m}`,
      );
    } else if (r === "stale_content") {
      const ageDaysRounded = Math.round(drift.age_days);
      lines.push(
        `- **Stale content** — page mtime is ${ageDaysRounded} days old and ` +
        "the page cites source files that may have changed.",
      );
    } else if (r === "off_template") {
      lines.push(
        `- **Off-template** — the body is missing one or more sections ` +
        `required for kind \`${drift.kind}\`. Restore the canonical structure.`,
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(none recorded)";
}

// ── Reauthor prompt builder ───────────────────────────────────────────

/**
 * Build the LLM prompt for a single drift case.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:build_reauthor_prompt
 */
export function buildReauthorPrompt(
  drift: DriftRecord,
  existingBody: string,
  sourceRoot: string | null,
  today: string = "",
): string {
  const todayStr = today || new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const cappedBody =
    existingBody.length > EXISTING_BODY_REAUTHOR_CAP
      ? existingBody.slice(0, EXISTING_BODY_REAUTHOR_CAP) + "\n…[truncated]"
      : existingBody;
  return formatPrompt(WIKI_REAUTHOR_PROMPT, {
    drift_summary: renderDriftSummary(drift),
    wiki_path:     drift.wiki_path,
    kind:          drift.kind || "explanation",
    domain:        drift.domain,
    last_updated:  drift.last_updated ?? "(unknown)",
    reasons:       drift.reasons.join(", "),
    source_root:   sourceRoot ?? "(unresolved — verify against memory + repo)",
    existing_body: cappedBody,
    today:         todayStr,
  });
}

// ── Reauthor job builder ──────────────────────────────────────────────

/**
 * Adapter to read a wiki page's body. Returns ``null`` when the page is
 * absent so the builder can skip it rather than crash.
 */
export type ReadWikiPageBodyFn = (wikiPath: string) => string | null;

/**
 * Adapter to resolve a domain to its source-tree root. Returns ``null``
 * when the domain has no checked-out tree (the page can still be
 * re-authored against memory).
 */
export type SourceRootResolverFn = (domain: string) => string | null;

/**
 * Build authoring jobs for every drifted page. Drifts whose page body
 * cannot be read are skipped.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_curator.py:build_reauthor_jobs
 */
export function buildReauthorJobs(
  drifts: readonly DriftRecord[],
  readWikiPageBody: ReadWikiPageBodyFn,
  sourceRootResolver: SourceRootResolverFn,
  today: string = "",
): ReauthorJob[] {
  const jobs: ReauthorJob[] = [];
  for (const d of drifts) {
    const body = readWikiPageBody(d.wiki_path);
    if (body == null) continue;
    const srcRoot = d.domain ? sourceRootResolver(d.domain) : null;
    const prompt = buildReauthorPrompt(d, body, srcRoot, today);
    jobs.push({
      wiki_path: d.wiki_path,
      domain: d.domain,
      kind: d.kind,
      reasons: [...d.reasons],
      prompt,
      cited_source_files: [...d.cited_source_files],
      missing_source_files: [...d.missing_source_files],
    });
  }
  return jobs;
}
