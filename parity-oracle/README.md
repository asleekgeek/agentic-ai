# Parity Oracle

The cross-language regression harness that decides whether a TS port of a
Cortex Python module (or a TS adapter wrapping the Rust automatised-pipeline
binary) preserves source semantics.

## Structure

```
parity-oracle/
├── cortex/
│   ├── inputs/            Frozen Day-0 fixture inputs (queries, payloads, …)
│   ├── expected/          Snapshot outputs from the Python source, captured Day 0
│   ├── runs/              Per-run actual outputs (gitignored)
│   └── *.parity.test.ts   Vitest suites that diff actual vs expected
├── codebase/              Same shape, fixtures for index_codebase + queries
└── prd/                   Same shape, fixtures for the prd-pipeline reducer
```

## Hard rule

Parity tests are **append-only between worktrees**. A worktree may add new
fixtures + expected outputs. A worktree may NOT modify existing expected
outputs without an ADR and explicit sign-off (`popper` + `feynman`).

Modifying expected outputs without that gate = silently weakening the
oracle = the whole parallel-port strategy stops working.

## How a port worktree uses this

1. Read `parity-oracle/cortex/inputs/<module>/*.json`.
2. Run them through the new TS implementation.
3. Diff against `parity-oracle/cortex/expected/<module>/*.json`.
4. Zero diff → the worktree's §3.1 acceptance check passes.
5. Any diff → either the port is wrong, or the expected output is wrong;
   in the latter case, see the "Hard rule" above.

## Capturing Day-0 expected outputs

Run the Python source against every input, capture stdout, commit. This
must happen in Phase 0 before any parallel work starts.

```bash
./scripts/capture-cortex-baseline.sh   # to be written in Phase 0
```
