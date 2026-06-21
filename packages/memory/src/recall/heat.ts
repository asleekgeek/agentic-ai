/**
 * Heat-base decay computation for memory thermodynamics.
 *
 * Heat is the primary thermodynamic signal that measures a memory's
 * relevance/importance. It decays over time (Ebbinghaus forgetting curve).
 * Access-boost via hippocampal replay (McClelland 1995) is NOT implemented
 * in this file; that mechanism lives in the Python mcp_server only.
 *
 * Port of: portions of mcp_server/core/decay_cycle.py
 *          mcp_server/core/thermodynamics.py (session coherence)
 *
 * Pure logic — no I/O.
 */

// ── Ebbinghaus decay ──────────────────────────────────────────────────────
// source: Ebbinghaus, H. (1885). "Über das Gedächtnis." r(t) = exp(-t/S)
// source: half-life tuned to the Cortex 30-day consolidation window

const EBBINGHAUS_HALF_LIFE_DAYS = 30;

/**
 * Compute the Ebbinghaus forgetting-curve retention for elapsed time.
 *
 * r(t) = exp(-t / S)  where S = EBBINGHAUS_HALF_LIFE_DAYS
 *
 * Returns a value in (0, 1] — 1.0 at t=0, decays toward 0.
 *
 * source: Ebbinghaus, H. (1885). "Über das Gedächtnis." r(t) = exp(-t/S)
 * source: half-life tuned to the Cortex 30-day consolidation window
 */
export function ebbinghausRetention(elapsedDays: number): number {
  if (elapsedDays < 0) return 1.0;
  return Math.exp(-elapsedDays / EBBINGHAUS_HALF_LIFE_DAYS);
}

/**
 * Compute the per-hour exponential decay factor.
 *
 * The legacy decay cycle ran ~daily and applied factor 0.95 per run.
 * A3 migration converted this to continuous per-hour equivalent:
 *
 *   p_factor = 0.95^(1/24) ≈ 0.99787
 *
 * This preserves the macroscopic decay rate while making the function
 * continuous in elapsed hours.
 *
 * source: docs/program/phase-3-a3-migration-design.md §2.
 * source: parity with mcp_server/core/thermodynamics.py:51 (_DECAY_FACTOR_DEFAULT = 0.95);
 *         per-hour conversion 0.95^(1/24) ≈ 0.99787 is applied here, Python applies the
 *         daily factor directly in compute_decay().
 */
// source: 0.95^(1/24) ≈ 0.99787 — phase-3-a3-migration-design.md §2
// source: parity with mcp_server/core/thermodynamics.py:51 (decay_factor=0.95 default)
const PER_HOUR_DECAY_FACTOR = 0.99787;

// Default permastore heat floor for CONSOLIDATED memories.
// source: parity with mcp_server/core/decay_cycle.py:16 (CONSOLIDATED: floor = 0.10)
const HEAT_FLOOR_DEFAULT = 0.1;

/**
 * Apply exponential heat decay over a number of elapsed hours.
 * Returns the new heat value, floored at the permastore heat floor.
 *
 * source: parity with mcp_server/core/decay_cycle.py::_compute_single_decay — note: stage
 *         multiplier is NOT ported here; this function uses a fixed decay rate. Full
 *         stage-adjusted logic lives in decay_cycle.py.
 * source: Enforce permastore floor (Bahrick 1984)
 */
export function applyHeatDecay(
  heatBase: number,
  elapsedHours: number,
  heatFloor = HEAT_FLOOR_DEFAULT,
): number {
  // source: Enforce permastore floor (Bahrick 1984)
  const decayed = heatBase * Math.pow(PER_HOUR_DECAY_FACTOR, elapsedHours);
  return Math.max(decayed, heatFloor);
}

// ── Session coherence constants ───────────────────────────────────────────

// Milliseconds per hour: 3600 s * 1000 ms/s.
// source: parity with mcp_server/core/decay_cycle.py:98 (hours = total_seconds / 3600)
const MS_PER_HOUR = 3_600_000;

// Default coherence bonus applied within session window.
// TS port uses 0.1 (Python compute_session_coherence uses 0.2 at thermodynamics.py:302;
// the TS port deliberately uses a smaller bonus — no paper source, engineering decision).
const SESSION_COHERENCE_BONUS_DEFAULT = 0.1;

// Default session window in hours.
// source: parity with mcp_server/core/thermodynamics.py:303 (window_hours: float = 4.0)
const SESSION_COHERENCE_WINDOW_HOURS_DEFAULT = 4;

// ── Session coherence boost ───────────────────────────────────────────────

/**
 * Compute effective heat with session-coherence bonus.
 *
 * Within a recent time window, memories that were created or accessed
 * get a coherence bonus — they are contextually relevant to the current
 * session. This is a simplified port; the full version lives in
 * mcp_server/core/thermodynamics.py::compute_session_coherence.
 *
 * Port of: mcp_server/core/thermodynamics.py::compute_session_coherence
 */
export function computeSessionCoherence(
  heat: number,
  createdAt: string,
  bonus = SESSION_COHERENCE_BONUS_DEFAULT,
  windowHours = SESSION_COHERENCE_WINDOW_HOURS_DEFAULT,
): number {
  if (!createdAt) return heat;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return heat;
  const elapsedHours = (Date.now() - createdMs) / MS_PER_HOUR;
  if (elapsedHours <= windowHours) {
    return Math.min(1.0, heat + bonus);
  }
  return heat;
}

// ── Recency boost constants ───────────────────────────────────────────────

// Milliseconds per day: 86400 s * 1000 ms/s.
// source: parity with mcp_server/core/temporal.py:221 (age_days = total_seconds / 86400)
const MS_PER_DAY = 86_400_000;

// Default maximum recency boost amplitude.
// TS port uses 0.3 (Python compute_recency_boost uses 0.15 at temporal.py:199;
// the TS port uses a different value — no paper source, engineering decision).
const RECENCY_BOOST_MAX_DEFAULT = 0.3;

// Default half-life for recency boost in days.
// TS port uses 7 days (Python uses 30 days at temporal.py:200;
// the TS port uses a shorter half-life — engineering decision).
const RECENCY_BOOST_HALFLIFE_DAYS_DEFAULT = 7;

// Default cutoff beyond which recency boost is zero, in days.
// TS port uses 30 days (Python uses 90 days at temporal.py:201;
// the TS port uses a shorter cutoff — engineering decision).
const RECENCY_BOOST_CUTOFF_DAYS_DEFAULT = 30;

// ── Recency boost ─────────────────────────────────────────────────────────

/**
 * Exponential recency boost for a memory based on its creation timestamp.
 *
 * Port of: mcp_server/core/temporal.py::compute_recency_boost
 */
export function computeRecencyBoost(
  createdAt: string,
  boostMax = RECENCY_BOOST_MAX_DEFAULT,
  halflifeDays = RECENCY_BOOST_HALFLIFE_DAYS_DEFAULT,
  cutoffDays = RECENCY_BOOST_CUTOFF_DAYS_DEFAULT,
): number {
  if (!createdAt) return 0;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 0;
  const elapsedDays = (Date.now() - createdMs) / MS_PER_DAY;
  if (elapsedDays > cutoffDays) return 0;
  return boostMax * Math.exp((-elapsedDays * Math.LN2) / halflifeDays);
}
