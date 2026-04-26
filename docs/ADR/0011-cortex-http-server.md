# ADR-0011 — Cortex HTTP server / 3D dashboard: defer to post-cutover

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/inventory-cortex` finding F-005 (15 files, 3 668 LOC under `mcp_server/server/` with no Phase-4 owner)
**Affects:** Phase 4 worktree roster; Phase 6 cutover scope

## Context

Cortex ships a FastAPI/Starlette HTTP server (15 files, 3 668 LOC) that
exposes a 3D D3/Three.js graph visualisation, a wiki viewer, and a
file-diff viewer. It is launched via `python -m mcp_server.server.http_launcher`
and is OPTIONAL — the core MCP-over-stdio install does not require it.

The original Phase-4 plan did not include a worktree for this subsystem.
A naive port (TypeScript with Express + a separate frontend bundle) is
2–3 person-weeks of work and crosses domain boundaries (the dashboard
mixes memory, wiki, and codebase-graph data — all four monorepo packages
are involved).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Add as worktree #14 in Phase 4 | Feature parity at cutover | Adds 2–3 weeks to the critical path; introduces frontend tooling (vite/esbuild bundling, D3, Three.js) into a monorepo whose other packages are pure backend |
| B. Defer to post-Phase-6 hardening | Cutover stays focused on MCP correctness | A user who currently uses the dashboard sees a regression at cutover |
| C. Discard — declare the dashboard out of scope | Simplest plan | Loss of a working feature; user backlash |

## Decision

**Option B (defer).** The HTTP server is a follow-up post-cutover phase.

Rationale:
- The core value of Cortex (memory recall, hooks, methodology) is
  delivered through MCP-over-stdio. The HTTP dashboard is a UX layer;
  not on the critical path of "agent does work using memory."
- Mixed-domain bundling: the dashboard reads from memory, wiki, AND
  codebase-graph. Forcing this dependency cross-cut into Phase 4 would
  push the merge order from 13 worktrees to 14 with new cross-package
  type contracts that aren't required by the MCP install.
- Pre-cutover comms: at Phase 6 cutover, the announcement explicitly
  documents that the HTTP dashboard is temporarily unavailable in the
  unified install and will be restored in v0.4.x of the `memory` plugin.
- Reversibility: the source repo's HTTP server keeps working until the
  source repos are archived. Users who depend on it can stay on the
  source repo until the post-cutover port lands.

## Consequences

- Phase 4 stays at 13 worktrees (per the updated `docs/PHASE_PLAN.md` §4).
- A new section in `docs/PHASE_PLAN.md` is added: **Phase 7 — Post-cutover
  port: Cortex HTTP dashboard.** Estimated 2–3 weeks. Genius panel:
  `engelbart` (augment human capability) + `kekule` (graph visualization)
  + `eco` (Model Reader of dashboard UX).
- Cutover communication: the `MIGRATED.md` redirect README in the Cortex
  source repo explicitly notes that users who need the HTTP dashboard
  should remain on the source repo until v0.4.x of the unified `memory`
  plugin is published.

## Verification

- Phase 6 cutover gate: the unified `memory` plugin's documentation
  includes a "Known limitations" section listing the HTTP dashboard
  deferral.
- Phase 7 entry criterion: ≥2 user requests for the HTTP dashboard in
  the agentic-ai issue tracker post-cutover. If demand is zero after
  one quarter, the deferral upgrades to a full discard (Option C above)
  and this ADR is updated to "Superseded by ADR-XXXX (discard HTTP server)".
