# Migration Manifest

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
| `mcp_server/handlers/recall.py` | `packages/memory/src/recall/recall.ts` | port-language | `port/cortex-recall` | ☐ |
| `mcp_server/handlers/recall_hierarchical.py` | `packages/memory/src/recall/hierarchical.ts` | port-language | `port/cortex-recall` | ☐ |
| `mcp_server/handlers/remember.py` | `packages/memory/src/remember/remember.ts` | port-language | `port/cortex-remember` | ☐ |
| `mcp_server/handlers/remember_global.py` | `packages/memory/src/remember/global.ts` | port-language | `port/cortex-remember` | ☐ |
| `mcp_server/handlers/ingest_codebase*.py` | `packages/memory/src/import/ingest-codebase.ts` | port-language | `port/cortex-import` | ☐ |
| `mcp_server/handlers/wiki_*.py` | `packages/memory/src/wiki/` | port-language | `port/cortex-remember` | ☐ |
| `mcp_server/handlers/navigate*.py` | `packages/memory/src/graph/navigate.ts` | port-language | `port/cortex-graph-navigation` | ☐ |
| `mcp_server/handlers/narrative.py` | `packages/memory/src/narrative/narrative.ts` | port-language | `port/cortex-narrative` | ☐ |
| `mcp_server/handlers/automate.py` | `packages/memory/src/automation/automate.ts` | port-language | `port/cortex-automation` | ☐ |
| `mcp_server/consolidation/` | `packages/memory/src/consolidation/` | port-language | `port/cortex-consolidation` | ☐ |
| `mcp_server/methodology/` | `packages/memory/src/methodology/` | port-language | `port/cortex-methodology` | ☐ |
| `mcp_server/profile/` | `packages/memory/src/methodology/profile.ts` | port-language | `port/cortex-methodology` | ☐ |
| `mcp_server/hooks/session_start.py` | `packages/memory/src/hooks/session-start.ts` | port-language | `port/cortex-hooks` | ☐ |
| `mcp_server/hooks/auto_recall.py` | `packages/memory/src/hooks/auto-recall.ts` | port-language | `port/cortex-hooks` | ☐ |
| `mcp_server/hooks/post_tool_use.py` | `packages/memory/src/hooks/post-tool-use.ts` | port-language | `port/cortex-hooks` | ☐ |
| `mcp_server/hooks/session_end.py` | `packages/memory/src/hooks/session-end.ts` | port-language | `port/cortex-hooks` | ☐ |
| `mcp_server/hooks/notification.py` | `packages/memory/src/hooks/notification.ts` | port-language | `port/cortex-hooks` | ☐ |
| `mcp_server/import/claude_mem.py` | `packages/memory/src/import/claude-mem.ts` | port-language | `port/cortex-import` | ☐ |
| `mcp_server/import/chatgpt.py` | `packages/memory/src/import/chatgpt.ts` | port-language | `port/cortex-import` | ☐ |
| `mcp_server/import/gemini.py` | `packages/memory/src/import/gemini.ts` | port-language | `port/cortex-import` | ☐ |
| `mcp_server/import/cursor.py` | `packages/memory/src/import/cursor.ts` | port-language | `port/cortex-import` | ☐ |
| `mcp_server/import/claude_code.py` | `packages/memory/src/import/claude-code.ts` | port-language | `port/cortex-import` | ☐ |
| `mcp_server/tool_registry*.py` | `packages/mcp-servers/memory/src/registry.ts` | port-language | (post-merge integration) | ☐ |
| `mcp_server/server/` | `packages/mcp-servers/memory/src/server.ts` | port-language | (post-merge integration) | ☐ |
| `mcp_server/doctor.py` | `packages/mcp-servers/memory/src/doctor.ts` | port-language | (post-merge integration) | ☐ |
| `mcp_server/__init__.py` | `packages/mcp-servers/memory/src/index.ts` | port-language | (post-merge integration) | ☐ |
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
