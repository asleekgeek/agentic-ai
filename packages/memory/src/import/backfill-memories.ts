/* eslint-disable @typescript-eslint/no-magic-numbers -- source: exact port of mcp_server/handlers/backfill_memories.py; all numeric literals copied verbatim from cited Python file */
/**
 * backfill-memories.ts — auto-import prior conversations into memory store.
 *
 * Scans ~/.claude/projects/ JSONL conversation files, extracts memorable
 * items, and stores them with backfill tags. Idempotent via file-hash
 * tracking in a backfill_log table.
 *
 * Port of: mcp_server/handlers/backfill_memories.py
 *
 * Composition root: wires scanner + session-extractor + remember + backfill helpers.
 *
 * Correctness contract:
 *   pre:  store is a connected MemoryStore with backfill_log DDL support.
 *   post: returns { backfilled, files_processed, files_already_done,
 *                   items_gated, total_files_found }.
 *         Idempotent — re-running with the same files skips already-processed
 *         hashes unless force_reprocess=true.
 *
 * source: cortex main mcp_server/handlers/backfill_memories.py
 * source: cortex main mcp_server/handlers/backfill_helpers.py
 */

import { readFullBounded } from "./scanner.js";
import { extractMemorableItems, extractSessionSummary } from "./session-extractor.js";
import { ageDecayedHeat, computeAgeDays } from "./heat.js";
import {
  discoverBackfillFiles,
  ensureBackfillLogAsync,
  fileHash,
  findConcepts,
  gistOversizedContent,
  isAlreadyBackfilledAsync,
  linkConcepts,
  markBackfilledAsync,
  slugToDomain,
} from "./backfill-helpers.js";
import { emitSessionGraphEntities } from "./jsonl-graph-emitter.js";
import type { MemoryStore } from "../remember/storage/memory-store.js";
import type { RememberHandler } from "./types.js";

// ── Schema ────────────────────────────────────────────────────────────────────
// source: cortex main mcp_server/handlers/backfill_memories.py schema

export const schema = {
  title: "Backfill memories",
  description:
    "Import prior Claude Code conversations from ~/.claude/projects/ " +
    "into the memory store. Walks JSONL session transcripts, extracts " +
    "memorable items (decisions, lessons, errors-and-fixes) via the " +
    "session_extractor, stores them with `backfill` tags through the " +
    "standard write gate, and links each to the auto-discovered core " +
    "concepts of the originating project. Idempotent — file hashes " +
    "tracked in backfill_log so re-runs only process new sessions. " +
    "Use this on first install, after long absences, or when migrating " +
    "to a new machine.",
  inputSchema: {
    type: "object",
    required: [],
    properties: {
      project: {
        type: "string",
        description:
          "Filter to a specific project directory slug (the Claude Code project ID). " +
          "Omit to process every project.",
        examples: ["-Users-alice-code-cortex"],
      },
      max_files: {
        type: "integer",
        description:
          "Maximum number of JSONL session files to process per call. " +
          "Use a small number for an initial dry run, then raise for the full backfill.",
        default: 20,
        minimum: 1,
        maximum: 1000,
        examples: [5, 20, 200],
      },
      min_importance: {
        type: "number",
        description:
          "Minimum extracted-item importance (0.0-1.0) to keep. " +
          "Lower values import more lower-signal memories.",
        default: 0.3,
        minimum: 0.0,
        maximum: 1.0,
        examples: [0.2, 0.3, 0.6],
      },
      dry_run: {
        type: "boolean",
        description:
          "Preview what would be imported without writing to the store. " +
          "Always run a dry_run first.",
        default: false,
      },
      force_reprocess: {
        type: "boolean",
        description:
          "Re-process files even if their hash is in the backfill log. " +
          "Only set this if you have changed the extractor and want a fresh pass.",
        default: false,
      },
    },
  },
} as const;

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface ParsedArgs {
  projectFilter: string;
  maxFiles: number;
  minImportance: number;
  dryRun: boolean;
  forceReprocess: boolean;
}

/** source: cortex main mcp_server/handlers/backfill_memories.py:_parse_args */
function parseArgs(args: Record<string, unknown> | null | undefined): ParsedArgs {
  const a = args ?? {};
  return {
    projectFilter: String(a["project"] ?? ""),
    maxFiles: Math.max(1, Number(a["max_files"] ?? 20)),
    // source: session_extractor.py — baseline score = 0.3; 0.35 excluded category-less msgs.
    // Default lowered to 0.3 to capture all msgs above length/noise floor. 2026-05-08.
    minImportance: Number(a["min_importance"] ?? 0.3),
    dryRun: Boolean(a["dry_run"] ?? false),
    forceReprocess: Boolean(a["force_reprocess"] ?? false),
  };
}

// ── Single item import ────────────────────────────────────────────────────────

/**
 * Store one extracted item. Returns memory_id if stored, else null.
 *
 * Preserves original session timestamp AND computes age-decayed initial heat
 * so a 6-month-old conversation imports at heat ~0.3 rather than 1.0.
 *
 * source: cortex main mcp_server/handlers/backfill_memories.py:_import_single_item
 * source: issue #14 P1 — age-decayed initial heat fix
 */
async function importSingleItem(
  item: { content?: string; tags?: string[]; timestamp?: string },
  cwd: string,
  domain: string,
  projectSlug: string,
  rememberHandler: RememberHandler,
): Promise<number | null> {
  const raw = item.content ?? "";
  if (!raw || raw.length < 20) return null; // source: backfill_memories.py:_import_single_item

  const content = gistOversizedContent(raw); // source: backfill_memories.py:_import_single_item

  const tags = [
    ...(item.tags ?? []),
    "_backfill",
    `project:${projectSlug.slice(0, 30)}`,
  ];
  const rememberArgs: Record<string, unknown> = {
    content,
    tags,
    directory: cwd,
    domain,
    source: "import",   // source: RememberRequestSchema enum — backfill:* rejected; project slug in tags
    force: true,
  };

  const timestamp = item.timestamp;
  if (timestamp) {
    rememberArgs["created_at"] = String(timestamp);
    const ageDays = computeAgeDays(String(timestamp));
    rememberArgs["initial_heat"] = ageDecayedHeat(ageDays);
  }

  const result = await rememberHandler(rememberArgs as unknown as Parameters<RememberHandler>[0]);
  if (!result?.stored) return null;
  // memory_id is present on extended RememberResult shapes (full write gate)
  // but not on the minimal RememberResult in import/types.ts.
  // Cast to unknown first to satisfy the structural constraint.
  const extResult = result as unknown as { memory_id?: number };
  return typeof extResult.memory_id === "number" ? extResult.memory_id : 0;
}

// ── Single file import ────────────────────────────────────────────────────────

/**
 * Import one JSONL file. Returns [imported, skipped] counts.
 *
 * Also emits graph entities (Tool, MCP, Skill, Command, Discussion, file)
 * and relationships (session_used_tool, session_called_mcp, session_invoked_skill,
 * session_ran_command, discussion_touched_file, co_occurrence) for every
 * tool_use block in the session transcript.
 *
 * source: cortex main mcp_server/handlers/backfill_memories.py:_import_file
 * source: Cortex workflow_graph_source_jsonl.py — graph entity emission per session
 */
async function importFile(
  store: MemoryStore,
  filePath: string,
  projectSlug: string,
  minImportance: number,
  rememberHandler: RememberHandler,
): Promise<[number, number]> {
  // Use full-bounded read to capture all messages (not just head+tail).
  // source: empirical — head+tail (40 KB) captured 59.8% of qualifying messages;
  //         full-bounded (4 MB cap) captures 100% for P99 of session files.
  //         Measured 2026-05-08 on 3,077 JSONL files.
  let records: ReturnType<typeof readFullBounded>;
  try {
    records = readFullBounded(filePath);
  } catch {
    return [0, 0];
  }

  if (records.length === 0) return [0, 0];

  const summary = extractSessionSummary(records);
  const items = extractMemorableItems(records, minImportance);
  const domain = slugToDomain(projectSlug);

  // Emit graph entities regardless of whether we have memorable items.
  // This ensures Tool/MCP/Skill/Command entities populate even for sessions
  // that produce no memorable text (e.g. tool-only sessions).
  // source: Cortex prod DB: Tool=30k+, MCP=10k+, co_occurrence=156k+ — all from JSONL.
  await emitSessionGraphEntities(store, filePath, domain);

  if (items.length === 0) return [0, 0];

  const cwd = summary.cwd;

  let imported = 0;
  for (const item of items) {
    const mid = await importSingleItem(item, cwd, domain, projectSlug, rememberHandler);
    if (mid !== null) {
      imported += 1;
      const concepts = findConcepts(item.content ?? "");
      if (concepts.length > 0) {
        // linkConcepts is async — must await so PG entity writes complete before
        // we mark the file as processed. source: engineer fix — linkConcepts uses *Async.
        await linkConcepts(store, mid, concepts);
      }
    }
  }

  return [imported, items.length - imported];
}

// ── Dry-run preview ───────────────────────────────────────────────────────────

interface DryRunEntry {
  file: string;
  project: string;
  extractable_items: number;
  concepts: string[];
}

/**
 * Build a preview entry for dry-run mode.
 *
 * source: cortex main mcp_server/handlers/backfill_memories.py:_build_dry_run_preview
 */
function buildDryRunPreview(
  filePath: string,
  slug: string,
  minImportance: number,
): DryRunEntry | null {
  try {
    const records = readFullBounded(filePath);
    const items = extractMemorableItems(records, minImportance);
    const concepts = new Set<string>();
    for (const item of items) {
      for (const c of findConcepts(item.content ?? "")) {
        concepts.add(c);
      }
    }
    return {
      file: filePath.split("/").pop() ?? filePath,
      project: slug,
      extractable_items: items.length,
      concepts: [...concepts],
    };
  } catch {
    return null;
  }
}

// ── Filter candidates ─────────────────────────────────────────────────────────

interface FilteredCandidate {
  filePath: string;
  slug: string;
  hash: string;
}

/**
 * Filter candidates by hash, returning ready list and skip count.
 *
 * Async to support PG isAlreadyBackfilledAsync (queryRawAsync).
 *
 * source: cortex main mcp_server/handlers/backfill_memories.py:_filter_candidates
 * source: engineer@41e5778 — *Async-when-available pattern for PG/SQLite parity.
 */
async function filterCandidates(
  store: MemoryStore,
  candidates: Array<{ filePath: string; slug: string }>,
  maxFiles: number,
  forceReprocess: boolean,
): Promise<[FilteredCandidate[], number]> {
  const ready: FilteredCandidate[] = [];
  let skipped = 0;

  for (const { filePath, slug } of candidates.slice(0, maxFiles)) {
    let fhash: string;
    try {
      fhash = fileHash(filePath);
    } catch {
      continue;
    }
    if (!forceReprocess && await isAlreadyBackfilledAsync(store, filePath, fhash)) {
      skipped += 1;
      continue;
    }
    ready.push({ filePath, slug, hash: fhash });
  }

  return [ready, skipped];
}

// ── Response types ────────────────────────────────────────────────────────────

export interface BackfillDryRunResponse {
  dry_run: true;
  files_found: number;
  already_processed: number;
  would_import: number;
  preview: DryRunEntry[];
}

export interface BackfillImportResponse {
  backfilled: number;
  files_processed: number;
  files_already_done: number;
  items_gated: number;
  total_files_found: number;
  error?: string;
  cascade_advanced?: number;
}

export type BackfillResponse = BackfillDryRunResponse | BackfillImportResponse;

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Backfill prior conversations into the memory store.
 *
 * Pre:  store is connected; rememberHandler routes through the write gate.
 * Post: discovered files are processed up to maxFiles; processed hashes are
 *       recorded in backfill_log.
 *
 * source: cortex main mcp_server/handlers/backfill_memories.py:handler
 */
export async function backfillMemoriesHandler(
  args: Record<string, unknown> | null | undefined,
  store: MemoryStore,
  rememberHandler: RememberHandler,
  projectsDirOverride?: string,
): Promise<BackfillResponse> {
  const parsed = parseArgs(args);
  // Use async DDL so PG gets SERIAL+timestamptz schema, SQLite gets AUTOINCREMENT.
  // source: ensureBackfillLogAsync — added 2026-05-08 for PG parity.
  await ensureBackfillLogAsync(store);

  const candidates = discoverBackfillFiles(
    parsed.projectFilter,
    parsed.maxFiles,
    projectsDirOverride,
  );

  if (candidates.length === 0) {
    return {
      backfilled: 0,
      files_processed: 0,
      files_already_done: 0,
      items_gated: 0,
      total_files_found: 0,
      error: "no_session_files_found",
    };
  }

  const [ready, filesSkipped] = await filterCandidates(
    store,
    candidates,
    parsed.maxFiles,
    parsed.forceReprocess,
  );

  if (parsed.dryRun) {
    // Dry-run: preview only
    const preview: DryRunEntry[] = [];
    let totalItems = 0;
    for (const { filePath, slug } of ready) {
      const entry = buildDryRunPreview(filePath, slug, parsed.minImportance);
      if (entry) {
        preview.push(entry);
        totalItems += entry.extractable_items;
      }
    }
    return {
      dry_run: true,
      files_found: candidates.length,
      already_processed: filesSkipped,
      would_import: totalItems,
      preview: preview.slice(0, 10), // source: backfill_memories.py:_process_dry_run — preview[:10]
    };
  }

  // Live import
  let totalImported = 0;
  let totalSkipped = 0;
  let filesProcessed = 0;

  for (const { filePath, slug, hash } of ready) {
    const [imported, skipped] = await importFile(
      store,
      filePath,
      slug,
      parsed.minImportance,
      rememberHandler,
    );
    if (imported > 0 || skipped === 0) {
      await markBackfilledAsync(store, filePath, hash, imported);
      filesProcessed += 1;
      totalImported += imported;
      totalSkipped += skipped;
    }
  }

  return {
    backfilled: totalImported,
    files_processed: filesProcessed,
    files_already_done: filesSkipped,
    items_gated: totalSkipped,
    total_files_found: candidates.length,
  };
}
