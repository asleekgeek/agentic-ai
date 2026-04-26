# Migration Manifest

> **Updated 2026-04-26 from `port/inventory-*` worktrees**: source paths
> verified against actual repo layouts. Three new Phase-4 worktrees added
> (wiki, workflow-graph, codebase-analysis); paths in the original draft
> for `automation/`, `methodology/`, `decay.py`, and `import/` corrected;
> hook count corrected from 5 to 9. See `docs/ADR/` for resolved decisions.

**Purpose:** Inventory every artifact across the four source repos with an
explicit disposition. Anything not in this manifest = data loss risk.

**Disposition tags:**
- **`move-as-is`** — copy without translation; pure relocation
- **`port-language`** — port from one language to TS (Python, Bash)
- **`subprocess-wrap`** — keep original binary; add TS adapter
- **`reformat`** — content preserved, structure changed (e.g. unify .md headers)
- **`discard`** — explicit decision NOT to migrate; must include justification
- **`defer`** — migrate after Phase 6 (post-cutover hardening)

**Status tags:**
- ☐ pending  ⏳ in-progress  ✅ migrated  ✋ blocked

---

## Repo 1 — `cdeust/Cortex` (Python)

> The long pole. Sharded across 9 parallel worktrees in Phase 4.

### Application code

| Source path | Target path | Disposition | Worktree | Status |
|---|---|---|---|---|
| `mcp_server/__init__.py`, `mcp_server/__main__.py`, `mcp_server/tool_error_handler.py`, `mcp_server/observability/`, `mcp_server/validation/`, `mcp_server/errors/`, `mcp_server/shared/` | `packages/memory/src/shared/` + `packages/memory/src/index.ts` | port-language | `port/cortex-shared` | ☐ |
| `mcp_server/handlers/recall.py`, `recall_hierarchical.py`, `mcp_server/core/multi_signal_fusion.py` | `packages/memory/src/recall/` | port-language | `port/cortex-recall` | ☐ |
| `mcp_server/handlers/{remember,remember_global,anchor,forget,rate_memory}.py`, `mcp_server/core/{write_gate,write_gate_calibration,write_post_store,memory_ingest,predictive_coding_*,abstention_gate}*.py`, `mcp_server/infrastructure/{pg_store*,sqlite_store*,memory_store}.py` | `packages/memory/src/remember/` | port-language | `port/cortex-remember` | ☐ |
| `mcp_server/handlers/consolidate.py`, `mcp_server/handlers/consolidation/` (12 files), `mcp_server/core/{decay_cycle,consolidation_engine,cascade*,two_stage_*,homeostatic_*,reconsolidation,replay*,sleep_compute,oscillatory_*,thermodynamics,microglial_pruning,neurogenesis}*.py` | `packages/memory/src/consolidation/` | port-language | `port/cortex-consolidation` | ☐ |
| `mcp_server/hooks/` — **9 files**: `session_start`, `auto_recall`, `post_tool_capture`, `agent_briefing`, `compaction_checkpoint`, `session_lifecycle`, `preemptive_context`, `pipeline_impact_bump`, `ingest_codebase_background` | `packages/memory/src/hooks/` | port-language | `port/cortex-hooks` | ☐ |
| `mcp_server/handlers/{methodology,detect_domain,explore_features,query_methodology,rebuild_profiles,update_profiles}.py`, `mcp_server/core/{cognitive_profile,methodology_engine,domain_detector,attribution_pipeline}*.py`, `mcp_server/shared/types_profiles.py` | `packages/memory/src/methodology/` | port-language | `port/cortex-methodology` | ☐ |
| `mcp_server/handlers/{navigate_memory,explore_features}.py`, `mcp_server/core/{graph,navigation,heat_propagation}*.py` | `packages/memory/src/graph/` | port-language | `port/cortex-graph-navigation` | ☐ |
| `mcp_server/handlers/narrative.py`, `mcp_server/core/{narrative_*,session_extractor}*.py` | `packages/memory/src/narrative/` | port-language | `port/cortex-narrative` | ☐ |
| `mcp_server/handlers/{automate,prospective,trigger_engine,sync_to_claude_md}*.py`, `mcp_server/core/{rule_engine,trigger_matcher}*.py` | `packages/memory/src/automation/` | port-language | `port/cortex-automation` | ☐ |
| `mcp_server/handlers/{import_claude_code,import_chatgpt,import_gemini,import_cursor,import_claude_mem}*.py` | `packages/memory/src/import/` | port-language | `port/cortex-import` | ☐ |
| **NEW** `mcp_server/handlers/wiki_*.py` (21), `mcp_server/core/{wiki_*,concept_emerger,concept_vocabulary,claim_extractor,claim_resolver,enrichment}*.py` (15), `mcp_server/infrastructure/{pg_store_wiki,wiki_store}.py` (2) | `packages/memory/src/wiki/` | port-language | `port/cortex-wiki` | ☐ |
| **NEW** `mcp_server/handlers/{workflow_graph,query_workflow_graph}.py`, `mcp_server/core/workflow_graph_*.py` (6), `mcp_server/infrastructure/workflow_graph_source*.py` (4) | `packages/memory/src/workflow-graph/` | port-language | `port/cortex-workflow-graph` | ☐ |
| **NEW** `mcp_server/handlers/{codebase_analyze*,ingest_codebase*,ingest_prd,ingest_helpers}.py` (9), `mcp_server/core/{ast_*,codebase_*,schema_engine,schema_extraction}*.py`, `mcp_server/infrastructure/scanner*.py` | `packages/memory/src/codebase-analysis/` | port-language | `port/cortex-codebase-analysis` | ☐ |
| `mcp_server/tool_registry*.py` | `packages/mcp-servers/memory/src/registry.ts` | port-language | (post-merge integration) | ☐ |
| `mcp_server/doctor.py` | `packages/mcp-servers/memory/src/doctor.ts` | port-language | (post-merge integration) | ☐ |
| `mcp_server/server/` (15 HTTP-dashboard files, 3 668 LOC) | DEFER per ADR-0011 | defer | (none — Phase 7) | ☐ |
| `scripts/launcher.py` | drop — not needed in TS (Node entry-point is the binary) | discard | — | ☐ |

### Schema + data

| Source path | Target path | Disposition | Status |
|---|---|---|---|
| `mcp_server/schema/*.sql` | `packages/memory/migrations/` | move-as-is (PostgreSQL DDL is portable) | ☐ |
| `mcp_server/embeddings/` | `packages/memory/src/embeddings/` | port-language | ☐ |
| `tests_py/` | `parity-oracle/cortex/inputs/` (frozen as ground truth) | reformat | ☐ |
| `tests_py/handlers/` | `packages/memory/__tests__/` | port-language | ☐ |

### Provenance (load-bearing)

| Source path | Target path | Disposition | Status |
|---|---|---|---|
| Every `# source: <citation>` comment in *.py | corresponding `// source:` in *.ts | reformat (mandatory; cite-check enforced) | ☐ |
| `docs/papers/` (PDFs / arXiv refs) | `packages/memory/sources/` | move-as-is | ☐ |
| `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md` | `packages/memory/` (then aggregated to root for unified version) | reformat | ☐ |

### Plugin distribution

| Source path | Target path | Disposition | Status |
|---|---|---|---|
| `.claude-plugin/plugin.json` | `.claude-plugin/cortex/plugin.json` (one of 4 in unified marketplace) | reformat | ☐ |
| `.mcp.json` | `.claude-plugin/cortex/.mcp.json` | reformat | ☐ |
| `commands/*.md` | `commands/cortex/` | move-as-is | ☐ |
| `skills/*` | `skills/cortex/` | move-as-is | ☐ |

---

## Repo 2 — `cdeust/automatised-pipeline` (Rust)

> **Strategy:** keep the binary, wrap it. Phase 3.

| Source path | Target path | Disposition | Status |
|---|---|---|---|
| `src/`, `benches/`, `Cargo.toml`, `Cargo.lock` | `packages/codebase-rust/` | move-as-is (cargo workspace under monorepo) | ☐ |
| `target/release/ai-architect-mcp` | built by CI; not committed | (build artifact) | ☐ |
| `.mcp.json` | `.claude-plugin/codebase/.mcp.json` (rewritten to reference the in-repo binary) | reformat | ☐ |
| `.claude-plugin/plugin.json` | `.claude-plugin/codebase/plugin.json` | reformat | ☐ |
| `assets/` | `packages/codebase-rust/assets/` | move-as-is | ☐ |
| `tests/` | `packages/codebase-rust/tests/` (cargo tests) + `parity-oracle/codebase/` (TS-side parity) | move-as-is + reformat | ☐ |
| `docs/`, `NOTES.md`, `README.md`, `LICENSE`, etc. | `packages/codebase-rust/` | reformat | ☐ |

---

## Repo 3 — `cdeust/zetetic-team-subagents` (Bash + Markdown)

> **Strategy:** prompts (.md) move as-is; bash scripts ported to TS modules.

| Source path | Target path | Disposition | Status |
|---|---|---|---|
| `agents/genius/*.md` | `packages/reasoning/src/genius/` (prompts as .md) + `packages/reasoning/src/genius/loader.ts` (TS loader) | move-as-is + port-language | ☐ |
| `agents/team/*.md` | same pattern under `packages/reasoning/src/team/` | move-as-is + port-language | ☐ |
| `rules/coding-standards.md` | `docs/coding-standards.md` (root, applies to whole monorepo) | move-as-is | ☐ |
| `rules/*.md` | `docs/rules/` | move-as-is | ☐ |
| `hooks/*.sh` | `packages/reasoning/src/hooks/` (port to TS) | port-language | ☐ |
| `tools/*.sh` | `packages/reasoning/src/tools/` (port to TS) | port-language | ☐ |
| `tests/*.sh` | `packages/reasoning/__tests__/` (vitest) | port-language | ☐ |
| `.claude-plugin/plugin.json` | `.claude-plugin/reasoning/plugin.json` | reformat | ☐ |

---

## Repo 4 — `cdeust/prd-spec-generator` (TypeScript) — **MOVE WITH HISTORY**

> Migrate via `git subtree` so commit history is preserved. Phase 2.

| Source repo | Target subtree | Disposition | Status |
|---|---|---|---|
| Whole repo @ `main` | `packages/prd-pipeline/` | git-subtree-add | ☐ |
| `@prd-gen/*` package names | rewrite to `@agentic/prd-*` | reformat | ☐ |
| `mcp-server/index.js` (bundle) | `packages/mcp-servers/prd/dist/index.js` (regenerated by CI) | (build artifact) | ☐ |
| `.claude-plugin/plugin.json` | `.claude-plugin/prd/plugin.json` | reformat | ☐ |
| `commands/`, `skills/` | `commands/prd/`, `skills/prd/` | move-as-is | ☐ |

---

## Cross-repo concerns (root-level, deduplicated)

| Concern | Disposition | Status |
|---|---|---|
| `LICENSE` (4 separate MIT files) | One root `LICENSE` MIT, with sub-package attributions in `NOTICE` | reformat | ☐ |
| `README.md` (4 separate) | One root `README.md`; each package keeps a brief `packages/<x>/README.md` | reformat | ☐ |
| `CHANGELOG.md` (4 separate) | One root `CHANGELOG.md` Keep-a-Changelog; each package's pre-merge history preserved as a §"Pre-merge" appendix | reformat | ☐ |
| `CONTRIBUTING.md` | One root `CONTRIBUTING.md` (start from prd-spec-generator's, broaden to monorepo) | reformat | ☐ |
| `SECURITY.md` | One root `SECURITY.md` (start from prd-spec-generator's) | reformat | ☐ |
| `CODE_OF_CONDUCT.md` | One root file (custom; Contributor Covenant text is content-filtered) | reformat | ☐ |
| `.github/ISSUE_TEMPLATE/` | One root copy (start from prd-spec-generator's) | reformat | ☐ |
| `.github/workflows/` | One root CI matrix; per-package logic conditional | reformat | ☐ |

---

## Discards (explicit, with justification)

| Source | Reason |
|---|---|
| `Cortex/scripts/launcher.py` | Node entry-point becomes the binary; no Python launcher needed in unified install |
| All `cargo run` wrapper scripts in automatised-pipeline | Replaced by built binary path in unified `.mcp.json` |
| `prd-spec-generator/.claude/scheduled_tasks.lock` and other ephemeral session state | Not portable; per-developer |
| `*.tsbuildinfo`, `target/`, `node_modules/`, `dist/` (committed by mistake?) | Build outputs, regenerated |
| Old "ai-prd-generator" plugin manifests | Already removed; ensure not re-introduced via subtree |

---

## Validation gate (Phase 6 exit)

Before flipping `agentic-ai` from private to public, run:

```bash
./scripts/audit-migration.sh
```

This script asserts:
1. Every row in this manifest tagged ✅ (or has an open ticket if defer).
2. Every `# source:` from Cortex Python has a matching `// source:` in TS.
3. Every cited paper PDF/markdown is present under `packages/memory/sources/`.
4. Test count: `tests_new ≥ Σ tests_source` per package.
5. Hook count: 14 hooks (Cortex 5 + zetetic 14? — verify) all accounted for.
6. Public symbols audit (`borges` exhaustive-space check): every symbol exported from a source repo's public API has a counterpart in the monorepo or a discard justification.
