/**
 * Active memory curation — merge/link/create decisions and self-improvement.
 *
 * Implements:
 *   - Ingestion decisions: merge near-duplicates, link related, create new
 *   - Contradiction detection: negation + action divergence
 *   - Memify self-improvement: prune, strengthen, reweight, derive
 *
 * Pure business logic — no I/O. Receives data, returns decisions/actions.
 *
 * Port of: mcp_server/core/curation.py
 * source: cortex@ed33435 mcp_server/core/curation.py
 */

// ── Constants ──────────────────────────────────────────────────────────────

// source: cortex@ed33435 mcp_server/core/curation.py:18
const NEGATION_RE =
  /\b(not|don't|doesn't|no longer|replaced|switched from|deprecated|never|removed|stopped|avoid)\b/i;

// source: cortex@ed33435 mcp_server/core/curation.py:24 (_ACTION_RE — Python uses it
// via re.findall, i.e. all matches, so the faithful TS port is the global variant
// consumed by .match() below; a non-global copy would be dead code).
const ACTION_RE_GLOBAL =
  /\b(use|using|prefer|run|install|deploy|build|create|configure|set|enable|disable|switch|migrate)\b/gi;

// source: cortex@ed33435 mcp_server/core/curation.py:31
export const MERGE_THRESHOLD = 0.85;
// source: cortex@ed33435 mcp_server/core/curation.py:32
export const LINK_LOW = 0.6;
// source: cortex@ed33435 mcp_server/core/curation.py:33
export const LINK_HIGH = 0.85;

// ── Memify self-improvement thresholds ──────────────────────────────────────
// Python expresses these as keyword-argument defaults on the curation.py
// functions; the TS port hoists them to named constants so no bare literal
// appears at a call/comparison site (rules/coding-standards §3.1, §7 — no magic
// numbers). Values are byte-identical to the Python defaults.
const CONTRADICTION_SIMILARITY_THRESHOLD = 0.7; // source: cortex@ed33435 mcp_server/core/curation.py:121 detect_contradictions
const PRUNE_HEAT_THRESHOLD = 0.01; // source: cortex@ed33435 mcp_server/core/curation.py:144
const PRUNE_CONFIDENCE_THRESHOLD = 0.3; // source: cortex@ed33435 mcp_server/core/curation.py:145
const STRENGTHEN_MIN_ACCESS = 5; // source: cortex@ed33435 mcp_server/core/curation.py:160
const STRENGTHEN_MIN_CONFIDENCE = 0.8; // source: cortex@ed33435 mcp_server/core/curation.py:161
const STRENGTHEN_BOOST = 0.1; // source: cortex@ed33435 mcp_server/core/curation.py:162
const DEFAULT_IMPORTANCE = 0.5; // source: cortex@ed33435 mcp_server/core/curation.py:175 mem.get("importance", 0.5)
const REWEIGHT_HOT_THRESHOLD = 0.7; // source: cortex@ed33435 mcp_server/core/curation.py:186
const REWEIGHT_COLD_THRESHOLD = 0.1; // source: cortex@ed33435 mcp_server/core/curation.py:187
const REWEIGHT_HOT_BOOST = 0.5; // source: cortex@ed33435 mcp_server/core/curation.py:188
const REWEIGHT_COLD_DECAY = 0.9; // source: cortex@ed33435 mcp_server/core/curation.py:189
const DEFAULT_ENTITY_HEAT = 0.5; // source: cortex@ed33435 mcp_server/core/curation.py:197-198 entity_heats.get(..., 0.5)
const WEIGHT_ROUND_FACTOR = 1000; // round to 3 decimals — source: cortex@ed33435 mcp_server/core/curation.py:208 round(new_weight, 3)
const DERIVABLE_WEIGHT_THRESHOLD = 10.0; // source: cortex@ed33435 mcp_server/core/curation.py:215

// ── Ingestion Decisions ────────────────────────────────────────────────────

/**
 * Decide what to do when storing a memory that has similar existing ones.
 *
 * Returns one of: "merge", "link", "create".
 *
 * Port of: mcp_server/core/curation.py::decide_curation_action
 * source: cortex@ed33435 mcp_server/core/curation.py:39
 */
export function decideCurationAction(
  similarity: number,
  hasTextualOverlap: boolean,
  mergeThreshold: number = MERGE_THRESHOLD,
  linkLow: number = LINK_LOW,
): "merge" | "link" | "create" {
  if (similarity >= mergeThreshold && hasTextualOverlap) return "merge";
  if (similarity >= linkLow) return "link";
  return "create";
}

/**
 * Jaccard similarity between word sets of two texts.
 * Port of: mcp_server/core/curation.py::compute_textual_overlap
 * source: cortex@ed33435 mcp_server/core/curation.py:57
 */
export function computeTextualOverlap(contentA: string, contentB: string): number {
  // Python's re.findall(r"\b\w+\b", text) uses Unicode \w by default, matching
  // accented Latin, Cyrillic, Greek, CJK, etc. JS \w stays ASCII-only [A-Za-z0-9_]
  // EVEN WITH the `u` flag (the u flag enables \p{} escapes + surrogate handling
  // but does NOT change \w membership — verified by executing both runtimes:
  // "café 日本語" → JS /\w+/gu = ["caf"], Python \w+ = ["café","日本語"]). The
  // faithful equivalent of Unicode \w is the explicit class [\p{L}\p{N}_] under
  // the u flag (re.findall over \w+ also makes the \b anchors redundant).
  // source: cortex@ed33435 mcp_server/core/curation.py:59-60 (Unicode \w)
  const wordsA = new Set((contentA.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []));
  const wordsB = new Set((contentB.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Merge two memory contents, avoiding pure duplication.
 * Port of: mcp_server/core/curation.py::merge_contents
 * source: cortex@ed33435 mcp_server/core/curation.py:66
 */
export function mergeContents(existingContent: string, newContent: string): string {
  if (existingContent.includes(newContent.trim())) return existingContent;
  if (newContent.includes(existingContent.trim())) return newContent;
  return `${existingContent}\n${newContent}`;
}

/**
 * Union of tag sets, preserving order.
 * Port of: mcp_server/core/curation.py::merge_tags
 * source: cortex@ed33435 mcp_server/core/curation.py:75
 */
export function mergeTags(existingTags: string[], newTags: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tag of [...existingTags, ...newTags]) {
    if (!seen.has(tag)) {
      seen.add(tag);
      merged.push(tag);
    }
  }
  return merged;
}

// ── Contradiction Detection ────────────────────────────────────────────────

export interface ContradictionRecord {
  memory_id: number;
  type: "negation_mismatch" | "action_divergence";
  description: string;
  confidence_penalty: number;
}

/**
 * Check one memory for contradiction against new content signals.
 * Port of: mcp_server/core/curation.py::_check_single_contradiction
 * source: cortex@ed33435 mcp_server/core/curation.py:89
 */
function checkSingleContradiction(
  mem: Record<string, unknown>,
  newHasNegation: boolean,
  newActions: Set<string>,
): ContradictionRecord | null {
  const existingContent = String(mem["content"] ?? "");
  const existingHasNegation = NEGATION_RE.test(existingContent);
  const memId = mem["id"] as number;

  if (newHasNegation !== existingHasNegation) {
    return {
      memory_id: memId,
      type: "negation_mismatch",
      description: `Negation conflict with memory ${memId}`,
      confidence_penalty: 0.2, // source: cortex@ed33435 curation.py:103
    };
  }

  const existingActions = new Set<string>(
    (existingContent.toLowerCase().match(ACTION_RE_GLOBAL) ?? []),
  );
  if (
    newActions.size > 0 &&
    existingActions.size > 0 &&
    ![...newActions].some((a) => existingActions.has(a))
  ) {
    return {
      memory_id: memId,
      type: "action_divergence",
      description: `Different actions on similar topic (memory ${memId})`,
      confidence_penalty: 0.1, // source: cortex@ed33435 curation.py:113
    };
  }
  return null;
}

/**
 * Detect potential contradictions between new content and existing memories.
 *
 * Returns list of {memory_id, type, description, confidence_penalty}.
 *
 * Port of: mcp_server/core/curation.py::detect_contradictions
 * source: cortex@ed33435 mcp_server/core/curation.py:118
 */
export function detectContradictions(
  newContent: string,
  similarMemories: Record<string, unknown>[],
  _similarityThreshold: number = CONTRADICTION_SIMILARITY_THRESHOLD,
): ContradictionRecord[] {
  const newHasNegation = NEGATION_RE.test(newContent);
  const newActions = new Set<string>(
    (newContent.toLowerCase().match(ACTION_RE_GLOBAL) ?? []),
  );

  const contradictions: ContradictionRecord[] = [];
  for (const mem of similarMemories) {
    const result = checkSingleContradiction(mem, newHasNegation, newActions);
    if (result !== null) contradictions.push(result);
  }
  return contradictions;
}

// ── Memify Self-Improvement ────────────────────────────────────────────────

/**
 * Identify memories that should be pruned.
 *
 * Prune criteria: heat < threshold AND confidence < threshold AND access_count == 0.
 *
 * Port of: mcp_server/core/curation.py::identify_prunable
 * source: cortex@ed33435 mcp_server/core/curation.py:142
 */
export function identifyPrunable(
  memories: Record<string, unknown>[],
  heatThreshold: number = PRUNE_HEAT_THRESHOLD,
  confidenceThreshold: number = PRUNE_CONFIDENCE_THRESHOLD,
): number[] {
  return memories
    .filter(
      (m) =>
        Number(m["heat"] ?? 1.0) < heatThreshold &&
        Number(m["confidence"] ?? 1.0) < confidenceThreshold &&
        Number(m["access_count"] ?? 0) === 0,
    )
    .map((m) => m["id"] as number);
}

/**
 * Identify memories that deserve importance boost.
 *
 * Returns list of [memory_id, new_importance].
 *
 * Port of: mcp_server/core/curation.py::identify_strengtheneable
 * source: cortex@ed33435 mcp_server/core/curation.py:158
 */
export function identifyStrengheneable(
  memories: Record<string, unknown>[],
  minAccess: number = STRENGTHEN_MIN_ACCESS,
  minConfidence: number = STRENGTHEN_MIN_CONFIDENCE,
  boostAmount: number = STRENGTHEN_BOOST,
): Array<[number, number]> {
  const results: Array<[number, number]> = [];
  for (const mem of memories) {
    if (
      Number(mem["access_count"] ?? 0) >= minAccess &&
      Number(mem["confidence"] ?? 0) >= minConfidence
    ) {
      const current = Number(mem["importance"] ?? DEFAULT_IMPORTANCE);
      const newImportance = Math.min(1.0, current + boostAmount);
      if (newImportance > current) {
        results.push([mem["id"] as number, newImportance]);
      }
    }
  }
  return results;
}

/**
 * Compute relationship weight adjustments based on entity heat.
 *
 * Returns list of [relationship_id, new_weight].
 *
 * Port of: mcp_server/core/curation.py::compute_relationship_reweights
 * source: cortex@ed33435 mcp_server/core/curation.py:182
 */
export function computeRelationshipReweights(
  relationships: Record<string, unknown>[],
  entityHeats: Map<number, number>,
  hotThreshold: number = REWEIGHT_HOT_THRESHOLD,
  coldThreshold: number = REWEIGHT_COLD_THRESHOLD,
  hotBoost: number = REWEIGHT_HOT_BOOST,
  coldDecay: number = REWEIGHT_COLD_DECAY,
): Array<[number, number]> {
  const updates: Array<[number, number]> = [];
  for (const rel of relationships) {
    const srcHeat = entityHeats.get(Number(rel["source_entity_id"] ?? 0)) ?? DEFAULT_ENTITY_HEAT;
    const tgtHeat = entityHeats.get(Number(rel["target_entity_id"] ?? 0)) ?? DEFAULT_ENTITY_HEAT;
    const avgHeat = (srcHeat + tgtHeat) / 2;
    const currentWeight = Number(rel["weight"] ?? 1.0);

    if (avgHeat > hotThreshold) {
      updates.push([rel["id"] as number, Math.round((currentWeight + hotBoost) * WEIGHT_ROUND_FACTOR) / WEIGHT_ROUND_FACTOR]);
    } else if (avgHeat < coldThreshold) {
      updates.push([rel["id"] as number, Math.round(currentWeight * coldDecay * WEIGHT_ROUND_FACTOR) / WEIGHT_ROUND_FACTOR]);
    }
    // else: no update — continue source: cortex@ed33435 curation.py:204
  }
  return updates;
}

/**
 * Generate synthetic facts from high-weight relationships.
 *
 * Returns list of fact strings.
 *
 * Port of: mcp_server/core/curation.py::identify_derivable_facts
 * source: cortex@ed33435 mcp_server/core/curation.py:212
 */
export function identifyDerivableFacts(
  relationships: Record<string, unknown>[],
  entityNames: Map<number, string>,
  weightThreshold: number = DERIVABLE_WEIGHT_THRESHOLD,
): string[] {
  const facts: string[] = [];
  for (const rel of relationships) {
    if (Number(rel["weight"] ?? 0) >= weightThreshold) {
      const srcName = entityNames.get(Number(rel["source_entity_id"] ?? 0)) ?? "?";
      const tgtName = entityNames.get(Number(rel["target_entity_id"] ?? 0)) ?? "?";
      const relType = String(rel["relationship_type"] ?? "related_to");
      facts.push(
        `${srcName} and ${tgtName} are strongly linked ` +
          `(${relType}, weight=${Number(rel["weight"]).toFixed(1)})`,
      );
    }
  }
  return facts;
}
