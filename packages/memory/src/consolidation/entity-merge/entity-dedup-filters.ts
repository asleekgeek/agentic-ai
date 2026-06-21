/**
 * Pure predicates for fuzzy entity deduplication.
 *
 * Port of: cortex main mcp_server/core/entity_dedup_filters.py
 *
 * Normalization, entropy gating, shingle/MinHash construction, and the five
 * false-positive blockers that keep near-miss-but-distinct labels from merging.
 * Pure business logic — no I/O, no process.env, no DB.
 *
 * Sources:
 *   - Shannon entropy: Shannon, C. E. (1948). "A Mathematical Theory of
 *     Communication." Bell System Technical Journal, 27(3), 379-423.
 *   - Winkler prefix boost: Winkler, W. E. (1990). "String comparator metrics
 *     and enhanced decision rules in the Fellegi-Sunter model of record linkage."
 *     Proc. Section on Survey Research Methods, ASA, 354-359.
 */

import { MinHash } from "../../shared/minhash.js";
import { jaroWinklerSimilarity, osaDistance } from "../../shared/string-distance.js";

// ── tunable constants (source: cortex main mcp_server/core/entity_dedup_filters.py:24-31,
//    originally graphify graphify/dedup.py) ──

// source: cortex main mcp_server/core/entity_dedup_filters.py:24 (bits/char; Shannon 1948)
export const ENTROPY_THRESHOLD = 2.5;
// source: cortex main mcp_server/core/entity_dedup_filters.py:25 (MinHash band-LSH blocking threshold)
export const LSH_THRESHOLD = 0.7;
// source: cortex main mcp_server/core/entity_dedup_filters.py:26 (Jaro-Winkler similarity required to merge)
export const MERGE_THRESHOLD = 0.92;
// source: cortex main mcp_server/core/entity_dedup_filters.py:27 (MinHash permutations)
export const NUM_PERM = 128;

// source: cortex main mcp_server/core/entity_dedup_filters.py:28 (below this, fuzzy edits are usually variants not typos)
const _SHORT_LABEL_MAX = 12;

// source: cortex main mcp_server/core/entity_dedup_filters.py:29 (JW floor for an allowed same-length single substitution)
const _SAME_LEN_SUB_JW = 0.97;

// source: cortex main mcp_server/core/entity_dedup_filters.py:31 (character k-gram size for MinHash)
const _SHINGLE_K = 3;

// ── normalizeLabel ────────────────────────────────────────────────────────────

/**
 * Lowercase + collapse non-alphanumeric runs to a single space (NFKC).
 *
 * Precondition:  label is a string, null, or undefined.
 * Postcondition: returns a NFKC-normalized string; all runs of non-letter /
 *                non-digit characters (Unicode-aware) are collapsed to a single
 *                space; leading/trailing whitespace is removed; empty string if
 *                input is null/undefined/"".
 *
 * DEVIATION: Python uses `re.sub(r"[\W_]+", ..., flags=re.UNICODE)` which with
 * Python's `\W` in Unicode mode matches non-alphanumeric Unicode codepoints.
 * JS `\W` is ASCII-only, so we use the Unicode-aware class `[^\p{L}\p{N}]+`
 * with the `u` flag to replicate the Python behavior faithfully.
 * `str.toLowerCase()` is used instead of `str.casefold()` — for the ASCII and
 * common Latin characters in entity labels, the results are identical.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:32-35
 */
export function normalizeLabel(label: string | null | undefined): string {
  if (label === null || label === undefined) {
    label = "";
  } else if (typeof label !== "string") {
    label = String(label);
  }
  const nfkc = label.normalize("NFKC");
  // Unicode-aware: replace runs of non-letter/non-digit codepoints with space.
  return nfkc.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// ── entropy ───────────────────────────────────────────────────────────────────

/**
 * Shannon entropy (bits/char) of the normalized label.
 *
 * Precondition:  label is any string (will be normalized internally).
 * Postcondition: returns 0.0 if the normalized label is empty; otherwise
 *                -sum((count/n) * log2(count/n)) for each distinct character c
 *                where count is the frequency of c and n is the label length.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:38-45
 */
export function entropy(label: string): number {
  const s = normalizeLabel(label);
  if (s.length === 0) return 0.0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const n = s.length;
  let h = 0;
  for (const c of freq.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// ── shingles ──────────────────────────────────────────────────────────────────

/**
 * Character k-gram shingles; the whole string if shorter than k.
 *
 * Precondition:  text is a string; k >= 1.
 * Postcondition: returns a Set of overlapping k-character substrings of text,
 *                or {text} if text.length < k.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:48-51
 */
export function shingles(text: string, k: number = _SHINGLE_K): Set<string> {
  if (text.length < k) return new Set([text]);
  const result = new Set<string>();
  for (let i = 0; i <= text.length - k; i++) {
    result.add(text.slice(i, i + k));
  }
  return result;
}

// ── makeMinhash ───────────────────────────────────────────────────────────────

/**
 * MinHash over space-stripped shingles so "a b" and "ab" share shingles.
 *
 * Precondition:  normalized is a normalized label string (output of
 *                normalizeLabel); numPerm >= 1.
 * Postcondition: returns a MinHash sketch of shingles(normalized.replace(" ", ""),
 *                k=_SHINGLE_K); sketch is reproducible for the same input.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:54-57
 */
export function makeMinhash(normalized: string, numPerm: number = NUM_PERM): MinHash {
  const m = new MinHash(numPerm);
  for (const shingle of shingles(normalized.replace(/ /g, ""))) {
    m.update(shingle);
  }
  return m;
}

// ── isVariantPair ─────────────────────────────────────────────────────────────

// Trailing version/variant suffix: digits (+letters) like "v2", "A55", or a
// 2+ letter codename revision. Stem must end in a letter so plain words don't
// match.
// source: cortex main mcp_server/core/entity_dedup_filters.py:62-63
const _VARIANT_SUFFIX = /^(.*[a-z])([0-9]+[a-z]*|[a-z]{2,})$/;

/**
 * True if a, b are sibling variants (same stem, different suffix).
 *
 * Only meaningful for short labels (< _SHORT_LABEL_MAX chars); longer labels
 * go through Jaro-Winkler normally.
 *
 * Precondition:  a, b are normalized strings.
 * Postcondition: true iff both match _VARIANT_SUFFIX, share the same stem,
 *                differ in the suffix, and max(len(a), len(b)) < _SHORT_LABEL_MAX.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:65-73
 */
export function isVariantPair(a: string, b: string): boolean {
  if (a === b || Math.max(a.length, b.length) >= _SHORT_LABEL_MAX) return false;
  const ma = _VARIANT_SUFFIX.exec(a);
  const mb = _VARIANT_SUFFIX.exec(b);
  if (ma === null || mb === null) return false;
  // Same stem, different suffix.
  return ma[1] === mb[1] && ma[2] !== mb[2];
}

// ── shortLabelBlocked ─────────────────────────────────────────────────────────

/**
 * Block fuzzy merge of short labels except a same-length single substitution.
 *
 * Insertions/deletions on short strings score high on Jaro-Winkler via the
 * prefix bonus but are rarely true duplicates. Allow only a same-length,
 * single-character substitution (a real typo like Extractor/Extractar).
 *
 * Precondition:  a, b are normalized strings; jwScore is jaroWinklerSimilarity(a, b).
 * Postcondition: false (not blocked) if max(len(a), len(b)) >= _SHORT_LABEL_MAX;
 *                false if jwScore >= _SAME_LEN_SUB_JW AND len(a) == len(b)
 *                AND osaDistance(a, b) <= 1;
 *                true (blocked) otherwise (i.e., the pair must not merge).
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:76-89
 */
export function shortLabelBlocked(a: string, b: string, jwScore: number): boolean {
  if (Math.max(a.length, b.length) >= _SHORT_LABEL_MAX) return false;
  if (
    jwScore >= _SAME_LEN_SUB_JW &&
    a.length === b.length &&
    osaDistance(a, b) <= 1
  ) {
    return false;
  }
  return true;
}

// ── isAffixExtension ──────────────────────────────────────────────────────────

/**
 * True if one label strictly contains the other as a prefix or suffix.
 *
 * Prefix extensions (getActiveSession / getActiveSessions, parseConfig /
 * parseConfigFile) and suffix extensions (MemoryStore / PgMemoryStore, Store /
 * FileStore) are specializations, not duplicates.
 *
 * Precondition:  a, b are normalized strings (space-separated).
 * Postcondition: true iff sorted-by-length (lo, hi): hi starts with lo OR hi
 *                ends with lo, AND hi !== lo.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:92-100
 */
export function isAffixExtension(a: string, b: string): boolean {
  const [lo, hi] = a.length <= b.length ? [a, b] : [b, a];
  return hi !== lo && (hi.startsWith(lo) || hi.endsWith(lo));
}

// ── isStructuralIdentifier ────────────────────────────────────────────────────

/**
 * True for dotted module paths or slash file paths (code identifiers).
 *
 * Cortex mis-types module identifiers like `mcp_server.core.engram` as
 * `technology`. These are code symbols whose identity is structural — their long
 * shared prefixes inflate Jaro-Winkler past the merge threshold for unrelated
 * modules. Multi-segment dotted paths (>= 2 dots) and any slash path qualify;
 * single-dot names (Node.js, Vue.js) do not.
 *
 * Precondition:  label is the raw (un-normalized) entity name.
 * Postcondition: true iff label contains "/" or contains 2 or more ".".
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:103-115
 */
export function isStructuralIdentifier(label: string): boolean {
  const s = label.trim();
  return s.includes("/") || (s.split(".").length - 1) >= 2;
}

// ── internal: common-prefix length ───────────────────────────────────────────

function commonPrefixLen(a: string, b: string): number {
  let p = 0;
  const limit = Math.min(a.length, b.length);
  while (p < limit && a[p] === b[p]) p++;
  return p;
}

// ── affixesSandwichDifference ─────────────────────────────────────────────────

/**
 * Block when a shared prefix AND suffix sandwich dissimilar middles.
 *
 * teststoreclassification / testcoreclassification share the prefix "test" and
 * a long suffix "classification" but differ in the middle (store/core). Jaro-
 * Winkler scores the shared majority high. Works on the normalized (glued) form.
 * When one middle is empty (labels differ only by an affix) this does not fire —
 * that case is handled by isAffixExtension.
 *
 * Precondition:  a, b are normalized strings with spaces stripped (glued form).
 * Postcondition: true iff shared prefix + suffix covers >= 50% of the shorter
 *                string AND both middles are non-empty AND their JW similarity
 *                is < MERGE_THRESHOLD.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:118-139
 */
export function affixesSandwichDifference(a: string, b: string): boolean {
  const p = commonPrefixLen(a, b);
  // Common suffix length, clamped so prefix and suffix don't overlap on the
  // shorter string. Python: s = min(s, min(len(a), len(b)) - p)
  // source: cortex main mcp_server/core/entity_dedup_filters.py:127
  let s = commonPrefixLen([...a].reverse().join(""), [...b].reverse().join(""));
  s = Math.min(s, Math.min(a.length, b.length) - p);
  if (s < 0 || p + s < 0.5 * Math.min(a.length, b.length)) return false;
  const midA = a.slice(p, a.length - s);
  const midB = b.slice(p, b.length - s);
  if (!midA || !midB) return false;
  return jaroWinklerSimilarity(midA, midB) < MERGE_THRESHOLD;
}

// ── sharedPrefixMasksDifference ───────────────────────────────────────────────

/**
 * True when a dominant shared prefix hides dissimilar tails.
 *
 * Jaro-Winkler's prefix bonus (Winkler 1990) was calibrated for short personal
 * names; on longer strings a long common prefix over-credits the score even
 * when the discriminating remainders differ. When the longest common prefix is
 * at least half of the shorter label, require the post-prefix remainders to
 * themselves clear MERGE_THRESHOLD — otherwise block.
 *
 * Precondition:  a, b are normalized strings.
 * Postcondition: true iff p >= 0.5 * min(len(a), len(b)) AND both remainders
 *                are non-empty AND JW(ra, rb) < MERGE_THRESHOLD.
 *
 * source: cortex main mcp_server/core/entity_dedup_filters.py:142-155
 */
export function sharedPrefixMasksDifference(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  const p = commonPrefixLen(a, b);
  if (p === 0 || p < 0.5 * n) return false;
  const ra = a.slice(p);
  const rb = b.slice(p);
  // One is a prefix of the other → isAffixExtension's job.
  if (!ra || !rb) return false;
  return jaroWinklerSimilarity(ra, rb) < MERGE_THRESHOLD;
}
