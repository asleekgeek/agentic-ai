# ADR-0007 — `better-sqlite3` native module build in monorepo

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/migrate-prd-spec` (ADR-007)
**Affects:** Phase 2 — TS-repos migration; Phase 4 — `port/cortex-remember` (which also uses better-sqlite3 for the SQLite-backed evidence DB)

## Context

`prd-spec-generator` and (post-port) `port/cortex-remember` both depend
on `better-sqlite3`, a native Node.js module. pnpm 10's default behaviour
SKIPS native module builds unless the package is in
`pnpm.onlyBuiltDependencies` whitelist. Without the whitelist, install
succeeds but tools that use the package fail at runtime with `MODULE_NOT_FOUND`
on `better_sqlite3.node`.

## Decision

Add `better-sqlite3` to the monorepo root `package.json`'s
`pnpm.onlyBuiltDependencies` array. This is a single-line config change:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": [
      "better-sqlite3"
    ]
  }
}
```

Other native modules used by source repos (sentence-transformers PyTorch
bindings in Cortex Python — N/A in TS port; sqlite-vec — TBD by
`port/cortex-remember`) get added to this list when they appear.

## Consequences

- `pnpm install --frozen-lockfile` in CI builds the native module on
  first install of every fresh agent or CI runner. This adds ~5 s to a
  cold install, ~0 s to subsequent installs (pnpm caches the build).
- Cross-platform: better-sqlite3 publishes prebuilt binaries for darwin,
  linux, win32 on x64 and arm64. The CI matrix (Node 20.x, 22.x) is
  fully covered.
- Failure mode: if a future native module gets added without updating
  the whitelist, the symptom is "MODULE_NOT_FOUND on a `.node` binary"
  at runtime. The fix is a one-line allowlist update. Document this in
  the troubleshooting section of `CONTRIBUTING.md`.

## Verification

- CI: `pnpm install --frozen-lockfile` followed by `pnpm test` must pass
  on Node 20.x and 22.x.
- Manual: a smoke test that loads the better-sqlite3 module and creates
  an in-memory DB.
