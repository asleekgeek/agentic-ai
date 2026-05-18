/**
 * file-doc-skeleton.ts — Generate file-doc skeletons that EXPOSE their
 * curation gaps.
 *
 * User direction 2026-05-18: a thin file-doc page is not "remove it
 * because it's thin" — it's "show what's missing so the curation queue
 * is visible at the document." This module produces skeletons that
 * declare every canonical FILE_DOC_SECTIONS heading + an explicit
 * ``_(missing — needs: <description>)_`` marker the LLM (or human
 * author) sees and fills in.
 *
 * The skeletons are NOT stubs in the placeholder sense — the stub
 * detector targets ``_(to be filled)_`` / ``_To be written._``. These
 * skeletons use ``_(missing — needs:`` so they're distinguishable; the
 * purge defaults leave them alone.
 *
 * Pure logic — produces a string. Callers write to disk.
 *
 * source: cortex@HEAD~ mcp_server/core/wiki_file_doc_skeleton.py (2026-05-18)
 */

import { FILE_DOC_SECTIONS } from "./curation-gaps.js";

// ── Tag set safe for the wiki classifier ──────────────────────────────

// These tags do NOT trigger the audit-tag rejection. ``codebase-skeleton``
// is a distinct provenance marker from the legacy ``codebase`` tag so
// the new skeletons are admitted while old auto-gen pages remain
// rejected.
// source: cortex/mcp_server/core/wiki_file_doc_skeleton.py:_DEFAULT_TAGS
const DEFAULT_TAGS: readonly string[] = [
  "file-doc",
  "codebase-skeleton",
  "needs-curation",
];

// Caps on imports / symbols inspected to keep the skeleton tractable.
// source: cortex/mcp_server/core/wiki_file_doc_skeleton.py
const IMPORT_INSPECT_LINES = 200; // _extract_imports — splitlines()[:200]
const IMPORT_SAMPLE_CAP    = 20;  // _extract_imports — list(seen)[:20]
const SYMBOL_SAMPLE_CAP    = 25;  // _extract_symbols — [:25]

// ── Language detection ────────────────────────────────────────────────

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".sql": "sql",
};

function detectLanguage(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "text";
  const ext = path.slice(dot).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? "text";
}

// ── Import / symbol extractors ────────────────────────────────────────

const PY_IMPORT_RE = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/;
const TS_IMPORT_RE = /^import\s+.*from\s+['"]([^'"]+)['"]/;
const PY_DEF_RE = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const TS_EXPORT_RE = /^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_]\w*)/;

function extractImports(language: string, source: string): string[] {
  const out: string[] = [];
  const lines = source.split("\n").slice(0, IMPORT_INSPECT_LINES);
  for (const ln of lines) {
    const s = ln.trim();
    if (language === "python") {
      const m = PY_IMPORT_RE.exec(s);
      if (m) out.push(m[1] ?? m[2] ?? "");
    } else if (language === "typescript" || language === "javascript") {
      const m = TS_IMPORT_RE.exec(s);
      if (m) out.push(m[1] ?? "");
    }
  }
  // Dedup preserving order, cap.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const i of out) {
    if (!i || seen.has(i)) continue;
    seen.add(i);
    result.push(i);
    if (result.length >= IMPORT_SAMPLE_CAP) break;
  }
  return result;
}

function extractSymbols(language: string, source: string): string[] {
  const out: string[] = [];
  for (const ln of source.split("\n")) {
    // Top-level only — skip indented (nested) defs.
    if (ln !== ln.replace(/^\s+/, "")) continue;
    if (language === "python") {
      const m = PY_DEF_RE.exec(ln);
      if (m && m[1]) out.push(m[1]);
    } else if (language === "typescript" || language === "javascript") {
      const m = TS_EXPORT_RE.exec(ln);
      if (m && m[1]) out.push(m[1]);
    }
  }
  // Dedup, drop underscore-prefixed (private convention), cap.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of out) {
    if (s.startsWith("_") || seen.has(s)) continue;
    seen.add(s);
    result.push(s);
    if (result.length >= SYMBOL_SAMPLE_CAP) break;
  }
  return result;
}

// ── Renderers ─────────────────────────────────────────────────────────

function missingMarker(description: string): string {
  return `_(missing — needs: ${description})_`;
}

function renderFrontmatter(
  relSourcePath: string,
  domain: string,
  language: string,
  lineCount: number,
  gapNames: readonly string[],
  today: string,
): string {
  const tags = [
    ...DEFAULT_TAGS,
    `lang:${language}`,
    `file:${relSourcePath}`,
    `domain:${domain}`,
  ];
  const tagBlock = tags.map((t) => `  - ${t}`).join("\n");
  const gapBlock = gapNames.map((g) => `  - ${g}`).join("\n");
  return (
    "---\n" +
    `title: File: ${relSourcePath}\n` +
    "kind: reference\n" +
    `domain: ${domain}\n` +
    `source_file_path: ${relSourcePath}\n` +
    `language: ${language}\n` +
    `line_count: ${lineCount}\n` +
    "lifecycle: needs-curation\n" +
    "provenance: skeleton\n" +
    "authored_by: file-doc-skeleton-v2\n" +
    `created: ${today}\n` +
    `updated: ${today}\n` +
    `last_reviewed: ${today}\n` +
    `curation_gaps:\n${gapBlock}\n` +
    `tags:\n${tagBlock}\n` +
    "---\n\n"
  );
}

// ── Public entry ──────────────────────────────────────────────────────

export interface BuildFileDocArgs {
  readonly relSourcePath: string;
  readonly sourceText: string;
  readonly domain: string;
  /** ``YYYY-MM-DD`` override for tests; defaults to today UTC. */
  readonly today?: string;
}

/**
 * Build a file-doc page body for the given source file.
 *
 * The body contains EVERY canonical section as a heading. Sections
 * the skeleton can populate automatically (file path, language,
 * imports, public symbols) are filled in. Sections that need a
 * human or LLM explanation are emitted with a clear
 * ``_(missing — needs: …)_`` marker that lists what should go there.
 *
 * source: cortex/mcp_server/core/wiki_file_doc_skeleton.py:build_file_doc
 */
export function buildFileDoc(args: BuildFileDocArgs): string {
  const today = args.today || new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const language = detectLanguage(args.relSourcePath);
  const lineCount = args.sourceText.split("\n").length;
  const imports = extractImports(language, args.sourceText);
  const symbols = extractSymbols(language, args.sourceText);

  // Sections we can pre-populate skip the "missing" marker.
  const autoPopulated: Record<string, string> = {};

  if (imports.length > 0) {
    const deps = imports.map((i) => `* \`${i}\``).join("\n");
    autoPopulated["dependencies"] =
      `_The following imports are declared at the top of ` +
      `\`${args.relSourcePath}\`. The curation step is to explain ` +
      "what each one is for and why this file depends on it._\n\n" +
      deps;
  }

  if (symbols.length > 0) {
    const apiLines = symbols
      .map((s) => `* \`${s}\` — ${missingMarker("one-line semantic")}`)
      .join("\n");
    autoPopulated["public-api"] =
      "_The exported / top-level symbols below were extracted " +
      "automatically. The curation step is to write what each " +
      "one does._\n\n" + apiLines;
  }

  const gaps: string[] = [];
  const bodyParts: string[] = [];
  bodyParts.push(`# File: \`${args.relSourcePath}\`\n`);
  bodyParts.push(
    `_Project_: **${args.domain}**  |  _Language_: **${language}**  |  ` +
    `_Line count_: **${lineCount}**\n`,
  );
  bodyParts.push(
    "_This file-doc was generated as a curation skeleton. Sections " +
    "marked **needs curation** are explicit gaps the autonomous " +
    "re-author loop (or a human author) will fill in. Nothing is " +
    "hidden — every missing piece of the explanation is named below._\n",
  );

  for (const section of FILE_DOC_SECTIONS) {
    bodyParts.push("\n" + section.heading + "\n");
    const filled = autoPopulated[section.name];
    if (filled !== undefined) {
      bodyParts.push(filled);
    } else {
      bodyParts.push(missingMarker(section.description));
      gaps.push(section.name);
    }
  }

  // ``see-also`` is canonical but lives outside FILE_DOC_SECTIONS so the
  // gap detector doesn't double-count it.
  bodyParts.push("\n## See also\n");
  bodyParts.push(missingMarker(
    "cross-links to the project's architecture / services / api " +
    "anchor pages and any sibling files in the same module",
  ));
  if (!FILE_DOC_SECTIONS.some((s) => s.name === "see-also")) {
    gaps.push("see-also");
  }

  const fm = renderFrontmatter(args.relSourcePath, args.domain, language, lineCount, gaps, today);
  return fm + bodyParts.join("\n") + "\n";
}
