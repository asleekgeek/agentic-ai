/**
 * LongMemEval dataset loader — port of
 * cortex/benchmarks/longmemeval/run_benchmark.py (the loader + date/heat/content
 * helpers in lines 44-118).
 *
 * The LongMemEval dataset (Wu et al., ICLR 2025) is a JSON array of question
 * items. Each item carries its own haystack of conversation sessions, the gold
 * answer session ids, and per-session dates. The variant "s" (LongMemEval-S,
 * ~40 sessions/question) and "oracle" (evidence sessions only) share the same
 * item schema; both contain 500 questions across 6 categories.
 *
 * This loader mirrors the Python item-decomposition EXACTLY:
 *   - one memory per haystack session (NOT per turn), source = session id
 *   - session content = "[role]: content" lines joined by newline
 *   - created_at = the session date parsed to ISO 8601 (UTC)
 *   - heat = two-phase decay relative to the question date
 *   - gold = the set of answer_session_ids (KU questions flag old+new evidence)
 *
 * source: cortex main benchmarks/longmemeval/run_benchmark.py:44-118, 227-269
 * source: Wu et al. (2025). "LongMemEval: Benchmarking Chat Assistants on
 *   Long-Term Interactive Memory." ICLR 2025.
 */

import { readFileSync, existsSync } from "node:fs";

/** One conversation turn inside a haystack session. */
export interface LongMemEvalTurn {
  readonly role?: string;
  readonly content?: string;
  readonly has_answer?: boolean;
}

/** One question item from the LongMemEval dataset array. */
export interface LongMemEvalItem {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer: string;
  readonly question_date: string;
  readonly haystack_dates: readonly string[];
  readonly haystack_session_ids: readonly string[];
  readonly haystack_sessions: readonly (readonly LongMemEvalTurn[])[];
  readonly answer_session_ids: readonly string[];
}

/** A single haystack session ready to seed as one memory. */
export interface LongMemEvalSession {
  /** Session id from haystack_session_ids — the source string + gold key. */
  readonly session_id: string;
  /** "[role]: content" lines joined by newline. source: run_benchmark.py:65-73 */
  readonly content: string;
  /** User-turn-only content (parity field; not seeded). source: run_benchmark.py:71-73 */
  readonly user_content: string;
  /** ISO 8601 (UTC) session date. source: run_benchmark.py:255 */
  readonly date: string;
  /** Two-phase decayed heat relative to the question date. source: run_benchmark.py:256 */
  readonly heat: number;
}

/** A question plus its decomposed haystack + gold session ids. */
export interface LongMemEvalQuestion {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer: string;
  /** Question date parsed to ISO 8601 (UTC). source: run_benchmark.py:231 */
  readonly question_date: string;
  /** Display category used for the score breakdown. source: run_benchmark.py:237-245 */
  readonly category: string;
  /** Gold answer session ids (KU flags old+new). source: run_benchmark.py:232 */
  readonly answer_session_ids: readonly string[];
  /** Haystack sessions to seed for THIS question. source: run_benchmark.py:251-267 */
  readonly sessions: readonly LongMemEvalSession[];
}

/**
 * Map question_type → baseline-json category key.
 *
 * The Python runner maps to display names ("Single-session (user)") for its
 * printed table; the parity baseline json keys are snake_case. We map directly
 * to the snake_case keys so measured.by_category lines up with baseline keys in
 * report.ts (which matches keys exactly).
 *
 * source: cortex main benchmarks/longmemeval/run_benchmark.py:237-245
 * source: parity-oracle/cortex/baselines/longmemeval.json by_category keys
 */
const CATEGORY_KEY_BY_TYPE: Readonly<Record<string, string>> = {
  "single-session-user": "single_session_user",
  "single-session-assistant": "single_session_assistant",
  "single-session-preference": "single_session_preference",
  "multi-session": "multi_session_reasoning",
  "temporal-reasoning": "temporal_reasoning",
  "knowledge-update": "knowledge_updates",
};

// ── Date parsing ─────────────────────────────────────────────────────────────

// Strip the "(Mon)" weekday token: "2023/04/10 (Mon) 17:50" → "2023/04/10 17:50".
// source: cortex main run_benchmark.py:50 — re.sub(r"\s*\(\w+\)\s*", " ", date_str)
const WEEKDAY_TOKEN_RE = /\s*\(\w+\)\s*/g;

// "YYYY/MM/DD HH:MM" matcher. source: run_benchmark.py:51 — strptime "%Y/%m/%d %H:%M"
const LME_DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/;

/**
 * Parse a LongMemEval date string to an ISO 8601 (UTC) timestamp.
 *
 * Mirrors parse_longmemeval_date: drop the weekday token, parse
 * "YYYY/MM/DD HH:MM" as UTC, and on any failure fall back to "now" (UTC).
 *
 * source: cortex main run_benchmark.py:47-54
 */
export function parseLongMemEvalDate(dateStr: string): string {
  const cleaned = (dateStr ?? "").replace(WEEKDAY_TOKEN_RE, " ").trim();
  const m = LME_DATE_RE.exec(cleaned);
  // Destructure the five capture groups (year/month/day/hour/minute) directly
  // so positional indices are not magic numbers; m is null when no match.
  const [, y, mo, d, h, mi] = m ?? [];
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    h === undefined ||
    mi === undefined
  ) {
    return new Date().toISOString();
  }
  // Date.UTC months are 0-based; the source uses Python strptime (1-based month).
  const ms = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10),
    0,
    0,
  );
  if (Number.isNaN(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

// ── Session → memory content ─────────────────────────────────────────────────

/**
 * Convert a haystack session (list of turns) to (full_content, user_content).
 *
 * Mirrors session_to_memory_content: every turn becomes a "[role]: content"
 * line; user turns are also collected for the user-only view. The default role
 * when absent is "user".
 *
 * source: cortex main run_benchmark.py:60-73
 */
export function sessionToMemoryContent(
  session: readonly LongMemEvalTurn[],
): { full: string; userOnly: string } {
  const parts: string[] = [];
  const userParts: string[] = [];
  for (const turn of session) {
    const role = turn.role ?? "user"; // source: run_benchmark.py:68 default "user"
    const content = turn.content ?? "";
    parts.push(`[${role}]: ${content}`);
    if (role === "user") userParts.push(content);
  }
  return { full: parts.join("\n"), userOnly: userParts.join("\n") };
}

// ── Heat decay ───────────────────────────────────────────────────────────────

// Two-phase decay constants — verbatim from the Python defaults.
// source: cortex main run_benchmark.py:79-81 (fast_factor / fast_hours / slow_factor)
const FAST_FACTOR = 0.995; // source: run_benchmark.py:79
const FAST_HOURS = 168; // source: run_benchmark.py:80 (7 days)
const SLOW_FACTOR = 0.999; // source: run_benchmark.py:81
const HEAT_FALLBACK = 0.5; // source: run_benchmark.py:93 (parse-failure default)
const MS_PER_HOUR = 3_600_000; // source: SI — 1000 ms × 3600 s/hour

/**
 * Two-phase heat decay: fast for the first week, slow tail thereafter.
 *
 * Mirrors compute_heat_with_decay: hours = max(0, query - mem) in hours; for
 * hours ≤ fast_hours return fast_factor**hours, else base × slow_factor**(tail).
 * On any parse failure return 0.5.
 *
 * source: cortex main run_benchmark.py:76-93
 */
export function computeHeatWithDecay(
  dateIso: string,
  queryDateIso: string,
): number {
  const memMs = Date.parse(dateIso);
  const queryMs = Date.parse(queryDateIso);
  if (Number.isNaN(memMs) || Number.isNaN(queryMs)) return HEAT_FALLBACK;
  const hours = Math.max(0, (queryMs - memMs) / MS_PER_HOUR);
  if (hours <= FAST_HOURS) return FAST_FACTOR ** hours;
  const base = FAST_FACTOR ** FAST_HOURS; // source: run_benchmark.py:90
  return base * SLOW_FACTOR ** (hours - FAST_HOURS); // source: run_benchmark.py:91
}

// ── Item → question ──────────────────────────────────────────────────────────

/**
 * Decompose one dataset item into a LongMemEvalQuestion (sessions + gold).
 *
 * Mirrors the per-question loop body of run_benchmark.py:227-267: zip the
 * haystack sessions, ids, and dates; build one memory per session with its
 * decayed heat and parsed date; keep the answer session ids as the gold set.
 *
 * source: cortex main run_benchmark.py:227-267
 */
export function itemToQuestion(item: LongMemEvalItem): LongMemEvalQuestion {
  const questionDate = parseLongMemEvalDate(item.question_date);
  const sessions: LongMemEvalSession[] = [];
  const n = Math.min(
    item.haystack_sessions.length,
    item.haystack_session_ids.length,
    item.haystack_dates.length,
  );
  for (let i = 0; i < n; i++) {
    const turns = item.haystack_sessions[i] ?? [];
    const sid = item.haystack_session_ids[i] ?? "";
    const dateStr = item.haystack_dates[i] ?? "";
    const { full, userOnly } = sessionToMemoryContent(turns);
    const dateIso = parseLongMemEvalDate(dateStr);
    sessions.push({
      session_id: sid,
      content: full,
      user_content: userOnly,
      date: dateIso,
      heat: computeHeatWithDecay(dateIso, questionDate),
    });
  }
  const category =
    CATEGORY_KEY_BY_TYPE[item.question_type] ?? item.question_type;
  return {
    question_id: item.question_id,
    question_type: item.question_type,
    question: item.question,
    answer: item.answer,
    question_date: questionDate,
    category,
    answer_session_ids: item.answer_session_ids,
    sessions,
  };
}

// ── Dataset discovery + load ─────────────────────────────────────────────────

/**
 * Locate a LongMemEval dataset file on disk for the given variant.
 *
 * Searches in order:
 *   1. CORTEX_LONGMEMEVAL_PATH env var (explicit override)
 *   2. the sibling Cortex repo's benchmarks/longmemeval/longmemeval_<variant>.json
 *
 * Returns null when not found; the caller decides whether to skip or fail.
 *
 * source: monorepo convention — sibling-repo path discovery (locomo-loader.ts)
 * source: cortex main run_benchmark.py:508-512 (longmemeval_{oracle,s}.json names)
 */
export function findLongMemEvalDataset(
  variant: "s" | "oracle" = "s",
): string | null {
  const explicit = process.env["CORTEX_LONGMEMEVAL_PATH"];
  if (explicit && existsSync(explicit)) return explicit;
  const file = `longmemeval_${variant}.json`;
  const candidates = [
    `/Users/cdeust/Developments/anthropic-partnership/Cortex/benchmarks/longmemeval/${file}`,
    `/Users/cdeust/Developments/cortex/benchmarks/longmemeval/${file}`,
    `../cortex/benchmarks/longmemeval/${file}`,
    `../../cortex/benchmarks/longmemeval/${file}`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Load a LongMemEval dataset file and decompose every item.
 *
 * precondition: path points to a readable JSON array matching the LongMemEval
 *   item schema (the variant "s" file is ~278 MB; the whole file is parsed at
 *   once, exactly as the Python json.load does).
 * postcondition: returns one LongMemEvalQuestion per array entry, in order.
 *
 * source: cortex main run_benchmark.py:171-175 (json.load + optional limit)
 */
export function loadLongMemEval(path: string): LongMemEvalQuestion[] {
  const raw = readFileSync(path, "utf8");
  const items = JSON.parse(raw) as LongMemEvalItem[];
  return items.map(itemToQuestion);
}
