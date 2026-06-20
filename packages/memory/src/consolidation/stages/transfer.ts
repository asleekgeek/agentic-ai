/**
 * Two-stage transfer stage: hippocampal → cortical memory transfer.
 *
 * Runs during deep-sleep consolidation. Calls updateHippocampalDependency
 * for memories with high replay counts and sufficient dependency to reduce.
 *
 * Port of: mcp_server/handlers/consolidation/transfer.py
 */

import { updateHippocampalDependency, shouldReleaseHippocampalTrace } from "../two-stage-model.js";

// ── Configuration ──────────────────────────────────────────────────────────────

// Maximum number of transfer candidates fetched per run.
// TS-only sentinel; not present in Cortex Python (the Python two_stage_model.py
// select_replay_candidates defaults to max_candidates=10 for in-memory scoring,
// but the DB query limit is defined here at the handler level). No paper source.
// default-limit-sentinel-epsilon; not in Cortex py (TS-only), no paper.
const TRANSFER_CANDIDATE_LIMIT = 200;

// Default hippocampal dependency when field is absent. Mirrors the Python
// default used throughout two_stage_model.py (e.g. mem.get("hippocampal_dependency", 1.0)
// for replay scoring) and two_stage_transfer.py compute_transfer_delta signature.
// default-limit-sentinel-epsilon; not in Cortex py as a named constant (TS-only), no paper.
const DEFAULT_HIPPOCAMPAL_DEPENDENCY = 1.0;

// Default importance when field is absent.
// source: port of core/two_stage_transfer.py:L57 (`importance: float = 0.5`);
// default-limit-sentinel-epsilon, no paper.
const DEFAULT_IMPORTANCE = 0.5;

// Minimum absolute change in hippocampal dependency required to issue a DB write.
// Avoids spurious writes when the dependency change is negligible. The Python
// update_hippocampal_dependency rounds to 4 decimal places (two_stage_transfer.py:L124),
// so the smallest representable change is 0.0001; this threshold is one order of
// magnitude larger. TS-only guard; not present in Cortex py, no paper.
const MIN_DEPENDENCY_DELTA = 0.001;

// Default heat when field is absent.
// source: port of core/two_stage_model.py:L245 (`mem.get("heat", 0.5)`);
// default-limit-sentinel-epsilon, no paper.
const DEFAULT_HEAT = 0.5;

export interface TransferStore {
  getTransferCandidates(limit: number): Promise<Record<string, unknown>[]>;
  updateHippocampalDependency(id: number, dependency: number): Promise<void>;
}

export interface TransferStageResult {
  transferred: number;
  released: number;
  scanned: number;
  duration_ms?: number;
}

/**
 * Run hippocampal-cortical transfer for memories with replay history.
 *
 * // source: McClelland JL et al. (1995) complementary learning systems.
 * // source: Ketz NA et al. (2023) C-HORSE cortical LR = 0.02. eLife 12:e77185.
 */
export async function runTwoStageTransfer(store: TransferStore): Promise<TransferStageResult> {
  const candidates = await store.getTransferCandidates(TRANSFER_CANDIDATE_LIMIT);
  let transferred = 0;
  let released = 0;

  for (const mem of candidates) {
    const dep = (mem["hippocampal_dependency"] as number | undefined) ?? DEFAULT_HIPPOCAMPAL_DEPENDENCY;
    const replayCount = (mem["replay_count"] as number | undefined) ?? 0;
    const schemaMatch = (mem["schema_match_score"] as number | undefined) ?? 0.0;
    const importance = (mem["importance"] as number | undefined) ?? DEFAULT_IMPORTANCE;

    const newDep = updateHippocampalDependency(dep, replayCount, schemaMatch, importance);

    if (Math.abs(newDep - dep) > MIN_DEPENDENCY_DELTA) {
      await store.updateHippocampalDependency(mem["id"] as number, newDep);
      transferred++;

      const stage = (mem["consolidation_stage"] as string | undefined) ?? "labile";
      const heat = (mem["heat"] as number | undefined) ?? DEFAULT_HEAT;
      if (shouldReleaseHippocampalTrace(newDep, stage, heat)) {
        released++;
      }
    }
  }

  return { transferred, released, scanned: candidates.length };
}
