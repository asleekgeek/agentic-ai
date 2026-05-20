/**
 * headless-authoring-anchors.ts — author the missing canonical
 * anchor pages (architecture / services / api / etc.) for every
 * project. The pages don't exist yet, so there's no marker to
 * replace — we feed Claude a project-level overview (file tree,
 * README, manifest, CLAUDE.md) and ask it to author the page from
 * scratch.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py
 *   — drain_missing_anchors + _scope_anchor_prompt + _write_anchor_page
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  type DrainResult,
  claudeInvoke,
} from "./headless-authoring-claude.js";
import {
  auditDomains,
  type AuditDomainAdapters,
  type ListSubdirsFn,
} from "./domain-coverage.js";
import { autoResolveProjectRoot } from "./project-roots.js";

// Hard cap on the project-level context handed to Claude. Bigger
// context = better content but slower call; 16 KB is empirically
// enough for the LLM to write a substantive anchor page.
// source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_CONTEXT_BYTES_CAP
const CONTEXT_BYTES_CAP = 16000;

// Per-file caps for the context blocks.
// source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_scope_anchor_prompt
const README_CAP = 4000;     // source: cortex headless_authoring.py:_scope_anchor_prompt — readme cap
const MANIFEST_CAP = 3000;   // source: cortex headless_authoring.py:_scope_anchor_prompt — manifest cap
const CLAUDE_MD_CAP = 4000;  // source: cortex headless_authoring.py:_scope_anchor_prompt — CLAUDE.md cap
const TREE_DEPTH = 2;
const TREE_ENTRY_CAP = 200;  // source: cortex headless_authoring.py:_top_level_tree — cap arg

// ── File/tree helpers ─────────────────────────────────────────────────

function readFirst(paths: readonly string[], cap: number): string {
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) {
        return fs.readFileSync(p, "utf-8").slice(0, cap);
      }
    } catch { /* skip */ }
  }
  return "";
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "venv", ".venv"]);

function topLevelTree(root: string): string {
  const lines: string[] = [];
  let count = 0;
  function walk(dir: string, depth: number): void {
    if (depth > TREE_DEPTH || count >= TREE_ENTRY_CAP) return;
    let entries: fs.Dirent<string>[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of entries) {
      if (count >= TREE_ENTRY_CAP) return;
      const name = child.name;
      if (name.startsWith(".") || name.startsWith("_")) continue;
      if (SKIP_DIRS.has(name)) continue;
      const indent = "  ".repeat(depth);
      const kind = child.isDirectory() ? "/" : "";
      lines.push(`${indent}- ${name}${kind}`);
      count += 1;
      if (child.isDirectory()) walk(path.join(dir, name), depth + 1);
    }
  }
  walk(root, 0);
  return lines.join("\n");
}

// ── Anchor prompt builder ─────────────────────────────────────────────

function scopeAnchorPrompt(
  domain: string,
  scopeName: string,
  scopeTitle: string,
  scopeDescription: string,
  sourceRoot: string,
): string {
  const tree = topLevelTree(sourceRoot);
  const readme = readFirst(
    ["README.md", "README.rst", "README.txt", "readme.md"].map((n) => path.join(sourceRoot, n)),
    README_CAP,
  );
  const manifest = readFirst(
    [
      "pyproject.toml", "package.json", "Cargo.toml", "go.mod",
      "build.gradle", "settings.gradle", "Gemfile", "pom.xml",
    ].map((n) => path.join(sourceRoot, n)),
    MANIFEST_CAP,
  );
  const claudeMd = readFirst(
    [path.join(sourceRoot, "CLAUDE.md"), path.join(sourceRoot, ".claude", "CLAUDE.md")],
    CLAUDE_MD_CAP,
  );
  let extra = readme ? `\n\n## Project README (truncated)\n\n\`\`\`\n${readme}\n\`\`\`` : "";
  extra += manifest ? `\n\n## Project manifest (truncated)\n\n\`\`\`\n${manifest}\n\`\`\`` : "";
  extra += claudeMd ? `\n\n## CLAUDE.md (truncated)\n\n\`\`\`\n${claudeMd}\n\`\`\`` : "";
  if (extra.length > CONTEXT_BYTES_CAP) extra = extra.slice(0, CONTEXT_BYTES_CAP) + "\n…[truncated]…";
  return (
    `You are authoring a wiki anchor page for the project \`${domain}\`.\n\n` +
    `The page you must produce is the **${scopeTitle}** anchor ` +
    `(scope: \`${scopeName}\`). The scope description is:\n\n` +
    `> ${scopeDescription}\n\n` +
    `## Ground your writing in codebase intelligence FIRST\n\n` +
    `Before drafting the page, use whatever codebase-intelligence ` +
    `tools are available to extract structural facts about the ` +
    `project. Try in this order (skip silently if a tool is ` +
    `unavailable):\n\n` +
    `1. \`codebase_analyze\` / \`codebase_query\` / \`codebase_scan\` ` +
    `on \`${sourceRoot}\` — call graph, module dependencies, ` +
    `file/symbol counts.\n` +
    `2. \`codebase_ownership\` — who edits what, hot files.\n` +
    `3. \`codebase_bus_factor\` — concentration risk per file.\n` +
    `4. \`codebase_dead_code\` — unused exports.\n` +
    `5. \`Bash\` as fallback — \`find ${sourceRoot} -type f\`, ` +
    `\`grep -r\`, language-specific queries.\n` +
    `6. \`Read\` the README, key entry-point files, and any ` +
    `\`docs/\` directory.\n\n` +
    `Then write the anchor page grounded in what you observed. Cite ` +
    `specific files, directories, modules, and call relationships — ` +
    `NOT generic prose.\n\n` +
    `## What I want from you\n\n` +
    `Write the FULL Markdown body of the anchor page (no frontmatter ` +
    `— I'll add it). It must be:\n\n` +
    `* Substantive (target 3-8 KB of real prose).\n` +
    `* Specific to THIS project — every claim grounded in either ` +
    `the codebase analysis tool output or a file you actually read.\n` +
    `* Structured: lead paragraph saying what the page is for, ` +
    `then 4-7 substantive sections.\n` +
    `* Honest: if the project genuinely has nothing for this scope, ` +
    `write a one-paragraph "this project does not currently expose ` +
    `this surface" page; don't fabricate.\n` +
    `* Cross-link to siblings via \`[[reference/${domain}/<other>]]\` ` +
    `notation when relevant.\n\n` +
    `Output ONLY the Markdown body. No preamble. No code fence around it.\n\n` +
    `## Project context (use as starting hint)\n\n` +
    `Domain: \`${domain}\`\n` +
    `Source root: \`${sourceRoot}\`\n\n` +
    `### Top-level structure\n\n\`\`\`\n${tree}\n\`\`\`${extra}`
  );
}

// ── Anchor writer ─────────────────────────────────────────────────────

const TITLE_MAP: Readonly<Record<string, string>> = {
  "product-overview":  "Product overview",
  "architecture":      "Architecture overview",
  "services":          "Services & components",
  "code-walkthrough":  "Code walkthrough",
  "api":               "Public API surface",
  "data-flow":         "Data flow",
  "commands":          "Commands & CLI",
  "mcp":               "MCP integration",
  "tools":             "Tooling & dependencies",
  "ci-cd":             "CI / CD",
  "ai-usage":          "AI usage",
  "operations":        "Operations & runbooks",
  "prd":               "Product requirements",
  "decisions":         "Decisions",
  "onboarding":        "Onboarding",
  "how-to-guides":     "How-to guides",
  "tutorials":         "Tutorials & learning paths",
  "troubleshooting":   "Troubleshooting & FAQ",
  "migration-guides":  "Migration & upgrade guides",
  "integration-guides":"Integration guides",
  "recipes":           "Recipes & cookbook",
  "configuration":    "Configuration reference",
  "local-development":"Local development",
  "testing":          "Testing guide",
  "debugging":        "Debugging guide",
  "logging":          "Logging guide",
  "observability":    "Observability",
  "performance":      "Performance & tuning",
  "security":         "Security & threat model",
  "secrets-management":"Secrets management",
  "access-control":   "Access control & permissions",
  "contributing":     "Contributing",
  "coding-standards": "Coding standards & conventions",
  "release-process":  "Release process",
  "changelog":        "Changelog",
  "roadmap":          "Roadmap",
  "plugins-extensions":"Plugins & extensions",
  "accessibility":    "Accessibility",
  "localization":     "Localization & i18n",
  "glossary":         "Glossary",
  "examples":         "Examples & sample code",
};

async function registerAnchorPointer(wikiRoot: string, pagePath: string, body: string): Promise<void> {
  try {
    const { registerPointerMemory } = await import("./headless-authoring-pointer.js");
    await registerPointerMemory(wikiRoot, pagePath, body);
  } catch { /* best effort */ }
}

function writeAnchorPage(
  wikiRoot: string,
  domain: string,
  scopeName: string,
  suggestedKind: string,
  suggestedPath: string,
  bodyMarkdown: string,
  today: string,
): string | null {
  const pagePath = path.join(wikiRoot, suggestedPath);
  try { fs.mkdirSync(path.dirname(pagePath), { recursive: true }); }
  catch { return null; }
  const title = `${domain} — ${TITLE_MAP[scopeName] ?? scopeName}`;
  const fm =
    `---\n` +
    `title: ${title}\n` +
    `kind: ${suggestedKind}\n` +
    `domain: ${domain}\n` +
    `scope: ${scopeName}\n` +
    `status: living\n` +
    `authored_by: headless-authoring-worker\n` +
    `provenance: auto-authored\n` +
    `created: ${today}\n` +
    `updated: ${today}\n` +
    `last_reviewed: ${today}\n` +
    `---\n\n`;
  try {
    fs.writeFileSync(pagePath, fm + bodyMarkdown.trim() + "\n", "utf-8");
    // Register PG pointer memory so retrieval sees it. Best-effort.
    // source: cortex@HEAD~ headless_authoring.py:_register_pointer_memory
    void registerAnchorPointer(wikiRoot, pagePath, bodyMarkdown);
    return pagePath;
  } catch { return null; }
}

// ── Public entry: drain missing anchors ───────────────────────────────

export interface AnchorAdapters {
  /** Subdir lister for ``listDomains``. */
  readonly listSubdirs: ListSubdirsFn;
  /** Stat adapter for the audit. */
  readonly pageStat: AuditDomainAdapters["pageStat"];
  /** Substantive-page counter for the audit. */
  readonly countSubstantivePages: AuditDomainAdapters["countSubstantivePages"];
}

export interface DrainAnchorsOpts {
  readonly wikiRoot: string;
  readonly maxDrains: number;
  readonly today: string;
  readonly adapters: AnchorAdapters;
}

/**
 * Author missing canonical anchor pages for every project.
 *
 * For each domain × scope combination with no covered anchor, calls
 * ``claude -p`` with a project-level context block and writes the
 * response as the new anchor page. Up to ``maxDrains`` authored per
 * invocation so a single cycle stays time-bounded.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:drain_missing_anchors
 */
export function drainMissingAnchors(opts: DrainAnchorsOpts): DrainResult[] {
  const results: DrainResult[] = [];
  // Discover domains via the page-aggregation walk (same as the
  // welcome-grid endpoint uses) so every page-bearing project gets
  // audited, not just multi-kind ones.
  const domains = collectDomainsFromWiki(opts.wikiRoot);
  const auditAdapters: AuditDomainAdapters = {
    pageStat: opts.adapters.pageStat,
    countSubstantivePages: opts.adapters.countSubstantivePages,
  };
  const coverages = auditDomains(domains, auditAdapters);
  for (const cov of coverages) {
    if (results.filter((r) => r.status === "filled").length >= opts.maxDrains) break;
    const srcRoot = autoResolveProjectRoot(cov.domain);
    if (!srcRoot) continue;
    for (const sc of cov.scopes) {
      if (sc.covered) continue;
      if (results.filter((r) => r.status === "filled").length >= opts.maxDrains) break;
      const t0 = performance.now();
      const prompt = scopeAnchorPrompt(
        cov.domain, sc.scope.name, sc.scope.title, sc.scope.description, srcRoot,
      );
      const response = claudeInvoke(prompt, srcRoot);
      const durMs = Math.round(performance.now() - t0);
      if (!response || response.trim() === "") {
        results.push({
          page_path: sc.suggestedPath,
          gap: `anchor:${sc.scope.name}`,
          status: "failed",
          duration_ms: durMs,
          detail: "claude returned empty",
        });
        continue;
      }
      const written = writeAnchorPage(
        opts.wikiRoot, cov.domain, sc.scope.name,
        sc.scope.suggestedKind, sc.suggestedPath,
        response.trim(), opts.today,
      );
      results.push({
        page_path: written ?? sc.suggestedPath,
        gap: `anchor:${sc.scope.name}`,
        status: written ? "filled" : "failed",
        duration_ms: durMs,
        detail: written ? "" : "page write failed",
      });
    }
  }
  return results;
}

// ── Domain discovery ──────────────────────────────────────────────────

/**
 * Walk ``<wiki>/<kind>/<domain>/`` and return every domain that
 * appears anywhere — not just multi-kind ones. Matches the welcome
 * grid's discovery logic so the autonomous loop authors anchors for
 * every project the user actually has.
 *
 * source: this module — parity with wiki-projects.ts:aggregatePagesByDomain
 */
function collectDomainsFromWiki(wikiRoot: string): string[] {
  const seen = new Set<string>();
  try {
    for (const kind of fs.readdirSync(wikiRoot, { withFileTypes: true })) {
      if (!kind.isDirectory()) continue;
      if (kind.name.startsWith(".") || kind.name.startsWith("_")) continue;
      const kindAbs = path.join(wikiRoot, kind.name);
      try {
        for (const dom of fs.readdirSync(kindAbs, { withFileTypes: true })) {
          if (!dom.isDirectory()) continue;
          if (dom.name.startsWith(".") || dom.name.startsWith("_")) continue;
          if (/^\d{4}$/.test(dom.name)) continue;
          seen.add(dom.name);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return [...seen].sort();
}
