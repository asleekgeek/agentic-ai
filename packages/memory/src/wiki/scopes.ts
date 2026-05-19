/**
 * scopes.ts — Canonical documentation scopes for any project (G6).
 *
 * The auto-curator is bottom-up: it clusters memories the user worked
 * on and queues authoring jobs for those topics. That misses what the
 * user DIDN'T touch — the structural scopes every codebase should
 * document (architecture, API surface, runbooks). This module is the
 * top-down counterpart. The 15 scopes below name what every project
 * needs documented; ``audit_domain`` (domain-coverage.ts) checks which
 * scopes have substantive anchor pages and which are missing.
 *
 * Pure data + types. No I/O.
 *
 * source: cortex@4883307 mcp_server/core/wiki_coverage.py:SCOPES
 */
// ── Constants ──────────────────────────────────────────────────────────

// Minimum useful page size in bytes. Below this, the page is a stub and
// doesn't count as covering the scope.
// source: cortex/mcp_server/core/wiki_coverage.py:_MIN_PAGE_BYTES (= 800)
export const MIN_PAGE_BYTES = 800;

// Default freshness window for an anchor page. Pages older than this
// many days are treated as stale and count as missing again, so the
// autonomous worker refreshes them. Anchor pages churn slowly; 90 is
// the conservative default.
// source: cortex/mcp_server/core/wiki_coverage.py:_DEFAULT_MAX_AGE_DAYS (= 90)
export const DEFAULT_MAX_AGE_DAYS = 90;

// ── Scope type ─────────────────────────────────────────────────────────

// Re-exported from scopes-types.ts to keep this file's surface stable
// while letting scopes-guides.ts depend on the type without an import
// cycle. source: ./scopes-types.ts
export type { Scope } from "./scopes-types.js";
import type { Scope as _ScopeT } from "./scopes-types.js";
import { GUIDE_SCOPES } from "./scopes-guides.js";

// ── Cortex-parity scopes ───────────────────────────────────────────────

/**
 * The original 15 cortex-parity scopes covering reference + explanation
 * + ADR/PRD + onboarding. Composed with ``GUIDE_SCOPES`` below to form
 * the full SCOPES catalogue.
 *
 * source: cortex@4883307 mcp_server/core/wiki_coverage.py:96-343 (SCOPES)
 */
const CORTEX_SCOPES: readonly _ScopeT[] = [
  {
    name: "product-overview",
    title: "Product overview",
    description:
      "What the project IS, in one page a non-engineer (customer, " +
      "partner, exec) can read. Problem, solution, who it's for, " +
      "what makes it different. The page sales picks up to " +
      "explain the project to a customer.",
    anchorFilenames: ["product-overview.md", "overview.md", "what-is-this.md", "elevator-pitch.md"],
    directories: ["guides", "reference", "explanation"],
    suggestedKind: "reference",
  },
  {
    name: "architecture",
    title: "Architecture overview",
    description:
      "Overall design: layers, the dependency rule, the major " +
      "subsystems and how they relate. The first page a new " +
      "engineer should read.",
    anchorFilenames: ["architecture-overview.md", "architecture.md"],
    directories: ["reference", "explanation", "architecture"],
    suggestedKind: "explanation",
  },
  {
    name: "services",
    title: "Services / components inventory",
    description:
      "Catalogue of the project's components, handlers, modules " +
      "or services — what each one is responsible for, where its " +
      "boundary lies, what it must not do.",
    anchorFilenames: ["services.md", "components.md", "modules.md", "handlers.md"],
    directories: ["reference", "explanation"],
    suggestedKind: "reference",
  },
  {
    name: "code-walkthrough",
    title: "Code walkthrough",
    description:
      "Reading-the-code guide: where to start in the source " +
      "tree, how the entry points connect, what each top-level " +
      "directory means. Targeted at a new engineer cloning the " +
      "repo for the first time.",
    anchorFilenames: ["code-walkthrough.md", "codebase-tour.md", "reading-the-code.md"],
    directories: ["explanation", "guides", "reference"],
    suggestedKind: "explanation",
  },
  {
    name: "api",
    title: "Public API surface",
    description:
      "The contract the project exposes to callers — CLI flags, " +
      "HTTP endpoints, MCP tools, library functions. What is " +
      "stable, what is experimental, what is deprecated.",
    anchorFilenames: ["api.md", "api-reference.md", "endpoints.md"],
    directories: ["reference"],
    suggestedKind: "reference",
  },
  {
    name: "data-flow",
    title: "Data flow",
    description:
      "Lifecycle of a record through the system: how it enters, " +
      "what transforms it, where it is stored, how it is " +
      "retrieved. Diagrams strongly preferred.",
    anchorFilenames: ["data-flow.md", "dataflow.md", "pipeline.md", "ingest.md"],
    directories: ["reference", "explanation"],
    suggestedKind: "explanation",
  },
  {
    name: "commands",
    title: "Commands & CLI",
    description:
      "Every slash command, CLI subcommand, or invocable entry " +
      "point. What each one does, when to use it, what to expect " +
      "in the response. The reference a user hits when they ask " +
      "'how do I do X?'",
    anchorFilenames: ["commands.md", "cli.md", "slash-commands.md"],
    directories: ["reference", "guides"],
    suggestedKind: "reference",
  },
  {
    name: "mcp",
    title: "MCP integration",
    description:
      "How the project exposes (or consumes) Model Context " +
      "Protocol surfaces — tools, resources, prompts, the " +
      "stability model. Only applies to projects that integrate " +
      "with MCP; otherwise the scope page documents 'we don't " +
      "use MCP.'",
    anchorFilenames: ["mcp.md", "mcp-integration.md", "mcp-tools.md"],
    directories: ["reference", "explanation"],
    suggestedKind: "reference",
  },
  {
    name: "tools",
    title: "Tooling & dependencies",
    description:
      "What's in the toolchain — runtime, package manager, " +
      "testing framework, linters, build system, hosted services, " +
      "third-party libraries the project takes hard dependencies " +
      "on. Each entry with a one-line 'why this one'.",
    anchorFilenames: ["tools.md", "tooling.md", "stack.md", "dependencies.md"],
    directories: ["reference"],
    suggestedKind: "reference",
  },
  {
    name: "ci-cd",
    title: "CI / CD",
    description:
      "Build, test, release pipeline. What runs on every push, " +
      "what runs on merge to main, what runs on tag. Where the " +
      "configuration lives, what fails block a merge.",
    anchorFilenames: ["ci-cd.md", "ci.md", "build.md", "release.md", "deploy.md"],
    directories: ["reference", "runbook", "guides"],
    suggestedKind: "reference",
  },
  {
    name: "ai-usage",
    title: "AI usage",
    description:
      "Where AI / LLMs are used in the project — which models, " +
      "which prompts, what's auto vs. human-in-the-loop, what " +
      "data the models see, how cost and rate-limit are bounded. " +
      "Skip with 'no AI usage' if the project doesn't use LLMs.",
    anchorFilenames: ["ai-usage.md", "llm-usage.md", "ai-integration.md", "prompts.md"],
    directories: ["explanation", "reference"],
    suggestedKind: "explanation",
  },
  {
    name: "operations",
    title: "Operations & runbooks",
    description:
      "Deploy, monitor, recover. On-call procedures, health " +
      "checks, common failure modes and how to respond to them.",
    anchorFilenames: ["operations.md", "runbook.md", "monitoring.md"],
    directories: ["runbook", "guides"],
    suggestedKind: "runbook",
  },
  {
    name: "prd",
    title: "Product requirements",
    description:
      "Spec / RFC / PRD documents — what's been formally proposed " +
      "and accepted as scope. Each PRD frames a problem, the " +
      "goals, the non-goals, the design, and the open questions.",
    anchorFilenames: [], // any spec or rfc page counts
    directories: ["specs", "rfc"],
    suggestedKind: "rfc",
  },
  {
    name: "decisions",
    title: "Decisions / task-records",
    description:
      "Documented decisions and completed tasks — Entry, " +
      "Mandatory elements, How, Result, Serves. The project's " +
      "causal history.",
    anchorFilenames: [], // any ADR counts
    directories: ["adr", "adrs"],
    suggestedKind: "adr",
  },
  {
    name: "onboarding",
    title: "Onboarding & getting started",
    description:
      "Day-one path for a new contributor or integrator: install, " +
      "configure, run the smoke test, ship the first change. " +
      "The 'I just landed in this repo, what do I do' page.",
    anchorFilenames: ["getting-started.md", "onboarding.md", "quickstart.md", "setup.md"],
    directories: ["guides", "tutorial"],
    suggestedKind: "tutorial",
  },
];

/**
 * Full canonical catalogue: cortex-parity scopes concatenated with
 * the 26 guide-shaped scopes (Diátaxis how-to + tutorial, setup +
 * operating, security, contribution, extensibility, reference
 * helpers). Adding a scope is a deliberate policy edit, not an
 * emergent property of tag drift.
 *
 * source: cortex@4883307 mcp_server/core/wiki_coverage.py:96-343
 * source: ./scopes-guides.ts — Diátaxis + operations + governance
 */
export const SCOPES: readonly _ScopeT[] = [...CORTEX_SCOPES, ...GUIDE_SCOPES];

/**
 * Lower bound on substantive pages before a no-anchor scope (decisions,
 * prd) is considered covered. The ``decisions`` scope is covered when
 * any substantive ADR exists.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:_COVERAGE_THRESHOLDS
 */
export const COVERAGE_THRESHOLDS: Readonly<Record<string, number>> = {
  decisions: 1,
};

/**
 * Where the LLM should write the missing scope's anchor page.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:_suggested_path_for
 */
export function suggestedPathFor(scope: _ScopeT, domain: string): string {
  const primaryDir = scope.directories[0] ?? "reference";
  const filename = scope.anchorFilenames[0] ?? `${scope.name}.md`;
  return `${primaryDir}/${domain}/${filename}`;
}
