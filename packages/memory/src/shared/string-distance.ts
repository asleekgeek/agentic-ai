/**
 * Edit-distance and prefix-weighted string similarity — dependency-free.
 *
 * Port of: cortex bc5af469 mcp_server/shared/string_distance.py
 *
 * Sources:
 *   - Jaro similarity: Jaro, M. A. (1989). "Advances in record linkage
 *     methodology." J. Amer. Statist. Assoc. 84(406), 414-420.
 *   - Winkler prefix boost: Winkler, W. E. (1990). "String comparator metrics
 *     and enhanced decision rules in the Fellegi-Sunter model of record
 *     linkage." Proc. Section on Survey Research Methods, ASA, 354-359.
 *     Standard scaling factor p = 0.1, prefix capped at l = 4.
 *   - Optimal String Alignment (restricted Damerau-Levenshtein): Damerau, F. J.
 *     (1964); standard DP formulation.
 *
 * Pure utility — no I/O. Similarities return values in [0, 1]; distances return
 * non-negative integers.
 */

// source: cortex bc5af469 mcp_server/shared/string_distance.py:15  (Winkler 1990, p)
const WINKLER_SCALING = 0.1;
// source: cortex bc5af469 mcp_server/shared/string_distance.py:16  (Winkler 1990, l capped at 4)
const WINKLER_MAX_PREFIX = 4;

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Return (s1Matched, s2Matched, matchCount) within the Jaro match window.
 *
 * Precondition:  s1 and s2 are non-empty; window >= 0.
 * Postcondition: s1Matched[i] is true iff s1[i] was matched to some s2[j];
 *                matchCount equals the number of matched character pairs.
 */
function jaroMatches(
  s1: string,
  s2: string,
  window: number,
): [boolean[], boolean[], number] {
  const s1Matched: boolean[] = new Array<boolean>(s1.length).fill(false);
  const s2Matched: boolean[] = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (!s2Matched[j] && s1[i] === s2[j]) {
        s1Matched[i] = true;
        s2Matched[j] = true;
        matches++;
        break;
      }
    }
  }
  return [s1Matched, s2Matched, matches];
}

/**
 * Count half-transpositions: matched characters appearing out of relative order.
 *
 * Precondition:  s1Matched and s2Matched are the arrays from jaroMatches.
 * Postcondition: returns Math.floor(t / 2) where t is the raw transposition
 *                count (number of matched-position pairs whose characters differ).
 */
function jaroTranspositions(
  s1: string,
  s2: string,
  s1Matched: boolean[],
  s2Matched: boolean[],
): number {
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matched[i]) continue;
    while (!s2Matched[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  // Python: transpositions // 2
  return Math.floor(transpositions / 2);
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Jaro similarity in [0, 1] (Jaro 1989).
 *
 * Precondition:  s1 and s2 are strings (any length, including empty).
 * Postcondition: returns 1.0 for equal inputs; 0.0 when either is empty or
 *                when no characters match within the window; otherwise
 *                (1/3)(m/|s1| + m/|s2| + (m - t) / m) where m is match count
 *                and t is half-transpositions.
 */
export function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;
  // Python: max(0, max(len1, len2) // 2 - 1)
  const window = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const [s1Matched, s2Matched, m] = jaroMatches(s1, s2, window);
  if (m === 0) return 0.0;
  const t = jaroTranspositions(s1, s2, s1Matched, s2Matched);
  return (m / len1 + m / len2 + (m - t) / m) / 3.0;
}

/**
 * Jaro-Winkler similarity in [0, 1] (Winkler 1990).
 *
 * Precondition:  s1 and s2 are strings.
 * Postcondition: jaro + l * p * (1 - jaro) where l is the common-prefix length
 *                capped at WINKLER_MAX_PREFIX (4) and p = WINKLER_SCALING (0.1).
 *                Prefix boost is applied unconditionally (no 0.7 jaro gate),
 *                matching the cortex source.
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);
  let prefix = 0;
  const maxPrefix = Math.min(s1.length, s2.length, WINKLER_MAX_PREFIX);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] !== s2[i]) break;
    prefix++;
  }
  return jaro + prefix * WINKLER_SCALING * (1.0 - jaro);
}

/**
 * Optimal String Alignment distance (restricted Damerau-Levenshtein).
 *
 * Precondition:  s1 and s2 are strings.
 * Postcondition: returns a non-negative integer — the minimum number of
 *                insertions, deletions, substitutions, and adjacent-transpositions
 *                (each substring edited at most once) to transform s1 into s2.
 *                Returns 0 iff s1 === s2.
 */
export function osaDistance(s1: string, s2: string): number {
  if (s1 === s2) return 0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  // prev2 = row i-2; prev = row i-1; cur = row i
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: len2 + 1 }, (_, j) => j);
  for (let i = 1; i <= len1; i++) {
    const cur: number[] = [i, ...new Array<number>(len2).fill(0)];
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      // cur is length len2+1; prev/prev2 are previous rows (also len2+1) and
      // 1 <= j <= len2 keeps every index in [0, len2] — assert in-bounds to
      // satisfy noUncheckedIndexedAccess (the DP guarantees the bound).
      cur[j] = Math.min(
        cur[j - 1]! + 1,      // insertion
        prev[j]! + 1,          // deletion
        prev[j - 1]! + cost,   // substitution
      );
      if (
        i > 1 && j > 1 &&
        s1[i - 1] === s2[j - 2] &&
        s1[i - 2] === s2[j - 1]
      ) {
        cur[j] = Math.min(cur[j]!, prev2[j - 2]! + 1); // adjacent transposition
      }
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[len2]!;
}
