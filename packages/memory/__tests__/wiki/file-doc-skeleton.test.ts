/**
 * Tests for file-doc-skeleton.ts — generates skeletons that expose their
 * canonical curation gaps as explicit ``_(missing — needs: …)_`` markers.
 *
 * source: packages/memory/src/wiki/file-doc-skeleton.ts
 * source: cortex@HEAD~ mcp_server/core/wiki_file_doc_skeleton.py (2026-05-18)
 */

import { describe, expect, it } from "vitest";
import { buildFileDoc } from "../../src/wiki/file-doc-skeleton.js";
import { FILE_DOC_SECTIONS } from "../../src/wiki/curation-gaps.js";

const TODAY = "2026-05-18";

describe("buildFileDoc — frontmatter", () => {
  it("emits required fields with the source path baked in", () => {
    const out = buildFileDoc({
      relSourcePath: "packages/memory/src/wiki/foo.ts",
      sourceText: "export const x = 1;",
      domain: "agentic-ai",
      today: TODAY,
    });
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("title: File: packages/memory/src/wiki/foo.ts");
    expect(out).toContain("kind: reference");
    expect(out).toContain("domain: agentic-ai");
    expect(out).toContain("source_file_path: packages/memory/src/wiki/foo.ts");
    expect(out).toContain("language: typescript");
    expect(out).toContain("lifecycle: needs-curation");
    expect(out).toContain("provenance: skeleton");
    expect(out).toContain("authored_by: file-doc-skeleton-v2");
    expect(out).toContain(`created: ${TODAY}`);
  });

  it("tags the page with safe-classifier markers", () => {
    const out = buildFileDoc({
      relSourcePath: "a.ts",
      sourceText: "",
      domain: "demo",
      today: TODAY,
    });
    expect(out).toContain("  - file-doc");
    expect(out).toContain("  - codebase-skeleton");
    expect(out).toContain("  - needs-curation");
    expect(out).toContain("  - lang:typescript");
    expect(out).toContain("  - file:a.ts");
    expect(out).toContain("  - domain:demo");
  });

  it("populates curation_gaps with every section the LLM still needs to fill", () => {
    const out = buildFileDoc({
      relSourcePath: "a.ts",
      sourceText: "",
      domain: "demo",
      today: TODAY,
    });
    // With no imports + no symbols, every FILE_DOC_SECTIONS entry
    // surfaces as a gap, plus the trailing ``see-also``.
    for (const s of FILE_DOC_SECTIONS) expect(out).toContain(`  - ${s.name}`);
    expect(out).toContain("  - see-also");
  });
});

describe("buildFileDoc — body sections", () => {
  it("emits every canonical heading", () => {
    const out = buildFileDoc({
      relSourcePath: "a.ts",
      sourceText: "",
      domain: "demo",
      today: TODAY,
    });
    for (const s of FILE_DOC_SECTIONS) {
      expect(out).toContain(s.heading);
    }
    expect(out).toContain("## See also");
  });

  it("pre-populates Dependencies from import lines + leaves a curation hint", () => {
    const py = `from a.b import c\nimport d\nfrom e.f import g\n`;
    const out = buildFileDoc({
      relSourcePath: "demo.py",
      sourceText: py,
      domain: "demo",
      today: TODAY,
    });
    expect(out).toContain("## Dependencies");
    expect(out).toContain("* `a.b`");
    expect(out).toContain("* `d`");
    expect(out).toContain("* `e.f`");
    // Curation hint still tells the reader the WHY is the work to fill.
    expect(out).toContain("The curation step is to explain");
    // Dependencies is auto-populated → should NOT appear in
    // curation_gaps.
    const gapsBlock = out.split("curation_gaps:")[1]?.split("---")[0] ?? "";
    expect(gapsBlock).not.toContain("- dependencies\n");
  });

  it("pre-populates Public API from top-level export declarations", () => {
    const ts = [
      "import { foo } from './x';",
      "export const APUBLIC = 1;",
      "export function aFn() { return 1; }",
      "export class AClass {}",
      "  export const indented = 1;", // indented — must NOT appear
    ].join("\n");
    const out = buildFileDoc({
      relSourcePath: "a.ts",
      sourceText: ts,
      domain: "demo",
      today: TODAY,
    });
    expect(out).toContain("## Public API");
    expect(out).toContain("* `APUBLIC` —");
    expect(out).toContain("* `aFn` —");
    expect(out).toContain("* `AClass` —");
    expect(out).not.toContain("indented");
  });

  it("uses the ``_(missing — needs:`` marker for unfilled sections", () => {
    const out = buildFileDoc({
      relSourcePath: "a.ts",
      sourceText: "",
      domain: "demo",
      today: TODAY,
    });
    // Distinct from stub-detector markers — purge will leave us alone.
    expect(out).toContain("_(missing — needs:");
    expect(out).not.toContain("_(to be filled)_");
    expect(out).not.toContain("_To be written._");
  });

  it("surfaces the 2026-05-18 sections in the body", () => {
    const out = buildFileDoc({
      relSourcePath: "a.ts",
      sourceText: "",
      domain: "demo",
      today: TODAY,
    });
    expect(out).toContain("## Sequence diagram");
    expect(out).toContain("## Parameters");
    expect(out).toContain("## Request example");
    expect(out).toContain("## Response example");
  });
});

describe("buildFileDoc — language detection", () => {
  it.each([
    [".py", "python"],
    [".ts", "typescript"],
    [".tsx", "typescript"],
    [".js", "javascript"],
    [".go", "go"],
    [".rs", "rust"],
    [".unknown", "text"],
  ])("maps %s extension → %s", (ext, lang) => {
    const out = buildFileDoc({
      relSourcePath: `file${ext}`,
      sourceText: "",
      domain: "demo",
      today: TODAY,
    });
    expect(out).toContain(`language: ${lang}`);
  });
});
