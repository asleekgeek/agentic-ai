/* eslint-disable @typescript-eslint/no-magic-numbers, max-lines -- source: exact port of mcp_server/core/wiki_axis_registry.py (687 LoC in Python); numeric literals (similarity cutoff 0.4, did-you-mean n=3) and full registry seed (8 kinds, 9 lifecycles, 5 audiences, 4 provenances + their detection patterns) copied verbatim. Splitting would obscure the 1:1 source mapping. */
/**
 * Wiki axis registry — data-driven classification with extensible values.
 *
 * Port of mcp_server/core/wiki_axis_registry.py (Cortex 6219fa2, PR #28).
 *
 * Open-world classification. The set of values for each axis (kind,
 * lifecycle, audience, provenance) is the union of:
 *   1. Python/TS defaults declared here (bootstrap seed)
 *   2. User-added markdown files under wiki/_schema/<axis>/<value>.md
 *
 * Adding a new audience / lifecycle / kind / provenance is a wiki edit
 * (a single file under wiki/_schema/), not a code edit. Each value
 * ships its own regex detection patterns so the classifier composes
 * the 4-tuple from pattern matches.
 *
 * source: mcp_server/core/wiki_axis_registry.py
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { WIKI_ROOT as DEFAULT_WIKI_ROOT } from "../infrastructure/config.js";

// ── Axis names ────────────────────────────────────────────────────────────

export const AXIS_KIND = "kind" as const;
export const AXIS_LIFECYCLE = "lifecycle" as const;
export const AXIS_AUDIENCE = "audience" as const;
export const AXIS_PROVENANCE = "provenance" as const;
export const AXES = [
  AXIS_KIND,
  AXIS_LIFECYCLE,
  AXIS_AUDIENCE,
  AXIS_PROVENANCE,
] as const;

export type Axis = typeof AXES[number];

const _SCHEMA_FOLDER = "_schema";

// ── Data model ────────────────────────────────────────────────────────────

export interface AxisValue {
  readonly name: string;
  readonly axis: Axis;
  readonly display_name: string;
  readonly patterns: readonly RegExp[];
  readonly tag_aliases: readonly string[];
  readonly default: boolean;
  readonly requires_generator: boolean;
  readonly applies_to_kinds: readonly string[];
  readonly description: string;
}

function av(opts: {
  name: string;
  axis: Axis;
  display_name?: string;
  patterns?: readonly RegExp[];
  tag_aliases?: readonly string[];
  default?: boolean;
  requires_generator?: boolean;
  applies_to_kinds?: readonly string[];
  description?: string;
}): AxisValue {
  return {
    name: opts.name,
    axis: opts.axis,
    display_name: opts.display_name ?? "",
    patterns: opts.patterns ?? [],
    tag_aliases: opts.tag_aliases ?? [],
    default: opts.default ?? false,
    requires_generator: opts.requires_generator ?? false,
    applies_to_kinds: opts.applies_to_kinds ?? [],
    description: opts.description ?? "",
  };
}

export class AxisRegistry {
  private readonly byAxis: Map<Axis, Map<string, AxisValue>>;

  constructor() {
    this.byAxis = new Map();
    for (const a of AXES) this.byAxis.set(a, new Map());
  }

  ingest(value: AxisValue): void {
    let bucket = this.byAxis.get(value.axis);
    if (!bucket) {
      bucket = new Map();
      this.byAxis.set(value.axis, bucket);
    }
    bucket.set(value.name.toLowerCase(), value);
  }

  values(axis: Axis): readonly AxisValue[] {
    const bucket = this.byAxis.get(axis);
    return bucket ? Array.from(bucket.values()) : [];
  }

  names(axis: Axis): ReadonlySet<string> {
    const bucket = this.byAxis.get(axis);
    return new Set(bucket?.keys() ?? []);
  }

  get(axis: Axis, name: string): AxisValue | null {
    const bucket = this.byAxis.get(axis);
    return bucket?.get(name.toLowerCase()) ?? null;
  }

  has(axis: Axis, name: string): boolean {
    return this.get(axis, name) !== null;
  }

  defaultFor(axis: Axis): AxisValue | null {
    for (const v of this.values(axis)) {
      if (v.default) return v;
    }
    return null;
  }
}

// ── Default seed (bootstrap when wiki has no _schema/) ────────────────────

function re(pat: string): RegExp {
  return new RegExp(pat, "i");
}

function reMl(pat: string): RegExp {
  return new RegExp(pat, "im");
}

const _DEFAULT_KINDS: readonly AxisValue[] = [
  av({
    name: "adr",
    axis: AXIS_KIND,
    display_name: "ADR (Architecture Decision Record)",
    patterns: [
      re("\\b(decided to|decision:|the decision is|chose .+ because)\\b"),
      re("\\b(rejected .+ (due to|because)|we will use|selected .+ over)\\b"),
      reMl("^##+\\s*Decision\\s*$"),
      reMl("^##+\\s*Consequences\\s*$"),
    ],
    // ``architecture`` removed (pilot 2026-05-13): too broad to be ADR-only.
    tag_aliases: ["decision", "adr"],
    description:
      "Nygard/MADR-style record of a single architectural decision.",
  }),
  av({
    name: "tutorial",
    axis: AXIS_KIND,
    display_name: "Tutorial",
    patterns: [
      re(
        "\\b(tutorial:|in this tutorial|we['’]?ll (learn|build|create|walk through))\\b",
      ),
      re("\\b(by the end of this tutorial|getting started:|step 1[:.])\\b"),
    ],
    tag_aliases: ["tutorial", "getting-started"],
    description: "Learn-by-doing walkthrough (Diátaxis).",
  }),
  av({
    name: "how-to",
    axis: AXIS_KIND,
    display_name: "How-to guide",
    patterns: [re("\\b(how to |how do (you|i) |here['’]?s how to )\\b")],
    tag_aliases: ["how-to", "howto", "guide"],
    description:
      "Task-oriented recipe for a known goal (Diátaxis / DITA task).",
  }),
  av({
    name: "reference",
    axis: AXIS_KIND,
    display_name: "Reference",
    // Producer audit (ADR-2244 Phase 6): ``codebase`` is the bare tag
    // written by ``codebase_analyze``; without it here, file-doc pages
    // got routed to ``explanation``.
    tag_aliases: ["reference", "api", "spec", "code-reference", "codebase"],
    description:
      "Authoritative lookup table — API docs, file docs, schema refs.",
  }),
  av({
    name: "explanation",
    axis: AXIS_KIND,
    display_name: "Explanation",
    patterns: [
      re("\\b(what is|why does|the reason|conceptually|under the hood)\\b"),
      re("\\b(the bug was|root cause|lesson learned|fix:|fixed by)\\b"),
      re(
        "\\b(always use|never |the canonical|convention:|rule:|standard:)\\b",
      ),
    ],
    tag_aliases: [
      "explanation",
      "concept",
      "lesson",
      "convention",
      "rule",
      "standard",
    ],
    description: "Concept-oriented prose explaining the 'why' (Diátaxis).",
  }),
  av({
    name: "runbook",
    axis: AXIS_KIND,
    display_name: "Runbook",
    patterns: [
      re(
        "\\b(runbook|incident response|on[- ]call|when (the )?alert fires)\\b",
      ),
      re("\\b(if (this|that) happens|recovery procedure|rollback steps?)\\b"),
    ],
    tag_aliases: ["runbook", "playbook", "incident", "oncall"],
    description:
      "SRE incident-response procedure (Rootly/Squadcast convention).",
  }),
  av({
    name: "rfc",
    axis: AXIS_KIND,
    display_name: "RFC (Request For Comments)",
    patterns: [
      re(
        "\\b(rfc:|proposal:|we propose to|proposed (design|change|approach))\\b",
      ),
      re("\\b(this rfc|request for comments)\\b"),
    ],
    tag_aliases: ["rfc", "proposal", "spec", "design"],
    description:
      "Pre-decision design proposal open for comment (IETF/arc42 §4).",
  }),
  av({
    name: "journal",
    axis: AXIS_KIND,
    display_name: "Journal entry",
    patterns: [reMl("^##?\\s*\\d{4}-\\d{2}-\\d{2}\\b")],
    tag_aliases: ["journal", "diary", "log"],
    description:
      "Dated reflective entry — digital-garden / Confluence blog style.",
  }),
];

const _DEFAULT_LIFECYCLES: readonly AxisValue[] = [
  av({
    name: "seedling",
    axis: AXIS_LIFECYCLE,
    display_name: "Seedling",
    default: true,
    patterns: [re("_to be (filled|written)_")],
    tag_aliases: ["seedling", "seed", "new", "stub"],
    description:
      "Initial stub, expected to grow (digital-garden convention).",
  }),
  av({
    name: "draft",
    axis: AXIS_LIFECYCLE,
    display_name: "Draft",
    patterns: [re("\\bdraft\\b")],
    tag_aliases: ["draft", "wip"],
    description: "Work in progress, not yet published.",
  }),
  av({
    name: "active",
    axis: AXIS_LIFECYCLE,
    display_name: "Active",
    tag_aliases: ["active", "current", "live"],
    description: "Maintained and authoritative.",
  }),
  av({
    name: "deprecated",
    axis: AXIS_LIFECYCLE,
    display_name: "Deprecated",
    patterns: [re("\\bdeprecated\\b")],
    tag_aliases: ["deprecated", "legacy"],
    description:
      "Still readable, but new use should prefer the replacement.",
  }),
  av({
    name: "archived",
    axis: AXIS_LIFECYCLE,
    display_name: "Archived",
    patterns: [re("\\barchived\\b")],
    tag_aliases: ["archived", "historic"],
    description: "Frozen historical record; do not modify.",
  }),
  // ADR-specific lifecycle subset (Nygard / MADR).
  av({
    name: "proposed",
    axis: AXIS_LIFECYCLE,
    display_name: "Proposed (ADR)",
    default: true,
    applies_to_kinds: ["adr"],
    patterns: [re("\\bproposed\\b")],
    tag_aliases: ["proposed"],
    description: "ADR awaiting decision (Nygard).",
  }),
  av({
    name: "accepted",
    axis: AXIS_LIFECYCLE,
    display_name: "Accepted (ADR)",
    applies_to_kinds: ["adr"],
    patterns: [re("\\baccepted\\b")],
    tag_aliases: ["accepted"],
    description: "ADR adopted and in effect (Nygard).",
  }),
  av({
    name: "rejected",
    axis: AXIS_LIFECYCLE,
    display_name: "Rejected (ADR)",
    applies_to_kinds: ["adr"],
    patterns: [re("\\brejected\\b")],
    tag_aliases: ["rejected"],
    description: "ADR considered and dismissed (Nygard).",
  }),
  av({
    name: "superseded",
    axis: AXIS_LIFECYCLE,
    display_name: "Superseded (ADR)",
    applies_to_kinds: ["adr"],
    patterns: [re("\\bsuperseded\\b")],
    tag_aliases: ["superseded"],
    description: "ADR replaced by a later one (Nygard).",
  }),
];

const _DEFAULT_AUDIENCES: readonly AxisValue[] = [
  av({
    name: "developer",
    axis: AXIS_AUDIENCE,
    display_name: "Developer",
    default: true,
    patterns: [
      re(
        "\\b(function|class|method|import|module|API|SDK|library|interface)\\b",
      ),
    ],
    tag_aliases: ["dev", "developer", "engineer", "code"],
    description: "Software engineers writing or modifying code.",
  }),
  av({
    name: "ops",
    axis: AXIS_AUDIENCE,
    display_name: "Operations / SRE",
    patterns: [
      re(
        "\\b(deploy(ment)?|kubernetes|terraform|infra(structure)?|cluster|node|pod)\\b",
      ),
      re(
        "\\b(sre|on[- ]call|incident|alert|monitoring|observability)\\b",
      ),
    ],
    tag_aliases: ["ops", "sre", "infra", "deploy", "k8s"],
    description: "Operators of production systems.",
  }),
  av({
    name: "security",
    axis: AXIS_AUDIENCE,
    display_name: "Security",
    patterns: [
      re(
        "\\b(authentication|authorization|cryptograph(y|ic)|vulnerab(le|ility)|cve|threat model)\\b",
      ),
      re(
        "\\b(credential|oauth|sso|encryption|decrypt(ed|ion)?|key rotation|HSM|secret manager)\\b",
      ),
    ],
    tag_aliases: ["security", "auth", "crypto", "vulnerability", "secops"],
    description: "Security engineers and reviewers.",
  }),
  av({
    name: "internal",
    axis: AXIS_AUDIENCE,
    display_name: "Internal",
    tag_aliases: ["internal", "private"],
    description:
      "Internal team-only content (not for external publication).",
  }),
  av({
    name: "external",
    axis: AXIS_AUDIENCE,
    display_name: "External",
    tag_aliases: ["external", "public", "customer"],
    description: "External-facing documentation for users / customers.",
  }),
];

const _DEFAULT_PROVENANCES: readonly AxisValue[] = [
  av({
    name: "human",
    axis: AXIS_PROVENANCE,
    display_name: "Human-authored",
    default: true,
    tag_aliases: ["human", "authored"],
    description: "Hand-written by a person.",
  }),
  av({
    name: "ai-generated",
    axis: AXIS_PROVENANCE,
    display_name: "AI-generated",
    tag_aliases: ["ai-generated", "synthesized", "synth"],
    requires_generator: true,
    description: "Produced by an LLM via a template prompt.",
  }),
  av({
    name: "imported",
    axis: AXIS_PROVENANCE,
    display_name: "Imported",
    tag_aliases: ["imported", "import"],
    description: "Bulk-imported from an external memory system.",
  }),
  av({
    name: "auto-generated",
    axis: AXIS_PROVENANCE,
    display_name: "Auto-generated (codebase)",
    tag_aliases: ["auto-generated", "code-reference", "codebase"],
    requires_generator: true,
    description: "Produced by ``codebase_analyze`` / ``wiki_seed_codebase``.",
  }),
];

const _ALL_DEFAULTS: readonly AxisValue[] = [
  ..._DEFAULT_KINDS,
  ..._DEFAULT_LIFECYCLES,
  ..._DEFAULT_AUDIENCES,
  ..._DEFAULT_PROVENANCES,
];

// ── Registry construction ─────────────────────────────────────────────────

export function buildDefaultRegistry(): AxisRegistry {
  const reg = new AxisRegistry();
  for (const v of _ALL_DEFAULTS) reg.ingest(v);
  return reg;
}

const _FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

function parseAxisValueFile(content: string): AxisValue | null {
  const m = content.match(_FRONTMATTER_RE);
  if (!m) return null;

  const fmText = m[1] ?? "";
  const body = content.slice(m[0].length).trim();
  const fm: Record<string, unknown> = {};
  let listKey: string | null = null;
  let listItems: string[] = [];

  function closeList(): void {
    if (listKey !== null) {
      fm[listKey] = listItems;
      listKey = null;
      listItems = [];
    }
  }

  for (const raw of fmText.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line) {
      continue;
    }
    if (listKey !== null && line.startsWith("  - ")) {
      listItems.push(line.slice(4).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    closeList();
    if (line.includes(":") && !line.startsWith(" ")) {
      const idx = line.indexOf(":");
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (value === "") {
        listKey = key;
        listItems = [];
      } else {
        fm[key] = value.replace(/^['"]|['"]$/g, "");
      }
    }
  }
  closeList();

  const name = String(fm.name ?? "").trim().toLowerCase();
  const axisRaw = String(fm.axis ?? "").trim().toLowerCase();
  if (!name || !(AXES as readonly string[]).includes(axisRaw)) return null;
  const axis = axisRaw as Axis;

  const patternsRaw = Array.isArray(fm.patterns) ? (fm.patterns as string[]) : [];
  const compiled: RegExp[] = [];
  for (const p of patternsRaw) {
    try {
      compiled.push(re(String(p)));
    } catch {
      // skip malformed patterns
    }
  }

  const tagAliasesRaw = Array.isArray(fm.tag_aliases)
    ? (fm.tag_aliases as string[])
    : [];

  const appliesToKindsRaw = Array.isArray(fm.applies_to_kinds)
    ? (fm.applies_to_kinds as string[])
    : [];

  return av({
    name,
    axis,
    display_name: String(fm.display_name ?? "").trim(),
    patterns: compiled,
    tag_aliases: tagAliasesRaw.map((t) => String(t).toLowerCase()),
    default: truthy(fm.default),
    requires_generator: truthy(fm.requires_generator),
    applies_to_kinds: appliesToKindsRaw.map((k) => String(k).toLowerCase()),
    description: body,
  });
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return ["true", "yes", "1"].includes(String(v ?? "").trim().toLowerCase());
}

/**
 * Build the registry: defaults + any user wiki/_schema/<axis>/ files.
 * User files override defaults with the same name. Never raises —
 * malformed files are silently skipped.
 */
export function loadAxisRegistry(
  wikiRoot?: string | null,
): AxisRegistry {
  const registry = buildDefaultRegistry();
  if (!wikiRoot) return registry;

  const schemaRoot = join(wikiRoot, _SCHEMA_FOLDER);
  let entries: string[];
  try {
    if (!existsSync(schemaRoot) || !statSync(schemaRoot).isDirectory()) {
      return registry;
    }
    entries = readdirSync(schemaRoot);
  } catch {
    return registry;
  }

  for (const axisDirName of entries) {
    const axisDir = join(schemaRoot, axisDirName);
    let isDir = false;
    try {
      isDir = statSync(axisDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const dirLower = axisDirName.toLowerCase();
    const knownAxes = AXES as readonly string[];
    const knownAxesPlural = AXES.map((a) => `${a}s`);
    if (!knownAxes.includes(dirLower) && !knownAxesPlural.includes(dirLower)) {
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(axisDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const fp = join(axisDir, f);
      let text: string;
      try {
        text = readFileSync(fp, "utf-8");
      } catch {
        continue;
      }
      const parsed = parseAxisValueFile(text);
      if (parsed !== null) registry.ingest(parsed);
    }
  }
  return registry;
}

// ── Lookup helpers used by validators + classifier ────────────────────────

/**
 * Suggest registered names close to ``unknown`` on the given axis.
 *
 * Implements the "reject + suggest" policy: validators throw with these
 * suggestions in the error message.
 */
export function didYouMean(
  axis: Axis,
  unknown: string,
  registry: AxisRegistry,
  n: number = 3,
): readonly string[] {
  const candidates = Array.from(registry.names(axis));
  const target = unknown.toLowerCase();
  // Simple Levenshtein-ish ratio with cutoff 0.4 (matches difflib default).
  const scored = candidates
    .map((c) => ({ name: c, score: similarity(target, c.toLowerCase()) }))
    .filter((s) => s.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  return scored.map((s) => s.name);
}

/** Ratio in [0,1] mirroring Python's difflib.SequenceMatcher.ratio. */
function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const matches = longestCommonSubseq(a, b);
  const total = a.length + b.length;
  return total === 0 ? 0 : (2 * matches) / total;
}

function longestCommonSubseq(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev: number[] = new Array<number>(n + 1).fill(0);
  let curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) curr[j] = (prev[j - 1] ?? 0) + 1;
      else curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n] ?? 0;
}

/**
 * Return value names whose patterns or tag aliases match the input.
 *
 * Order preserved as iteration order over registry values; first hit
 * wins for axes that take a single value (kind, lifecycle, provenance).
 * For lifecycle, ``restrictToKind`` filters values whose
 * ``applies_to_kinds`` excludes the kind (so an ADR cannot be
 * ``seedling`` and a non-ADR cannot be ``proposed``).
 */
export function matchAxis(
  content: string,
  tags: readonly string[] | null | undefined,
  axis: Axis,
  registry: AxisRegistry,
  opts: { restrictToKind?: string | null } = {},
): readonly string[] {
  const restrictToKind = opts.restrictToKind ?? null;
  const tagSet = new Set((tags ?? []).map((t) => t.toLowerCase()));
  const matches: string[] = [];

  for (const value of registry.values(axis)) {
    if (
      axis === AXIS_LIFECYCLE &&
      value.applies_to_kinds.length > 0 &&
      restrictToKind !== null &&
      !value.applies_to_kinds.includes(restrictToKind)
    ) {
      continue;
    }
    if (
      axis === AXIS_LIFECYCLE &&
      value.applies_to_kinds.length === 0 &&
      restrictToKind === "adr"
    ) {
      // Universal lifecycle values do not apply to ADRs.
      continue;
    }
    let tagHit = false;
    for (const alias of value.tag_aliases) {
      if (tagSet.has(alias)) {
        tagHit = true;
        break;
      }
    }
    if (tagHit) {
      matches.push(value.name);
      continue;
    }
    for (const pat of value.patterns) {
      if (pat.test(content)) {
        matches.push(value.name);
        break;
      }
    }
  }
  return matches;
}

// ── Lazy singleton — cached for in-process classifier calls ───────────────

let _registryCache: AxisRegistry | null = null;
let _cacheRoot: string | null = null;

/**
 * Return the process-wide registry (defaults + wiki/_schema/ overrides).
 *
 * Cached against the supplied wikiRoot. Use ``resetRegistry`` to force
 * a reload — e.g. after the user edits a schema file.
 */
export function getRegistry(wikiRoot?: string | null): AxisRegistry {
  // Default to the configured WIKI_ROOT so user-edited
  // wiki/_schema/<axis>/<value>.md files are picked up automatically
  // (mirrors Cortex Python's behavior — the Python ``get_registry``
  // reads WIKI_ROOT from infrastructure.config with no argument).
  const normRoot = wikiRoot ?? DEFAULT_WIKI_ROOT;
  if (_registryCache !== null && _cacheRoot === normRoot) {
    return _registryCache;
  }
  _registryCache = loadAxisRegistry(normRoot);
  _cacheRoot = normRoot;
  return _registryCache;
}

export function resetRegistry(): void {
  _registryCache = null;
  _cacheRoot = null;
}
