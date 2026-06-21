/**
 * Detect whether a memory should be marked as global (cross-project).
 *
 * Global memories are visible to all projects during recall. They represent
 * knowledge that transcends any single codebase: architecture rules, coding
 * conventions, infrastructure facts, security policies, team agreements,
 * and reusable patterns.
 *
 * Classification uses weighted keyword/phrase signals across 6 categories.
 * A memory is global when its score exceeds a threshold AND it doesn't
 * contain project-specific anchors (file paths, branch names, PR numbers).
 *
 * Port of: mcp_server/core/global_detector.py
 * Pure business logic -- no I/O.
 */

// ── Signal weights ─────────────────────────────────────────────────────────────
// Phrase weights used in GLOBAL_SIGNALS. Phrases (multi-word) score higher
// than single keywords to reduce false positives.
// source: parity with mcp_server/core/global_detector.py:24-130

/** Strong multi-word phrase: highest confidence global signal. */
const WEIGHT_STRONG_PHRASE = 2.5;
/** High-confidence multi-word phrase indicating global scope. */
const WEIGHT_HIGH_PHRASE = 2.0;
/** Architectural/cross-project multi-word phrase. */
const WEIGHT_MED_HIGH_PHRASE = 1.8;
/** Common informative phrase. */
const WEIGHT_MED_PHRASE = 1.5;
/** Knowledge / race-condition / deadlock / memory-leak signal. */
const WEIGHT_KNOWLEDGE_MED = 1.2;
/** Single-word general signal. */
const WEIGHT_LOW = 1.0;
/** Weak single-word signal. */
const WEIGHT_WEAK = 0.8;
/** Very weak single-word signal (database, dns, backups). */
const WEIGHT_VERY_WEAK = 0.6;

// ── Infrastructure boost & tag boost ──────────────────────────────────────────
// source: parity with mcp_server/core/global_detector.py:219-237

/** Additive score boost when an IP address or hostname pattern is found. */
const INFRA_PATTERN_BOOST = 1.0;
/** Per-matching-tag additive score boost for explicit global tags. */
const GLOBAL_TAG_BOOST = 1.5;

// ── Anchor penalty multipliers ─────────────────────────────────────────────────
// source: parity with mcp_server/core/global_detector.py:240-244

/** Score multiplier when >= 3 project-specific anchors found. */
const ANCHOR_PENALTY_HIGH = 0.4;
/** Score multiplier when 1–2 project-specific anchors found. */
const ANCHOR_PENALTY_LOW = 0.7;
/** Anchor count at or above which the high penalty applies. */
const ANCHOR_COUNT_HIGH_THRESHOLD = 3;

// ── Rounding ───────────────────────────────────────────────────────────────────
// source: parity with mcp_server/core/global_detector.py:254

/** Multiplier / divisor for rounding score to 2 decimal places. */
const SCORE_ROUND_FACTOR = 100; // source: parity with mcp_server/core/global_detector.py:254 — round(score, 2) → 10^2

// ── Signal categories ─────────────────────────────────────────────────────────
// Each category contributes to the global score. Phrases (multi-word)
// score higher than single keywords to reduce false positives.

export type SignalCategory =
  | "architecture"
  | "convention"
  | "infrastructure"
  | "security"
  | "cross_project"
  | "knowledge";

export const GLOBAL_SIGNALS: Record<SignalCategory, Array<[string, number]>> = {
  architecture: [
    ["clean architecture", WEIGHT_HIGH_PHRASE], ["single responsibility", WEIGHT_HIGH_PHRASE],
    ["dependency injection", WEIGHT_HIGH_PHRASE], ["dependency inversion", WEIGHT_HIGH_PHRASE],
    ["separation of concerns", WEIGHT_HIGH_PHRASE], ["composition root", WEIGHT_MED_HIGH_PHRASE],
    ["hexagonal architecture", WEIGHT_MED_HIGH_PHRASE], ["domain driven design", WEIGHT_MED_PHRASE],
    ["solid principles", WEIGHT_MED_HIGH_PHRASE], ["design pattern", WEIGHT_MED_PHRASE],
    ["anti-pattern", WEIGHT_MED_PHRASE], ["coupling", WEIGHT_LOW], ["cohesion", WEIGHT_LOW],
    ["abstraction", WEIGHT_WEAK], ["interface segregation", WEIGHT_MED_HIGH_PHRASE],
    ["open closed principle", WEIGHT_MED_HIGH_PHRASE], ["liskov substitution", WEIGHT_MED_HIGH_PHRASE],
  ],
  convention: [
    ["coding standard", WEIGHT_HIGH_PHRASE], ["naming convention", WEIGHT_HIGH_PHRASE],
    ["code style", WEIGHT_MED_PHRASE], ["best practice", WEIGHT_MED_PHRASE],
    ["always use", WEIGHT_MED_PHRASE], ["never use", WEIGHT_MED_PHRASE],
    ["prefer", WEIGHT_WEAK], ["convention", WEIGHT_LOW], ["rule of thumb", WEIGHT_MED_PHRASE],
    ["we always", WEIGHT_MED_PHRASE], ["we never", WEIGHT_MED_PHRASE], ["team agreement", WEIGHT_HIGH_PHRASE],
    ["standard approach", WEIGHT_MED_PHRASE],
  ],
  infrastructure: [
    ["server at", WEIGHT_MED_HIGH_PHRASE], ["database url", WEIGHT_HIGH_PHRASE], ["connection string", WEIGHT_HIGH_PHRASE],
    ["production server", WEIGHT_HIGH_PHRASE], ["staging server", WEIGHT_HIGH_PHRASE], ["home network", WEIGHT_MED_HIGH_PHRASE],
    ["docker compose", WEIGHT_MED_PHRASE], ["ci/cd pipeline", WEIGHT_MED_HIGH_PHRASE], ["github actions", WEIGHT_MED_PHRASE],
    ["deployment", WEIGHT_LOW], ["kubernetes", WEIGHT_LOW], ["load balancer", WEIGHT_MED_PHRASE],
    ["reverse proxy", WEIGHT_MED_PHRASE], ["dns", WEIGHT_WEAK], ["vpn", WEIGHT_LOW],
    ["ssl certificate", WEIGHT_MED_PHRASE], ["backups", WEIGHT_WEAK], ["backup", WEIGHT_WEAK],
    ["monitoring", WEIGHT_WEAK], ["database", WEIGHT_VERY_WEAK],
  ],
  security: [
    ["api key rotation", WEIGHT_HIGH_PHRASE], ["secret rotation", WEIGHT_HIGH_PHRASE], ["security policy", WEIGHT_HIGH_PHRASE],
    ["access control", WEIGHT_MED_PHRASE], ["authentication", WEIGHT_LOW], ["authorization", WEIGHT_LOW],
    ["jwt", WEIGHT_LOW], ["oauth", WEIGHT_LOW], ["encryption", WEIGHT_LOW], ["password policy", WEIGHT_HIGH_PHRASE],
    ["credentials", WEIGHT_LOW], ["credential", WEIGHT_LOW], ["vulnerability", WEIGHT_LOW],
    ["owasp", WEIGHT_MED_PHRASE], ["cors policy", WEIGHT_MED_PHRASE], ["rate limiting", WEIGHT_MED_PHRASE],
  ],
  cross_project: [
    ["across all projects", WEIGHT_STRONG_PHRASE], ["all projects", WEIGHT_HIGH_PHRASE],
    ["cross-project", WEIGHT_STRONG_PHRASE],
    ["shared across", WEIGHT_HIGH_PHRASE], ["every project", WEIGHT_HIGH_PHRASE], ["universal", WEIGHT_MED_PHRASE],
    ["global rule", WEIGHT_STRONG_PHRASE], ["global policy", WEIGHT_STRONG_PHRASE], ["applies everywhere", WEIGHT_HIGH_PHRASE],
    ["company-wide", WEIGHT_HIGH_PHRASE], ["team-wide", WEIGHT_HIGH_PHRASE], ["organization", WEIGHT_LOW],
    ["reusable", WEIGHT_LOW],
  ],
  knowledge: [
    ["utc timestamp", WEIGHT_MED_HIGH_PHRASE], ["wal mode", WEIGHT_MED_PHRASE], ["connection pool", WEIGHT_MED_PHRASE],
    ["idempotent", WEIGHT_MED_PHRASE], ["eventual consistency", WEIGHT_MED_PHRASE], ["cap theorem", WEIGHT_MED_PHRASE],
    ["acid", WEIGHT_LOW], ["race condition", WEIGHT_KNOWLEDGE_MED], ["deadlock", WEIGHT_KNOWLEDGE_MED],
    ["memory leak", WEIGHT_KNOWLEDGE_MED], ["cache invalidation", WEIGHT_MED_PHRASE], ["index on", WEIGHT_KNOWLEDGE_MED],
    ["foreign key", WEIGHT_LOW], ["migration", WEIGHT_WEAK], ["schema design", WEIGHT_MED_PHRASE],
  ],
};

// ── Negative signals — project-specific anchors ───────────────────────────────
// Content with these patterns is likely project-specific, not global.

const PROJECT_ANCHORS_RE =
  /(?:(?:\.{0,2}\/)?(?:[\w@.-]+\/){2,}[\w@.-]+\.\w+|PR\s*#\d+|issue\s*#\d+|branch\s+[\w/-]+|commit\s+[0-9a-f]{7,}|\bv\d+\.\d+\.\d+)/gi;

// Tool log prefix — auto-captured tool output is never global
const TOOL_LOG_PREFIX_RE = /^#\s*Tool:\s/m;

// IP addresses and hostnames are infrastructure (positive, not negative)
const IP_PATTERN_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const HOST_PATTERN_RE = /\b[\w-]+\.(internal|local|dev|prod|staging)\b/i;

/** Score threshold for global classification. */
export const GLOBAL_THRESHOLD = 3.0;

// ── Pre-compiled signal structures ────────────────────────────────────────────

interface CompiledSignal {
  phrase: string;
  weight: number;
  regex: RegExp | null; // null = multi-word phrase match (substring)
  category: SignalCategory;
}

const COMPILED_SIGNALS: CompiledSignal[] = [];

for (const [cat, signals] of Object.entries(GLOBAL_SIGNALS) as [SignalCategory, Array<[string, number]>][]) {
  for (const [phrase, weight] of signals) {
    const isMultiWord = phrase.includes(" ");
    COMPILED_SIGNALS.push({
      phrase,
      weight,
      regex: isMultiWord ? null : new RegExp(`\\b${phrase}\\b`, "i"),
      category: cat,
    });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Classify whether memory content should be global.
 *
 * @returns [is_global, score, reason]
 *   - is_global: true if score >= GLOBAL_THRESHOLD
 *   - score: weighted sum of matched signals
 *   - reason: best-matching category or "not_global"
 *
 * Precondition: content is a string; tags is an array of strings or undefined.
 * Postcondition: is_global === (score >= GLOBAL_THRESHOLD).
 */
export function detectGlobal(
  content: string,
  tags?: string[],
): [boolean, number, string] {
  if (!content) return [false, 0.0, "empty"];

  // Skip auto-captured tool logs
  if (TOOL_LOG_PREFIX_RE.test(content)) return [false, 0.0, "tool_log"];

  const lower = content.toLowerCase();
  const tagText = (tags ?? []).join(" ").toLowerCase();
  const haystack = lower + " " + tagText;

  // Score positive signals
  let score = 0.0;
  const categoryScores = new Map<string, number>();

  for (const { phrase, weight, regex, category } of COMPILED_SIGNALS) {
    const matched = regex !== null ? regex.test(haystack) : haystack.includes(phrase);
    if (matched) {
      score += weight;
      categoryScores.set(category, (categoryScores.get(category) ?? 0) + weight);
    }
  }

  // Boost for infrastructure indicators
  if (IP_PATTERN_RE.test(content)) {
    score += INFRA_PATTERN_BOOST;
    categoryScores.set("infrastructure", (categoryScores.get("infrastructure") ?? 0) + INFRA_PATTERN_BOOST);
  }
  if (HOST_PATTERN_RE.test(content)) {
    score += INFRA_PATTERN_BOOST;
    categoryScores.set("infrastructure", (categoryScores.get("infrastructure") ?? 0) + INFRA_PATTERN_BOOST);
  }

  // Boost for explicit global tags
  const globalTagSet = new Set(["global", "shared", "infrastructure", "cross-project", "universal"]);
  const tagOverlap = (tags ?? []).filter((t) => globalTagSet.has(t.toLowerCase()));
  if (tagOverlap.length > 0) {
    score += GLOBAL_TAG_BOOST * tagOverlap.length;
    categoryScores.set(
      "cross_project",
      (categoryScores.get("cross_project") ?? 0) + GLOBAL_TAG_BOOST * tagOverlap.length,
    );
  }

  // Penalize project-specific anchors (but not zero — infra can have paths)
  PROJECT_ANCHORS_RE.lastIndex = 0;
  const anchorMatches = content.match(PROJECT_ANCHORS_RE);
  const anchorCount = anchorMatches ? anchorMatches.length : 0;
  if (anchorCount >= ANCHOR_COUNT_HIGH_THRESHOLD) {
    score *= ANCHOR_PENALTY_HIGH;
  } else if (anchorCount >= 1) {
    score *= ANCHOR_PENALTY_LOW;
  }

  if (categoryScores.size === 0) return [false, 0.0, "not_global"];

  let bestCat = "";
  let bestCatScore = -Infinity;
  for (const [cat, s] of categoryScores) {
    if (s > bestCatScore) {
      bestCatScore = s;
      bestCat = cat;
    }
  }

  const isGlobal = score >= GLOBAL_THRESHOLD;
  const reason = isGlobal ? `global_${bestCat}` : "not_global";

  return [isGlobal, Math.round(score * SCORE_ROUND_FACTOR) / SCORE_ROUND_FACTOR, reason];
}
