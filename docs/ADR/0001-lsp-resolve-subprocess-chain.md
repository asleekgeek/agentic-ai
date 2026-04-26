# ADR-0001 — `lsp_resolve` subprocess chain timeout + signal propagation

**Status:** Accepted
**Date:** 2026-04-26
**Originated:** `port/inventory-automatised-pipeline` worktree (ADR-001 in MISSION.md)
**Affects:** Phase 3 — Rust adapter implementation

## Context

The Rust automatised-pipeline binary's `lsp_resolve` MCP tool spawns a
language-server subprocess (rust-analyzer / pyright / typescript-language-server)
to resolve symbol-position queries. Once the TS adapter wraps the Rust
binary as ITS OWN subprocess, the call chain becomes a 3-process pipeline:

```
TS host  →  Rust binary  →  LSP server
```

Three failure modes were unspecified:

1. **LSP hang.** The LSP server is non-responsive. Does the Rust binary's
   `timeout_ms` actually kill the LSP process, or does it merely stop
   waiting (leaving a zombie)?
2. **Adapter dispose.** When the TS adapter's `dispose()` is called, what
   guarantees does it provide about the LSP process? `SIGTERM` to the Rust
   parent does not necessarily propagate to the LSP grandchild.
3. **Cross-call leakage.** A previous `lsp_resolve` call that left a hung
   LSP can starve subsequent calls.

## Decision

1. **Timeout authority lives at the Rust layer.** The Rust binary owns the
   LSP subprocess and is the only layer that can SIGKILL it. The TS adapter
   does NOT impose its own LSP-level timeout — instead, it sets its overall
   tool-call timeout to `LSP_TIMEOUT_MS + RUST_OVERHEAD_BUDGET` (currently
   `30_000ms + 2_000ms` = 32 s). If the Rust binary fails to honour its
   internal timeout, the TS adapter's outer timeout fires and we tear down
   the entire Rust subprocess (which also kills the LSP via process-group
   semantics).

2. **`spawn_pgid` with `setsid` on the Rust subprocess.** The TS adapter
   spawns the Rust binary in its own process group (`detached: true` on
   POSIX, equivalent on Windows). On `dispose()`, the adapter sends
   `SIGTERM` to the negative PGID, which delivers to the Rust binary AND
   any LSP children. Delay `SIGKILL` by 5 s to allow graceful shutdown.

3. **Per-call LSP isolation.** The Rust binary is configured (via env var
   `AI_ARCH_LSP_FRESH_PROCESS=1` set by the TS adapter) to spawn a fresh
   LSP subprocess per `lsp_resolve` call rather than reusing a long-lived
   one. Pays a per-call startup cost (~150–400 ms for rust-analyzer cold
   start) but guarantees no cross-call hang propagation. Acceptable because
   `lsp_resolve` is not on the hot path; codebase-graph queries dominate
   latency-sensitive workloads.

## Consequences

- **Adapter contract:** `CodebasePort.lspResolve(...)` is the only method
  whose timeout budget exceeds 5 s. Document this on the interface.
- **Test plan:** Phase 3 must include an integration test that spawns the
  Rust binary, calls `lsp_resolve` with a guaranteed-hanging input
  (`fixtures/hung-lsp-server.sh` returning never), asserts the TS adapter
  surfaces a typed `TimeoutError` within 32 s and that no orphan LSP
  process remains (`pgrep -f 'rust-analyzer\|pyright\|typescript-language-server'`).
- **Performance regression risk:** Per-call LSP startup adds ~250 ms p50
  to `lsp_resolve`. Mitigation: cache LSP results by `(file_path, byte_offset)`
  for the duration of a single TS host process.

## Verification

- Adapter integration test: `packages/codebase/__tests__/lsp-timeout.parity.test.ts`
- Process-tree assertion: `ps -o pid,pgid,comm -p $(pgrep ai-architect-mcp)` post-dispose returns empty.
