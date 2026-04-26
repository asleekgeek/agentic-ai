# ADR-0006 — `mcp-server/index.js` bundle: preserve vs regenerate post-migration

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/migrate-prd-spec` (ADR-006)
**Affects:** Phase 2 — prd-spec subtree migration

## Context

The source repo `prd-spec-generator` commits a generated esbuild bundle at
`mcp-server/index.js`. After migration this lives at
`packages/prd-pipeline/mcp-server/index.js`. The bundle is what the
marketplace install loads; it is also what the `pnpm bundle` script
regenerates from source.

Two options on day-1 of the monorepo:
1. **Preserve** the bundle byte-for-byte through the subtree migration
   and trust CI's `bundle freshness gate` to fail if the source has
   diverged.
2. **Regenerate** the bundle as part of the migration commit so the
   monorepo's bundle is the canonical artifact going forward.

## Decision

**Preserve byte-for-byte.** Rationale:
- The source repo's bundle was generated against the source repo's
  exact dependency tree. The monorepo will eventually have a different
  resolved tree (different transitive versions). Regenerating in the
  migration commit means the FIRST monorepo bundle differs from the
  pre-migration one for reasons unrelated to the migration itself —
  pollutes the audit trail.
- esbuild bundles are self-contained: they resolve all imports at bundle
  time, so the bundle does NOT contain `@prd-gen/*` symbol names at
  runtime. The post-migration namespace rename does not affect the
  bundle's correctness.
- CI's existing bundle-freshness gate (commit `7e953e8` in
  `cdeust/prd-spec-generator`) catches drift on the very next merge that
  touches `packages/prd-pipeline/packages/mcp-server/src/`.

## Consequences

- The first monorepo CI run for `port/migrate-prd-spec` shows
  `mcp-server/index.js` as unchanged from the source-repo-pre-migration
  byte-content. The freshness gate passes.
- The first PR after migration that touches `packages/prd-pipeline/mcp-server/src/`
  must include a regenerated bundle (the gate will reject otherwise).
  This is the natural cutover point.
- A `MIGRATION_NOTE.md` in the prd-pipeline package documents that the
  bundle was preserved across migration and points at this ADR.

## Verification

- Pre-migration: `sha256sum mcp-server/index.js` (in source repo) →
  recorded in `worktrees/port-migrate-prd-spec/migration/VERIFICATION.md`.
- Post-migration: `sha256sum packages/prd-pipeline/mcp-server/index.js`
  matches the recorded hash.
- First-merge gate: any source change in `packages/prd-pipeline/packages/mcp-server/src/`
  WITHOUT a corresponding bundle update fails CI.
