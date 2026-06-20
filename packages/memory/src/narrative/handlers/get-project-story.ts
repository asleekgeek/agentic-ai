/**
 * Handler: get_project_story — period-based autobiographical narrative.
 *
 * Distinct from the `narrative` handler (generic project summary, no time
 * buckets). get_project_story produces a time-bounded, chronological story of
 * what happened in a project, structured as chapters bucketed by time period
 * (day / week / month / all).
 *
 * Direct port of mcp_server/handlers/get_project_story.py — every helper below
 * mirrors a named Python helper (cited at its definition). The Python handler
 * is async (awaits the store); this port is sync because the injected
 * MemoryPort methods are sync-signature (async-bridged inside the PG adapter),
 * matching the existing wiring in tools/narrative.ts.
 *
 * source: cortex@ed33435 mcp_server/handlers/get_project_story.py:99-264
 * Layer: narrative/handlers — application layer
 */

import type { MemoryPort } from "./narrative.js";
import type { MemoryRecord } from "../types.js";

// ── Response shape ──────────────────────────────────────────────────────────
// source: cortex@ed33435 get_project_story.py:151-161 (entry), :208-215 (chapter),
//         :259-264 (response).

export interface ChapterEntry {
  memory_id: number;
  headline: string;
  importance: number;
  heat: number;
  is_decision: boolean;
  tags: string[];
}

export interface StoryChapter {
  label: string;
  bucket_key: string;
  memory_count: number;
  entries: ChapterEntry[];
  decision_count: number;
  highlight: string;
}

export interface GetProjectStoryResponse {
  period: string;
  chapters: StoryChapter[];
  total_memories: number;
  story: string;
}

// ── Named constants ─────────────────────────────────────────────────────────

// source: get_project_story.py:102-106 — day/week/month cutoff spans
const DAY_MS = 86_400_000; // 24 * 60 * 60 * 1000
const DAY_DAYS = 1;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
// source: get_project_story.py:108 — "all" sentinel = datetime(2000, 1, 1, UTC)
const ALL_CUTOFF_YEAR = 2000;
const ALL_CUTOFF_MS = Date.UTC(ALL_CUTOFF_YEAR, 0, 1);

// source: get_project_story.py:181-184 — fetch scoping heat/limit
const DIR_DOMAIN_MIN_HEAT = 0.0;
const HOT_MIN_HEAT = 0.05; // source: get_project_story.py — get_hot_memories min_heat=0.05
const FETCH_LIMIT = 500; // source: get_project_story.py — get_memories_for_domain/get_hot_memories limit=500

// source: get_project_story.py:139,142 — headline extraction bounds
const HEADLINE_MATCH_MIN = 10;
const HEADLINE_MATCH_MAX = 100; // source: get_project_story.py:139 — headline regex {10,100}
const HEADLINE_MAX = 80;

// source: get_project_story.py:157-158 — round importance/heat to 3 dp (10^3)
const ROUND_FACTOR = 1000;

// source: get_project_story.py:206 — at most 10 entries per chapter
const MAX_ENTRIES_PER_CHAPTER = 10;

// source: get_project_story.py — max_chapters default = 5
const DEFAULT_MAX_CHAPTERS = 5;

// source: get_project_story.py:123-133 — bucket key uses a 4-digit year
const BUCKET_YEAR_PAD = 4;

// source: get_project_story.py:222-223 — story uses first 3 entries, 2 headlines
const STORY_ENTRIES = 3;
const STORY_HEADLINES = 2;

// source: get_project_story.py:157-158 default importance/heat
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_HEAT = 0.0;

const VALID_PERIODS = new Set(["day", "week", "month", "all"]);

// ── Helpers (pure) ──────────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp, treating naive (timezone-less) strings as UTC to
 * match Python datetime.fromisoformat + tzinfo=UTC coercion.
 *
 * SQLite stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" (space-separated,
 * naive); the remember path stores `new Date().toISOString()` ("...Z").
 * JS `new Date()` parses a naive space/T string as LOCAL time, which diverges
 * from Cortex's UTC assumption — so naive strings are normalized to UTC here.
 *
 * source: get_project_story.py:87-96 (_parse_dt — naive coerced to UTC)
 */
function parseDt(iso: string): Date | null {
  if (!iso) {
    return null;
  }
  let normalized = iso.includes("T") ? iso : iso.replace(" ", "T");
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized);
  if (!hasZone) {
    normalized = `${normalized}Z`;
  }
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Epoch-ms cutoff for the period window.
 * source: get_project_story.py:99-108 (_period_cutoff)
 */
function periodCutoffMs(period: string, now: number = Date.now()): number {
  if (period === "day") {
    return now - DAY_DAYS * DAY_MS;
  }
  if (period === "week") {
    return now - WEEK_DAYS * DAY_MS;
  }
  if (period === "month") {
    return now - MONTH_DAYS * DAY_MS;
  }
  return ALL_CUTOFF_MS;
}

/**
 * Human-readable bucket label (UTC).
 * source: get_project_story.py:111-120 (_bucket_label — %H:00 / %A %b %d /
 *         "Week of %b %d" / %B %Y).
 */
function bucketLabel(dt: Date, period: string): string {
  if (period === "day") {
    return `${String(dt.getUTCHours()).padStart(2, "0")}:00`;
  }
  if (period === "week") {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    }).format(dt);
  }
  if (period === "month") {
    const md = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    }).format(dt);
    return `Week of ${md}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(dt);
}

/**
 * ISO-8601 week number (Thursday-based), matching Python date.isocalendar().
 * source: get_project_story.py:130-131 (dt.isocalendar() → year, week)
 */
function isoWeekYear(dt: Date): { year: number; week: number } {
  // Work on a UTC copy at midnight to avoid sub-day drift.
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const DAYS_PER_WEEK = 7;
  const THURSDAY = 4;
  // ISO weekday: Monday=1 .. Sunday=7.
  const isoDay = d.getUTCDay() === 0 ? DAYS_PER_WEEK : d.getUTCDay();
  // Shift to the Thursday of this ISO week; its calendar year is the ISO year.
  d.setUTCDate(d.getUTCDate() + THURSDAY - isoDay);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / DAYS_PER_WEEK);
  return { year: isoYear, week };
}

/**
 * Lexicographically sortable bucket key (UTC).
 * source: get_project_story.py:123-133 (_bucket_key — %Y%m%d%H / %Y%m%d /
 *         f"{year}{week:02d}" / %Y%m).
 */
function bucketKey(dt: Date, period: string): string {
  const y = String(dt.getUTCFullYear()).padStart(BUCKET_YEAR_PAD, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const h = String(dt.getUTCHours()).padStart(2, "0");
  if (period === "day") {
    return `${y}${m}${d}${h}`;
  }
  if (period === "week") {
    return `${y}${m}${d}`;
  }
  if (period === "month") {
    const { year, week } = isoWeekYear(dt);
    return `${year}${String(week).padStart(2, "0")}`;
  }
  return `${y}${m}`;
}

/**
 * Extract a short headline from memory content.
 * source: get_project_story.py:136-142 (_extract_headline)
 */
function extractHeadline(text: string): string {
  const trimmed = text.trim();
  const re = new RegExp(`^([^.!?\\n]{${HEADLINE_MATCH_MIN},${HEADLINE_MATCH_MAX}})[.!?\\n]`);
  const match = re.exec(trimmed);
  const captured = match?.[1];
  if (captured !== undefined) {
    return captured.trim();
  }
  return trimmed.slice(0, HEADLINE_MAX).trim();
}

// source: get_project_story.py:145-148 (_DECISION_RE)
const DECISION_RE =
  /\b(decided|chose|switched|migrated|using|adopted|replaced|fixed|resolved|deployed)\b/i;

function round3(x: number): number {
  return Math.round(x * ROUND_FACTOR) / ROUND_FACTOR;
}

/**
 * Memory bucketed with its parsed datetime (internal to bucketing/sorting).
 */
interface DatedMemory extends MemoryRecord {
  _dt: Date;
}

/**
 * source: get_project_story.py:151-161 (_memory_to_chapter_entry)
 */
function memoryToChapterEntry(mem: MemoryRecord): ChapterEntry {
  const content = mem.content;
  return {
    memory_id: mem.id,
    headline: extractHeadline(content),
    importance: round3(mem.importance ?? DEFAULT_IMPORTANCE),
    heat: round3(mem.heat ?? DEFAULT_HEAT),
    is_decision: DECISION_RE.test(content),
    tags: Array.isArray(mem.tags) ? mem.tags : [],
  };
}

/**
 * source: get_project_story.py:202-215 (_build_chapter)
 */
function buildChapter(key: string, mems: DatedMemory[], period: string): StoryChapter {
  const memsSorted = [...mems].sort(
    (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
  );
  // Precondition (mirrors Cortex _build_chapter): a bucket is only created when
  // a memory is pushed into it, so memsSorted is non-empty here.
  const first = memsSorted[0];
  const label = first ? bucketLabel(first._dt, period) : "";
  const entries = memsSorted.slice(0, MAX_ENTRIES_PER_CHAPTER).map(memoryToChapterEntry);
  const decisions = entries.filter((e) => e.is_decision);
  const head = entries[0];
  return {
    label,
    bucket_key: key,
    memory_count: mems.length,
    entries,
    decision_count: decisions.length,
    highlight: head ? head.headline : "",
  };
}

/**
 * source: get_project_story.py:218-224 (_build_story)
 */
function buildStory(chapters: StoryChapter[]): string {
  const sentences = chapters.map((ch) => {
    const headlines = ch.entries.slice(0, STORY_ENTRIES).map((e) => e.headline);
    return `${ch.label}: ${headlines.slice(0, STORY_HEADLINES).join("; ")}.`;
  });
  return sentences.join(" ");
}

/**
 * source: get_project_story.py:164-171 (_empty_story)
 */
function emptyStory(period: string, message: string): GetProjectStoryResponse {
  return { period, chapters: [], total_memories: 0, story: message };
}

/**
 * source: get_project_story.py:174-184 (_fetch_memories)
 */
function fetchMemories(
  store: MemoryPort,
  directory: string,
  domain: string,
): MemoryRecord[] {
  if (directory) {
    return store.getMemoriesForDirectory(directory, DIR_DOMAIN_MIN_HEAT);
  }
  if (domain) {
    return store.getMemoriesForDomain(domain, DIR_DOMAIN_MIN_HEAT, FETCH_LIMIT);
  }
  return store.getHotMemories(HOT_MIN_HEAT, FETCH_LIMIT);
}

/**
 * source: get_project_story.py:187-199 (_filter_by_period) — reads created_at,
 * which the narrative adapters surface as MemoryRecord.timestamp.
 */
function filterByPeriod(memories: MemoryRecord[], period: string): DatedMemory[] {
  const cutoff = periodCutoffMs(period);
  const filtered: DatedMemory[] = [];
  for (const mem of memories) {
    const dt = parseDt(mem.timestamp);
    if (dt && dt.getTime() >= cutoff) {
      filtered.push({ ...mem, _dt: dt });
    }
  }
  return filtered;
}

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * Generate a period-based autobiographical narrative from memory.
 *
 * precondition:  store is a valid MemoryPort.
 * postcondition: returns a GetProjectStoryResponse whose chapters are bucketed
 *                chronologically within the period window (≤ max_chapters most
 *                recent buckets).
 *
 * source: cortex@ed33435 get_project_story.py:230-264 (handler)
 */
export function getProjectStoryHandler(
  store: MemoryPort,
  args: { directory?: string; domain?: string; period?: string; max_chapters?: number },
): GetProjectStoryResponse {
  const directory = args.directory ?? "";
  const domain = args.domain ?? "";
  let period = args.period ?? "week";
  const maxChapters = Math.trunc(Number(args.max_chapters ?? DEFAULT_MAX_CHAPTERS));

  if (!VALID_PERIODS.has(period)) {
    period = "week";
  }

  const memories = fetchMemories(store, directory, domain);
  if (memories.length === 0) {
    return emptyStory(period, "No memories found for this period.");
  }

  const filtered = filterByPeriod(memories, period);
  if (filtered.length === 0) {
    return emptyStory(period, `No memories found within the last ${period}.`);
  }

  // Bucket into chapters.
  const buckets = new Map<string, DatedMemory[]>();
  for (const mem of filtered) {
    const key = bucketKey(mem._dt, period);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(mem);
    } else {
      buckets.set(key, [mem]);
    }
  }

  // source: get_project_story.py:256 — sorted(keys)[-max_chapters:]
  const sortedKeys = [...buckets.keys()].sort().slice(-maxChapters);
  const chapters = sortedKeys.map((key) => buildChapter(key, buckets.get(key) ?? [], period));

  return {
    period,
    chapters,
    total_memories: filtered.length,
    story: buildStory(chapters),
  };
}
