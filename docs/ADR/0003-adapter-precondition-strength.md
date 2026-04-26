# ADR-0003 — Adapter preconditions must NOT be stronger than the Rust binary

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/inventory-automatised-pipeline` (ADR-003 in MISSION.md)
**Affects:** Phase 3 — Rust adapter contract design

## Context

The Rust binary's `validate_graph_path_safe` accepts any path that ends in
`/graph` and is not a system root prefix. The TS adapter's draft Zod schema
`AbsolutePathSchema = z.string().min(1)` is intentionally LOOSER. The
question: should the adapter's input validation match the Rust binary's
checks, or stay a strict superset?

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. TS adapter mirrors Rust validation exactly | Same error surface in both layers | Liskov violation if Rust evolves and TS is not updated synchronously |
| B. TS adapter validates only Zod-level shape (string, non-empty); defers semantic validation to Rust | TS port is a thin pass-through; Rust remains the authority | Errors from Rust come back as opaque strings — typed-error story is weaker |
| C. TS adapter validates the SUBSET it's confident about, no more | Compromise | Hard to define "the subset" rigorously |

## Decision

**Option B.** The TS adapter validates only what is needed to construct a
syntactically valid JSON-RPC payload (the input must be a non-empty
string, optional fields are optional, etc.). All semantic validation
(path safety, schema membership of enum values, range checks on numbers)
lives in the Rust binary, where it already lives, and the adapter
surfaces Rust validation errors as a typed `CodebaseValidationError` with
the Rust error message preserved verbatim.

Rationale:
- Liskov substitutability: any future adapter (in-memory test double, an
  alternative native-TS reimplementation, an HTTP-mediated remote adapter)
  must accept the same range of inputs as the Rust adapter. Strengthening
  preconditions in one adapter breaks substitutability.
- Single source of truth: path-safety logic in `validate_graph_path_safe`
  changes when security requirements change. We do NOT want to maintain
  the same logic in TS and have it drift.
- Performance: the adapter is on the hot path; double-validation is
  wasted CPU.

## Consequences

- **Adapter contract** (`packages/codebase/src/adapters/rust-pipeline-adapter.ts`):
  every Zod input schema declares minimum syntactic shape. Error mapping
  takes Rust's error response and produces typed TS errors with full
  fidelity (no message truncation).
- **Caller responsibility:** callers MAY pre-validate inputs against
  semantically richer schemas if they want to fail fast at the call site.
  They MUST NOT assume the adapter has done so.
- **Test plan:** parity tests in `parity-oracle/codebase/` include
  intentionally-invalid inputs (paths outside the wiki root, unknown enum
  values) and assert the TS adapter returns the SAME typed error
  (matching error message and error code) as a direct call to the Rust
  binary with the same input.

## Verification

- Adapter test: `packages/codebase/__tests__/precondition-passthrough.parity.test.ts`
- Static-analysis: `liskov` audit on the `CodebasePort` interface checks
  that no concrete adapter strengthens preconditions in JSDoc/comments
  beyond what the interface declares.
