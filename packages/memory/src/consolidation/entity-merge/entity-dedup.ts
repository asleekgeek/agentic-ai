/**
 * Fuzzy entity-graph deduplication — 3-pass exact / MinHash-LSH / Jaro-Winkler.
 *
 * Port of: cortex main mcp_server/core/entity_dedup.py
 *
 * Collapses near-duplicate *concept* entities that the case-canonical insert
 * policy and exact-name DB upsert miss — whitespace and punctuation variants
 * ("Embedding Engine" vs "EmbeddingEngine"), and typos ("Postgres" vs
 * "Postgers") — so the co-access / knowledge graph is not fragmented across
 * spelling variants of one concept.
 *
 * Cortex adaptations vs graphify:
 *   - Identity is the entity name (Cortex entities are name-keyed and already
 *     case-deduped on insert), so "same label, different file → keep apart"
 *     guards are unnecessary; instead we require same type for any merge.
 *   - Code symbols (functions, classes, …) are exempt from label-fuzzy merging.
 *   - Match strength is a float Jaro-Winkler score with a textual reason.
 *
 * This is a batch operation (a maintenance / consolidation step), not the
 * synchronous write-gate path. Pure business logic — no I/O.
 */

import {
  ENTROPY_THRESHOLD,
  LSH_THRESHOLD,
  MERGE_THRESHOLD,
  NUM_PERM,
  affixesSandwichDifference,
  entropy,
  isAffixExtension,
  isStructuralIdentifier,
  isVariantPair,
  makeMinhash,
  normalizeLabel,
  sharedPrefixMasksDifference,
  shortLabelBlocked,
} from "./entity-dedup-filters.js";
import { MinHash, MinHashLSH } from "../../shared/minhash.js";
import { jaroWinklerSimilarity } from "../../shared/string-distance.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal shape the dedup engine expects for each input entity. */
export interface EntityInput {
  name: string;
  type?: string;
  id?: string | number;
  heat?: number;
  mention_count?: number;
  origin?: string;
  [k: string]: unknown;
}

/** One matched pair and why it matched (audit trail). */
export interface EntityMerge {
  keyA: string;
  keyB: string;
  score: number;
  reason: string;
}

/** Outcome of a dedup pass. */
export interface DedupResult {
  /** alias entity key → surviving canonical entity key */
  remap: Record<string, string>;
  /** every matched pair with its score and reason */
  merges: EntityMerge[];
  /** entities that remain after collapsing aliases */
  survivors: EntityInput[];
}

// Concept-ish types where spelling/spacing variants of one real-world entity
// legitimately arise. Structural code symbols and file paths are exempt — their
// identity is the symbol/path, not a fuzzy label.
// source: cortex main mcp_server/core/entity_dedup.py:45-46
export const FUZZY_ELIGIBLE_TYPES: ReadonlySet<string> = new Set([
  "technology",
  "decision",
  "error",
  "dependency",
]);

// ── Union-Find (disjoint-set) ─────────────────────────────────────────────────

/**
 * Disjoint-set with path halving — groups entities into merge components.
 *
 * Invariant: for every key x, _parent.get(x) exists and represents the
 * "next step" toward the root in x's component tree. Path halving keeps the
 * tree flat.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:49-63
 */
class UnionFind {
  private readonly _parent = new Map<string, string>();

  find(x: string): string {
    // precondition:  x is any string key.
    // postcondition: returns the canonical root of x's component; path is
    //                halved for future queries (amortized near-O(1)).
    if (!this._parent.has(x)) this._parent.set(x, x);
    let cur = x;
    // `?? cur` treats a missing entry as a self-root — the union-find identity
    // (mirrors Python's setdefault(x, x)). It keeps the lookup total, so no cast
    // and no `undefined` ever escapes into the path.
    let parent = this._parent.get(cur) ?? cur;
    while (parent !== cur) {
      // path halving: cur → grandparent
      const grandparent = this._parent.get(parent) ?? parent;
      this._parent.set(cur, grandparent);
      cur = grandparent;
      parent = this._parent.get(cur) ?? cur;
    }
    return cur;
  }

  union(x: string, y: string): void {
    // precondition:  x, y are string keys.
    // postcondition: x and y are in the same component; the root of y's old
    //                component points to the root of x's component.
    if (!this._parent.has(x)) this._parent.set(x, x);
    if (!this._parent.has(y)) this._parent.set(y, y);
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this._parent.set(ry, rx);
  }

  components(): Map<string, string[]> {
    // postcondition: returns a Map from each root → all members in its
    //                component, in insertion order.
    const groups = new Map<string, string[]>();
    for (const x of this._parent.keys()) {
      const root = this.find(x);
      const group = groups.get(root);
      if (group !== undefined) {
        group.push(x);
      } else {
        groups.set(root, [x]);
      }
    }
    return groups;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Stable merge identity: the entity id if present, else its name.
 *
 * Precondition:  entity has at least a name field or id field.
 * Postcondition: returns String(id) if id is not null/undefined, else
 *                String(name ?? "").
 *
 * source: cortex main mcp_server/core/entity_dedup.py:66-68
 */
function mergeKey(entity: EntityInput): string {
  if (entity.id !== null && entity.id !== undefined) {
    return String(entity.id);
  }
  return String(entity.name ?? "");
}

/**
 * Canonical survivor: most-mentioned, then hottest, then shortest name.
 *
 * The rank tuple mirrors Python: (-mention_count, -heat, len(name), name).
 * Minimum of the rank tuple picks the winner. Python tuple ordering is:
 * element-by-element ascending; we implement that as a comparator.
 *
 * Precondition:  group is a non-empty array of EntityInput objects.
 * Postcondition: returns the element minimising (-mention_count, -heat,
 *                len(name), name) — i.e. maximising mention_count, then heat,
 *                then shortest name, then lexicographically first.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:71-82
 */
function pickWinner(group: EntityInput[]): EntityInput {
  return group.reduce((best, cur) => {
    const bName = String(best.name ?? "");
    const cName = String(cur.name ?? "");
    const bMention = -(Number(best.mention_count ?? 0));
    const cMention = -(Number(cur.mention_count ?? 0));
    if (cMention !== bMention) return cMention < bMention ? cur : best;
    const bHeat = -(Number(best.heat ?? 0));
    const cHeat = -(Number(cur.heat ?? 0));
    if (cHeat !== bHeat) return cHeat < bHeat ? cur : best;
    if (cName.length !== bName.length) return cName.length < bName.length ? cur : best;
    return cName < bName ? cur : best;
  });
}

// ── Pass 1: exact-norm merge ──────────────────────────────────────────────────

/**
 * Union entities whose normalized labels are identical.
 *
 * Precondition:  group is a list of entities of the same type.
 * Postcondition: entities sharing the same normalized label are unioned in uf;
 *                a merge record is appended for each pair after the first.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:121-131
 */
function exactNormPass(
  group: EntityInput[],
  uf: UnionFind,
  merges: EntityMerge[],
): void {
  // bucket by normalized label — preserve insertion order (Map).
  const buckets = new Map<string, EntityInput[]>();
  for (const e of group) {
    const norm = normalizeLabel(e.name);
    const bucket = buckets.get(norm);
    if (bucket !== undefined) {
      bucket.push(e);
    } else {
      buckets.set(norm, [e]);
    }
  }
  for (const [norm, members] of buckets) {
    // `[base, ...rest]` narrows away `undefined` and skips singletons in one
    // step: base is undefined only for an empty bucket, rest is empty for a
    // singleton — either way there is nothing to union.
    const [base, ...rest] = members;
    if (base === undefined || rest.length === 0) continue;
    const baseKey = mergeKey(base);
    for (const other of rest) {
      const otherKey = mergeKey(other);
      uf.union(baseKey, otherKey);
      merges.push({ keyA: baseKey, keyB: otherKey, score: 1.0, reason: `exact-norm:${norm}` });
    }
  }
}

// ── Pass 2 helpers ────────────────────────────────────────────────────────────

/**
 * Pick one high-entropy entity per distinct normalized label for Pass 2.
 *
 * Precondition:  group is a list of entities of the same type.
 * Postcondition: returns [candidates, normCache] where candidates is a list of
 *                entities with distinct norms and entropy >= ENTROPY_THRESHOLD,
 *                and normCache maps mergeKey → normalized label.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:134-144
 */
function gatherCandidates(
  group: EntityInput[],
): [EntityInput[], Map<string, string>] {
  const candidates: EntityInput[] = [];
  const normCache = new Map<string, string>();
  const seenNorm = new Set<string>();
  for (const e of group) {
    // Structural identifiers (dotted paths, file paths) are exempt.
    if (isStructuralIdentifier(String(e.name ?? ""))) continue;
    const norm = normalizeLabel(e.name);
    if (!norm || seenNorm.has(norm)) continue;
    seenNorm.add(norm);
    if (entropy(e.name) >= ENTROPY_THRESHOLD) {
      candidates.push(e);
      normCache.set(mergeKey(e), norm);
    }
  }
  return [candidates, normCache];
}

/**
 * Index candidate sketches for sub-quadratic neighbor blocking.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:147-155
 */
function buildLsh(
  candidates: EntityInput[],
  normCache: Map<string, string>,
): [MinHashLSH, Map<string, MinHash>] {
  const lsh = new MinHashLSH(LSH_THRESHOLD, NUM_PERM);
  const minhashes = new Map<string, MinHash>();
  for (const e of candidates) {
    const key = mergeKey(e);
    const norm = normCache.get(key);
    if (norm === undefined) continue;
    const m = makeMinhash(norm);
    minhashes.set(key, m);
    try {
      lsh.insert(key, m);
    } catch {
      // duplicate key already inserted — skip silently.
      // source: cortex main mcp_server/core/entity_dedup.py:153-154
    }
  }
  return [lsh, minhashes];
}

/**
 * Apply Jaro-Winkler + the five blockers to a candidate pair.
 *
 * Precondition:  aNorm, bNorm are normalized entity labels.
 * Postcondition: returns (shouldMerge, score, reason).
 *
 * source: cortex main mcp_server/core/entity_dedup.py:158-169
 */
function verifyPair(
  aNorm: string,
  bNorm: string,
  threshold: number,
): [boolean, number, string] {
  const score = jaroWinklerSimilarity(aNorm, bNorm);
  if (isVariantPair(aNorm, bNorm)) return [false, score, "blocked:variant"];
  if (shortLabelBlocked(aNorm, bNorm, score)) return [false, score, "blocked:short-label"];
  if (isAffixExtension(aNorm, bNorm)) return [false, score, "blocked:affix-extension"];
  if (sharedPrefixMasksDifference(aNorm, bNorm)) return [false, score, "blocked:shared-prefix"];
  if (affixesSandwichDifference(aNorm, bNorm)) return [false, score, "blocked:affix-sandwich"];
  if (score >= threshold) return [true, score, "jaro-winkler"];
  return [false, score, "below-threshold"];
}

/**
 * MinHash/LSH blocking then Jaro-Winkler verification.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:172-188
 */
function fuzzyPass(
  group: EntityInput[],
  uf: UnionFind,
  merges: EntityMerge[],
  threshold: number,
): void {
  const [candidates, normCache] = gatherCandidates(group);
  if (candidates.length < 2) return;
  const [lsh, minhashes] = buildLsh(candidates, normCache);
  for (const e of candidates) {
    const key = mergeKey(e);
    const aNorm = normCache.get(key);
    if (aNorm === undefined) continue;
    const probe = minhashes.get(key);
    if (probe === undefined) continue;
    for (const nbrKey of lsh.query(probe)) {
      if (nbrKey === key || uf.find(key) === uf.find(nbrKey)) continue;
      const bNorm = normCache.get(nbrKey);
      if (bNorm === undefined) continue;
      const [ok, score, reason] = verifyPair(aNorm, bNorm, threshold);
      if (ok) {
        uf.union(key, nbrKey);
        merges.push({ keyA: key, keyB: nbrKey, score, reason });
      }
    }
  }
}

// ── Build remap + survivor list ───────────────────────────────────────────────

/**
 * Turn union-find components into an alias→canonical remap + survivor list.
 *
 * Precondition:  entities is the original input list; uf reflects all merged
 *                pairs.
 * Postcondition: remap maps each non-winner key → winner key; survivors is
 *                the list of entities whose mergeKey is NOT in remap.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:191-202
 */
function buildRemap(
  entities: EntityInput[],
  uf: UnionFind,
): [Record<string, string>, EntityInput[]] {
  // Build a lookup from mergeKey → entity (last-write-wins for key collisions,
  // matching Python dict behavior on duplicate keys).
  const byKey = new Map<string, EntityInput>();
  for (const e of entities) {
    byKey.set(mergeKey(e), e);
  }

  const remap: Record<string, string> = {};
  for (const members of uf.components().values()) {
    if (members.length <= 1) continue;
    const groupEntities = members
      .filter((m) => byKey.has(m))
      .map((m) => byKey.get(m) as EntityInput);
    if (groupEntities.length === 0) continue;
    const winnerKey = mergeKey(pickWinner(groupEntities));
    for (const m of members) {
      if (m !== winnerKey) {
        remap[m] = winnerKey;
      }
    }
  }
  const survivors = entities.filter((e) => !(mergeKey(e) in remap));
  return [remap, survivors];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Find near-duplicate concept entities and plan their collapse.
 *
 * Precondition:  entities is an array of EntityInput objects (may be empty).
 * Postcondition: returns DedupResult with:
 *   - remap: alias → canonical key map (empty if no merges).
 *   - merges: every matched pair with score and reason.
 *   - survivors: entities remaining after collapsing aliases.
 *   No mutation of the input array or its elements.
 *
 * source: cortex main mcp_server/core/entity_dedup.py:85-119
 */
export function deduplicateEntities(
  entities: EntityInput[],
  opts?: {
    eligibleTypes?: ReadonlySet<string>;
    mergeThreshold?: number;
  },
): DedupResult {
  if (entities.length <= 1) {
    return { remap: {}, merges: [], survivors: [...entities] };
  }

  const eligibleTypes = opts?.eligibleTypes ?? FUZZY_ELIGIBLE_TYPES;
  const mergeThreshold = opts?.mergeThreshold ?? MERGE_THRESHOLD;

  // Group eligible entities by type. Preserve insertion order (Map).
  const byType = new Map<string, EntityInput[]>();
  for (const e of entities) {
    // AST-extracted code symbols are exempt from fuzzy merging.
    // source: cortex main mcp_server/core/entity_dedup.py:100-101
    if ((e.origin ?? "text_concept") === "ast_symbol") continue;
    const type = e.type ?? "";
    if (eligibleTypes.has(type) && normalizeLabel(e.name)) {
      const group = byType.get(type);
      if (group !== undefined) {
        group.push(e);
      } else {
        byType.set(type, [e]);
      }
    }
  }

  const uf = new UnionFind();
  const merges: EntityMerge[] = [];
  for (const group of byType.values()) {
    exactNormPass(group, uf, merges);
    fuzzyPass(group, uf, merges, mergeThreshold);
  }

  const [remap, survivors] = buildRemap(entities, uf);
  return { remap, merges, survivors };
}
