/**
 * `buildConcludeOpts` — extracted to keep index.ts under the §4.1 500-LOC cap.
 *
 * Encapsulates four concerns of the `conclude_verification` MCP tool:
 *   1. Reliability-repo lookup + provider hookup (D2 wiring).
 *   2. Curie A3 loud-warn when `claim_types` is omitted (one-sided censoring guard).
 *   3. CC-3 observation flusher (B4 control-arm write semantics).
 *   4. ConsensusConfig wiring (strategy, runId, claimTypes).
 *
 * Oracle resolution (external_grounding → invokeOracle) is intentionally
 * omitted at this composition root. The calibration sub-path
 * (@agentic/prd-benchmark/calibration) contains calibrate-gates-production.ts
 * which uses top-level await and is incompatible with esbuild ESM bundling.
 * oracle_resolved_truth is left undefined, which triggers the consensus-majority
 * fallback path — the same behaviour as OracleUnavailableError in the source
 * server. This is a documented residual (TODO: resolve when calibration
 * sub-path no longer uses top-level await).
 * // LSP-NOTE: postcondition weakened vs source (oracle_resolved_truth always
 * //   undefined here vs conditionally resolved in source). Acceptable degradation:
 * //   calibration quality is affected but pipeline correctness is preserved.
 *
 * source: prd-spec-generator/packages/mcp-server/src/build-conclude-opts.ts
 * source: Wave D code-reviewer extraction; coding-standards.md §4.1.
 */

import type { Claim } from "@agentic/prd-core";
import {
  appendObservationLog,
  JUDGE_OBSERVATION_LOG_PATH,
} from "@agentic/prd-benchmark";
import {
  type ConcludeOptions,
} from "@agentic/prd-verification";
import {
  getReliabilityRepo,
  getConsensusReliabilityProvider,
} from "./reliability-wiring.js";

export interface BuildConcludeOptsInput {
  readonly consensus_strategy: ConcludeOptions["strategy"];
  readonly run_id?: string;
  readonly claim_types?: Record<string, string>;
  readonly claims?: ReadonlyMap<string, Claim>;
}

export function buildConcludeOpts(input: BuildConcludeOptsInput): ConcludeOptions {
  const { consensus_strategy, run_id, claim_types, claims } = input;
  const reliabilityRepo = getReliabilityRepo();
  const reliabilityProvider = getConsensusReliabilityProvider();

  // B5 — Loud diagnostic when claim_types omitted (Curie A3).
  if (claim_types === undefined && reliabilityRepo !== null) {
    console.error(
      "[reliability] WARNING: conclude_verification called without claim_types" +
      " — observations will NOT be flushed to the calibration repository for" +
      " this batch. This may produce one-sided censoring across runs.",
    );
  }

  const claimTypesMap = claim_types !== undefined
    ? new Map(Object.entries(claim_types) as [string, string][])
    : undefined;

  // CC-3 control-arm semantics:
  // - onObservation fires on ALL runs (write-side contributes prior-weighted
  //   ground-truth observations to the calibration pool).
  // source: Curie cross-audit Wave D, A1 anomaly resolution.
  const onObservation = reliabilityRepo !== null && claimTypesMap !== undefined
    ? (obs: Parameters<NonNullable<ConcludeOptions["onObservation"]>>[0]) => {
        void (async () => {
          try {
            reliabilityRepo.recordObservation(
              obs.judge,
              obs.claimType,
              obs.observation,
            );

            const judgeVerdictIsPass = !obs.observation.groundTruthIsFail
              ? obs.observation.judgeWasCorrect
              : !obs.observation.judgeWasCorrect;

            // Oracle resolution omitted — see module-level comment above.
            // oracle_resolved_truth remains undefined → consensus-majority fallback.
            const oracle_resolved_truth: boolean | undefined = undefined;
            const oracle_evidence: string | undefined = undefined;

            appendObservationLog(
              {
                run_id: run_id ?? "unknown",
                judge_id: { kind: obs.judge.kind, name: obs.judge.name },
                claim_id: obs.claim_id,
                claim_type: obs.claimType,
                judge_verdict: judgeVerdictIsPass,
                judge_confidence: 0,
                ground_truth: obs.observation.groundTruthIsFail,
                oracle_resolved_truth,
                oracle_evidence,
              },
              JUDGE_OBSERVATION_LOG_PATH,
            );
          } catch {
            // Best-effort: observation persistence must not break the pipeline.
          }
        })();
      }
    : undefined;

  return {
    strategy: consensus_strategy,
    reliabilityProvider: reliabilityProvider ?? undefined,
    runId: run_id,
    claimTypes: claimTypesMap as
      | ReadonlyMap<string, Claim["claim_type"]>
      | undefined,
    claims,
    onObservation,
  };
}
