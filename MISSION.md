# Worktree Mission — `port/inventory-automatised-pipeline`

> Phase 3 planning worktree. Mission: produce a 100%-faithful inventory of the Rust
> `ai-automatised-pipeline` binary and design the TypeScript subprocess-adapter contract
> that will wrap it. No implementation is committed here — only design artifacts.

---

## 1. Source

- **Source repo**: `/Users/cdeust/Developments/anthropic/ai-automatised-pipeline`
- **Crate name**: `ai-architect-mcp` (see `Cargo.toml` line 8)
- **Binary entry point**: `src/main.rs` — hand-rolled JSON-RPC 2.0 over stdio; no MCP SDK
- **Source paths** (files owned by this inventory):
  - `src/main.rs` — entry point, wire protocol, all stage dispatch (~3400 LOC)
  - `src/tool_schemas.rs` — `tools_list()` + per-tool JSON Schema definitions
  - `src/graph_store.rs` — LadybugDB wrapper (`GraphStore`), node/edge constants
  - `src/indexer.rs` — codebase walk + tree-sitter parse pipeline
  - `src/resolver.rs` — static cross-file edge resolution
  - `src/resolver_layers.rs` — layer-by-layer resolution helpers
  - `src/clustering.rs` — Louvain community detection + process tracing
  - `src/search/` — `mod.rs`, `bm25.rs`, `rrf.rs`, `vector.rs` — hybrid search
  - `src/parser/` — `mod.rs`, `rust.rs`, `python.rs`, `typescript.rs` — tree-sitter parsers
  - `src/lsp_client.rs` — LSP subprocess client
  - `src/lsp_resolver.rs` — LSP-enhanced edge resolution
  - `src/prd_input.rs` — Stage 4 bundle builder
  - `src/prd_validator.rs` — Stage 6 PRD-vs-graph validator
  - `src/security_gates.rs` — Stage 8 security gate checks
  - `src/semantic_diff.rs` — Stage 9 before/after graph diff
  - `src/git_diff.rs` — git diff → symbol impact mapper
  - `src/macro_expansion/` — `mod.rs`, `python.rs`, `rust.rs`, `typescript.rs`
  - `src/stdlib_index/` — `mod.rs`, `python.rs`, `rust.rs`, `typescript.rs`
  - `src/rust_parser.rs` — legacy Rust parser (superseded by `parser/rust.rs`)
  - `src/lib.rs` — library entry point for integration tests
- **Source language**: Rust 2021 edition
- **Crate version**: `0.0.4` (source: `Cargo.toml` line 9)
- **Lines of code (approx.)**: `src/main.rs` ~3450 LOC; full `src/` ~8000 LOC
- **Cited papers / sources** (every `// source:` annotation that must travel to TS):
  - Blondel et al. 2008, J Stat Mech P10008 — Louvain community detection
  - Traag et al. 2019, Scientific Reports 9(1) 5233 §3.2 — C2 repair pass
  - Howard Hinnant, "chrono-Compatible Low-Level Date Algorithms" — `civil_from_unix`
  - Marsaglia 2003, Journal of Statistical Software 8(14) — xorshift64*
  - Knuth TAOCP vol 2 §3.3.4 — LCG multiplier constant
  - Steele, Lea, Flood, OOPSLA 2014 — SplitMix64 seed advance constant
  - IEEE Std 1003.1-2017 rename(2) — atomic write via POSIX rename
  - Neo4j Cypher Manual §"Literals" — Cypher string escaping rules

---

## 2. Target

- **Target package**: `packages/codebase/src/adapters/rust-pipeline-adapter.ts`
- **Target language**: TypeScript (strict, `tsc --strict`)
- **Public API surface** (exported symbols this worktree will produce in Phase 3):
  - `interface CodebasePort` — one method per MCP tool (defined in `packages/core/`)
  - `class RustPipelineAdapter implements CodebasePort` — subprocess adapter
  - `function createRustPipelineAdapter(config: AdapterConfig): CodebasePort`
- **Ports consumed** (declared in `packages/core/src/ports/`):
  - `CodebasePort` — the full behavioral contract; every MCP tool maps to one method
- **Ports provided** (this module's interface to the rest of the monorepo):
  - `CodebasePort` implementation via `RustPipelineAdapter`
  - `InMemoryCodebaseAdapter` (test double — substitutable per Liskov)

---

## 3. Acceptance Contract (load-bearing)

This worktree is **complete** when ALL of the following are true. No exceptions.

### 3.1 Functional parity
- [ ] Parity-oracle suite under `parity-oracle/codebase/` passes 100%.
- [ ] Every probe in `contract/PARITY_PROBES.md` produces identical key-sets from Rust binary and TS adapter.
- [ ] Adversarial corpus from `popper`'s falsification panel produces zero divergences.

### 3.2 Source-citation provenance
- [ ] Every `// source:` annotation from Rust source is preserved in TS adapter.
- [ ] Cited papers listed in §1 are present at `packages/codebase/sources/`.
- [ ] `feynman` rederives `civil_from_unix` civil-from-days algorithm from Hinnant paper.

### 3.3 Type contracts
- [ ] Public types match Zod schemas in `packages/shared-contracts/`.
- [ ] No `any`, no `unknown` outside Zod parse-then-narrow boundaries.
- [ ] `liskov` audit: `RustPipelineAdapter` substitutable for `CodebasePort` on all 23 tools; no postcondition weakened.

### 3.4 Tests
- [ ] Unit tests for every `CodebasePort` method (≥1 happy path, ≥1 edge case, ≥1 failure mode).
- [ ] Contract tests: `InMemoryCodebaseAdapter` passes same test suite as `RustPipelineAdapter`.
- [ ] Subprocess lifecycle tests: restart-on-crash, graceful shutdown, concurrent-call serialization.

### 3.5 Layer rules
- [ ] `core/` imports stdlib only; `CodebasePort` interface has zero infrastructure imports.
- [ ] `adapters/` may import `child_process` / `zod` / `rxjs`.
- [ ] No circular imports (`madge --circular`).

### 3.6 Style
- [ ] `pnpm lint` passes with zero warnings.
- [ ] `tsc --strict` passes.
- [ ] No file > 500 lines, no function > 50 lines.

---

## 4. Genius Panel

### 4.1 Truth-finding
- **`feynman`** — Rederive `civil_from_unix` from Hinnant paper; confirm TS port preserves algorithm. **Sign-off**: ☐
- **`popper`** — Adversarial input corpus for schema-validation edge cases, path-traversal attempts, and Cypher injection strings. **Sign-off**: ☐

### 4.2 Structural
- **`liskov`** — Verify adapter substitutability; precondition weakening preserved; postconditions not weakened; history constraint (serialized call queue) documented. **Sign-off**: ☐
- **`lamport`** — Subprocess lifecycle: spawn ordering, stdio framing, graceful-shutdown sequence, restart-on-crash invariant. **Sign-off**: ☐

### 4.3 Domain-relevant
- **Picked**: `kekule` — graph/structural module (the codebase intelligence graph is the core artifact)
- **Sign-off**: ☐

### 4.4 Engineering review
- `code-reviewer` — coding-standards.md compliance. **Sign-off**: ☐
- `test-engineer` — coverage + mutation survival. **Sign-off**: ☐
- `security-auditor` — subprocess spawn (path injection risk), Cypher injection pass-through, path traversal via `graph_path`. **Sign-off**: ☐

---

## 5. Findings & Actions

| ID | Severity | Pattern | Description | Status |
|---|---|---|---|---|
| F-001 | HIGH | liskov | `lsp_resolve` error reason codes (`lsp_command_not_allowed`, `lsp_not_found`, `lsp_probe_failed`, `lsp_resolve_failed`) must be preserved exactly through the adapter — callers branch on them. Adapter MUST NOT coerce these into a single generic error. | open |
| F-002 | HIGH | liskov | `query_graph` returns both `columns` (array) and `rows` (array-of-arrays) AND a pre-formatted `result` string. The adapter must surface all three; callers may depend on any. | open |
| F-003 | MED | lamport | `search_codebase` sets `AA_SEARCH_INDEX_DIR` env var via `std::env::set_var` on the Rust side. The TS adapter inherits the subprocess environment; the search index directory convention (`graph/` sibling `search_index/`) must be documented so callers know `analyze_codebase` must be called before `search_codebase`. | open |
| F-004 | MED | liskov | `get_symbol` returns `node: null` (not an error) when the symbol is not found. The adapter must not convert null-node into a thrown error. | open |
| F-005 | LOW | liskov | `cluster_graph` response includes `clusters_truncated_at` only when truncation occurred. Callers must not assume its presence. Adapter output type must make it optional. | open |

---

## 6. Merge Conditions

1. All acceptance subsections (§3.1–§3.6) check out.
2. All genius panel members signed off.
3. All CRIT and HIGH findings closed.
4. Parity-oracle CI shows zero divergence.
5. Human reviewer approves PR.

---

## 7. Known Risks / Open Questions

- **ADR-001 (OPEN)**: `lsp_resolve` spawns a language server subprocess from within the Rust subprocess. The TS adapter then wraps the Rust subprocess. This is a three-process chain. Timeout and signal propagation must be specified before Phase 3 implementation.
- **ADR-002 (OPEN)**: `analyze_codebase` is long-running (minutes for large repos). The adapter's serialized-call queue means all subsequent calls block. A separate "streaming progress" notification channel (JSON-RPC notifications) would require protocol extension; document the decision to accept blocking or not.
- **ADR-003 (OPEN)**: The Rust binary's `validate_graph_path_safe` rejects paths ending in anything other than `graph`. The TS adapter's precondition must NOT strengthen this (i.e., the adapter must not add additional path restrictions beyond what the Rust binary enforces). Verify no `output_dir` sanitization is added in the adapter layer.
- **ADR-004 (OPEN)**: The Rust binary writes `stage-8.security.json` only when `run_id + finding_id + output_dir` are ALL provided. The TS types must make this triple optional as a group, not individually optional, to preserve the all-or-nothing postcondition.

---

## 8. Daily Log

- **2026-04-26**: Inventory pass completed. All 23 MCP tools documented. Adapter contract drafted. 5 findings raised; 4 open ADRs requiring human decision before Phase 3 implementation starts.
