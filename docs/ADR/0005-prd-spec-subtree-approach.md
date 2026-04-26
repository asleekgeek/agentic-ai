# ADR-0005 — `prd-spec-generator` migration approach: filter-repo over subtree

**Status:** Accepted (per `port/migrate-prd-spec` worktree analysis)
**Date:** 2026-04-26
**Originated:** `port/migrate-prd-spec` (ADR-005 in SUBTREE_PLAN.md)
**Affects:** Phase 2 — TS-repos migration

## Context

Two viable git approaches to bring `prd-spec-generator` into the
monorepo with history:
1. `git subtree add --prefix=packages/prd-pipeline cdeust-prd main`
2. `git filter-repo --to-subdirectory-filter=packages/prd-pipeline` (run
   on a fresh clone of prd-spec-generator) followed by `git fetch + git merge --allow-unrelated-histories`.

Both rewrite SHAs (any graft does). The question is which preserves the
causal partial order in a way that `git log --follow` can trace per-file
through the merge.

## Decision

**`git filter-repo --to-subdirectory-filter`** for three reasons:
1. Produces a clean linear ancestry inside the monorepo. `git log --follow
   -- packages/prd-pipeline/packages/core/src/domain/agent.ts` traces
   through all 17 source-repo commits without special flags.
2. `git subtree add` creates a merge commit whose only parents are a
   monorepo commit and the foreign root — `git log --follow` does not
   traverse this gracefully.
3. Operator semantics simpler: filter-repo's `--to-subdirectory-filter`
   is purpose-built for this rewrite. `subtree add` is a general-purpose
   command repurposed for the same goal.

## Consequences

- Original SHAs (`a766082`, `342f15f`, etc.) are gone from the monorepo.
  They are frozen in
  `worktrees/port-migrate-prd-spec/migration/PRE_MIGRATION_COMMIT_GRAPH.txt`
  as the reference anchor. Any future "what commit was this?" lookup
  cross-references that file.
- Authorship metadata is preserved (filter-repo does not touch author/date).
- The migration is encoded in `worktrees/port-migrate-prd-spec/migration/SCRIPT.sh`
  with `--dry-run` and `--execute` modes; the operator runs `--dry-run`
  first to verify the planned commit graph against `VERIFICATION.md` (35
  runnable assertions).

## Verification

The 35 assertions in `worktrees/port-migrate-prd-spec/migration/VERIFICATION.md`
include:
- Commit count delta (`git log --oneline | wc -l` matches expected)
- File count under `packages/prd-pipeline/` (matches source repo's tracked file count)
- Namespace rename completeness (`grep -r "@prd-gen/" packages/prd-pipeline/` returns zero)
- Test count (`pnpm --filter @agentic/prd-* test` ≥ 267)
- Bundle path (`packages/prd-pipeline/mcp-server/index.js` exists and is the same SHA-256 as the source repo's bundle pre-migration)
