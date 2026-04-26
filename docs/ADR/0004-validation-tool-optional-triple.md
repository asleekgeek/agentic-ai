# ADR-0004 — Optional `(run_id, finding_id, output_dir)` triple typing

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/inventory-automatised-pipeline` (ADR-004 in MISSION.md)
**Affects:** Phase 3 — `CodebasePort` interface; Phase 4 — `validate_prd_against_graph` and `check_security_gates` callers

## Context

Two MCP tools exposed by the Rust binary — `validate_prd_against_graph`
and `check_security_gates` — accept three OPTIONAL fields:
- `run_id: string`
- `finding_id: string`
- `output_dir: string`

When all three are present, the binary writes artifacts (analysis output,
finding records) to `output_dir`. When any of the three is absent, the
binary skips artifact writes. This is an all-or-nothing semantic that the
Zod input schema must encode — three independent `optional()` fields
allow the partial state where, e.g., `run_id` is set but `output_dir` is
not, which is silently ignored by the binary.

A schema that admits a state the binary ignores is a contract defect:
the caller believes they requested artifact writes but no artifacts
appear.

## Options considered

| Option | Encoding | TS callers see |
|---|---|---|
| A. Three independent `.optional()` | `{run_id?: string, finding_id?: string, output_dir?: string}` | Confusing — partial state silently ignored |
| B. Discriminated union with a flag | `{ writeArtifacts: false } \| { writeArtifacts: true; runId; findingId; outputDir }` | Explicit; type-safe but requires explicit `writeArtifacts` |
| C. Single optional bundle field | `{ artifacts?: { runId; findingId; outputDir } }` | Clean; the bundle's optionality is the all-or-nothing | 

## Decision

**Option C.** The optional triple is encoded as a single `artifacts` field
of type `ArtifactWriteSpec | undefined`. When `artifacts` is undefined,
the binary is called without the three fields. When present, all three
sub-fields are required.

```typescript
export const ArtifactWriteSpecSchema = z.object({
  runId: z.string().min(1),
  findingId: z.string().min(1),
  outputDir: z.string().min(1),
});
export type ArtifactWriteSpec = z.infer<typeof ArtifactWriteSpecSchema>;

export const ValidatePrdAgainstGraphInputSchema = z.object({
  graphPath: z.string(),
  prdPath: z.string(),
  artifacts: ArtifactWriteSpecSchema.optional(),
});
```

Rationale:
- Closest to the binary's actual semantic. The TS type system enforces
  what the binary already enforces at runtime.
- No new flag field — `writeArtifacts` would duplicate the information
  that `artifacts !== undefined` already carries.
- Discoverable: callers reading the type immediately see the all-or-nothing
  shape.
- Adapter implementation: `if (input.artifacts) { rustArgs.run_id = ...; rustArgs.finding_id = ...; rustArgs.output_dir = ...; }` — no partial state can leak through.

## Consequences

- **Adapter contract:** the two affected methods on `CodebasePort` use
  `ArtifactWriteSpec | undefined`, NOT three independent optional strings.
- **Caller migration:** any existing callers in the source repos that
  passed the three fields independently must be updated. The migration
  is mechanical (consolidate into a single `artifacts` object).
- **Parity test:** `parity-oracle/codebase/validate-prd-with-artifacts.parity.test.ts`
  asserts that (a) calling without `artifacts` produces no `output_dir`
  on disk, (b) calling with all three sub-fields produces the expected
  artifacts at the path, (c) the type system rejects partial state at
  compile time.

## Verification

- TypeScript compile-time check: a unit test that uses `expectTypeOf` to
  assert that the partial state `{ runId: "x" }` (no findingId/outputDir)
  is a TYPE ERROR, not just a runtime validation failure.
- Parity test on actual artifact production.
