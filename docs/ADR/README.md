# Architecture Decision Records

Each ADR captures one decision with its context, options considered, and
consequences. ADRs are numbered sequentially and never edited after
acceptance — superseded ADRs link forward to their replacement.

## Index

| # | Title | Status | Phase |
|---|---|---|---|
| [0001](0001-lsp-resolve-subprocess-chain.md) | `lsp_resolve` subprocess chain timeout + signal propagation | Accepted | 3 |
| [0002](0002-analyze-codebase-serial-vs-parallel.md) | `analyze_codebase` serial queue vs parallel adapter pool | Accepted | 3 |
| [0003](0003-adapter-precondition-strength.md) | Adapter preconditions must NOT be stronger than the Rust binary | Accepted | 3 |
| [0004](0004-validation-tool-optional-triple.md) | Optional `(run_id, finding_id, output_dir)` triple typing | Accepted | 3 |
| [0005](0005-prd-spec-subtree-approach.md) | `prd-spec-generator` migration approach: filter-repo over subtree | Accepted | 2 |
| [0006](0006-prd-bundle-preserve-vs-regenerate.md) | `mcp-server/index.js` bundle: preserve vs regenerate post-migration | Accepted | 2 |
| [0007](0007-better-sqlite3-native-build.md) | `better-sqlite3` native module build in monorepo | Accepted | 2/4 |
| [0008](0008-claude-plugin-path-placement.md) | `.claude-plugin/` path placement: per-package vs root-aggregated | Accepted | 2/5 |
| [0009](0009-tsconfig-nodenext.md) | `tsconfig.base.json` module: `NodeNext` | Accepted | 1 |
| [0010](0010-claude-plugin-root-expansion.md) | `${CLAUDE_PLUGIN_ROOT}` expansion semantics | Accepted | 5 |
| [0011](0011-cortex-http-server.md) | Cortex HTTP server / 3D dashboard: defer to post-cutover | Accepted | 4/7 |

All 11 originated as open questions from the Phase-0 inventory worktrees
(`port/inventory-cortex`, `port/inventory-automatised-pipeline`,
`port/migrate-prd-spec`, `port/plugin-manifest-design`). They unblock
Phase 2 (subtree migration), Phase 3 (Rust adapter), Phase 4 (Cortex
parallel ports), and Phase 5 (unified install).

## Process

- One decision per ADR.
- ADRs are committed to `main` only. Worktrees may propose ADRs but the
  PR that proposes them lands on `main` separately.
- Every Phase plan that depends on a decision must reference the ADR
  number (e.g. "per ADR-0010").
- Superseded ADRs change Status to `Superseded by ADR-XXXX` and add a
  forward-link line. Their original content is preserved.
