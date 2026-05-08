/**
 * dashboard-xss.test.ts — SEC-005 regression test.
 *
 * SEC-005: Stored XSS in the loopback dashboard via memory content.
 *
 * Before fix: the memory list renderer in static/index.html did:
 *   list.innerHTML = (data.memories ?? []).map(m => `<div>${m.content}</div>`)
 * Memory `content` is attacker-controllable (any tool agent that calls
 * cortex:remember can submit a payload). When the dashboard fetched and
 * rendered such memories, <script>, <img onerror=...> and other HTML
 * elements were parsed and executed.
 *
 * After the Cortex frontend port (commit a764ac8), memory rendering moved from
 * static/index.html into static/js/knowledge.js. This test was updated to scan
 * the actual rendering location.
 *
 * CONTRACT (what we enforce):
 *   1. Memory `content` in the card list is rendered via textContent / createTextNode
 *      — NOT via innerHTML / dangerouslySetInnerHTML.
 *   2. The expanded-view renderer (renderMemoryContent) that does use innerHTML
 *      MUST escape all user content via the esc() helper before injection.
 *   3. All other rendering surfaces (timeline.js, sankey.js, wiki.js) must either
 *      use textContent for memory.content OR escape through a sanitiser before
 *      assigning innerHTML.
 *   4. No use of document.write or eval-equivalent constructs.
 *
 * Falsification: revert buildCard() to use innerHTML = m.content → test 2 fails.
 * Falsification: remove esc() calls inside renderMemoryContent → test 3 fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_JS = join(__dirname, "..", "src", "static", "js");

function readJs(name: string): string {
  return readFileSync(join(STATIC_JS, name), "utf-8");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip JS line and block comments to avoid false positives when checking
 * for innerHTML vs textContent usage. Does not handle all edge cases
 * (e.g. regex literals) but is sufficient for the simple patterns we test.
 *
 * precondition:  src is valid JS.
 * postcondition: comments removed; string literals are NOT stripped (we check
 *   for inline HTML strings that are constants, not user data paths).
 */
function stripComments(src: string): string {
  // Block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Line comments
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

// ── knowledge.js: primary memory rendering surface ───────────────────────────

describe("knowledge.js — SEC-005 XSS regression", () => {
  const src = readJs("knowledge.js");
  const stripped = stripComments(src);

  it("buildCard() renders m.content via textContent, not innerHTML", () => {
    // Locate the buildCard function body.
    // source: packages/memory-dashboard/src/static/js/knowledge.js:buildCard
    const fnMatch = /function buildCard\([\s\S]*?\n\s{2}\}/.exec(src);
    expect(fnMatch, "buildCard function not found in knowledge.js").not.toBeNull();
    const body = fnMatch![0];

    // buildCard must NOT assign innerHTML with any expression containing content/label.
    // Pattern: `.innerHTML` on the left of an assignment that references mem.content / mem.label.
    const unsafeContentInnerHtml =
      /\.innerHTML\s*=\s*[^;]*(?:mem\.content|mem\.label|m\.content|m\.label)/s.test(body);
    expect(unsafeContentInnerHtml, "buildCard injects mem.content via innerHTML").toBe(false);

    // buildCard MUST use textContent for the title and body preview.
    expect(body.includes("textContent"), "buildCard must use textContent for safe rendering").toBe(true);
  });

  it("renderMemoryContent() escapes all user content through esc() before innerHTML", () => {
    // Locate renderMemoryContent function body.
    // source: packages/memory-dashboard/src/static/js/knowledge.js:renderMemoryContent
    const fnMatch = /function renderMemoryContent\([\s\S]*?\n\s{2}\}/.exec(src);
    expect(fnMatch, "renderMemoryContent function not found in knowledge.js").not.toBeNull();
    const body = fnMatch![0];

    // esc() must be defined — it HTML-escapes &, <, >, ".
    expect(src.includes("function esc("), "esc() helper not found in knowledge.js").toBe(true);

    // Every line that builds an HTML string with user-derived content must call esc().
    // Strategy: there must be NO bare variable interpolation of `text` or `line`
    // directly inside an innerHTML-bound string WITHOUT going through esc().
    // We verify that every `html.push(` call that contains a JS variable either
    // wraps it with esc() or uses a constant-only HTML fragment.
    //
    // Practical check: the function must call esc() at least 3 times
    // (code lines, heading content, and plain text lines) to cover the main paths.
    const escCallCount = (body.match(/\besc\s*\(/g) ?? []).length;
    expect(escCallCount, "renderMemoryContent must call esc() for user content (expected >= 3)").toBeGreaterThanOrEqual(3);

    // The raw user text variable (`text` / `line`) must never appear in a template
    // literal or concatenation without being wrapped in esc(). Check that `+ text +`
    // or `+ line +` never appears unescaped.
    const bareTextConcat = /['"`][^'"`]*\+\s*(?:text|line|raw)\s*\+[^'"`]*['"`]/g;
    const bareMatches = body.match(bareTextConcat) ?? [];
    expect(bareMatches, "renderMemoryContent concatenates raw user text into HTML string without esc()").toEqual([]);
  });

  it("knowledge.js does not use document.write or eval", () => {
    expect(stripped.includes("document.write"), "knowledge.js uses document.write").toBe(false);
    expect(/[^a-zA-Z_$]eval\s*\(/.test(stripped), "knowledge.js uses eval()").toBe(false);
    expect(/new\s+Function\s*\(/.test(stripped), "knowledge.js uses new Function()").toBe(false);
  });
});

// ── timeline.js: Board tab memory rendering ──────────────────────────────────

describe("timeline.js — SEC-005 XSS regression", () => {
  const src = readJs("timeline.js");

  it("timeline.js does not inject memory.content or memory.label into innerHTML", () => {
    // On timeline.js the card labels use textContent; innerHTML is only used for
    // structural HTML (stage flow arrows, stat bars) with constant strings — never
    // with user-supplied memory content.
    // source: packages/memory-dashboard/src/static/js/timeline.js:buildCard
    const unsafeContentInnerHtml =
      /\.innerHTML\s*=\s*[^;]*(?:mem\.content|mem\.label|m\.content|m\.label|\.label\s*\|\|)/s.test(src);
    expect(unsafeContentInnerHtml, "timeline.js injects mem.content/label into innerHTML").toBe(false);
  });

  it("timeline.js does not use document.write or eval", () => {
    const stripped = stripComments(src);
    expect(stripped.includes("document.write")).toBe(false);
    expect(/[^a-zA-Z_$]eval\s*\(/.test(stripped)).toBe(false);
  });
});

// ── sankey.js: heat-flow rendering ───────────────────────────────────────────

describe("sankey.js — SEC-005 XSS regression", () => {
  const src = readJs("sankey.js");

  it("sankey.js does not inject memory.content into innerHTML", () => {
    // sankey.js uses innerHTML only for stat bars with numeric values (no user text).
    const unsafeContentInnerHtml =
      /\.innerHTML\s*=\s*[^;]*(?:\.content|\.label\b)/s.test(src);
    expect(unsafeContentInnerHtml, "sankey.js injects memory content/label into innerHTML").toBe(false);
  });

  it("sankey.js does not use document.write or eval", () => {
    const stripped = stripComments(src);
    expect(stripped.includes("document.write")).toBe(false);
    expect(/[^a-zA-Z_$]eval\s*\(/.test(stripped)).toBe(false);
  });
});

// ── wiki.js: markdown renderer — expected innerHTML with sanitisation ─────────

describe("wiki.js — SEC-005 XSS regression", () => {
  const src = readJs("wiki.js");

  it("wiki.js has an esc() sanitiser that escapes HTML metacharacters", () => {
    // wiki.js uses innerHTML for markdown output. The esc() function must exist
    // and must escape the four critical HTML metacharacters.
    // source: packages/memory-dashboard/src/static/js/wiki.js:esc
    const escFnMatch = /function esc\([\s\S]*?\n\s{2}\}/.exec(src);
    expect(escFnMatch, "esc() function not found in wiki.js").not.toBeNull();
    const escBody = escFnMatch![0];

    // Must escape & < > " — the four critical HTML metacharacters.
    // source: OWASP XSS Prevention Cheat Sheet — Rule #1: escape HTML entities
    expect(escBody.includes("&amp;"), "esc() must escape &").toBe(true);
    expect(escBody.includes("&lt;"), "esc() must escape <").toBe(true);
    expect(escBody.includes("&gt;"), "esc() must escape >").toBe(true);
    expect(escBody.includes("&quot;"), "esc() must escape \"").toBe(true);
  });

  it("wiki.js renderMarkdown uses esc() for all user-content interpolation", () => {
    // renderMarkdown injects into innerHTML; every user-content variable must go
    // through esc(). We check the function exists and calls esc() >= 3 times.
    const fnMatch = /function renderMarkdown\([\s\S]*?\n\s{2}\}/.exec(src);
    expect(fnMatch, "renderMarkdown not found in wiki.js").not.toBeNull();
    const body = fnMatch![0];

    const escCallCount = (body.match(/\besc\s*\(/g) ?? []).length;
    expect(escCallCount, "renderMarkdown must call esc() >= 3 times for user content").toBeGreaterThanOrEqual(3);
  });

  it("wiki.js does not use document.write or eval", () => {
    const stripped = stripComments(src);
    expect(stripped.includes("document.write")).toBe(false);
    expect(/[^a-zA-Z_$]eval\s*\(/.test(stripped)).toBe(false);
  });
});
