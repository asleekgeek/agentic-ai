/**
 * headless-authoring-gaps.ts — drain curation gaps on existing
 * file-doc pages. One ``claude -p`` call per page fills EVERY
 * missing section in one response (sectioned by ``<<<slug>>>``
 * delimiters); about 7-8× faster than per-section drain and keeps
 * cross-references between sections coherent.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py
 *   — drain_all_gaps_on_page + _build_page_prompt + _parse_sectioned_response
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  type DrainResult,
  type ParsedPage,
  GAP_DESCRIPTIONS,
  claudeInvoke,
  gapHeading,
  parsePageFm,
} from "./headless-authoring-claude.js";

/**
 * Append a freshly-authored canonical section to a body that lacks
 * the placeholder marker. Inserts BEFORE the trailing ``## See also``
 * section when present so the see-also block stays at the end of the
 * page; otherwise appends to the bottom.
 *
 * source: this module — pages authored before the section was added
 *   to the FILE_DOC_SECTIONS catalogue
 */
function appendNewSection(body: string, gapName: string, content: string): string {
  const heading = `## ${gapHeading(gapName)}`;
  const newSection = `\n${heading}\n\n${content}\n`;
  // Insert before the ``## See also`` heading if present.
  const seeAlsoIdx = body.search(/^## See also\s*$/m);
  if (seeAlsoIdx >= 0) {
    return body.slice(0, seeAlsoIdx) + newSection + "\n" + body.slice(seeAlsoIdx);
  }
  // Otherwise append.
  return body.replace(/\s*$/, "") + "\n" + newSection;
}
import { missingSections } from "./curation-gaps.js";
import { autoResolveProjectRoot } from "./project-roots.js";

// Source body cap for the prompt — 8 KB sweet spot the Cortex
// version converged on.
// source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_project_source_for_page
const SOURCE_BODY_CAP = 8000;
const SOURCE_HEAD_KEEP = 6000; // source: same — keep head 6k + tail 1.5k on truncation
const SOURCE_TAIL_KEEP = 1500;

// ── Source file resolution ────────────────────────────────────────────

function resolveSourceForPage(meta: Record<string, unknown>): { source_path: string | null; source_text: string | null } {
  const rel = meta["source_file_path"];
  const domain = meta["domain"];
  if (typeof rel !== "string" || !rel) return { source_path: null, source_text: null };
  if (typeof domain !== "string" || !domain) return { source_path: null, source_text: null };
  const srcRoot = autoResolveProjectRoot(domain);
  if (!srcRoot) return { source_path: null, source_text: null };
  const full = path.join(srcRoot, rel);
  let text: string;
  try { text = fs.readFileSync(full, "utf-8"); }
  catch { return { source_path: full, source_text: null }; }
  if (text.length > SOURCE_BODY_CAP) {
    text = text.slice(0, SOURCE_HEAD_KEEP) +
           "\n\n…[truncated middle]…\n\n" +
           text.slice(text.length - SOURCE_TAIL_KEEP);
  }
  return { source_path: full, source_text: text };
}

// ── Live audit ────────────────────────────────────────────────────────

/**
 * Compute the true set of missing sections from the body NOW.
 *
 * Frontmatter ``curation_gaps`` is a *hint* — it's frozen at skeleton
 * generation time. The truth is whatever ``missingSections`` says
 * today. This lets the worker fill sections added to the catalogue
 * after a page was already generated (sequence-diagram / parameters /
 * etc. added 2026-05-18 / 2026-05-19).
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_live_audit_gaps
 */
function liveAuditGaps(body: string, frozenGaps: readonly string[]): string[] {
  let live: string[] = [];
  try { live = missingSections(body).map((s) => s.name); }
  catch { return [...frozenGaps]; }
  // Augment live audit with any section whose body still contains the
  // ``_(missing — needs:`` marker. The marker text can clear the
  // section's minCharsUnderHeading threshold (especially for short
  // descriptions like 80-char tests/invariants), so the canonical
  // ``missingSections`` audit misses them. The marker is the ground
  // truth — if it's there, the section is unfilled.
  // source: this module — bug observed against live wiki drain (2026-05-19)
  for (const name of Object.keys(GAP_DESCRIPTIONS)) {
    const heading = `## ${gapHeading(name)}`;
    const idx = body.indexOf(heading);
    if (idx < 0) continue;
    // Snapshot the body between this heading and the next one.
    const after = body.slice(idx + heading.length);
    const nextHeadingMatch = /\n## /.exec(after);
    const section = nextHeadingMatch ? after.slice(0, nextHeadingMatch.index) : after;
    if (section.includes("_(missing — needs:") && !live.includes(name)) {
      live.push(name);
    }
  }
  // Merge: frozen-ordered first, then live's new items.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of frozenGaps) if (live.includes(g) && !seen.has(g)) { seen.add(g); out.push(g); }
  for (const g of live) if (!seen.has(g)) { seen.add(g); out.push(g); }
  return out;
}

// ── Prompt + response parsing ─────────────────────────────────────────

function buildPagePrompt(
  pagePath: string,
  meta: Record<string, unknown>,
  gaps: readonly string[],
  sourceText: string | null,
): string {
  const domain = String(meta["domain"] ?? "");
  const sourcePath = String(meta["source_file_path"] ?? "");
  const language = String(meta["language"] ?? "");
  const srcBlock = sourceText
    ? `\n## Source file content (file: ${sourcePath})\n\n\`\`\`${language}\n${sourceText}\n\`\`\`\n`
    : `\n_(source file \`${sourcePath}\` is unavailable; write from general knowledge of the project)_\n`;
  const sectionsList = gaps
    .map((name) => `### <<<${name}>>>\n${GAP_DESCRIPTIONS[name] ?? name}`)
    .join("\n\n");
  return (
    `You are authoring missing sections for the wiki file-doc of ` +
    `\`${sourcePath}\` in project \`${domain}\`.\n\n` +
    `## Ground your writing in codebase intelligence FIRST\n\n` +
    `Before drafting, extract structural facts about the file using whatever ` +
    `tools are available. Try in this order; skip silently if a tool isn't ` +
    `available:\n\n` +
    `1. \`codebase_context\` for \`${sourcePath}\` — direct callers ` +
    `(the **Callers** section is exactly this), callees, sibling files.\n` +
    `2. \`codebase_impact\` for \`${sourcePath}\` — what changes if you ` +
    `modify this file (the **What can go wrong** section can use this).\n` +
    `3. \`codebase_query\` — search for imports / uses of any public symbol ` +
    `exported from this file.\n` +
    `4. \`Bash\` fallback: \`grep -rn 'from ${sourcePath}'\` or ` +
    `\`grep -rn '<symbol>'\`.\n` +
    `5. \`Read\` the FULL source if the truncated block below leaves ` +
    `something unclear.\n\n` +
    `Then author the ${gaps.length} sections grounded in what you observed.\n\n` +
    `## What I want\n\n` +
    `For each section, write a substantive Markdown body (no heading line — ` +
    `I'll add it). Length per section: 3-6 sentences of real prose, or a ` +
    `short list when that fits. Cite specific symbols, paths, callers. No ` +
    `filler.\n\n` +
    `If a section's information is GENUINELY absent (e.g. the file has no ` +
    `callers — it's an entry point — say so explicitly), write a one-line ` +
    `factual statement, NOT \`NO INFORMATION AVAILABLE\`. Reserve that ` +
    `sentinel for sections you truly cannot answer at all.\n\n` +
    `## Output format (STRICT — I parse this)\n\n` +
    `Emit each section preceded by a delimiter line containing ONLY the ` +
    `section slug between \`<<<\` and \`>>>\`, in the exact order I list ` +
    `the sections below. After the slug delimiter, emit the section body ` +
    `(no heading line), then a blank line, then the next delimiter.\n\n` +
    `Example:\n\`\`\`\n<<<purpose>>>\nThis file owns X. It does Y. It must ` +
    `not Z.\n\n<<<public-api>>>\n* \`foo()\` — does X\n* \`bar()\` — does Y\n\`\`\`\n\n` +
    `## Sections to author (in order — match these slugs)\n\n${sectionsList}\n\n` +
    `## Source context (truncated — use Read for full)${srcBlock}` +
    `\n\nPage path: \`${pagePath}\``
  );
}

function parseSectionedResponse(response: string, gaps: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!response) return out;
  const parts = response.split(/^<<<([\w-]+)>>>\s*$/m);
  // parts = [preamble, slug1, body1, slug2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const slug = (parts[i] ?? "").trim();
    const body = i + 1 < parts.length ? (parts[i + 1] ?? "").trim() : "";
    if (gaps.includes(slug) && body) out.set(slug, body);
  }
  return out;
}

// ── Marker replacement ────────────────────────────────────────────────

const PREFIX_MATCH_LEN = 60; // source: cortex headless_authoring.py:_find_gap_marker — gap_description[:60]

function replaceGapMarker(
  body: string,
  gapDescription: string,
  newContent: string,
): { body: string; replaced: boolean } {
  const needle = `_(missing — needs: ${gapDescription})_`;
  const idx = body.indexOf(needle);
  if (idx >= 0) {
    return { body: body.slice(0, idx) + newContent + body.slice(idx + needle.length), replaced: true };
  }
  // Fallback: regex match on the first marker whose description starts
  // with the canonical prefix. Tolerates minor whitespace drift.
  const escapedPrefix = gapDescription.slice(0, PREFIX_MATCH_LEN).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pat = new RegExp(String.raw`_\(missing — needs:\s*${escapedPrefix}[^)]*\)_`);
  const m = pat.exec(body);
  if (m) {
    return { body: body.slice(0, m.index) + newContent + body.slice(m.index + m[0].length), replaced: true };
  }
  return { body, replaced: false };
}

// ── Page rewrite ──────────────────────────────────────────────────────

function rewritePage(
  pagePath: string,
  newBody: string,
  newCurationGaps: readonly string[],
): boolean {
  let text: string;
  try { text = fs.readFileSync(pagePath, "utf-8"); }
  catch { return false; }
  if (!text.startsWith("---")) return false;
  const FM_DELIM_LEN = 3;
  const end = text.indexOf("\n---", FM_DELIM_LEN);
  if (end < 0) return false;
  const fmBlock = text.slice(FM_DELIM_LEN, end);
  // Strip existing curation_gaps block.
  const lines = fmBlock.split("\n");
  const outLines: string[] = [];
  let skipBlock = false;
  for (const line of lines) {
    if (skipBlock) {
      if (!(line.startsWith(" ") || line.startsWith("\t"))) skipBlock = false;
      else continue;
    }
    if (line.startsWith("curation_gaps:")) { skipBlock = true; continue; }
    outLines.push(line);
  }
  if (newCurationGaps.length > 0) {
    outLines.push("curation_gaps:");
    for (const g of newCurationGaps) outLines.push(`  - ${g}`);
  }
  let newFm = outLines.join("\n").replace(/^\s+|\s+$/g, "");
  // Promote lifecycle as gaps drain — when zero gaps left, lifecycle
  // moves to ``draft`` (ready for human review + promotion).
  if (newCurationGaps.length === 0) {
    newFm = newFm.replace(/^lifecycle:\s*.*$/m, "lifecycle: draft");
  }
  const newText = `---\n${newFm}\n---\n\n${newBody.replace(/^\n+/, "")}`;
  try { fs.writeFileSync(pagePath, newText, "utf-8"); return true; }
  catch { return false; }
}

// ── Public entry: drain all gaps on one page ──────────────────────────

/**
 * Fill every curation gap on one page in a single ``claude -p`` call.
 *
 * Returns one DrainResult per gap so the cycle summary accounts for
 * each individually. A failure on one gap leaves the others' fills
 * intact — the parser tolerates missing delimiters.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:drain_all_gaps_on_page
 */
export function drainAllGapsOnPage(
  pagePath: string,
  parsed: ParsedPage,
): DrainResult[] {
  const start = performance.now();
  const frozenRaw = parsed.meta["curation_gaps"];
  const frozen: string[] = Array.isArray(frozenRaw) ? frozenRaw.filter((g): g is string => typeof g === "string") : [];
  const gaps = liveAuditGaps(parsed.body, frozen);
  if (gaps.length === 0) return [];
  const { source_text } = resolveSourceForPage(parsed.meta);
  const prompt = buildPagePrompt(pagePath, parsed.meta, gaps, source_text);
  const response = claudeInvoke(prompt);
  const baseMs = Math.round(performance.now() - start);
  if (!response) {
    return gaps.map((g) => ({
      page_path: pagePath, gap: g, status: "failed" as const, duration_ms: baseMs, detail: "claude invocation failed",
    }));
  }
  const filledMap = parseSectionedResponse(response, gaps);
  let newBody = parsed.body;
  const filledGaps: string[] = [];
  const results: DrainResult[] = [];
  for (const g of gaps) {
    const content = filledMap.get(g);
    const gapDesc = GAP_DESCRIPTIONS[g] ?? g;
    if (!content) {
      results.push({ page_path: pagePath, gap: g, status: "failed", duration_ms: baseMs, detail: "not in response" });
      continue;
    }
    const replacement = content.toUpperCase().startsWith("NO INFORMATION AVAILABLE")
      ? "_(no information available for this section)_"
      : content;
    const { body: nb, replaced } = replaceGapMarker(newBody, gapDesc, replacement);
    if (replaced) {
      newBody = nb;
      filledGaps.push(g);
      results.push({ page_path: pagePath, gap: g, status: "filled", duration_ms: baseMs, detail: "" });
      continue;
    }
    // Marker not found — page was authored before this canonical
    // section existed in the catalogue. APPEND the section with a
    // fresh heading rather than dropping the LLM's content.
    // source: this module — pages predate sequence-diagram / flow-diagram
    //   / parameters / request-example / response-example additions
    newBody = appendNewSection(newBody, g, replacement);
    filledGaps.push(g);
    results.push({ page_path: pagePath, gap: g, status: "filled", duration_ms: baseMs, detail: "appended" });
  }
  if (filledGaps.length > 0) {
    const remaining = gaps.filter((g) => !filledGaps.includes(g));
    rewritePage(pagePath, newBody, remaining);
    // Register the freshly-groomed body as a PG pointer memory so
    // spreading activation can see it. Fire-and-forget: a PG hiccup
    // never breaks the disk rewrite. Wiki root inferred from the
    // page path's parent chain.
    // source: cortex@HEAD~ headless_authoring.py:_register_pointer_memory
    void registerPointerMemoryForPage(pagePath, newBody);
  }
  return results;
}

async function registerPointerMemoryForPage(pagePath: string, body: string): Promise<void> {
  try {
    const { registerPointerMemory } = await import("./headless-authoring-pointer.js");
    // Walk up the path until we hit a "wiki" directory; that's the root.
    let dir = path.dirname(pagePath);
    while (dir !== "/" && path.basename(dir) !== "wiki") dir = path.dirname(dir);
    const wikiRoot = dir === "/" ? path.dirname(pagePath) : dir;
    await registerPointerMemory(wikiRoot, pagePath, body);
  } catch { /* best effort */ }
}

// ── Page-with-gaps scanner ────────────────────────────────────────────

/**
 * Walk the wiki and return ``(path, parsed)`` for pages with gaps.
 *
 * A page is "with gaps" when EITHER the frontmatter declares
 * non-empty ``curation_gaps`` OR a live audit shows missing sections
 * (catches pages that pre-date catalogue additions).
 *
 * Only file-doc pages (kind=reference + source_file_path) get
 * live-audited; ADRs / specs / guides have their own section
 * catalogues and shouldn't be force-fed file-doc sections.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_scan_pages_with_gaps
 */
export function scanPagesWithGaps(wikiRoot: string): Array<{ path: string; parsed: ParsedPage }> {
  const out: Array<{ path: string; parsed: ParsedPage }> = [];
  function walk(absDir: string): void {
    let entries: fs.Dirent<string>[];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const full = path.join(absDir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      let text: string;
      try { text = fs.readFileSync(full, "utf-8"); }
      catch { continue; }
      const parsed = parsePageFm(text);
      const gapsRaw = parsed.meta["curation_gaps"];
      if (Array.isArray(gapsRaw) && gapsRaw.length > 0) {
        out.push({ path: full, parsed });
        continue;
      }
      // Live-audit file-docs only.
      if (parsed.meta["kind"] === "reference" && typeof parsed.meta["source_file_path"] === "string") {
        let live: ReturnType<typeof missingSections> = [];
        try { live = missingSections(parsed.body); }
        catch { live = []; }
        if (live.length > 0) out.push({ path: full, parsed });
      }
    }
  }
  walk(wikiRoot);
  return out;
}
