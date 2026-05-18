/**
 * auto-task-record.ts — Auto-spawn task-record ADRs from completed
 * session work (G9).
 *
 * User direction 2026-05-18: every new task / bug / feature should be
 * treated with the same detailed approach. This module turns a session
 * ending with substantive work into a draft ADR carrying the
 * task-record contract (Entry / Mandatory elements / How / Result /
 * Serves) — the same shape humans use, so nothing is below the level
 * of importance.
 *
 * The draft is NOT a finished page. It pulls together commit messages
 * (intent), session-tagged memories (explicit captures), and changed
 * files (artifacts), then frames them under the canonical ADR
 * sections. The frontmatter carries ``lifecycle: draft`` so the
 * conversational LLM refines it on the next session via the
 * curate_wiki re-author queue.
 *
 * Pure logic — no I/O. The writer (auto-task-record-writer.ts)
 * composes this with git + store + filesystem adapters.
 *
 * source: cortex@HEAD~ mcp_server/core/auto_task_record.py (2026-05-18)
 */

// ── Substantive-session thresholds ────────────────────────────────────

// Below these counts a session isn't substantive enough to warrant a
// task-record. Tuned so a quick browse / read-only session doesn't
// pollute the wiki, but any session that produced commits, edits, or
// explicit memories above the floor gets documented.
// source: cortex/mcp_server/core/auto_task_record.py:36-38
export const MIN_COMMITS_FOR_RECORD = 1;
export const MIN_MEMORIES_FOR_RECORD = 2;
export const MIN_TOOLS_FOR_RECORD = 5;

// Caps used in the body renderer so the draft stays tractable for the
// LLM that refines it on the next session.
// source: cortex/mcp_server/core/auto_task_record.py — slice([:N])
const TITLE_MAX_LEN          = 120;
const COMMITS_IN_HOW         = 10;
const FILES_IN_HOW           = 20;
const MEMORIES_IN_REFERENCES = 8;
const MEMORY_HEAD_CHARS      = 160; // source: cortex/mcp_server/core/auto_task_record.py:_section_references — content[:160]
const MEMORY_TAG_TRIGGERS_FOR_TITLE = new Set(["decision", "lesson", "adr"]);
const MEMORY_TAG_TRIGGERS_FOR_ENTRY = new Set(["decision", "lesson", "todo", "bug"]);

// Slug rules.
// source: cortex/mcp_server/core/auto_task_record.py:_slugify
const SLUG_MAX_LEN = 60;

// ADR id zero-padding.
// source: packages/memory/src/wiki/pages.ts — ADR_NUMBER_WIDTH = 4
const ADR_NUMBER_WIDTH = 4;

// ── Types ─────────────────────────────────────────────────────────────

export interface SessionCommit {
  readonly hash: string;
  readonly message: string;
  readonly files: readonly string[];
  readonly timestamp: string;
}

export interface SessionMemory {
  readonly content: string;
  readonly tags: readonly string[];
  readonly created_at?: string | null;
}

/** Bundle of session evidence the auto-ADR builder needs. */
export interface TaskRecordInputs {
  readonly session_id: string;
  readonly domain: string;
  readonly cwd: string;
  readonly duration_seconds: number | null;
  readonly turn_count: number | null;
  readonly commits: readonly SessionCommit[];
  readonly memories: readonly SessionMemory[];
  readonly changed_files: readonly string[];
  readonly tools_used: readonly string[];
}

/** The synthesised draft. */
export interface TaskRecord {
  readonly slug: string;
  readonly title: string;
  readonly domain: string;
  readonly suggested_path: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

const SLUG_SAFE_RE = /[^a-z0-9]+/g;
const FIRST_LINE_RE = /^.+/m;

function slugify(text: string): string {
  const s = text.toLowerCase().replace(SLUG_SAFE_RE, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, SLUG_MAX_LEN).replace(/-+$/, "") || "unnamed";
}

function firstLine(text: string): string {
  const m = FIRST_LINE_RE.exec(text);
  return m ? m[0].trim() : "";
}

function todayIso(today: string = ""): string {
  if (today) return today;
  return new Date().toISOString().slice(0, "YYYY-MM-DD".length);
}

function deriveTitle(inputs: TaskRecordInputs): string {
  // 1) First commit subject — usually states intent.
  if (inputs.commits.length > 0) {
    const msg = inputs.commits[0]?.message ?? "";
    const first = firstLine(msg);
    if (first) return first.slice(0, TITLE_MAX_LEN);
  }
  // 2) First decision/lesson memory.
  for (const m of inputs.memories) {
    if (m.tags.some((t) => MEMORY_TAG_TRIGGERS_FOR_TITLE.has(t))) {
      const head = firstLine(m.content.trim());
      if (head) return head.slice(0, TITLE_MAX_LEN);
    }
  }
  // 3) Generic fallback.
  return `Session work — ${inputs.cwd || inputs.domain}`;
}

// ── Substantive-session predicate ─────────────────────────────────────

/**
 * True when the session produced enough evidence to deserve an ADR.
 *
 * Thresholds are deliberately lenient: anything with a commit earns a
 * record. Tool-heavy read-only sessions need ≥5 tools AND ≥2 captured
 * memories.
 *
 * source: cortex/mcp_server/core/auto_task_record.py:is_substantive
 */
export function isSubstantive(inputs: TaskRecordInputs): boolean {
  if (inputs.commits.length >= MIN_COMMITS_FOR_RECORD) return true;
  if (
    inputs.memories.length >= MIN_MEMORIES_FOR_RECORD &&
    inputs.tools_used.length >= MIN_TOOLS_FOR_RECORD
  ) return true;
  return false;
}

// ── Section drafters ──────────────────────────────────────────────────

function sectionEntry(inputs: TaskRecordInputs): string {
  if (inputs.commits.length > 0) {
    const msg = inputs.commits[0]?.message?.trim() ?? "";
    const head = msg.split("\n")[0] ?? "(no message)";
    return (
      `Session triggered by the following intent (first commit in ` +
      `session):\n\n> ${head}\n\n` +
      `Total commits in this session: ${inputs.commits.length}.`
    );
  }
  // source: cortex/mcp_server/core/auto_task_record.py:_section_entry — memories[:5]
  const ENTRY_MEMORY_PEEK = 5;
  for (const m of inputs.memories.slice(0, ENTRY_MEMORY_PEEK)) {
    if (m.tags.some((t) => MEMORY_TAG_TRIGGERS_FOR_ENTRY.has(t))) {
      const head = m.content.trim().split("\n")[0] ?? "(no content)";
      return `Captured at session start: ${head}`;
    }
  }
  return (
    `Session in \`${inputs.domain}\` produced ${inputs.tools_used.length} ` +
    `tool invocations and ${inputs.memories.length} memory captures. The LLM ` +
    "should refine this Entry by reading those memories and the commits " +
    "before publishing."
  );
}

function sectionHow(inputs: TaskRecordInputs): string {
  const lines: string[] = [];
  if (inputs.commits.length > 0) {
    lines.push("Implementation moves (commit-by-commit):", "");
    for (const c of inputs.commits.slice(0, COMMITS_IN_HOW)) {
      const hsh = (c.hash ?? "").slice(0, "abcdef12".length);
      const msg = (c.message?.split("\n")[0]) || "(no message)";
      lines.push(`- \`${hsh}\` — ${msg}`);
    }
    if (inputs.commits.length > COMMITS_IN_HOW) {
      lines.push(`- … and ${inputs.commits.length - COMMITS_IN_HOW} more commits.`);
    }
  }
  if (inputs.changed_files.length > 0) {
    lines.push("", "Files touched:");
    for (const f of inputs.changed_files.slice(0, FILES_IN_HOW)) {
      lines.push(`- \`${f}\``);
    }
    if (inputs.changed_files.length > FILES_IN_HOW) {
      lines.push(`- … and ${inputs.changed_files.length - FILES_IN_HOW} more files.`);
    }
  }
  if (lines.length === 0) {
    lines.push(
      "(no commits or file changes recorded — session was likely " +
      "read-only. LLM should describe the analysis path from the " +
      "session memories.)",
    );
  }
  return lines.join("\n");
}

function sectionResult(inputs: TaskRecordInputs): string {
  if (inputs.commits.length === 0) {
    return (
      "(no commits — work product is whatever the session memories and " +
      "tool outputs describe. LLM should cite specifically.)"
    );
  }
  const latest = inputs.commits[inputs.commits.length - 1];
  const hsh = (latest?.hash ?? "").slice(0, "abcdef12".length);
  const msg = latest?.message?.split("\n")[0] ?? "";
  return (
    `Latest commit at session end: \`${hsh}\` — ${msg}\n\n` +
    `Total: ${inputs.commits.length} commits across ` +
    `${inputs.changed_files.length} files.`
  );
}

function sectionMandatory(): string {
  return (
    "_The LLM should fill this from the project's CLAUDE.md, the coding " +
    "standards file, and any explicit invariants the session memories " +
    "captured. Typical constraints to enumerate:_\n\n" +
    "- Clean Architecture layer rule (core ← shared, infra → core)\n" +
    "- SOLID — single responsibility, dependency inversion\n" +
    "- Source-citation discipline — every algorithm/constant has a paper or benchmark\n" +
    // source: rules/coding-standards.md §4.1 / §4.2 — file ≤500, method ≤50
    "- File-size limits (500 lines per file, 50 per method)\n" +
    "- Layer boundaries / domain invariants\n" +
    "- Existing PG schema invariants if the work touched migrations"
  );
}

function sectionServes(inputs: TaskRecordInputs): string {
  return (
    "_The LLM should fill this from the session intent. Typical anchors:_\n\n" +
    `- Which subsystem in \`${inputs.domain}\` depends on this work?\n` +
    "- What user-visible behaviour does it support?\n" +
    "- Which invariant or contract is upheld by it?\n" +
    "- What downstream task does it unblock?"
  );
}

function sectionReferences(inputs: TaskRecordInputs): string {
  if (inputs.memories.length === 0) {
    return "_no memories captured in session; the LLM should look up related entries via `recall`._";
  }
  const lines = ["Memories captured during this session:", ""];
  for (const m of inputs.memories.slice(0, MEMORIES_IN_REFERENCES)) {
    const date = (m.created_at ?? "").slice(0, "YYYY-MM-DD".length);
    const head = (m.content.split("\n")[0] ?? "").slice(0, MEMORY_HEAD_CHARS);
    lines.push(`- \`${date}\` — ${head}`);
  }
  return lines.join("\n");
}

// ── Task-record composer ──────────────────────────────────────────────

export interface BuildTaskRecordOpts {
  /** Next available ADR number for the domain. */
  readonly adrNumber: number;
  /** YYYY-MM-DD override for tests; defaults to today UTC. */
  readonly today?: string;
}

/**
 * Compose the task-record from the inputs.
 *
 * ``adrNumber`` is the next ADR identifier for the project — caller
 * counts existing ``adr/<domain>/NNNN-*.md`` and passes the next value.
 * The body carries every mandatory section from the ADR template even
 * when the corresponding evidence is thin; the LLM finishes the draft
 * on the next session via the curate_wiki re-author flow.
 *
 * source: cortex/mcp_server/core/auto_task_record.py:build_task_record
 */
export function buildTaskRecord(
  inputs: TaskRecordInputs,
  opts: BuildTaskRecordOpts,
): TaskRecord {
  const title = deriveTitle(inputs);
  const slug = slugify(title);
  const id = String(opts.adrNumber).padStart(ADR_NUMBER_WIDTH, "0");
  const filename = `${id}-${slug}.md`;
  const suggestedPath = `adr/${inputs.domain}/${filename}`;
  const today = todayIso(opts.today);

  const frontmatter: Record<string, string> = {
    id,
    title,
    kind: "adr",
    domain: inputs.domain,
    status: "proposed",
    lifecycle: "draft",
    audience: "developer",
    provenance: "auto-generated",
    authored_by: "auto-task-record",
    session_id: inputs.session_id,
    date: today,
    created: today,
    updated: today,
    last_reviewed: today,
  };
  const fmLines = "---\n" +
    Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n") +
    "\n---\n";

  const bodyParts: string[] = [
    fmLines,
    `\n# ADR-${id}: ${title}`,
    "\n## Status\n\nproposed (auto-draft — LLM to verify and flip to `accepted` once refined)",
    `\n## Entry\n\n${sectionEntry(inputs)}`,
    `\n## Mandatory elements\n\n${sectionMandatory()}`,
    `\n## How\n\n${sectionHow(inputs)}`,
    `\n## Result\n\n${sectionResult(inputs)}`,
    `\n## Serves\n\n${sectionServes(inputs)}`,
    "\n## Alternatives considered\n\n_The LLM should enumerate alternatives discussed in session memories tagged `decision` / `alternative` and any rejected approaches captured in commit messages._",
    `\n## References\n\n${sectionReferences(inputs)}`,
  ];
  const body = bodyParts.join("\n") + "\n";

  return { slug, title, domain: inputs.domain, suggested_path: suggestedPath, frontmatter, body };
}
