/**
 * Wiki classification 4-tuple — kind, lifecycle, audience, provenance + tags.
 *
 * Port of mcp_server/shared/wiki_classification.py (Cortex e1a088a, PR #27 +
 * 6219fa2, PR #28 — refactor onto axis registry).
 *
 * Open-world by design. The set of valid values on each axis is loaded
 * from the registry in ./axis-registry.ts which merges TS defaults with
 * user-editable files under wiki/_schema/<axis>/. Adding a new audience
 * or lifecycle is a wiki edit, not a code edit.
 *
 * Validation policy: reject + suggest. An unknown value throws with a
 * message proposing the closest registered name.
 *
 * source: mcp_server/shared/wiki_classification.py
 */

import {
  AXIS_AUDIENCE,
  AXIS_KIND,
  AXIS_LIFECYCLE,
  AXIS_PROVENANCE,
  didYouMean,
  getRegistry,
  type AxisRegistry,
} from "./axis-registry.js";

// ── Legacy kind back-compat (read-time only) ──────────────────────────────

/**
 * Legacy kinds — readable for backward-compat but never produced by new
 * writes. The registry does not list these.
 *
 * source: mcp_server/shared/wiki_classification.py:32
 */
export const LEGACY_KINDS = new Set<string>([
  "notes",
  "specs",
  "conventions",
  "lessons",
  "guides",
  "files",
  "adrs",
]);

/** Legacy → modern kind map applied at read time. */
export const LEGACY_KIND_TO_MODERN: Readonly<Record<string, string>> = {
  notes: "explanation",
  specs: "rfc",
  conventions: "explanation",
  lessons: "explanation",
  guides: "how-to",
  files: "reference",
  adrs: "adr",
};

/** Map a legacy kind name to its modern equivalent. */
export function normalizeLegacyKind(kind: string): string {
  return LEGACY_KIND_TO_MODERN[kind] ?? kind;
}

/** True if the kind belongs to the pre-ADR-2244 taxonomy. */
export function isLegacyKind(kind: string): boolean {
  return LEGACY_KINDS.has(kind);
}

/** Modern (registered) + legacy kinds. For read paths that accept either. */
export function allKnownKinds(registry?: AxisRegistry): ReadonlySet<string> {
  const reg = registry ?? getRegistry();
  const merged = new Set<string>(reg.names(AXIS_KIND));
  for (const k of LEGACY_KINDS) merged.add(k);
  return merged;
}

// ── Data model ────────────────────────────────────────────────────────────

/**
 * Full provenance block for ai/auto-generated content. Required when
 * the registered provenance value's ``requires_generator`` flag is true.
 */
export interface Generator {
  readonly model: string;
  readonly version: string;
  readonly prompt_template: string;
  readonly generated_at: string;
}

/**
 * 4-tuple page classification per ADR-2244.
 *
 * Validation consults the runtime registry rather than hardcoded sets.
 * Adding a new value to any axis requires only writing
 * wiki/_schema/<axis>/<name>.md.
 */
export interface Classification {
  readonly kind: string;
  readonly lifecycle: string;
  readonly audience: readonly string[];
  readonly provenance: string;
  readonly generator: Generator | null;
  readonly tags: readonly string[];
}

export interface ClassificationInput {
  readonly kind: string;
  readonly lifecycle: string;
  readonly audience?: readonly string[];
  readonly provenance?: string;
  readonly generator?: Generator | null;
  readonly tags?: readonly string[];
}

/**
 * Construct + validate a Classification. Throws (with did-you-mean) on
 * any axis violation.
 */
export function makeClassification(
  input: ClassificationInput,
  registry?: AxisRegistry,
): Classification {
  const c: Classification = {
    kind: input.kind,
    lifecycle: input.lifecycle,
    audience: input.audience ?? ["developer"],
    provenance: input.provenance ?? "human",
    generator: input.generator ?? null,
    tags: input.tags ?? [],
  };
  validateClassification(c, registry);
  return c;
}

/** Throw with did-you-mean if any axis violates the schema. */
export function validateClassification(
  c: Classification,
  registry?: AxisRegistry,
): void {
  const reg = registry ?? getRegistry();

  // Kind ────────────────────────────────────────────────────────────────
  if (!reg.has(AXIS_KIND, c.kind)) {
    throw new Error(
      formatUnknown(AXIS_KIND, c.kind, didYouMean(AXIS_KIND, c.kind, reg)),
    );
  }

  // Lifecycle ───────────────────────────────────────────────────────────
  const lc = reg.get(AXIS_LIFECYCLE, c.lifecycle);
  if (lc === null) {
    throw new Error(
      formatUnknown(
        AXIS_LIFECYCLE,
        c.lifecycle,
        didYouMean(AXIS_LIFECYCLE, c.lifecycle, reg),
      ),
    );
  }
  if (lc.applies_to_kinds.length > 0 && !lc.applies_to_kinds.includes(c.kind)) {
    throw new Error(
      `lifecycle ${JSON.stringify(c.lifecycle)} does not apply to kind ` +
        `${JSON.stringify(c.kind)} (only to ${JSON.stringify([...lc.applies_to_kinds].sort())})`,
    );
  }
  if (lc.applies_to_kinds.length === 0 && c.kind === "adr") {
    const adrLc = reg
      .values(AXIS_LIFECYCLE)
      .filter((v) => v.applies_to_kinds.includes("adr"))
      .map((v) => v.name);
    throw new Error(
      `kind=adr requires a lifecycle from ${JSON.stringify(adrLc.sort())}; ` +
        `got ${JSON.stringify(c.lifecycle)}`,
    );
  }

  // Audience ────────────────────────────────────────────────────────────
  if (c.audience.length === 0) {
    throw new Error("audience must not be empty");
  }
  for (const a of c.audience) {
    if (!reg.has(AXIS_AUDIENCE, a)) {
      throw new Error(
        formatUnknown(AXIS_AUDIENCE, a, didYouMean(AXIS_AUDIENCE, a, reg)),
      );
    }
  }

  // Provenance ──────────────────────────────────────────────────────────
  const prov = reg.get(AXIS_PROVENANCE, c.provenance);
  if (prov === null) {
    throw new Error(
      formatUnknown(
        AXIS_PROVENANCE,
        c.provenance,
        didYouMean(AXIS_PROVENANCE, c.provenance, reg),
      ),
    );
  }
  if (prov.requires_generator && c.generator === null) {
    throw new Error(
      `provenance=${JSON.stringify(c.provenance)} requires a Generator block`,
    );
  }
}

/**
 * Render a Classification as a YAML-compatible frontmatter object.
 *
 * source: mcp_server/shared/wiki_classification.py:165
 */
export function toFrontmatter(
  c: Classification,
): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    kind: c.kind,
    lifecycle: c.lifecycle,
    audience: [...c.audience],
    provenance: c.provenance,
  };
  if (c.generator !== null) {
    fm.generator = {
      model: c.generator.model,
      version: c.generator.version,
      prompt_template: c.generator.prompt_template,
      generated_at: c.generator.generated_at,
    };
  }
  if (c.tags.length > 0) {
    fm.tags = [...c.tags];
  }
  return fm;
}

function formatUnknown(
  axis: string,
  value: string,
  suggestions: readonly string[],
): string {
  if (suggestions.length > 0) {
    return (
      `unknown ${axis}: ${JSON.stringify(value)}. Did you mean one of ` +
      `${JSON.stringify([...suggestions])}? Register a new value by writing ` +
      `wiki/_schema/${axis}s/${value}.md.`
    );
  }
  return (
    `unknown ${axis}: ${JSON.stringify(value)}. No close matches in the ` +
    `registry. Register a new value by writing ` +
    `wiki/_schema/${axis}s/${value}.md.`
  );
}
