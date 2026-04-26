# @agentic/core

Pure domain types, Zod schemas, and Port (Protocol-style) interfaces shared
across the monorepo. **Zero I/O. Stdlib + zod only.** Every other package
depends on this; this package depends on none.

This is the FROZEN surface that the parallel worktrees in Phase 4 build
against. Changes here require a separate "type-amendment" PR + sign-off
from `liskov` + `panini`.
