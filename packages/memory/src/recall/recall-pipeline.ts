/* eslint-disable @typescript-eslint/no-magic-numbers */
/**
 * Post-WRRF recall pipeline stages — affect/reconsolidation stages.
 * Part 2 of 2 (stages: EMOTIONAL_RETRIEVAL, MOOD_CONGRUENT_RERANK, RECONSOLIDATION).
 *
 * Port of: cortex main mcp_server/core/recall_pipeline.py:535-759
 *
 * These stages operate on the candidate list after HOPFIELD, HDC, SA,
 * and DENDRITIC_CLUSTERS have run (see recall-pipeline-stages.ts).
 *
 * RECONSOLIDATION is the only stage that MUTATES the store. All others
 * are pure ranking transforms.
 *
 * Pure business logic — no I/O except the bounded store writes in
 * reconsolidationApply.
 *
 * Sources:
 *   Bower, G.H. (1981). "Mood and Memory." Am. Psychologist 36(2):129-148.
 *   Hutto, C.J. & Gilbert, E. (2014). "VADER." ICWSM 2014.
 *   Nader, Schafe & LeDoux (2000). Nature 406(6797).
 *   Cormack, Clarke & Buettcher (2009). SIGIR — RRF blend.
 */

import { rrfBlend, type Candidate, type CandidateStore } from "./recall-pipeline-stages.js";
import {
  computeMismatch,
  decideAction,
} from "../consolidation/reconsolidation.js";

// ── Ablation gate ─────────────────────────────────────────────────────────

function isMechanismDisabled(mech: string): boolean {
  if (typeof process === "undefined") return false;
  return process.env[`CORTEX_ABLATE_${mech}`] === "1";
}

function envFloat(name: string, defaultVal: number): number {
  if (typeof process === "undefined") return defaultVal;
  const raw = process.env[name];
  if (raw === undefined || raw === null) return defaultVal;
  const n = parseFloat(raw);
  return isNaN(n) ? defaultVal : n;
}

// ── Constants ─────────────────────────────────────────────────────────────

// Emotional / mood-congruent rerank blend weights.
// Bower (1981) does not prescribe a numeric blend weight — these are set
// conservatively below the perception-side stages.
//
// Calibration outcome (task #50, Phase B — 25-cell 5×5 grid, n=30
// LongMemEval-S, 2026-05-02): both affect-side knobs showed zero
// observable effect on LongMemEval-S (all 25 cells tied at MRR=0.84).
// Constants are kept at the conservative engineering defaults.
// source: cortex main mcp_server/core/recall_pipeline.py:118-123

const _EMOTIONAL_RETRIEVAL_BETA = envFloat(
  "CORTEX_EMOTIONAL_RETRIEVAL_BETA",
  0.20, // source: cortex main mcp_server/core/recall_pipeline.py:119 — no effect on LME-S
);
const _MOOD_CONGRUENT_BETA = envFloat(
  "CORTEX_MOOD_CONGRUENT_BETA",
  0.15, // source: cortex main mcp_server/core/recall_pipeline.py:122 — no user-mood adapter
);

// Below this absolute compound-valence value the query is treated as
// emotionally neutral and the EMOTIONAL_RETRIEVAL stage no-ops.
// VADER (Hutto & Gilbert, ICWSM 2014) §4 reports |compound| >= 0.05 as a
// useful cutoff; we use 0.10 to avoid single weakly-loaded tokens.
// source: cortex main mcp_server/core/recall_pipeline.py:130
const _EMOTIONAL_QUERY_VALENCE_FLOOR = 0.10;

// ── VADER compound (stub) ─────────────────────────────────────────────────
// The Python path calls mcp_server.shared.vader.vader_compound which
// wraps the Python vaderSentiment library. In TS there is no equivalent
// at this layer. We return 0.0 (neutral) so the emotional/mood stages
// no-op — identical to the Python behaviour when VADER is unavailable.
// A native VADER adapter can be wired in via the VaderProvider below.

export interface VaderProvider {
  compound(text: string): number;
}

let _vaderProvider: VaderProvider | null = null;

/**
 * Register a VADER compound score provider (optional).
 * When not registered, all valence queries return 0.0 (no-op).
 */
export function registerVaderProvider(provider: VaderProvider): void {
  _vaderProvider = provider;
}

function vaderCompound(text: string): number {
  if (_vaderProvider !== null) return _vaderProvider.compound(text);
  return 0.0; // neutral — emotional stages no-op
}

// ── EMOTIONAL_RETRIEVAL stage ─────────────────────────────────────────────

/**
 * Rerank by query-valence ↔ candidate-valence congruence.
 *
 * Port of: cortex main mcp_server/core/recall_pipeline.py:542-591
 *
 * Bower (1981): emotionally-congruent material is retrieved faster and
 * more accurately than incongruent material. We infer the query's
 * affective load via VADER (Hutto & Gilbert, ICWSM 2014), measure each
 * candidate's stored emotional_valence distance from the query valence,
 * then RRF-blend that rank with the WRRF rank.
 *
 * A neutral query (|valence| < valence_floor) carries no congruence signal
 * and the stage no-ops — RRF on a uniform rank would only add noise.
 *
 * precondition: candidates is non-empty
 * postcondition: returns input unchanged when ablated or query is neutral;
 *   otherwise returns RRF-blended list sorted descending
 *
 * Constants — source: cortex main mcp_server/core/recall_pipeline.py:545-547
 *   blend_beta     = _EMOTIONAL_RETRIEVAL_BETA = 0.20
 *   valence_floor  = _EMOTIONAL_QUERY_VALENCE_FLOOR = 0.10
 */
export function emotionalRetrievalRerank(
  candidates: Candidate[],
  query: string,
  blendBeta = _EMOTIONAL_RETRIEVAL_BETA,
  valenceFloor = _EMOTIONAL_QUERY_VALENCE_FLOOR,
): Candidate[] {
  if (isMechanismDisabled("EMOTIONAL_RETRIEVAL")) return candidates;
  if (candidates.length === 0) return candidates;

  const qValence = vaderCompound(query);
  if (Math.abs(qValence) < valenceFloor) {
    // Neutral query — no useful congruence signal to inject.
    return candidates;
  }

  const distance = (c: Candidate): number => {
    const cv = (c.emotional_valence ?? 0.0) as number;
    return Math.abs(Number(cv) - qValence);
  };

  // Sort candidates by distance (closest valence = best rank)
  const byMatch = candidates
    .map((c, i) => [i, c] as [number, Candidate])
    .sort(([, a], [, b]) => distance(a) - distance(b));

  const mechRanks = new Map<number, number>(
    byMatch.map(([origIdx, ], rank) => [candidates[origIdx]?.memory_id ?? -1, rank]),
  );
  return rrfBlend(candidates, mechRanks, blendBeta);
}

// ── RECONSOLIDATION stage ─────────────────────────────────────────────────
// Nader, Schafe & LeDoux (2000), Nature 406(6797).

export interface ReconsolidationStore {
  bumpHeatRaw?(memoryId: number, newHeatBase: number): void | Promise<void>;
  updateMemoryAccess?(memoryId: number): void | Promise<void>;
  updateMemoryEmotionalValence?(memoryId: number, valence: number): void | Promise<void>;
}

interface ReconsolidationAction {
  action: string;
  heat_delta: number;
  valence_delta: number;
  update_last_accessed: boolean;
}

// ── Reconsolidation heat constants ───────────────────────────────────────
// source: cortex main mcp_server/core/reconsolidation.py:261-265
const _RECONS_HEAT_BUMP_UPDATE: number = 0.05;  // source: cortex main mcp_server/core/reconsolidation.py:261
const _RECONS_HEAT_BUMP_NONE: number = 0.02;    // source: cortex main mcp_server/core/reconsolidation.py:262 — passive retrieval touch
const _RECONS_HEAT_BUMP_ARCHIVE: number = -0.10; // source: cortex main mcp_server/core/reconsolidation.py:263
const _RECONS_VALENCE_STEP: number = 0.10;      // source: cortex main mcp_server/core/reconsolidation.py:264
const _RECONS_QUERY_VALENCE_FLOOR: number = 0.10; // source: cortex main mcp_server/core/reconsolidation.py:265

/**
 * Compute the reconsolidation action for a single candidate.
 *
 * Faithful port of cortex main mcp_server/core/reconsolidation.py:268-378
 * (compute_reconsolidation_action). Composes computeMismatch + decideAction
 * from consolidation/reconsolidation.ts and translates the abstract action
 * into concrete heat / valence / timestamp deltas.
 *
 * Precondition: c is a non-null Candidate; query is a string (may be empty).
 * Postcondition: returns ReconsolidationAction whose action is one of
 *   {"none", "update", "archive"}; heat_delta in [-0.10, +0.05];
 *   valence_delta in [-0.10, +0.10].
 *
 * source: cortex main mcp_server/core/reconsolidation.py:268-378
 */
function computeReconsolidationAction(
  c: Candidate,
  _query: string,
  qValence: number,
  _qTokens: Set<string>,
): ReconsolidationAction {
  const updateLastAccessed = true; // source: Nader (2000) — retrieval renders memories labile

  const mismatch = computeMismatch({
    embeddingSimilarity: null, // embedding similarity not available at this stage
    memoryDirectory: (c["directory"] as string | undefined) ?? "",
    currentDirectory: "",
    memoryLastAccessed: (c["last_accessed"] as string | undefined) ?? null,
    memoryTags: new Set(
      Array.isArray(c.tags) ? (c.tags as string[]) : (typeof c.tags === "string" ? [c.tags as string] : []),
    ),
    contextTokens: new Set<string>(),
  });

  const decision = decideAction(
    mismatch,
    (c["stability"] as number | undefined) ?? 0.0,
    (c["plasticity"] as number | undefined) ?? 1.0,
    (c["is_protected"] as boolean | undefined) ?? false,
    Math.abs((c.emotional_valence as number | undefined) ?? 0.0),
    (c["age_days"] as number | undefined) ?? 0.0,
  );

  if (decision.action === "archive") {
    return {
      action: "archive",
      heat_delta: _RECONS_HEAT_BUMP_ARCHIVE,
      valence_delta: 0.0,
      update_last_accessed: updateLastAccessed,
    };
  }

  if (decision.action === "update") {
    // Heat bump scaled by emotional_multiplier (Yonelinas & Ritchey 2015)
    const heatDelta = Math.min(
      _RECONS_HEAT_BUMP_UPDATE * 2.0,
      _RECONS_HEAT_BUMP_UPDATE * decision.emotionalMultiplier,
    );
    let valenceDelta = 0.0;
    // Bower (1981): retrieval context's affective load shifts re-stored emotional tag.
    // source: cortex main mcp_server/core/reconsolidation.py:351-356
    if (Math.abs(qValence) >= _RECONS_QUERY_VALENCE_FLOOR) {
      const sign = qValence > 0 ? 1.0 : -1.0;
      valenceDelta = sign * _RECONS_VALENCE_STEP;
    }
    return {
      action: "update",
      heat_delta: heatDelta,
      valence_delta: valenceDelta,
      update_last_accessed: updateLastAccessed,
    };
  }

  // action === "none" — passive retrieval: still applies +0.02 heat touch.
  // source: cortex main mcp_server/core/reconsolidation.py:366-378
  return {
    action: "none",
    heat_delta: _RECONS_HEAT_BUMP_NONE,
    valence_delta: 0.0,
    update_last_accessed: updateLastAccessed,
  };
}

/**
 * Apply Nader-2000 reconsolidation to the top-K retrieved candidates.
 *
 * Port of: cortex main mcp_server/core/recall_pipeline.py:607-708
 *
 * For each candidate (up to top_k, default = all): compute the
 * reconsolidation action, then apply the resulting heat / valence /
 * last_accessed deltas to the store.
 *
 * The candidate list itself is returned unchanged in shape; in-place
 * mutation of the candidate objects reflects the new heat / valence values.
 *
 * Store contract — uses only methods already on PgMemoryStore:
 *   bumpHeatRaw(memory_id, new_heat_base)
 *   updateMemoryAccess(memory_id)
 *   updateMemoryEmotionalValence(memory_id, valence) — optional
 *
 * A store stub lacking any of these methods → that mutation is silently
 * skipped. Failures inside individual store calls are caught per-candidate.
 *
 * precondition: candidates is non-empty; store is non-null
 * postcondition: candidates list returned with updated heat/valence values;
 *   store state modified via bounded mutations; returns input unchanged when
 *   ablated or store is null
 */
export async function reconsolidationApply(
  candidates: Candidate[],
  query: string,
  store: (CandidateStore & ReconsolidationStore) | null,
  topK?: number,
): Promise<Candidate[]> {
  if (isMechanismDisabled("RECONSOLIDATION")) return candidates;
  if (candidates.length === 0) return candidates;
  if (store === null) return candidates;

  const qValence = vaderCompound(query);
  const qTokens = new Set<string>(
    (query ?? "")
      .split(/\s+/)
      .map((t) => t.replace(/[.,!?;:()[\]{}"'`]/g, "").toLowerCase())
      .filter((t) => t.length > 2),
  );

  const limit =
    topK === undefined ? candidates.length : Math.min(topK, candidates.length);
  const hasBump = typeof store.bumpHeatRaw === "function";
  const hasAccess = typeof store.updateMemoryAccess === "function";
  const hasValence = typeof store.updateMemoryEmotionalValence === "function";

  for (let i = 0; i < limit; i++) {
    const c = candidates[i];
    if (!c) continue;
    let outcome: ReconsolidationAction;
    try {
      outcome = computeReconsolidationAction(c, query, qValence, qTokens);
    } catch {
      continue; // non-load-bearing per-candidate
    }

    if (outcome.action === "none" && outcome.heat_delta === 0.0) continue;

    // Heat: clamp to [0, 1], write through bumpHeatRaw
    if (hasBump && outcome.heat_delta !== 0.0) {
      try {
        const curHeat = (c.heat as number | undefined) ?? 0.5;
        const newHeat = Math.max(0.0, Math.min(1.0, Number(curHeat) + outcome.heat_delta));
        await store.bumpHeatRaw?.(c.memory_id, newHeat);
        (candidates[i] as Candidate).heat = newHeat;
      } catch { /* non-load-bearing */ }
    }

    // last_accessed + access_count refresh
    if (hasAccess && outcome.update_last_accessed) {
      try {
        await store.updateMemoryAccess?.(c.memory_id);
      } catch { /* non-load-bearing */ }
    }

    // Optional valence shift — Bower 1981 mood-congruent re-storage
    if (hasValence && outcome.valence_delta !== 0.0) {
      try {
        const curVal = (c.emotional_valence as number | undefined) ?? 0.0;
        const newVal = Math.max(-1.0, Math.min(1.0, Number(curVal) + outcome.valence_delta));
        await store.updateMemoryEmotionalValence?.(c.memory_id, newVal);
        (candidates[i] as Candidate).emotional_valence = newVal;
      } catch { /* non-load-bearing */ }
    }
  }

  return candidates;
}

// ── MOOD_CONGRUENT_RERANK stage ───────────────────────────────────────────

/**
 * Rerank by user-mood ↔ candidate-valence congruence.
 *
 * Port of: cortex main mcp_server/core/recall_pipeline.py:718-759
 *
 * userMood is a float in [-1, +1] representing the user's current
 * affective state. When null, the stage no-ops: we do NOT fabricate a
 * mood signal in the absence of one.
 *
 * Distinct from EMOTIONAL_RETRIEVAL: this stage uses a USER session-level
 * mood signal, not the per-query valence.
 *
 * precondition: userMood is in [-1, +1] or null
 * postcondition: returns input unchanged when ablated or userMood is null;
 *   otherwise returns RRF-blended list sorted descending
 *
 * Constants — source: cortex main mcp_server/core/recall_pipeline.py:722
 *   blend_beta = _MOOD_CONGRUENT_BETA = 0.15
 */
export function moodCongruentRerank(
  candidates: Candidate[],
  userMood: number | null,
  blendBeta = _MOOD_CONGRUENT_BETA,
): Candidate[] {
  if (isMechanismDisabled("MOOD_CONGRUENT_RERANK")) return candidates;
  if (userMood === null || candidates.length === 0) return candidates;

  const userMoodF = Number(userMood);

  const distance = (c: Candidate): number => {
    const cv = (c.emotional_valence ?? 0.0) as number;
    return Math.abs(Number(cv) - userMoodF);
  };

  const byMatch = candidates
    .map((c, i) => [i, c] as [number, Candidate])
    .sort(([, a], [, b]) => distance(a) - distance(b));

  const mechRanks = new Map<number, number>(
    byMatch.map(([origIdx, ], rank) => [candidates[origIdx]?.memory_id ?? -1, rank]),
  );
  return rrfBlend(candidates, mechRanks, blendBeta);
}

// Re-export constants for testing
export {
  _EMOTIONAL_RETRIEVAL_BETA as EMOTIONAL_RETRIEVAL_BETA,
  _MOOD_CONGRUENT_BETA as MOOD_CONGRUENT_BETA,
  _EMOTIONAL_QUERY_VALENCE_FLOOR as EMOTIONAL_QUERY_VALENCE_FLOOR,
};
