# ADR-0009 — `tsconfig.base.json` module: `NodeNext`

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/migrate-prd-spec` (ADR-009)
**Affects:** Phase 1 — monorepo tsconfig; all packages

## Context

`prd-spec-generator`'s `tsconfig.base.json` uses `module: "Node16"`. The
monorepo's `tsconfig.base.json` uses `module: "NodeNext"`. On the surface
this looks like a breaking change for the prd-pipeline subtree.

## Decision

Align the monorepo on **`NodeNext`**. Inside `packages/prd-pipeline/`,
the local `tsconfig.json` extends `tsconfig.base.json` and inherits
`NodeNext`. No package-local override needed.

Rationale:
- `NodeNext` is a strict superset of `Node16` for ESM resolution. Every
  pattern that compiles under `Node16` compiles under `NodeNext`.
- TypeScript 5.6+ recommends `NodeNext` for forward compatibility with
  Node 22's ESM evolution.
- The `package.json` `"type": "module"` declarations in the source repo
  and the `.js`/`.ts` import-extension requirements work identically
  under both settings.
- Aligning the whole monorepo on one module setting prevents per-package
  drift that would surface as cross-package type errors at build time.

## Consequences

- The first build of `port/migrate-prd-spec` after subtree-add must pass
  cleanly with `tsc --strict` against the inherited `NodeNext` setting.
  Any package-local `tsconfig.json` overrides in the source repo that
  forced `Node16` are stripped during the migration commit.
- A future package that genuinely needs a different module setting (e.g.
  a browser-targeting package) can override locally — but no such
  package is currently in scope.

## Verification

- `pnpm typecheck` after Phase 2 migration commits: zero TypeScript
  errors across all packages.
- Smoke test: `node -e 'import("./packages/prd-pipeline/dist/index.js")'`
  succeeds (the bundle path is fully resolvable under NodeNext).
