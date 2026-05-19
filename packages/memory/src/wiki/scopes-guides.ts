/**
 * scopes-guides.ts — Diátaxis "how-to" + "tutorial" scopes and
 * operations / security / contribution / extensibility guides.
 *
 * Split from scopes.ts to keep that file under §4.1. The two modules
 * compose: ``scopes.ts`` exports the original cortex-parity scopes
 * (architecture, services, api, ...) plus the concatenation with
 * ``GUIDE_SCOPES`` below.
 *
 * source: user direction 2026-05-19 — "we're missing a lot of guides
 *   type to cover completely the project"
 * source: Diátaxis https://diataxis.fr/ — tutorial / how-to /
 *   reference / explanation quadrants
 */

import type { Scope } from "./scopes-types.js";

/**
 * Guide-shaped scopes the cortex catalogue underspecified. 26 entries
 * spanning every task a real project's user / contributor / operator
 * might attempt: how-to / tutorial quadrants, setup + operating
 * guides, security guides, contribution + governance, domain
 * extensibility, and reference helpers.
 *
 * All entries support "Not applicable — <why>" as a valid section
 * body so projects without (say) plugin extensibility still surface
 * the heading; missing headings hide the curation gap and are why
 * docs go stale.
 */
export const GUIDE_SCOPES: readonly Scope[] = [
  // The five scopes below cover the guide-shaped pages every project
  // needs but that the prior catalogue underspecified. Onboarding
  // (above) covers day-1; these cover every later task the user
  // attempts.
  // source: Diátaxis https://diataxis.fr/ — four documentation types,
  //   the how-to + tutorial halves
  {
    name: "how-to-guides",
    title: "How-to guides",
    description:
      "Task-oriented guides answering 'how do I X?' for the most " +
      "common operations the project supports. Distinct from " +
      "tutorials (which teach concepts) and reference (which " +
      "catalogues fields): a how-to is a recipe that gets a user " +
      "from a stated starting point to a stated outcome with the " +
      "minimum number of steps. Anchor page is an index of the " +
      "available how-tos; each individual recipe is a sibling page.",
    anchorFilenames: ["how-to.md", "how-to-guides.md", "guides.md", "howto.md"],
    directories: ["guides", "how-to"],
    suggestedKind: "how-to",
  },
  {
    name: "tutorials",
    title: "Tutorials & learning paths",
    description:
      "Step-by-step learning sequences that take a beginner from " +
      "zero to a working understanding of one concept. Distinct " +
      "from onboarding (which is one-shot day-1 setup) and from " +
      "how-to guides (which assume the reader knows what they're " +
      "doing). A tutorial introduces concepts in order, with " +
      "expected outputs at every step, ending with a working " +
      "example the reader has built themselves.",
    anchorFilenames: ["tutorials.md", "tutorial.md", "learn.md", "lessons.md"],
    directories: ["tutorial", "tutorials", "guides"],
    suggestedKind: "tutorial",
  },
  {
    name: "troubleshooting",
    title: "Troubleshooting & FAQ",
    description:
      "Symptom → diagnosis → fix index. Every error message the " +
      "user might see, every common misconfiguration, every 'why " +
      "isn't this working?' should have an entry the reader can " +
      "find by searching for the symptom (the exception class, the " +
      "log line, the visible UI state). Include the bypass / " +
      "workaround as well as the root-cause fix.",
    anchorFilenames: ["troubleshooting.md", "faq.md", "common-issues.md", "errors.md"],
    directories: ["guides", "how-to", "reference"],
    suggestedKind: "how-to",
  },
  {
    name: "migration-guides",
    title: "Migration & upgrade guides",
    description:
      "Version-to-version upgrade paths. Every breaking change " +
      "between releases should have a guide: what changed, why, " +
      "what the user's existing code must do to keep working, " +
      "and the deprecation timeline for the old behaviour. " +
      "Write 'Not applicable — no breaking changes yet' for fresh " +
      "projects rather than omitting the heading.",
    anchorFilenames: ["migration.md", "migrations.md", "upgrade.md", "upgrading.md", "breaking-changes.md"],
    directories: ["guides", "how-to", "reference"],
    suggestedKind: "how-to",
  },
  {
    name: "integration-guides",
    title: "Integration guides",
    description:
      "How to wire this project into external systems: the IDEs, " +
      "CI providers, model APIs, databases, MCP clients, browser " +
      "extensions, or downstream services that consume its output. " +
      "Each integration entry gives the contract (what the external " +
      "system must do), the wiring steps, and the smoke test that " +
      "proves the integration works.",
    anchorFilenames: ["integrations.md", "integration.md", "integration-guides.md"],
    directories: ["guides", "how-to", "reference"],
    suggestedKind: "how-to",
  },
  {
    name: "recipes",
    title: "Recipes & cookbook",
    description:
      "Cookbook-style task patterns: solved-problem snippets a " +
      "reader can copy into their own work and adapt. Each recipe " +
      "names a concrete situation, shows the working code, and " +
      "explains the choices made so the reader can adapt rather " +
      "than blindly copy. Distinct from how-to guides because a " +
      "recipe is shorter, code-first, and assumes the reader " +
      "already knows the basics.",
    anchorFilenames: ["recipes.md", "cookbook.md", "snippets.md", "examples.md"],
    directories: ["guides", "how-to", "reference"],
    suggestedKind: "how-to",
  },
  // ── Setup + operating guides ──
  {
    name: "configuration",
    title: "Configuration reference",
    description:
      "Every environment variable, config-file key, and CLI flag the " +
      "project reads, with type, default, validation rule, and the " +
      "behaviour it controls. The single page a reader hits when " +
      "asking 'what knobs does this thing have?' For each entry: " +
      "name, type, required/optional, default, valid range, effect.",
    anchorFilenames: ["configuration.md", "config.md", "settings.md", "env-vars.md"],
    directories: ["reference", "guides"],
    suggestedKind: "reference",
  },
  {
    name: "local-development",
    title: "Local development",
    description:
      "How a contributor sets the project up on their own machine: " +
      "clone, install deps, run the dev server, run the watcher, " +
      "swap in stub services. Includes the fast feedback loops " +
      "(hot reload, incremental test runs) and the mocks / " +
      "fixtures that make local work possible without production " +
      "credentials.",
    anchorFilenames: ["local-development.md", "dev-setup.md", "developing.md", "development.md"],
    directories: ["guides", "how-to"],
    suggestedKind: "how-to",
  },
  {
    name: "testing",
    title: "Testing guide",
    description:
      "How tests are organised, how to run each layer (unit / " +
      "integration / e2e / property / parity), where fixtures live, " +
      "what the assertions actually check, how flaky tests are " +
      "triaged. Includes the commands and the CI matrix.",
    anchorFilenames: ["testing.md", "tests.md", "test-strategy.md"],
    directories: ["guides", "how-to", "reference"],
    suggestedKind: "how-to",
  },
  {
    name: "debugging",
    title: "Debugging guide",
    description:
      "How to break a problem down when the project misbehaves: " +
      "log levels, trace flags, where breakpoints belong, the " +
      "common shapes of bugs the project's architecture invites. " +
      "Pair with troubleshooting (symptom → fix); this one is " +
      "about the technique, not the catalogue.",
    anchorFilenames: ["debugging.md", "debug.md", "diagnostics.md"],
    directories: ["guides", "how-to"],
    suggestedKind: "how-to",
  },
  {
    name: "logging",
    title: "Logging guide",
    description:
      "Log format the project emits, log levels and what each one " +
      "is for, where logs go (stdout / file / remote sink), how to " +
      "filter, how to rotate, how to plumb structured fields. " +
      "Names the libraries used and the conventions for adding " +
      "new log sites.",
    anchorFilenames: ["logging.md", "logs.md", "log-format.md"],
    directories: ["guides", "reference", "how-to"],
    suggestedKind: "reference",
  },
  {
    name: "observability",
    title: "Observability",
    description:
      "Metrics emitted, traces instrumented, dashboards available, " +
      "alerts wired. The runbook a reader checks BEFORE production " +
      "goes wrong: 'how do I see what this is doing?' Names the " +
      "OpenTelemetry surface, Prometheus / Grafana boards, log " +
      "queries to copy-paste.",
    anchorFilenames: ["observability.md", "metrics.md", "telemetry.md", "tracing.md"],
    directories: ["guides", "reference", "runbook"],
    suggestedKind: "reference",
  },
  {
    name: "performance",
    title: "Performance & tuning",
    description:
      "Performance characteristics the project ships with (latency " +
      "tiers, throughput envelopes, memory footprint), the " +
      "benchmarks that measure them (with file paths), and the " +
      "tuning knobs an operator turns when a workload pushes the " +
      "defaults. Includes profiling techniques specific to the " +
      "stack.",
    anchorFilenames: ["performance.md", "benchmarks.md", "tuning.md", "scaling.md"],
    directories: ["guides", "reference"],
    suggestedKind: "reference",
  },
  // ── Security guides ──
  {
    name: "security",
    title: "Security & threat model",
    description:
      "What the project defends against, what it explicitly does " +
      "not, the trust boundaries, the data classifications, the " +
      "audit surface. A reader hitting this page wants to know " +
      "'is it safe to put X through this?' before adopting.",
    anchorFilenames: ["security.md", "threat-model.md", "security-model.md"],
    directories: ["reference", "explanation", "guides"],
    suggestedKind: "reference",
  },
  {
    name: "secrets-management",
    title: "Secrets management",
    description:
      "Where API keys, tokens, certificates, and other secrets " +
      "live during local dev, in CI, and in production. Rotation " +
      "procedure, scope of each credential, what happens when one " +
      "leaks. Distinct from access-control because this is about " +
      "the credentials themselves, not who can use them.",
    anchorFilenames: ["secrets.md", "secrets-management.md", "credentials.md"],
    directories: ["guides", "how-to", "reference"],
    suggestedKind: "how-to",
  },
  {
    name: "access-control",
    title: "Access control & permissions",
    description:
      "Who can do what: roles, scopes, capabilities, the matrix of " +
      "actions × principal. Includes the model (RBAC / ABAC / ACL " +
      "/ capability) and the enforcement points (middleware, " +
      "policy engine). For projects without external users, " +
      "documents the internal trust model.",
    anchorFilenames: ["access-control.md", "permissions.md", "authorization.md", "rbac.md"],
    directories: ["reference", "guides"],
    suggestedKind: "reference",
  },
  // ── Contribution + governance ──
  {
    name: "contributing",
    title: "Contributing",
    description:
      "How to land a change in the codebase: branch model, PR " +
      "flow, who reviews, what the CI checks, how decisions are " +
      "made, what gets you merged vs blocked. Pair with " +
      "coding-standards (mechanical rules) and code-review (the " +
      "reviewer's lens).",
    anchorFilenames: ["contributing.md", "CONTRIBUTING.md", "contribute.md"],
    directories: ["guides", "reference"],
    suggestedKind: "how-to",
  },
  {
    name: "coding-standards",
    title: "Coding standards & conventions",
    description:
      "The mechanical rules every contribution honours: file-size " +
      "limits, layer boundaries, naming, lint config, type-system " +
      "discipline, source-citation requirements. Cite the lint / " +
      "format / typecheck tools that enforce each rule.",
    anchorFilenames: ["coding-standards.md", "style-guide.md", "conventions.md", "code-style.md"],
    directories: ["reference", "guides"],
    suggestedKind: "reference",
  },
  {
    name: "release-process",
    title: "Release process",
    description:
      "How a version ships: branch / tag / build pipeline, " +
      "versioning scheme (semver / calver / commit-hash), " +
      "changelog format, sign-off requirements, rollback procedure. " +
      "Distinct from ci-cd which describes the pipeline; this " +
      "describes how a human cuts a release.",
    anchorFilenames: ["releasing.md", "release-process.md", "release.md", "publishing.md"],
    directories: ["guides", "how-to", "runbook"],
    suggestedKind: "how-to",
  },
  {
    name: "changelog",
    title: "Changelog",
    description:
      "User-facing record of what changed between versions. Each " +
      "release entry calls out new features, breaking changes, " +
      "deprecations, security fixes, and the migration guide that " +
      "pairs with a breaking change. Format follows Keep a " +
      "Changelog by default; project may override.",
    anchorFilenames: ["CHANGELOG.md", "changelog.md", "history.md", "releases.md"],
    directories: ["reference"],
    suggestedKind: "reference",
  },
  {
    name: "roadmap",
    title: "Roadmap",
    description:
      "What's planned, what's in progress, what's deferred and " +
      "why. Not a release schedule (use release-process for cadence) " +
      "— this is the strategic surface a reader checks before " +
      "betting on the project. Honest about what isn't going to " +
      "happen.",
    anchorFilenames: ["roadmap.md", "ROADMAP.md", "future-work.md", "planned.md"],
    directories: ["explanation", "reference", "guides"],
    suggestedKind: "explanation",
  },
  // ── Domain extensibility ──
  {
    name: "plugins-extensions",
    title: "Plugins & extensions",
    description:
      "The project's extension API: what surfaces can be extended, " +
      "the lifecycle of an extension, the manifest / hook shape, " +
      "the testing strategy for an extension. Write 'Not " +
      "applicable — this project does not expose an extension API' " +
      "for monolithic projects rather than omitting the heading.",
    anchorFilenames: ["plugins.md", "extensions.md", "plugin-api.md", "addons.md"],
    directories: ["reference", "guides", "explanation"],
    suggestedKind: "reference",
  },
  {
    name: "accessibility",
    title: "Accessibility",
    description:
      "Accessibility standards the project follows (WCAG level, " +
      "screen-reader support, keyboard navigation, colour contrast " +
      "audit). For non-UI projects, write 'Not applicable — this " +
      "project has no user interface; downstream consumers are " +
      "responsible for their own a11y' rather than omitting.",
    anchorFilenames: ["accessibility.md", "a11y.md"],
    directories: ["reference", "explanation"],
    suggestedKind: "reference",
  },
  {
    name: "localization",
    title: "Localization & i18n",
    description:
      "How the project handles translation, locale data, " +
      "currency / date formatting, right-to-left layout. Names the " +
      "i18n library, the source-of-truth strings file, the " +
      "translator workflow. 'Not applicable — single-locale " +
      "project' is a valid answer; write it explicitly.",
    anchorFilenames: ["localization.md", "i18n.md", "translations.md"],
    directories: ["reference", "guides"],
    suggestedKind: "reference",
  },
  // ── Reference helpers ──
  {
    name: "glossary",
    title: "Glossary",
    description:
      "Project-specific terms with a one-paragraph definition. " +
      "Cortex-specific concepts (heat, consolidation, valence), " +
      "domain abbreviations, internal aliases. Every term the " +
      "reader might hit in another page without context should " +
      "resolve here.",
    anchorFilenames: ["glossary.md", "terms.md", "definitions.md"],
    directories: ["reference"],
    suggestedKind: "reference",
  },
  {
    name: "examples",
    title: "Examples & sample code",
    description:
      "End-to-end working examples in the form a reader can copy " +
      "and run: a sample app, a demo workflow, a starter template. " +
      "Distinct from recipes (which are snippets) — examples are " +
      "complete buildable units that show several pieces working " +
      "together.",
    anchorFilenames: ["examples.md", "demos.md", "sample-apps.md"],
    directories: ["guides", "tutorial", "reference"],
    suggestedKind: "tutorial",
  },
];
