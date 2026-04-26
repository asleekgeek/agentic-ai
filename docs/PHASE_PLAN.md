# Phase Plan

Authoritative plan for the four-repo unification. Updated as phases complete.

---

## Phase 0 — Foundation (1 day, blocking)

**Mission:** Land everything that downstream worktrees depend on, BEFORE spawning parallel work. While Day 0 is in-flight, no other worktree starts.

### Deliverables
- [x] Private repo created (`cdeust/agentic-ai`)
- [x] `README.md`
- [x] `.gitignore`
- [x] `docs/WORKTREE_MISSION_TEMPLATE.md`
- [x] `docs/PHASE_PLAN.md` (this file)
- [ ] `docs/MIGRATION_MANIFEST.md` — every artifact from every source repo, tagged
- [ ] `pnpm-workspace.yaml`
- [ ] Root `package.json`
- [ ] `tsconfig.base.json`
- [ ] `packages/core/` — domain types + ports + Zod schemas
- [ ] `packages/shared-contracts/` — cross-MCP-server schemas
- [ ] `parity-oracle/` — fixture corpus + harness for cross-language parity tests
- [ ] `scripts/spawn-worktree.sh` — creates worktree + pre-populated MISSION.md
- [ ] `.github/workflows/ci.yml` — pnpm install + build + test + parity gate
- [ ] First commit pushed to `origin/main`

### Genius gate at exit
- `architect` — package boundaries are correct, no leakage
- `liskov` + `panini` — type space is exhaustive, no public surface left undefined
- `noether` — schema migrations preserve invariants
- `coase` — package boundaries minimize cross-worktree coordination cost

---

## Phase 1 — Skeleton + CI (2 days)

**Mission:** Make the empty monorepo build, test, and lint cleanly. Single CI matrix; one tsconfig.

### Deliverables
- [ ] Each `packages/<x>/` has its own `package.json` + `tsconfig.json` extending the base
- [ ] ESLint config (flat config, single root)
- [ ] Vitest config (workspace mode)
- [ ] Layer-import lint (matches `prd-spec-generator/rules/coding-standards.md §2.2`)
- [ ] `// source:` annotation pre-commit hook (lifted from zetetic-team-subagents)
- [ ] CI matrix: Node 20, 22; pnpm 10
- [ ] Smoke test: `pnpm install && pnpm build && pnpm test` green on a fresh clone

### Genius gate
- `liskov` — port interfaces in `packages/core/src/ports/`
- `lamport` — build-order dep graph (no cycles)

---

## Phase 2 — Move TS repos preserving git history (3 days)

**Mission:** Migrate `prd-spec-generator` and `zetetic-team-subagents` into the monorepo with full commit history.

### Deliverables
- [ ] `git subtree add` (or `git filter-repo --to-subdirectory-filter`) for each repo
- [ ] `prd-spec-generator/` → `packages/prd-pipeline/` (rename `@prd-gen/*` → `@agentic/prd-*`)
- [ ] `zetetic-team-subagents/` → `packages/reasoning/`
- [ ] Verify `git log --all --format=%H | wc -l` matches sum of source repos
- [ ] All 267 prd-spec tests pass inside the monorepo

### Genius gate
- `feynman` — rederive 3 random formulas (consensus weighting, strategy scoring, validator penalty) from scratch in the new layout
- `popper` — adversarial parity tests vs the source repos

---

## Phase 3 — Wrap Rust (automatised-pipeline) as subprocess (3 days)

**Mission:** Keep the Rust binary, give it a TS adapter that implements `CodebasePort`.

### Deliverables
- [ ] `packages/codebase-rust/` — relocate Rust source under cargo workspace
- [ ] `packages/codebase/src/adapters/rust-pipeline-adapter.ts` — subprocess JSON-RPC bridge
- [ ] CI builds the Rust binary as part of the monorepo build
- [ ] Parity test: `index_codebase` on a 100-file fixture — node count, edge count, schema match exactly

### Genius gate
- `dijkstra` — stdio framing race-free, no deadlock under concurrent calls
- `lamport` — no global "now" assumption between TS host and Rust child

---

## Phase 4 — Cortex Python → TS port (parallel worktrees, ~7 days wall-clock)

**Mission:** Port every Cortex module to TS, parity-tested, dual-runnable.

### Worktree roster (one per row, all parallel after Day 0)

| Worktree branch | Source paths | TS target | Genius panel |
|---|---|---|---|
| `port/cortex-recall` | `mcp_server/handlers/recall.py`, `recall_hierarchical.py` | `packages/memory/src/recall/` | cochrane + feynman + pearl + liskov + lamport |
| `port/cortex-remember` | `mcp_server/handlers/remember*.py` | `packages/memory/src/remember/` | dijkstra + liskov + noether |
| `port/cortex-consolidation` | `mcp_server/consolidation/`, `mcp_server/decay.py` | `packages/memory/src/consolidation/` | darwin + margulis + meadows + popper |
| `port/cortex-hooks` | `mcp_server/hooks/` (5 files) | `packages/memory/src/hooks/` | lamport + hamilton + dijkstra |
| `port/cortex-methodology` | `mcp_server/methodology/`, `mcp_server/profile/` | `packages/memory/src/methodology/` | bateson + kahneman + feinstein |
| `port/cortex-graph-navigation` | `mcp_server/handlers/navigate*.py`, `graph/` | `packages/memory/src/graph/` | kekule + mandelbrot + euler |
| `port/cortex-narrative` | `mcp_server/handlers/narrative.py` | `packages/memory/src/narrative/` | propp + bruner + eco |
| `port/cortex-automation` | `mcp_server/automation/`, `mcp_server/handlers/automate.py` | `packages/memory/src/automation/` | kay + boyd + simon |
| `port/cortex-import` | `mcp_server/import/` (claude-mem, ChatGPT, Gemini, Cursor, Claude Code) | `packages/memory/src/import/` | champollion + ventris + rejewski |

### Merge order (fixed; do NOT merge out of order)

1. `port/cortex-remember`        (foundation — others write to the same persistence layer)
2. `port/cortex-recall`          (depends on remember's persistence)
3. `port/cortex-consolidation`   (operates on remember + recall outputs)
4. `port/cortex-graph-navigation` (operates on persisted graph)
5. `port/cortex-methodology`     (writes profile via remember)
6. `port/cortex-narrative`       (reads recall + methodology)
7. `port/cortex-import`          (writes via remember; isolated)
8. `port/cortex-automation`      (orchestrates all above)
9. `port/cortex-hooks`           (last — wires the orchestrator into Claude Code lifecycle)

After each merge: full parity-oracle suite must pass. Any regression blocks the next merge.

---

## Phase 5 — Unified plugin manifest + Skills (2 days)

**Mission:** One marketplace.json, four plugin entries, all Skills migrated.

### Deliverables
- [ ] `.claude-plugin/marketplace.json` with 4 plugin entries
- [ ] Per-server `.claude-plugin/<server>/plugin.json` with independent versioning
- [ ] All Skills from source repos migrated to `skills/`
- [ ] Install verified end-to-end on a fresh Claude Code session

### Genius gate
- `eco` — Model Reader of the install flow; every prereq surfaced

---

## Phase 6 — Cutover, archive old repos (4 days)

**Mission:** Switch to the unified install path; archive the four source repos.

### Deliverables
- [ ] 48-hour dual-run with zero divergence between source-repo MCPs and monorepo MCPs
- [ ] `MIGRATED.md` redirect README in each of the four source repos
- [ ] Old repos archived (not deleted) on GitHub
- [ ] Final genius cross-audit: `feynman + dijkstra + popper + cochrane + liskov + ginzburg + curie`
- [ ] `agentic-ai` flipped from private to public, relicensed MIT

### Genius gate
- `popper` — severity tests (could the new system fail in a way the old one wouldn't?)
- `borges` — exhaustive-space audit (every public symbol from every old repo accounted for)
