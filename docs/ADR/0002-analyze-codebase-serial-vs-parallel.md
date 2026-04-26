# ADR-0002 — `analyze_codebase` serial queue vs parallel adapter pool

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/inventory-automatised-pipeline` (ADR-002 in MISSION.md)
**Affects:** Phase 3 — Rust adapter concurrency model

## Context

`analyze_codebase` on a 5 000-file repository can run for 60–180 s. The
default Phase-3 adapter design uses a single Rust subprocess + a serial
in-flight queue, so all other `CodebasePort` calls block for the duration
of a long `analyze_codebase`.

In a single-user dev workflow this is fine. In a multi-tenant orchestrator
(e.g. agentic-ai running multiple PRD pipelines concurrently against the
same codebase graph) it produces unacceptable head-of-line blocking.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Serial single-process queue | Simplest; deterministic; matches Rust binary's natural assumption | HoL blocking; one slow caller stalls everyone |
| B. Per-call subprocess spawn | No HoL; full isolation | Spawn cost (~50–200 ms) on every call; doesn't share graph cache |
| C. Adapter pool (N persistent subprocesses, round-robin) | Bounded concurrency; amortises spawn; no HoL | Memory cost of N graph caches; cache coherence problems |
| D. Single subprocess + concurrent in-flight, trust Rust binary's tokio runtime | Lowest overhead | Requires verifying the Rust binary handles concurrent JSON-RPC; the source uses `tokio::main` so it CAN, but tool handlers may not be `&mut self`-safe |

## Decision

**Option A (serial queue) for Phase 3 launch. Re-evaluate in Phase 6+ if
real workloads show HoL blocking.**

Rationale:
- Cortex memory operations dominate the latency budget; codebase queries
  are infrequent and tolerate seconds of queueing.
- The Rust binary's `analyze_codebase` is checkpointed (writes intermediate
  graph state) so a long call can be cancelled without graph corruption,
  giving us a clean escape hatch later.
- Option D was investigated by reading `src/main.rs` (commit `cf85cfc` of
  cdeust/automatised-pipeline) — the dispatcher is tokio-async but tool
  handlers acquire a global `RwLock<GraphState>`. Concurrent calls
  serialise on the lock anyway. Adding parallelism on the TS side gains
  nothing.

## Consequences

- **Adapter contract:** the `CodebasePort` documents that all methods are
  serialised at the adapter level. Callers needing parallelism must spawn
  multiple adapter instances (Option C done at the orchestrator level,
  not inside the adapter).
- **Test plan:** queue-fairness test — issue 3 fast calls + 1 slow
  `analyze_codebase` interleaved; assert the 3 fast calls complete in
  FIFO order after the slow one, and none time out (so the adapter's
  outer timeout must accommodate worst-case queue depth).
- **Future migration to Option C:** when triggered, requires (1) per-instance
  graph-path argument so caches don't conflict, (2) a queue-aware load
  balancer at the orchestrator, (3) reconciliation if two instances index
  the same path at the same time.

## Verification

- Integration test: `packages/codebase/__tests__/serial-queue.parity.test.ts`
- Telemetry: emit `adapter.queue.depth` and `adapter.queue.wait_ms` so a
  real-workload signal can flag when Option C becomes necessary.
