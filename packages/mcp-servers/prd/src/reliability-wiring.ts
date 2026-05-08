/**
 * Reliability wiring — composition-root helpers for the
 * ConsensusReliabilityProvider port (Wave D2).
 *
 * Layer contract (§2.2):
 *   mcp-server (composition root) → benchmark (adapter) → core (port)
 *   This is the ONLY file in mcp-server that imports @agentic/prd-benchmark.
 *
 * source: prd-spec-generator/packages/mcp-server/src/reliability-wiring.ts
 * source: docs/PHASE_4_PLAN.md §4.1; Wave D2 deliverable D2.4 / D2.6.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  tryCreateReliabilityRepository,
  RELIABILITY_SCHEMA_VERSION,
  type ConsensusReliabilityProvider,
  type ReliabilityRepository,
} from "@agentic/prd-core";
import { BenchmarkConsensusReliabilityProvider } from "@agentic/prd-benchmark";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Default path for the reliability SQLite DB.
 * source: docs/PHASE_4_PLAN.md §4.1 Persistence — "~/.prd-gen/reliability.db"
 */
const DEFAULT_RELIABILITY_DB_PATH = join(homedir(), ".prd-gen", "reliability.db");

// ─── Lazy singleton ───────────────────────────────────────────────────────────

let _reliabilityRepo: ReliabilityRepository | null | undefined = undefined;
let _reliabilityProvider: ConsensusReliabilityProvider | null | undefined = undefined;

/**
 * Lazy-init the SqliteReliabilityRepository.
 *
 * Precondition: none (gracefully returns null when better-sqlite3 is absent).
 * Postcondition: returns the same instance on subsequent calls (lazy singleton).
 */
export function getReliabilityRepo(): ReliabilityRepository | null {
  if (_reliabilityRepo === undefined) {
    _reliabilityRepo = tryCreateReliabilityRepository(DEFAULT_RELIABILITY_DB_PATH);
  }
  return _reliabilityRepo;
}

/**
 * Lazy-init the BenchmarkConsensusReliabilityProvider.
 *
 * Precondition: none (returns null when the repository is unavailable).
 * Backward-compat invariant: when null is returned, consensus falls back to
 *   the Beta(7,3) prior mean for all (judge × claim_type) cells.
 */
export function getConsensusReliabilityProvider(): ConsensusReliabilityProvider | null {
  if (_reliabilityProvider === undefined) {
    const repo = getReliabilityRepo();
    _reliabilityProvider =
      repo !== null ? new BenchmarkConsensusReliabilityProvider(repo) : null;
  }
  return _reliabilityProvider as ConsensusReliabilityProvider | null;
}

/**
 * Release the reliability DB connection on graceful shutdown.
 * Idempotent — safe to call multiple times or before first use.
 *
 * source: Wave D2.C step 4 — teardown path.
 */
export function closeReliabilityRepo(): void {
  if (_reliabilityRepo !== null && _reliabilityRepo !== undefined) {
    _reliabilityRepo.close();
  }
  _reliabilityRepo = null;
  _reliabilityProvider = null;
}

// ─── Health check (D2.6) ─────────────────────────────────────────────────────

export interface ReliabilityHealthResult {
  readonly healthy: boolean;
  readonly schemaVersion: number | null;
  readonly recordCount: number | null;
  readonly message: string;
}

/**
 * Startup health check for the reliability DB.
 *
 * source: Wave D2 deliverable D2.6.
 */
export function checkReliabilityHealth(): ReliabilityHealthResult {
  const repo = getReliabilityRepo();

  if (repo === null) {
    return {
      healthy: false,
      schemaVersion: null,
      recordCount: null,
      message:
        "reliability.db unavailable: better-sqlite3 not installed or DB failed to open. " +
        "Consensus will use Beta(7,3) prior fallback for all (judge × claim_type) cells.",
    };
  }

  let schemaVersion: number;
  try {
    schemaVersion = repo.getSchemaVersion();
  } catch (err) {
    return {
      healthy: false,
      schemaVersion: null,
      recordCount: null,
      message:
        `reliability.db schema check failed: ${String(err)}. ` +
        "If schema_version is 1 (pre-rename DB), delete ~/.prd-gen/reliability.db " +
        "and restart — see README §reliability-db for migration instructions.",
    };
  }

  if (schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
    return {
      healthy: false,
      schemaVersion,
      recordCount: null,
      message:
        `reliability.db schema version mismatch: DB has version ${schemaVersion}, ` +
        `implementation expects version ${RELIABILITY_SCHEMA_VERSION}. ` +
        "Delete ~/.prd-gen/reliability.db and restart — see README §reliability-db.",
    };
  }

  const records = repo.getAllRecords();
  const recordCount = records.length;

  if (recordCount === 0) {
    console.error(
      "[prd-gen] reliability.db: no calibrated reliabilities yet — " +
        "consensus using Beta(7,3) prior fallback for all (judge × claim_type) cells.",
    );
  }

  return {
    healthy: true,
    schemaVersion,
    recordCount,
    message:
      recordCount === 0
        ? "reliability.db is empty — consensus using Beta(7,3) prior fallback."
        : `reliability.db healthy: ${recordCount} calibrated (judge × claim_type × direction) cells.`,
  };
}
