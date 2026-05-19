/**
 * headless-authoring-claude.ts — shared utilities for the headless
 * authoring worker: ``claude -p`` invocation, gap-name → heading +
 * description mapping, frontmatter parser.
 *
 * Split from headless-authoring.ts so the orchestration / anchor /
 * gap-drain files stay under §4.1.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py
 */

import { spawnSync } from "node:child_process";

// ── Tunables ──────────────────────────────────────────────────────────

// Per-cycle drain budget. Tuned so the worker finishes within a
// reasonable wall-clock window even when ``claude -p`` takes 15-30s
// per call.
// source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:MAX_DRAINS_PER_CYCLE
export const MAX_DRAINS_PER_CYCLE = 8;

// Wall-clock cap per LLM call. File-doc gap fills typically complete
// in 10-20 seconds. Anchor pages (architecture, services, …) carry
// more context and need 60-120s. 180s is the bound past which we
// abort the subprocess and move on.
// source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:CLAUDE_CALL_TIMEOUT_SEC
export const CLAUDE_CALL_TIMEOUT_SEC = 180;
const MS_PER_SECOND = 1000; // source: ECMAScript Date timestamps are ms

// Claude CLI binary. Resolved via PATH; the SessionStart hook already
// requires ``claude`` to be installed.
const CLAUDE_BIN = "claude";

// ── Result types ──────────────────────────────────────────────────────

export interface DrainResult {
  readonly page_path: string;
  readonly gap: string;
  readonly status: "filled" | "failed" | "skipped";
  readonly duration_ms: number;
  readonly detail: string;
}

export interface CycleSummary {
  readonly pages_scanned: number;
  readonly pages_with_gaps: number;
  readonly drains_attempted: number;
  readonly drains_filled: number;
  readonly drains_failed: number;
  readonly duration_ms: number;
  readonly results: readonly DrainResult[];
}

// ── claude -p invocation ──────────────────────────────────────────────

/**
 * Run ``claude --print --no-session-persistence <prompt>`` and return
 * its stdout, or null on failure.
 *
 * Inherits the user's Claude Code session credentials — no API key
 * configuration needed. Subprocess is timed out at
 * CLAUDE_CALL_TIMEOUT_SEC so a hung call doesn't block the worker.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_claude_invoke
 */
export function claudeInvoke(prompt: string, cwd?: string): string | null {
  const result = spawnSync(
    CLAUDE_BIN,
    ["--print", "--no-session-persistence", prompt],
    {
      encoding: "utf-8",
      timeout: CLAUDE_CALL_TIMEOUT_SEC * MS_PER_SECOND,
      ...(cwd ? { cwd } : {}),
    },
  );
  if (result.error) return null;
  if (result.status !== 0) return null;
  const out = (result.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

// ── Gap → heading + description maps ──────────────────────────────────

/**
 * Map a canonical gap slug to the H2 heading text the skeleton uses.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_gap_heading
 */
export function gapHeading(name: string): string {
  return {
    "purpose":          "Purpose",
    "public-api":       "Public API",
    "dependencies":     "Dependencies",
    "callers":          "Callers",
    "behaviour":        "How it works",
    "invariants":       "Invariants",
    "failure-modes":    "What can go wrong",
    "tests":            "Tests",
    "see-also":         "See also",
    "sequence-diagram": "Sequence diagram",
    "flow-diagram":     "Flow diagram",
    "parameters":       "Parameters",
    "request-example":  "Request example",
    "response-example": "Response example",
  }[name] ?? name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Canonical gap description — mirrors the strings the file-doc-skeleton
 * embeds in the ``_(missing — needs: <desc>)_`` markers. Kept in this
 * module (not imported from curation-gaps.ts) so the worker keeps a
 * stable contract even if the gap catalogue evolves.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_GAP_DESCRIPTIONS
 */
export const GAP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "purpose":
    "What this file is responsible for, in two to four sentences. " +
    "Not a restatement of the filename — what behaviour it owns, " +
    "what it must NOT do, where its boundary lies.",
  "public-api":
    "Each exported symbol (function, class, constant) with a " +
    "one-line semantic — what it does, what it returns, when " +
    "to call it. NOT a bare list of names.",
  "dependencies":
    "Why each import is here. 'json' is uninteresting; " +
    "'sentence_transformers' (the embedding model) is. " +
    "Group standard-library imports separately.",
  "callers":
    "Which files in the project depend on this one. The author " +
    "should grep the repo for imports of this module and list " +
    "the top callers with one-line context.",
  "behaviour":
    "Walk through the file's main flow: entry point, key " +
    "branches, state transitions. Diagram (mermaid) preferred " +
    "for anything sequence-shaped.",
  "invariants":
    "What must always be true about this file's outputs / " +
    "internal state. Layer-boundary contracts, type guarantees, " +
    "thread-safety, idempotency. Empty 'none' is fine when " +
    "truly none — say so explicitly.",
  "failure-modes":
    "How this file can fail in production and what the symptom " +
    "looks like. The reader should be able to recognise the " +
    "failure from a stack trace or log line.",
  "tests":
    "Which test files exercise this file. Path + brief on what each test covers.",
  "see-also":
    "cross-links to the project's architecture / services / api " +
    "anchor pages and any sibling files in the same module",
  "sequence-diagram":
    "A `mermaid` sequence diagram of the typical call flow " +
    "involving this file — caller → this file → callees → " +
    "return. Render with ```mermaid sequenceDiagram fences. " +
    "For files that participate in no sequence flow (pure " +
    'data types, constants), explicitly write "Not applicable" ' +
    "and explain why.",
  "flow-diagram":
    "A `mermaid` flowchart or state diagram of the file's " +
    "branching logic, lifecycle, or decision tree. Use " +
    "```mermaid flowchart TD``` (or `LR`) for branching, " +
    "```mermaid stateDiagram-v2``` for state machines. For " +
    'files with no branching to depict, write "Not applicable" ' +
    "and explain why.",
  "parameters":
    "Exhaustive table of every parameter exposed by this " +
    "file's public entry points. Columns: name | type | " +
    "required | default | description. For files with no " +
    'external parameter surface, write "Not applicable."',
  "request-example":
    "A concrete request example — for HTTP handlers, the full " +
    "curl command including headers (Content-Type, " +
    "Authorization, custom headers); for MCP tools, the " +
    "JSON-RPC envelope with `method` and `params`; for library " +
    "functions, the call site as it appears in client code. " +
    "Show headers explicitly. For files not on a request " +
    'boundary, write "Not applicable."',
  "response-example":
    "A concrete response example showing every field the " +
    "caller receives — JSON for HTTP / MCP, return-value " +
    "structure for library functions. Annotate non-obvious " +
    "fields with one-line explanations. Include both success " +
    "and the most common error shape if applicable. For files " +
    'with no response surface, write "Not applicable."',
};

// ── Frontmatter parser (light-weight, mirrors pages.ts but kept local) ──

export interface ParsedPage {
  readonly meta: Record<string, unknown>;
  readonly body: string;
}

/**
 * Parse a wiki page's frontmatter + body. Handles inline + block-list
 * YAML values. Same contract as pages.ts:parsePage but local to the
 * worker so the headless module has no cross-package import.
 *
 * source: cortex/mcp_server/handlers/consolidation/headless_authoring.py:_parse_frontmatter
 */
export function parsePageFm(text: string): ParsedPage {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const FM_DELIM_LEN = 3; // source: YAML 1.2 — directives-end marker is "---"
  const end = text.indexOf("\n---", FM_DELIM_LEN);
  if (end < 0) return { meta: {}, body: text };
  const block = text.slice(FM_DELIM_LEN, end).trim();
  const after = text.slice(end + "\n---".length).replace(/^\n+/, "");
  const meta: Record<string, unknown> = {};
  const lines = block.split("\n");
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    const colon = line.indexOf(":");
    if (colon < 0) { idx += 1; continue; }
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (!raw) {
      const items: string[] = [];
      let j = idx + 1;
      while (j < lines.length) {
        const peek = lines[j] ?? "";
        if (!(peek.startsWith(" ") || peek.startsWith("\t"))) break;
        const stripped = peek.replace(/^\s+/, "");
        if (stripped.startsWith("- ")) {
          items.push(stripped.slice(2).trim().replace(/^["']|["']$/g, ""));
          j += 1;
        } else { break; }
      }
      if (items.length > 0) { meta[key] = items; idx = j; continue; }
      meta[key] = "";
      idx += 1;
      continue;
    }
    meta[key] = raw;
    idx += 1;
  }
  return { meta, body: after };
}
