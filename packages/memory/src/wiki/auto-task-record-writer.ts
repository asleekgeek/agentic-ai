/**
 * auto-task-record-writer.ts — Compose + write a task-record ADR draft
 * at session end (G9).
 *
 * The writer pulls together session evidence (commits, memories,
 * changed files), invokes the pure auto-task-record composer, and
 * writes the page to ``<wiki>/adr/<domain>/NNNN-<slug>.md``.
 *
 * Failure is non-fatal — the caller (record-session-end) must
 * continue regardless of the write outcome.
 *
 * Adapters (filesystem, git, store) are injected so tests stay
 * deterministic and production wires real implementations.
 *
 * source: cortex@HEAD~ mcp_server/handlers/auto_task_record_writer.py (2026-05-18)
 */

import {
  buildTaskRecord,
  isSubstantive,
  type SessionCommit,
  type SessionMemory,
  type TaskRecordInputs,
} from "./auto-task-record.js";

// ── Constants ─────────────────────────────────────────────────────────

// Seconds → minutes for the git window heuristic.
// source: SI definition
const SECONDS_PER_MINUTE = 60;
// Extra margin (minutes) added to the session-duration window so any
// commit made during the session lands in the lookback even if the
// duration arg is slightly under-counted.
// source: cortex/mcp_server/handlers/auto_task_record_writer.py — 5-minute margin
const COMMIT_WINDOW_MARGIN_MIN = 5;
// Default lookback when no duration is known.
// source: cortex/mcp_server/handlers/auto_task_record_writer.py — 60 minutes default
const DEFAULT_WINDOW_MIN = 60;
// Cap the memory pool pulled for the session-memory filter.
// source: cortex/mcp_server/handlers/auto_task_record_writer.py — limit=200
const MEMORY_POOL_LIMIT = 200;
// Cap memories embedded in the draft so the LLM doesn't see noise.
// source: cortex/mcp_server/handlers/auto_task_record_writer.py — out[:50]
const MEMORIES_PER_DRAFT = 50;

// ADR filename pattern — ``NNNN-<slug>.md`` (zero-padded id).
// source: cortex/mcp_server/handlers/auto_task_record_writer.py:_ADR_FILENAME_RE
const ADR_FILENAME_RE = /^(\d{4})-/;

// ── Adapter shapes ────────────────────────────────────────────────────

/**
 * List ADR filenames under ``<wiki>/adr/<domain>/``. Returns an empty
 * array when the directory is absent.
 */
export type ListAdrFilenamesFn = (domain: string) => readonly string[];

/**
 * Persist a generated page body to ``<wiki>/<relPath>``. Throws on
 * failure; the caller catches and maps to ``status: "error"``.
 */
export type WritePageFn = (relPath: string, body: string) => Promise<void>;

/**
 * Return commits authored under ``cwd`` in the trailing window.
 * ``windowMinutes`` is the lookback. Implementations typically shell
 * out to ``git log --since=<n> minutes ago``. Returns an empty array
 * when ``cwd`` isn't a git repo or git fails.
 */
export type GitCommitsInWindowFn = (
  cwd: string,
  windowMinutes: number,
) => readonly SessionCommit[];

/**
 * Pull memories captured during this session. Implementations
 * typically fetch the recently-accessed memory pool and filter by
 * ``session:<id>`` tag. Returns at most MEMORIES_PER_DRAFT entries.
 */
export type SessionMemoriesFn = (
  sessionId: string,
  domain: string,
) => Promise<readonly SessionMemory[]>;

// ── Writer entry point ────────────────────────────────────────────────

export interface WriteTaskRecordArgs {
  readonly session_id: string;
  readonly domain: string;
  readonly cwd: string | null;
  readonly duration_seconds: number | null;
  readonly turn_count: number | null;
  readonly tools_used: readonly string[];
  /** ``YYYY-MM-DD`` override for tests; defaults to today UTC. */
  readonly today?: string;
}

export interface WriteTaskRecordDeps {
  readonly listAdrFilenames: ListAdrFilenamesFn;
  readonly writePage: WritePageFn;
  readonly gitCommitsInWindow: GitCommitsInWindowFn;
  readonly sessionMemories: SessionMemoriesFn;
}

export type WriteTaskRecordResult =
  | { readonly status: "skipped"; readonly reason: string; readonly commits?: number; readonly memories?: number; readonly tools?: number }
  | { readonly status: "written"; readonly path: string; readonly adr_number: number; readonly title: string; readonly evidence: { readonly commits: number; readonly memories: number; readonly changed_files: number } }
  | { readonly status: "error"; readonly reason: string };

/**
 * Pick the next free ADR number for ``domain``.
 *
 * Returns 1 when the directory is empty or missing; otherwise
 * ``max(existing NNNN) + 1``.
 *
 * source: cortex/mcp_server/handlers/auto_task_record_writer.py:_next_adr_number
 */
export function nextAdrNumber(
  listAdrFilenames: ListAdrFilenamesFn,
  domain: string,
): number {
  let highest = 0;
  for (const entry of listAdrFilenames(domain)) {
    if (!entry.endsWith(".md")) continue;
    const m = ADR_FILENAME_RE.exec(entry);
    if (!m) continue;
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest + 1;
}

/**
 * Compose and write an ADR draft for this session.
 *
 * Resolves to:
 *   - ``{status: "skipped"}`` — session wasn't substantive, or no domain.
 *   - ``{status: "written", ...}`` — draft saved at ``adr/<domain>/NNNN-<slug>.md``.
 *   - ``{status: "error", ...}`` — non-fatal failure (write threw).
 *
 * source: cortex/mcp_server/handlers/auto_task_record_writer.py:maybe_write_task_record
 */
export async function maybeWriteTaskRecord(
  args: WriteTaskRecordArgs,
  deps: WriteTaskRecordDeps,
): Promise<WriteTaskRecordResult> {
  if (!args.domain) return { status: "skipped", reason: "no_domain" };

  const windowMinutes =
    args.duration_seconds != null
      ? args.duration_seconds / SECONDS_PER_MINUTE + COMMIT_WINDOW_MARGIN_MIN
      : DEFAULT_WINDOW_MIN;
  const commits = deps.gitCommitsInWindow(args.cwd ?? "", windowMinutes);
  const memories = (await deps.sessionMemories(args.session_id, args.domain)).slice(0, MEMORIES_PER_DRAFT);

  // Dedup changed files across commits, preserving first-seen order.
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      if (f && !seen.has(f)) {
        changedFiles.push(f);
        seen.add(f);
      }
    }
  }

  const inputs: TaskRecordInputs = {
    session_id: args.session_id,
    domain: args.domain,
    cwd: args.cwd ?? "",
    duration_seconds: args.duration_seconds,
    turn_count: args.turn_count,
    commits,
    memories,
    changed_files: changedFiles,
    tools_used: args.tools_used,
  };

  if (!isSubstantive(inputs)) {
    return {
      status: "skipped",
      reason: "not_substantive",
      commits: commits.length,
      memories: memories.length,
      tools: args.tools_used.length,
    };
  }

  // Touching ``MEMORY_POOL_LIMIT`` here so it isn't reported unused —
  // sessionMemories implementations typically respect this cap when
  // fetching from the store. Inline reference keeps the constant
  // discoverable from the writer's contract.
  void MEMORY_POOL_LIMIT;

  try {
    const adrNumber = nextAdrNumber(deps.listAdrFilenames, args.domain);
    const record = buildTaskRecord(inputs, {
      adrNumber,
      ...(args.today === undefined ? {} : { today: args.today }),
    });
    await deps.writePage(record.suggested_path, record.body);
    return {
      status: "written",
      path: record.suggested_path,
      adr_number: adrNumber,
      title: record.title,
      evidence: {
        commits: commits.length,
        memories: memories.length,
        changed_files: changedFiles.length,
      },
    };
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: `${name}: ${msg}` };
  }
}
