/**
 * Integration test: open-world axis registry.
 *
 * Validates the ADR-2244 "wiki edit, not code edit" promise: dropping a
 * markdown file under wiki/_schema/<axis>/<value>.md must extend the
 * registry — adding a new audience, kind, lifecycle, or provenance —
 * without recompilation.
 *
 * Covers PR #28 of the Cortex port.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AXIS_AUDIENCE,
  AXIS_KIND,
  AXIS_LIFECYCLE,
  AXIS_PROVENANCE,
  buildDefaultRegistry,
  loadAxisRegistry,
  matchAxis,
  resetRegistry,
} from "../../src/wiki/axis-registry.js";

let wikiRoot: string;

beforeEach(() => {
  wikiRoot = mkdtempSync(join(tmpdir(), "wiki-axis-"));
  mkdirSync(join(wikiRoot, "_schema", "audiences"), { recursive: true });
  mkdirSync(join(wikiRoot, "_schema", "kinds"), { recursive: true });
  mkdirSync(join(wikiRoot, "_schema", "lifecycles"), { recursive: true });
  mkdirSync(join(wikiRoot, "_schema", "provenances"), { recursive: true });
  resetRegistry();
});

afterEach(() => {
  rmSync(wikiRoot, { recursive: true, force: true });
  resetRegistry();
});

describe("axis registry — open-world extension", () => {
  it("ships the 8 ADR-2244 default kinds", () => {
    const reg = buildDefaultRegistry();
    expect([...reg.names(AXIS_KIND)].sort()).toEqual([
      "adr",
      "explanation",
      "how-to",
      "journal",
      "reference",
      "rfc",
      "runbook",
      "tutorial",
    ]);
  });

  it("ships 9 default lifecycles (5 universal + 4 ADR-specific)", () => {
    const reg = buildDefaultRegistry();
    expect(reg.names(AXIS_LIFECYCLE).size).toBe(9);
    const seedling = reg.get(AXIS_LIFECYCLE, "seedling");
    expect(seedling?.default).toBe(true);
    expect(seedling?.applies_to_kinds).toEqual([]);
    const proposed = reg.get(AXIS_LIFECYCLE, "proposed");
    expect(proposed?.default).toBe(true);
    expect(proposed?.applies_to_kinds).toEqual(["adr"]);
  });

  it("loadAxisRegistry returns defaults when wiki has no _schema/", () => {
    rmSync(join(wikiRoot, "_schema"), { recursive: true, force: true });
    const reg = loadAxisRegistry(wikiRoot);
    expect(reg.names(AXIS_KIND).size).toBe(8);
  });

  it("picks up a new audience value from _schema/audiences/", () => {
    writeFileSync(
      join(wikiRoot, "_schema", "audiences", "data-scientist.md"),
      `---
name: data-scientist
axis: audience
display_name: Data scientist
patterns:
  - '\\b(dataset|train(ing)?|inference|model|notebook|jupyter)\\b'
  - '\\b(scikit|pandas|numpy|pytorch|tensorflow)\\b'
tag_aliases:
  - ds
  - ml
  - data
---

# Data scientist audience

Pages targeting practitioners building or analysing ML systems.
`,
    );

    const reg = loadAxisRegistry(wikiRoot);
    const value = reg.get(AXIS_AUDIENCE, "data-scientist");
    expect(value).not.toBeNull();
    expect(value?.display_name).toBe("Data scientist");
    expect(value?.tag_aliases).toEqual(["ds", "ml", "data"]);

    // The detection works end-to-end: content with notebook-y prose
    // gets the new audience.
    const matches = matchAxis(
      "We trained the model on a Jupyter notebook with pandas and scikit-learn.",
      [],
      AXIS_AUDIENCE,
      reg,
    );
    expect(matches).toContain("data-scientist");

    // Tag-alias matching also fires.
    const tagMatches = matchAxis("", ["ml"], AXIS_AUDIENCE, reg);
    expect(tagMatches).toContain("data-scientist");
  });

  it("picks up a new kind from _schema/kinds/", () => {
    writeFileSync(
      join(wikiRoot, "_schema", "kinds", "troubleshooting.md"),
      `---
name: troubleshooting
axis: kind
display_name: Troubleshooting guide
patterns:
  - '\\b(symptom|diagnos(e|is)|workaround)\\b'
tag_aliases:
  - troubleshoot
  - ts-guide
---

# Troubleshooting kind

Symptom-cause-fix pages distinct from incident runbooks.
`,
    );

    const reg = loadAxisRegistry(wikiRoot);
    expect(reg.has(AXIS_KIND, "troubleshooting")).toBe(true);
    expect(reg.names(AXIS_KIND).size).toBe(9); // 8 defaults + 1 new

    const matches = matchAxis(
      "Common symptoms and their diagnosis. If you see X, the workaround is Y.",
      [],
      AXIS_KIND,
      reg,
    );
    expect(matches).toContain("troubleshooting");
  });

  it("user file overrides a default by same name", () => {
    writeFileSync(
      join(wikiRoot, "_schema", "kinds", "adr.md"),
      `---
name: adr
axis: kind
display_name: My Custom ADR Format
tag_aliases:
  - my-custom-adr
---

# Custom ADR
`,
    );

    const reg = loadAxisRegistry(wikiRoot);
    const adr = reg.get(AXIS_KIND, "adr");
    expect(adr?.display_name).toBe("My Custom ADR Format");
    expect(adr?.tag_aliases).toEqual(["my-custom-adr"]);
  });

  it("malformed schema files are silently skipped", () => {
    writeFileSync(
      join(wikiRoot, "_schema", "audiences", "broken.md"),
      "no frontmatter, just body",
    );
    writeFileSync(
      join(wikiRoot, "_schema", "audiences", "wrong-axis.md"),
      `---
name: ops-engineer
axis: not-a-real-axis
---
`,
    );
    writeFileSync(
      join(wikiRoot, "_schema", "audiences", "missing-name.md"),
      `---
axis: audience
display_name: Nobody
---
`,
    );
    const reg = loadAxisRegistry(wikiRoot);
    // No throws, no broken values picked up.
    expect(reg.has(AXIS_AUDIENCE, "ops-engineer")).toBe(false);
    expect(reg.has(AXIS_AUDIENCE, "broken")).toBe(false);
    // Defaults still present.
    expect(reg.has(AXIS_AUDIENCE, "developer")).toBe(true);
  });

  it("accepts both singular and plural axis directory names", () => {
    // singular ``audience`` → use plural seed dir for the other test;
    // here we use the singular directory.
    rmSync(join(wikiRoot, "_schema", "audiences"), { recursive: true });
    mkdirSync(join(wikiRoot, "_schema", "audience"), { recursive: true });
    writeFileSync(
      join(wikiRoot, "_schema", "audience", "researcher.md"),
      `---
name: researcher
axis: audience
display_name: Researcher
tag_aliases:
  - researcher
  - phd
---
`,
    );

    const reg = loadAxisRegistry(wikiRoot);
    expect(reg.has(AXIS_AUDIENCE, "researcher")).toBe(true);
  });

  it("provenance value can be flagged requires_generator via schema file", () => {
    writeFileSync(
      join(wikiRoot, "_schema", "provenances", "claude-synth.md"),
      `---
name: claude-synth
axis: provenance
display_name: Claude-synthesized
requires_generator: true
tag_aliases:
  - claude-synth
---
`,
    );
    const reg = loadAxisRegistry(wikiRoot);
    const v = reg.get(AXIS_PROVENANCE, "claude-synth");
    expect(v?.requires_generator).toBe(true);
  });

  it("lifecycle value can restrict applies_to_kinds via schema file", () => {
    writeFileSync(
      join(wikiRoot, "_schema", "lifecycles", "rollout.md"),
      `---
name: rollout
axis: lifecycle
display_name: Rollout phase
applies_to_kinds:
  - runbook
  - how-to
tag_aliases:
  - rollout
---
`,
    );
    const reg = loadAxisRegistry(wikiRoot);
    const v = reg.get(AXIS_LIFECYCLE, "rollout");
    expect(v?.applies_to_kinds).toEqual(["runbook", "how-to"]);

    // matchAxis lifecycle restrictToKind filtering also picks this up.
    const adrLifecycles = matchAxis(
      "rollout phase",
      ["rollout"],
      AXIS_LIFECYCLE,
      reg,
      { restrictToKind: "adr" },
    );
    expect(adrLifecycles).not.toContain("rollout");

    const runbookLifecycles = matchAxis(
      "rollout phase",
      ["rollout"],
      AXIS_LIFECYCLE,
      reg,
      { restrictToKind: "runbook" },
    );
    expect(runbookLifecycles).toContain("rollout");
  });
});
