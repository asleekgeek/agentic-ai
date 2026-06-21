/**
 * Temporal scoring: date parsing, proximity, distance decay, recency boost.
 *
 * Recency formula: boost = 0.15 * exp(-days/30), cutoff 90 days.
 * Date distance uses exponential decay (closer dates score higher).
 *
 * Pure business logic — no I/O.
 *
 * Port of: cortex main mcp_server/core/temporal.py
 */

// ── Month name lookup ─────────────────────────────────────────────────────
// source: cortex main mcp_server/core/temporal.py:15-28

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// ── Numeric constants ─────────────────────────────────────────────────────

// Minimum word-part length for partial proximity matching.
// source: parity with mcp_server/core/temporal.py:85
const MIN_WORD_PART_LENGTH = 3;

// Partial match score (hint parts found but not exact match).
// source: parity with mcp_server/core/temporal.py:86
const PARTIAL_PROXIMITY_SCORE = 0.5;

// Minimum length of a string containing "T" to be treated as ISO with time.
// source: parity with mcp_server/core/temporal.py:155
const ISO_WITH_TIME_MIN_LENGTH = 19;

// Default exponential-decay scale (days) for date distance scoring.
// source: parity with mcp_server/core/temporal.py:173
const DATE_DISTANCE_SCALE_DAYS = 14.0;

// Milliseconds per day (86 400 s × 1 000 ms/s); TS equivalent of Python's 86400.0 s.
// source: parity with mcp_server/core/temporal.py:190
const MS_PER_DAY = 86400000;

// Maximum recency boost amplitude.
// source: parity with mcp_server/core/temporal.py:199
const RECENCY_BOOST_MAX = 0.15;

// Recency boost half-life in days.
// source: parity with mcp_server/core/temporal.py:200
const RECENCY_HALFLIFE_DAYS = 30.0;

// Recency boost cutoff — no boost beyond this age in days.
// source: parity with mcp_server/core/temporal.py:201
const RECENCY_CUTOFF_DAYS = 90.0;

// Radix for parseInt — always decimal (base 10) when parsing date components.
// source: parity with mcp_server/core/temporal.py:109
const DECIMAL_RADIX = 10;

// Regex capture-group index for the third capture group in date patterns.
// source: parity with mcp_server/core/temporal.py:109
const CAPTURE_GROUP_3 = 3;

// ── Regex constants ───────────────────────────────────────────────────────
// source: cortex main mcp_server/core/temporal.py:30-52

const TEMPORAL_QUERY_RE = /\b(when|date|time|ago|before|after|during|january|february|march|april|may|june|july|august|september|october|november|december|yesterday|today|last|recent|week|month|year|\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})\b/gi;

const DATE_PATTERNS = [
  /(\d{4}-\d{2}-\d{2})/,
  /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  /\[Date:\s*([^\]]+)\]/,
];

const DD_MONTH_YYYY_RE = /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i;
const MONTH_DD_YYYY_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i;
const EMBEDDED_ISO_RE = /(\d{4})-(\d{2})-(\d{2})/;

// ── Temporal query detection ──────────────────────────────────────────────

/**
 * Detect temporal intent in a query.
 *
 * postcondition: returns true iff at least one temporal keyword/pattern is found.
 * source: cortex main mcp_server/core/temporal.py:55-57
 */
export function isTemporalQuery(query: string): boolean {
  const matches = query.match(TEMPORAL_QUERY_RE);
  return (matches?.length ?? 0) >= 1;
}

// ── Date hint extraction ──────────────────────────────────────────────────

/**
 * Extract date/month mentions from text.
 *
 * postcondition: returned array contains unique date mentions found in text.
 * source: cortex main mcp_server/core/temporal.py:60-69
 */
export function extractDateHints(text: string): string[] {
  const hints = new Set<string>();
  for (const pattern of DATE_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const m of text.matchAll(globalPattern)) {
      hints.add(m[0].trim());
    }
  }
  for (const month of Object.keys(MONTH_NAMES)) {
    if (text.toLowerCase().includes(month)) hints.add(month);
  }
  return Array.from(hints);
}

// ── Temporal proximity scoring ────────────────────────────────────────────

/**
 * Score document by date-hint overlap. 1.0=exact, 0.5=partial, 0.0=none.
 *
 * precondition:  dateHints is an array of strings.
 * postcondition: result ∈ [0, 1].
 * source: cortex main mcp_server/core/temporal.py:72-87
 */
export function computeTemporalProximity(
  docText: string,
  dateHints: string[],
): number {
  if (dateHints.length === 0) return 0.0;
  const docLower = docText.toLowerCase();
  let score = 0.0;
  for (const hint of dateHints) {
    const hintLower = hint.toLowerCase();
    if (docLower.includes(hintLower)) {
      score = Math.max(score, 1.0);
    } else {
      const parts = hintLower.split(/\s+/).filter((p) => p.length > MIN_WORD_PART_LENGTH);
      if (parts.some((p) => docLower.includes(p))) {
        score = Math.max(score, PARTIAL_PROXIMITY_SCORE);
      }
    }
  }
  return score;
}

// ── Date parsing ──────────────────────────────────────────────────────────

/**
 * Try DD Month YYYY and Month DD, YYYY formats.
 * Returns a Date or null.
 *
 * source: cortex main mcp_server/core/temporal.py:103-127
 */
function tryParseNamedDate(dateStr: string): Date | null {
  // Each regex's captures are required by its anchor pattern, so a match
  // implies all groups are present. The `?? ""` / `?? "0"` fallbacks satisfy
  // strict `noUncheckedIndexedAccess` without changing observable behavior:
  // an unparseable input fails the isNaN() guard and returns null below.
  let m = dateStr.match(DD_MONTH_YYYY_RE);
  if (m) {
    const monthNum = MONTH_NAMES[(m[2] ?? "").toLowerCase()];
    if (monthNum) {
      const d = new Date(parseInt(m[CAPTURE_GROUP_3] ?? "0", DECIMAL_RADIX), monthNum - 1, parseInt(m[1] ?? "0", DECIMAL_RADIX));
      if (!isNaN(d.getTime())) return d;
    }
  }
  m = dateStr.match(MONTH_DD_YYYY_RE);
  if (m) {
    const monthNum = MONTH_NAMES[(m[1] ?? "").toLowerCase()];
    if (monthNum) {
      const d = new Date(parseInt(m[CAPTURE_GROUP_3] ?? "0", DECIMAL_RADIX), monthNum - 1, parseInt(m[2] ?? "0", DECIMAL_RADIX));
      if (!isNaN(d.getTime())) return d;
    }
  }
  const em = dateStr.match(EMBEDDED_ISO_RE);
  if (em) {
    const d = new Date(parseInt(em[1] ?? "0", DECIMAL_RADIX), parseInt(em[2] ?? "0", DECIMAL_RADIX) - 1, parseInt(em[CAPTURE_GROUP_3] ?? "0", DECIMAL_RADIX));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Parse date from ISO 8601, named month formats, or embedded ISO.
 *
 * precondition:  dateStr is a non-empty string.
 * postcondition: returns a Date object or null if unparseable.
 * source: cortex main mcp_server/core/temporal.py:130-139
 */
export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const s = dateStr.trim();
  // Try ISO 8601 (date-only portion). split("T")[0] is always defined (split on
  // any non-empty string yields a non-empty array) but TS's noUncheckedIndexedAccess
  // narrows it to string|undefined; fall back to the original string.
  const isoDate = s.replace("Z", "+00:00").split("T")[0] ?? s;
  const isoAttempt = new Date(isoDate);
  if (!isNaN(isoAttempt.getTime())) return isoAttempt;
  return tryParseNamedDate(s);
}

/**
 * Normalize a free-form date string to ISO 8601 for storage.
 *
 * Handles formats like '8 May 2023', 'May 8, 2023', ISO strings.
 *
 * postcondition: returns ISO string or null if unparseable.
 * source: cortex main mcp_server/core/temporal.py:142-168
 */
export function normalizeDateToIso(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  // Already ISO with time — pass through
  if (s.includes("T") && s.length >= ISO_WITH_TIME_MIN_LENGTH) return s;
  const dt = parseDate(s);
  if (dt) return dt.toISOString();
  return null;
}

// ── Date distance score ───────────────────────────────────────────────────

/**
 * Exponential decay distance between document date and target date.
 *
 * Closer dates score higher. Used for temporal retrieval queries.
 *
 * precondition:  scaleDays > 0.
 * postcondition: result ∈ [0, 1].
 * source: cortex main mcp_server/core/temporal.py:170-194
 *   Formula: exp(-delta_days / scale_days); scale_days default = 14
 */
export function computeDateDistanceScore(
  docDateStr: string,
  targetDateHints: string[],
  scaleDays = DATE_DISTANCE_SCALE_DAYS,
): number {
  if (!docDateStr || targetDateHints.length === 0) return 0.0;

  const docDt = parseDate(docDateStr);
  if (!docDt) return 0.0;

  let bestScore = 0.0;
  for (const hint of targetDateHints) {
    const targetDt = parseDate(hint);
    if (targetDt) {
      const deltaDays = Math.abs(docDt.getTime() - targetDt.getTime()) / MS_PER_DAY;
      const score = Math.exp(-deltaDays / scaleDays);
      bestScore = Math.max(bestScore, score);
    }
  }

  return bestScore;
}

// ── Recency boost ─────────────────────────────────────────────────────────

/**
 * Exponential recency boost (ai-architect formula).
 *
 * Formula: boost = boost_max * exp(-age * ln(2) / halflife_days)
 *
 * precondition:  halflifeDays > 0; cutoffDays > 0.
 * postcondition: result ∈ [0, boostMax]; returns 0 for age > cutoffDays.
 * source: cortex main mcp_server/core/temporal.py:197-224
 *   boost_max default = 0.15; halflife_days default = 30; cutoff_days default = 90
 */
export function computeRecencyBoost(
  createdAt: string | Date | null | undefined,
  boostMax = RECENCY_BOOST_MAX,
  halflifeDays = RECENCY_HALFLIFE_DAYS,
  cutoffDays = RECENCY_CUTOFF_DAYS,
): number {
  if (!createdAt) return 0.0;
  const now = Date.now();
  let ts: number;
  if (createdAt instanceof Date) {
    ts = createdAt.getTime();
  } else {
    const d = new Date(String(createdAt).replace("Z", "+00:00"));
    if (isNaN(d.getTime())) return 0.0;
    ts = d.getTime();
  }
  const ageDays = (now - ts) / MS_PER_DAY;
  if (ageDays < 0 || ageDays > cutoffDays) return 0.0;
  // source: cortex main mcp_server/core/temporal.py:224
  // boost = boost_max * exp(-ln(2)/halflife * age)
  return boostMax * Math.exp(-(Math.LN2 / halflifeDays) * ageDays);
}
