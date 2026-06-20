# Audit de conformité MCP — Phase 0 catch-up

**Date** : 2026-06-20 · **Composants** : 13 · **Verdict critique** : manques-mineurs

> Audit de DISTRIBUTION (quel serveur est livré en .mcpb conforme, par langage) — distinct de l'inventaire de PARITÉ fonctionnelle (inventory/CORTEX_*.md).


## Matrice de conformité

## Conformance Matrix — by capability (SOURCE = anthropic-partnership vs CONSOLIDÉ-TS = agentic-ai)

Surface law: local .mcpb → Node/TS. Gate = .mcpb v0.3.1 (clean stdio boot + offline models + 3-platform smoke + sha256). H1 = isCliEntry-bomb (`fileURLToPath(import.meta.url)===argv[1]`); H2 = stdout pollution (console.log/info/warn on stdio). n/a for Python/Rust/Swift, with stdout-equivalent noted.

### memory
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| cortex (hypermnesia-mcp) | SOURCE | Python | local-stdio | .mcpb 3.24.0 published (uv) + PyPI (deprecated) | partial (no 3-platform smoke+sha256; model pulled at install) | n/a | absent (1 print under `__main__` guard; rest stderr) | **gap** (surface = Python, law wants Node/TS) |
| memory (`packages/mcp-servers/memory`) | CONSOLIDÉ-TS | TS/Node | local-stdio | **.mcpb 0.3.1 SHIPPED** (GitHub release, 3 bundles + sha256) | **passing** (offline smoke gate wired, models bundled) | **absent in shipped tag**; BOMB present in stale local `dist-mcpb/` v0.3.0 only | **residual present** (2 console.warn: content-hardening.ts:52, homeostatic.ts:452 — runtime-conditional, not boot) | **partial** |

### codebase
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| automatised-pipeline | SOURCE | Rust | local-stdio | .mcpb 0.5.0 declared but **.mcpb ABSENT from release** (only tarballs); server.json sha256 = placeholder | partial (3-platform tarballs + sha256 exist; **no boot smoke**; .mcpb artifact missing) | n/a (no spawn at boot) | absent (only write_message→stdout; rest eprintln!) | **partial** |
| codebase / codebase-rust | CONSOLIDÉ-TS | Mixed (TS adapter + Rust v0.0.4) | not-a-server | none (TS=private lib; Rust=internal subprocess) | none | n/a | absent | **partial** (stale fork v0.0.4 vs source v0.5.0; 3 parsers vs 11) |

### prd
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| prd-spec-generator | SOURCE | TS/Node | local-stdio | .mcpb machinery present (manifest v0.4) but **NEVER shipped** (no git tag, sha256 placeholder) | partial (ubuntu-only, no 3-platform, no boot smoke) | absent | **present** (3 project console.warn in bundle: build-conclude-opts.ts:78/143/152; +vendored) | **partial** |
| prd-pipeline (`packages/prd-pipeline`+`plugins/prd`) | CONSOLIDÉ-TS | TS/Node | local-stdio | none (no manifest/server.json/.mcpb) | none | absent | absent (3 console.warn→stderr, stylistic only) | **partial** |

### reasoning
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| zetetic-team-subagents | SOURCE | Python+bash | local-stdio (memory-mcp) | (Python source of the port; memory-tool.sh backend) | n/a here | n/a | n/a | (origin, not a ship target) |
| reasoning (`packages/reasoning`) | CONSOLIDÉ-TS | TS/Node | local-stdio | none (no .mcpb/npm); marketplace plugin | none | absent (no guard, unconditional main()) | absent (10 console.log all in vendored JSDoc) | **partial** (3 divergent versions; brittle 8-level hardcoded backend path to sibling repo) |

### viz
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| cortex-viz | SOURCE | Python | local-stdio | none (no tag despite "cut v1.0.0"); runtime pip-install | none (not offline) | n/a | absent (all stderr or detached subprocess) | **gap** (surface = Python) |
| neural-graph-visualizer | SOURCE | TS/Node | local-stdio | published as Claude Code plugin .zip, **no .mcpb** | n/a (no .mcpb recipe) | absent (no esbuild, structurally impossible) | absent (only JSON-RPC stdout write) | **partial** (version drift 1.1.0 vs 1.0.0) |
| memory-dashboard | CONSOLIDÉ-TS | TS/Node | dashboard-ui (not MCP) | none (private); consumed by memory .mcpb | n/a | absent (correct basename idiom) | absent (server-side clean; browser console = not on pipe) | **partial** (PACKAGING GAP: dashboard server.js/static NOT copied into memory .mcpb → open_visualization spawns non-existent server.js) |

### vision
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| cortex-vision | SOURCE | Mixed (Python+Swift) | local-stdio | none (plugin only, runtime pip) | none | n/a | absent (Swift print→captured subprocess; Python stderr) | **gap** (Python+native; macOS-only — 3-platform gate inapplicable) |
| — | CONSOLIDÉ-TS | — | — | (no TS counterpart) | — | — | — | — |

### voice
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| cortex-voice | SOURCE | Python (+Swift helper) | local-stdio | none (plugin only, runtime pip) | none | n/a | absent (3 print→stderr; Swift→captured subprocess) | **gap** (Python+native; macOS-only) |
| — | CONSOLIDÉ-TS | — | — | (no TS counterpart) | — | — | — | — |

### orchestration
| Composant | Côté | Runtime | Surface | Packaging | Gate | H1 | H2 | Verdict |
|---|---|---|---|---|---|---|---|---|
| — | SOURCE | — | — | (net-new, no source counterpart) | — | — | — | — |
| orchestrator (`packages/orchestrator`) | CONSOLIDÉ-TS | TS/Node | api-sdk (host, not MCP server) | none (private, skeleton) | n/a | absent (sub-optimal `URL().pathname===argv[1]` but tsc output, not esbuild → trap inert) | absent (5 stderr writes) | **partial** (skeleton; Phase-6 deferred; raw API SDK not Agent SDK) |


## Canonical ship source (par capacité)

- **memory** → `agentic-ai/packages/mcp-servers/memory` — Already the law-conformant artifact: TS/Node, .mcpb v0.3.1 SHIPPED (GitHub release memory-v0.3.1, 3 bundles + sha256, offline smoke gate passing). The Python cortex (3.24.0) is the superseded upstream source and must NOT be the Directory ship target (surface law: local→Node/TS). One residual H2 (2 console.warn) must be flipped to console.error before final, but the canonical source is settled.
- **codebase** → `anthropic-partnership/automatised-pipeline (DEPENDS ON USER RULING — see why)` — The Rust source is canonical TODAY: v0.5.0, 11 parsers, the only side with .mcpb machinery + server.json + 3-platform tarballs. The consolidated codebase-rust is a stale v0.0.4 fork (3 parsers) and packages/codebase is a non-shipping private lib. Law prefers Node/TS for local .mcpb, but native tree-sitter+LadybugDB+Tantivy is a justified native exception. MISSING INFO: PHASE_3_PLAN.md says the source is archived in Phase 6, after which codebase-rust becomes canonical — so the long-term ship source is unresolved. Ship from automatised-pipeline NOW; re-sync codebase-rust to v0.5.0 before any archival cutover.
- **prd** → `anthropic-partnership/prd-spec-generator (DEPENDS ON DEDUP RULING)` — Both sides are the SAME source diverged. The partnership repo is AHEAD (v0.4.0, full .mcpb manifest+server.json+ensure-deps.sh) vs consolidated prd-pipeline (v0.1.0/0.3.0, no packaging). Law-conformant (TS/Node). Ship from partnership AFTER fixing H2 (3 console.warn→console.error) and wiring a real 3-platform release. MISSING INFO: explicit dedup ruling on which side survives — confirm with `gh release list -R cdeust/prd-spec-generator` that nothing is already published (local git tag is empty, sha256 is zero placeholder).
- **reasoning** → `agentic-ai/packages/reasoning (the MCP surface is MEMORY, not reasoning patterns)` — The 'reasoning' plugin's MCP server is actually a memory server (identity memory-mcp-server, 2 tools delegating to memory-tool.sh). The 97 genius patterns ship as Claude Code agents/skills, NOT MCP tools. If a memory MCP is desired it should consolidate onto the memory capability ship source, not duplicate it. As a marketplace plugin it has no .mcpb. MISSING INFO: which of the 3 divergent versions (0.0.5/2.13.1/0.1.0) is authoritative; how dist/index.js is built (no esbuild config found); whether the published plugin ships/symlinks the zetetic-team-subagents backend or always requires MEMORY_BACKEND_CMD.
- **viz** → `agentic-ai/packages/memory-dashboard (for the memory-bound viz) — NOT a standalone .mcpb` — memory-dashboard is the TS dashboard-ui consumed BY the memory .mcpb via open_visualization; it is the law-aligned (TS) viz for the shipped memory product. It is not itself an MCP server. The PACKAGING GAP (dashboard server.js/static not copied into the memory .mcpb bundle) must be fixed for open_visualization to work in the packaged build. cortex-viz (Python) and neural-graph-visualizer (Node generic, plugin-only) are separate products with no .mcpb — keep them distinct, do not ship as the memory viz.
- **vision** → `anthropic-partnership/cortex-vision (Python+Swift — native macOS exception)` — On-device capability IS the macOS Apple Vision framework; a pure-TS rewrite still requires a Swift helper subprocess, so the Node/TS law cannot fully apply. macOS-only by construction → the 3-platform smoke gate is inapplicable. No consolidated-TS counterpart exists. SHIP DECISION DEPENDS ON USER: whether the partner waives Node/TS + 3-platform for inherently-native macOS capture plugins, or whether vision/voice stay as marketplace plugins outside the Directory.
- **voice** → `anthropic-partnership/cortex-voice (Python+Swift — native macOS exception)` — Same as vision: Apple Speech (SFSpeechRecognizer/AVAudioEngine) is macOS-native with no Node equivalent; macOS-only → 3-platform gate inapplicable; on-device model is OS-managed. No TS counterpart. SHIP DECISION DEPENDS ON USER ruling on native-macOS exception, identical to vision.
- **orchestration** → `agentic-ai/packages/orchestrator (NOT a .mcpb — it is the host)` — Net-new consolidation-side host/composition-root that ATTACHES MCP servers via @anthropic-ai/sdk; it is not itself an MCP server, so no .mcpb applies. It is currently a Phase-6-deferred skeleton (compiles, exports types, no real conversation). MISSING INFO: whether Phase-6 targets the Agent SDK (partner reco for agents surface) or stays on raw messages API + mcp_servers beta; whether the skeleton will ever be wired (risk of dead scaffolding per coding-standards §9).

## Doublons à résoudre

- **memory** : garder `agentic-ai/packages/mcp-servers/memory (TS, .mcpb v0.3.1 shipped)` · retirer/archiver `anthropic-partnership/cortex (Python hypermnesia-mcp 3.24.0) — supersede its Directory entry io.github.cdeust/hypermnesia-mcp; the TS port carries 1741 source-citations back to it, confirming it is the upstream to retire for Directory purposes`
- **codebase** : garder `anthropic-partnership/automatised-pipeline (Rust v0.5.0, canonical, packaged) — until Phase-6 archival cutover` · retirer/archiver `agentic-ai/packages/codebase-rust (stale v0.0.4 fork, 3 parsers) must be re-synced to v0.5.0 OR retired; agentic-ai/packages/codebase (@agentic/codebase TS lib) — confirm it has a runtime caller or it is dead code`
- **prd** : garder `anthropic-partnership/prd-spec-generator (v0.4.0, ahead, has .mcpb machinery)` · retirer/archiver `agentic-ai/packages/prd-pipeline + plugins/prd (v0.1.0/0.3.0, same source diverged, no packaging) — same lineage, byte-identical esbuild script; collapse to one to avoid publishing two near-identical PRD MCP servers`
- **reasoning/memory** : garder `the single canonical memory MCP (agentic-ai memory)` · retirer/archiver `agentic-ai/packages/reasoning's bundled memory MCP server is a THIRD memory surface (port of zetetic memory-mcp-server) — it duplicates the memory capability; the reasoning plugin should ship genius patterns as agents/skills only and not re-expose memory tools`
- **viz** : garder `Three distinct viz products, intentionally divergent (per audit): memory-dashboard (memory-bound TS), cortex-viz (Cortex-Postgres Python), neural-graph-visualizer (generic Node)` · retirer/archiver `NONE confirmed — audit states no code-sharing; confirm with user whether cortex-viz + neural-graph-visualizer should be consolidated or kept as generic-vs-Cortex-bound split (open question, do not auto-retire)`

## Hazards globaux (bloquants avant ship)

- H2 LIVE in shipped memory v0.3.1 (TS, CONFIRMED): packages/memory/src/shared/content-hardening.ts:52 + consolidation/stages/homeostatic.ts:452 both still console.warn on the stdio JSON-RPC channel (runtime-conditional via remember/ingest/consolidate, NOT boot path). The offline smoke gate sets CORTEX_CONSOLIDATION_DISABLED=1 and uses small content, so it does NOT exercise these paths and would not catch them. BLOCKING for a clean v0.3.2 — flip both to console.error.
- H1 BOMB present in stale local artifact (CONFIRMED present in working tree): agentic-ai/packages/mcp-servers/memory/dist-mcpb/ contains agentic-memory-0.3.0-darwin-arm64.mcpb + bundle/dist/index.js:46741 with the live isCliEntry bomb (import.meta.url===argv[1], zero basename idiom). NOT shipped (pre-fix v0.3.0 build, Jun-19 11:22), but must be DELETED so future audits/builds do not mistake it for the release bundle.
- H2 LIVE in prd-spec-generator shipped bundle (TS): build-conclude-opts.ts:78/143/152 console.warn survive into mcp-server/index.js on the conclude_verification path. Node routes console.warn→stderr so JSON-RPC is not corrupted in practice, but it violates the house console.error rule and must be fixed before the first .mcpb publish.
- H1 in orchestrator (TS) uses sub-optimal `new URL(import.meta.url).pathname === process.argv[1]` — INERT TODAY because dist is plain tsc (94 lines, not esbuild-bundled), but becomes a live bomb the moment a bundler is introduced. Upgrade to basename idiom preemptively.
- No H1/H2 in: reasoning (10 console.log all in vendored JSDoc), memory-dashboard server-side (browser console only), neural-graph-visualizer (no esbuild, only JSON-RPC stdout write), and all Python/Rust/Swift components (stdout-equivalent audited clean — every diagnostic on stderr/eprintln/file=sys.stderr; native helper stdout is captured by subprocess, isolated from MCP pipe).

## Phase 1 — livrer .mcpb

- **memory (agentic-ai/packages/mcp-servers/memory)** — Finalize the already-shipped .mcpb: (a) flip the 2 residual H2 console.warn→console.error (content-hardening.ts:52, homeostatic.ts:452 — CONFIRMED still present); (b) delete stale dist-mcpb/ (CONFIRMED present: agentic-memory-0.3.0-darwin-arm64.mcpb + bundle/ with live H1 bomb at index.js:46741); (c) reconcile version drift (plugin.json 0.3.2 vs engine/mcpb 0.3.1); (d) extend the offline smoke gate to exercise remember/ingest/consolidate so it would actually catch H2. Then cut v0.3.2.
  - _memory is the ONLY component with a passing v0.3.1 gate and a real shipped .mcpb. It is the reference recipe — closing its 2 residual hazards + stale artifact makes it the clean template for every other Phase-1 ship._
- **prd-spec-generator (anthropic-partnership)** — Ship .mcpb v0.4.x: fix H2 (build-conclude-opts.ts:78/143/152 console.warn→console.error, verify they leave the bundle), add 3-platform matrix (darwin-arm64/linux-x64/linux-arm64) + per-platform sha256 + boot smoke step to release.yml, inject real .mcpb sha256 into server.json (currently zero placeholder), reconcile mcp-server/package.json 0.2.0 vs 0.4.0, cut the first git tag. FIRST confirm via `gh release list -R cdeust/prd-spec-generator` nothing is already published.
  - _Law-conformant TS/Node, already has .mcpb scaffolding, the only blockers are an active H2 in the shipped bundle and a never-fired single-platform release. Highest-ready ship after memory._
- **automatised-pipeline (anthropic-partnership)** — Ship .mcpb v0.5.x: investigate why automatised-pipeline.mcpb is ABSENT from the v0.5.0 release (package_mcpb job failed/skipped), wire the workflow-computed .mcpb.sha256 back into server.json (currently zero placeholder), add a boot/JSON-RPC handshake smoke step across the 3 platforms (CI currently only runs cargo test). H1/H2 already clean (Rust, eprintln! discipline verified).
  - _Native-justified Rust exception; code hazards already absent. The gate gap is purely packaging delivery + sha256 wiring + boot proof — mechanical fixes, no code rewrite._

## Phase 2 — porter Python→Node

- **codebase-rust (agentic-ai) re-sync vs retire** — Decide: re-sync codebase-rust from automatised-pipeline v0.5.0 (gain 8 parsers + ZERA crate) before any Phase-6 archival, OR retire codebase-rust and keep automatised-pipeline as the surviving artifact. Also confirm whether @agentic/codebase (TS adapter) has a live runtime caller or delete it as dead code.
  - _Three implementations of one capability (Rust source v0.5.0, Rust port v0.0.4, TS lib). Consolidating from the stale fork would lose capability. Not a Python→Node port — a divergence-reconciliation._
- **cortex (Python) → memory TS** — No port needed — the port is DONE (agentic-ai memory is the TS re-implementation with 1741 citations). Phase-2 action is to formally retire/supersede the Python Directory entry, not re-port.
  - _Memory is the one capability where the Python→Node migration is already complete and shipped. Avoid re-doing it._
- **cortex-viz (Python) → TS shell (optional)** — If Directory listing is desired: port only the thin 2-tool MCP shell (open_visualization, get_methodology_graph) to TS, keep the heavy Python render/graph engine (igraph/datashader/numpy, 125 files) behind it as a subprocess. Otherwise keep as Python marketplace plugin (documented exception).
  - _Full TS port of the viz stack is costly and low-value; only the MCP surface needs to be Node/TS for the law. Decision depends on whether cortex-viz is even a Directory target._
- **cortex-vision + cortex-voice (Python+Swift, macOS-native)** — SPECIAL CASE — escalate to user/partner: these CANNOT become pure-TS (Apple Vision/Speech are macOS frameworks; a TS .mcpb would still shell to a Swift helper) and CANNOT satisfy the linux-x64/linux-arm64 smoke gate (macOS-only). Request a native-macOS exception to the Node/TS + 3-platform rules, or keep them as marketplace plugins outside the Directory. Also fix runtime-pip-install-at-boot (breaks offline posture) before any packaging.
  - _The on-device capability IS the OS framework. No amount of porting removes the native dependency or makes linux gates meaningful. This is a policy decision, not an engineering task._

## Phase 3 — durcissement §5 + garde-fous

- **memory engine (packages/memory/src)** — Add a commit/CI lint rule: no-console except console.error on the stdio MCP path (ban console.log/info/warn). #96 was a manual one-time sweep — without a guard rail H2 WILL recur (proof: 2 sites were missed by #96 and persist).
  - _Prevents H2 regression at source. The audit explicitly flags this as an open question — the missed sites prove manual sweeps are insufficient._
- **ALL Node/TS components (memory, prd, reasoning, orchestrator, neural-graph-visualizer)** — Add a shared pre-commit/CI guard banning the H1 idiom `fileURLToPath(import.meta.url) === process.argv[1]` (require basename `process.argv[1]?.endsWith('X.js')`) AND banning bundled console.log/info/warn on stdio servers. Run the grep over BOTH src/ and every dist/ bundle.
  - _H1+H2 are the two banned root causes of the memory-v0.3.1 delivery. A static guard is the only durable defense; code review missed them once already._
- **memory-dashboard packaging gap** — Fix pack-mcpb.mjs to cpSync the dashboard dist/server.js + src/static/ into the memory .mcpb BUNDLE (currently only models+icon copied), OR change launchDashboard to resolve a bundled path. Then end-to-end verify: install agentic-memory-*.mcpb and call open_visualization. If dashboard is dev-only, document that open_visualization is non-functional in the packaged build.
  - _Under esbuild __dirname=bundle root, so the inlined launcher spawns a non-existent server.js — open_visualization silently fails in the shipped .mcpb. §5 hardening + truthful packaging._
- **reasoning plugin** — Resolve the 3 divergent versions (0.0.5/2.13.1/0.1.0), document/refresh the dist/index.js build provenance (no esbuild config found), and fix the brittle 8-level hardcoded backend path to zetetic-team-subagents (require MEMORY_BACKEND_CMD or bundle/symlink the backend). Decide whether it re-exposes memory tools at all.
  - _Boot is unsatisfiable in the published layout (default path resolves to an absent sibling repo). Bootability hardening before any distribution._
- **orchestrator** — Decide Phase-6 target (Agent SDK vs raw messages API+mcp_servers beta), upgrade the sub-optimal H1 guard to basename idiom for hygiene, update stale 'claude-opus-4-5' default, and either wire it or mark it explicitly as planned-not-dead scaffolding (coding-standards §9).
  - _Skeleton risk of unwired code; H1 guard is inert today (tsc not esbuild) but becomes a live bomb if a bundler is introduced._

## Tension stratégique (mémoire Cortex 4200273)

Lesson Cortex 4200273 framed the choice as FastMCP aggregator (~3 weeks, a thin facade fronting the existing servers) vs full alignment (~4-9 months, real TS re-ports). The user chose FULL ALIGNMENT, and this backlog serves it: memory is already a shipped TS re-port (not a facade), prd/codebase ship from their own real artifacts, and Phase-2 ports the remaining Python surfaces individually rather than wrapping them. The aggregator path is explicitly NOT taken — nothing here proposes a single FastMCP front. THE BASCULE (tipping point) is the macOS-native pair (cortex-vision, cortex-voice): full alignment to Node/TS is structurally impossible there because the capability IS an Apple framework. At that boundary the alignment strategy must accept a documented native exception (Python+Swift plugin) rather than force a port — this is the one place where 'full alignment' yields to 'aligned MCP shell over a native helper, or kept outside the Directory.' That decision is a user/partner policy call, not an engineering deliverable.

## Top risques

- Publishing two near-identical PRD MCP servers (partnership prd-spec-generator v0.4.0 + consolidated prd-pipeline) into the Directory — same source diverged, no dedup ruling made yet. Must collapse to one before any prd ship.
- The Python cortex (hypermnesia-mcp) may ALREADY be listed in the Anthropic MCP Directory under io.github.cdeust/hypermnesia-mcp. If so, shipping the TS memory creates a duplicate listing unless the Python entry is withdrawn/superseded — a policy action, not code.
- Three live H2 sites across shipped TS artifacts (2 in memory v0.3.1, 3 in prd bundle) + a stale H1-bomb .mcpb in the memory working tree. Manual sweeps already missed sites once (#96) — without a CI lint guard, every future ship risks reintroducing stdout pollution that silently corrupts JSON-RPC framing.
- memory .mcpb packaging gap: open_visualization spawns a non-existent server.js inside the shipped bundle (dashboard not copied in). The flagship shipped product has a broken tool until verified/fixed end-to-end.
- Codebase capability has THREE implementations (Rust v0.5.0 source, Rust v0.0.4 stale fork, TS lib) with a Phase-6 archival plan that flips canonicity — shipping or archiving the wrong one loses the 11-parser + ZERA capability.
- automatised-pipeline v0.5.0 server.json advertises a .mcpb at a download URL that 404s (artifact missing from release) with a zero-placeholder sha256 — registry submission would be unverifiable/broken.

## Actions USER

- Decide the PRD dedup: ship from anthropic-partnership/prd-spec-generator (v0.4.0, ahead) and retire/archive agentic-ai prd-pipeline — explicit ruling needed before any prd publish.
- Confirm whether the Python cortex (io.github.cdeust/hypermnesia-mcp) is already submitted to the Anthropic MCP Directory. If yes, supersede/withdraw it via the Anthropic Directory form in favor of the TS memory server (the gap is a surface/policy mismatch, not a code defect).
- Rule on the macOS-native exception for cortex-vision + cortex-voice: either request a partner waiver of the Node/TS + 3-platform requirements for inherently-native macOS capture plugins, or keep them as marketplace plugins OUTSIDE the Directory. Engineering cannot resolve this — Apple Vision/Speech have no Node equivalent.
- Decide codebase canonicity: re-sync agentic-ai/codebase-rust to v0.5.0 before Phase-6 archival of automatised-pipeline, OR keep automatised-pipeline as the surviving artifact and retire the fork. Confirm @agentic/codebase TS adapter has a live caller or delete it.
- Authorize deletion of the stale agentic-ai/packages/mcp-servers/memory/dist-mcpb/ directory (contains the live-H1-bomb v0.3.0 .mcpb + bundle).
- Confirm whether cortex-viz and neural-graph-visualizer should be consolidated or intentionally kept as Cortex-bound-vs-generic distinct products (audit found no code sharing; do not auto-merge).

## À vérifier

- prd-spec-generator publication state: run `gh release list -R cdeust/prd-spec-generator` — local git tag is EMPTY and server.json sha256 is a zero placeholder, so it appears unpublished, but confirm no release was pushed from a clean checkout elsewhere.
- automatised-pipeline: why is automatised-pipeline.mcpb absent from the v0.5.0 GitHub release assets (only tarballs present)? Did package_mcpb fail/skip, or was the .mcpb published to a different channel (glama.json suggests a Glama path)?
- memory .mcpb open_visualization end-to-end: install agentic-memory-*.mcpb and actually call open_visualization to confirm whether the dashboard server.js is reachable or the packaging gap breaks it (audit flags this as needing end-to-end verification, not yet proven).
- memory version drift: is plugin.json 0.3.2 an in-flight bump or accidental drift vs engine/mcpb/tag 0.3.1? Runtime serverInfo reads 0.3.1 regardless — confirm intended.
- reasoning plugin: which of the 3 divergent versions (0.0.5/2.13.1/0.1.0) is authoritative; how dist/index.js is built (no esbuild config found under packages/reasoning/scripts/); whether the published plugin ships/symlinks the zetetic-team-subagents backend or the 8-level hardcoded path is always unsatisfied (requiring MEMORY_BACKEND_CMD).
- cortex (Python) offline-model gate: does the local .mcpb run fully offline or pull all-MiniLM-L6-v2 + flashrank from HuggingFace at first boot? No vendored-model or 3-platform smoke+sha256 evidence found. Also confirm the win32 manifest claim given the bundle ships only darwin .so natives.
- orchestrator Phase-6 intent: Agent SDK vs raw messages API+mcp_servers beta; and whether the skeleton is genuinely planned or risks being dead scaffolding (no real caller drives a conversation today).
- release-codebase-binaries.yml references plugins/codebase/src-rust which does not exist in agentic-ai (plugins/ holds only memory,prd) — confirm whether this workflow is dead or pending an uncommitted tree.
- codebase-rust Cargo.toml port comment names a THIRD upstream path (/Users/cdeust/Developments/anthropic/ai-automatised-pipeline) distinct from the audited repo — confirm stale reference vs separate mirror needing audit.
- reasoning memory.ts/memory-extensions.ts exact tool input-schema enums were inferred from backend.ts mappers, not read from the schema definitions — confirm the precise client-surfaced subcommand set if it matters for Directory tool-listing.

## Critique de complétude

- **session-optimizer (anthropic-partnership/session-optimizer)** — manque : Composant du périmètre JAMAIS audité. C'est un repo Claude Code plugin publié (plugin.json v1.3.0, github.com/cdeust/session-optimizer) avec hooks Stop+UserPromptSubmit, /refine skill, statusline. Absent de toutes les lignes et de la matrice. Question non répondue: est-ce un serveur Directory ou juste un plugin agents/skills/hooks ?
  - action : VÉRIFIÉ ICI: plugin.json n'a AUCUNE clé mcpServers, grep StdioServerTransport/FastMCP = 0 — c'est un plugin hooks/skills pur, PAS un serveur MCP. Ajouter une ligne capability=orchestration/tooling, mcpSurface=not-a-server, phaseAction=none (hors Directory, distribué marketplace). Documenter explicitement comme 'plugin, pas un ship target Directory' pour fermer le périmètre.
- **codebase (matrix verdict + packaging 'none' / 'no prebuilt binaries shipped on this side')** — manque : AFFIRMATION CONTREDITE PAR PREUVE. La ligne codebase et la matrice affirment 'No prebuilt binaries shipped on this side' / packaging 'none'. FAUX: gh release view codebase-v0.0.1 -R cdeust/agentic-ai (non-draft, 2026-05-07) ship 6 assets automatised-pipeline-{linux-aarch64,linux-x86_64,macos-aarch64}.tar.gz + .sha256 DEPUIS le repo agentic-ai. Le côté consolidé A déjà publié des binaires codebase Rust.
  - action : Corriger la ligne codebase: packaging.published doit refléter codebase-v0.0.1 (binaires Rust shippés côté consolidé, 3 plateformes + sha256, mais pas de .mcpb). Re-vérifier: ces binaires viennent-ils de codebase-rust v0.0.4 ou d'un build importé ? Réévaluer le verdict 'not-a-server' à la lumière d'un release de binaires réel. release-codebase-binaries.yml EXISTE bien dans agentic-ai/.github/workflows/ (contrairement à l'implication 'workflow dead').
- **reasoning (evidence file:line paths)** — manque : CHEMIN MAL CITÉ. La ligne reasoning et les evidence citent 'src/index.ts:128', 'packages/reasoning/src/...' mais packages/reasoning/ N'A PAS de src/ (seulement agents/dist/hooks/skills). La VRAIE source du serveur MCP est packages/mcp-servers/reasoning/src/index.ts. Le verdict H1 (main() inconditionnel, pas de guard) est correct mais à un chemin différent de celui cité.
  - action : Reprover toutes les evidence file:line de la ligne reasoning contre packages/mcp-servers/reasoning/src/ (PAS packages/reasoning/src/). VÉRIFIÉ ICI: main().catch à mcp-servers/reasoning/src/index.ts:128, pas de guard import.meta.url===argv[1] (H1 absent confirmé). Corriger repoPath et les 10+ chemins d'evidence pour pointer le bon package.
- **parity-benchmark, parity-runner, core (agentic-ai/packages)** — manque : Trois packages du monorepo consolidé non audités ni classés. core (@agentic/core, Frozen Day-0 type surface), parity-benchmark (@agentic/parity-benchmark v0.1.0, bin parity-benchmark, harness qui asserte la parité TS-port vs scores publiés source), parity-runner. parity-dual-run.yml existe comme workflow. Aucun n'est un serveur MCP mais aucun n'est explicitement écarté.
  - action : Ajouter une note de périmètre: core/parity-benchmark/parity-runner = libs internes private (not-a-server), hors Directory. Confirmer qu'aucun n'expose StdioServerTransport. Le parity harness est load-bearing pour la stratégie 'full alignment' (il prouve la parité du port) — le mentionner dans memoryTension comme l'instrument qui valide que memory est un vrai re-port et pas une façade.
- **prd-pipeline consolidated (matrix 'no manifest/server.json')** — manque : Le find a trouvé packages/prd-pipeline/packages/benchmark/src/golden-fixtures/sample-feature/manifest.json — un faux positif (fixture de test), mais l'affirmation 'no manifest.json' n'a pas été qualifiée pour distinguer fixtures vs packaging réel. Mineur mais l'evidence devrait exclure explicitement les fixtures.
  - action : Préciser dans la ligne prd-pipeline: 'no manifest.json/server.json de PACKAGING (le seul manifest.json est une golden-fixture de test sous packages/benchmark/)'. Évite qu'un futur audit croie à tort qu'un manifest de packaging existe.
- **prd-spec-generator publication state (matrix 'NEVER shipped' vs toVerify)** — manque : Incohérence de niveau de certitude: la matrice AFFIRME 'NEVER shipped (no git tag, sha256 placeholder)' comme un fait, mais toVerify le liste comme à confirmer via gh. Une affirmation et une réserve sur le même fait.
  - action : RÉSOLU ICI: gh release list -R cdeust/prd-spec-generator = VIDE, git tag local = VIDE. Confirmé non-publié. Promouvoir de 'toVerify' à fait établi: prd-spec-generator n'a aucune release GitHub. Retirer l'item correspondant de toVerify pour éviter le doute résiduel sur une décision 'ship from'.
- **automatised-pipeline .mcpb absence (cross-check codebase-v0.0.1)** — manque : L'audit traite la v0.5.0 (anthropic-partnership) mais ne croise pas avec codebase-v0.0.1 (agentic-ai, 2026-05-07) qui ship les MÊMES binaires automatised-pipeline-*.tar.gz. Le .mcpb manque dans la v0.5.0 source, MAIS des binaires automatised-pipeline existent déjà publiés côté consolidé — doublon de distribution non relevé.
  - action : VÉRIFIÉ ICI: v0.5.0 (cdeust/automatised-pipeline) = 6 tarballs SANS .mcpb (confirme l'audit); codebase-v0.0.1 (cdeust/agentic-ai) = les mêmes 6 tarballs automatised-pipeline. Ajouter au duplication[]: les binaires codebase Rust sont publiés sur DEUX repos (automatised-pipeline source ET agentic-ai/codebase-v0.0.1). Décision user requise: quel repo est le canal de distribution canonique des binaires codebase ?
- **EULER conformanceTarget (surface law 'Node/TS')** — manque : Toute la matrice repose sur 'surface law: local .mcpb → Node/TS' attribuée à 'EULER partner reco / checkpoint 2026-06-20'. Cette loi-socle n'est citée par AUCUNE preuve file:line ni artefact partenaire vérifiable dans le périmètre — c'est l'axiome qui drive TOUS les verdicts 'gap' (cortex/cortex-viz/vision/voice) et la stratégie de port. Non vérifié à la source.
  - action : Confirmer la règle 'local MCP/.mcpb = Node/TypeScript' via mcp__claude_ai_EULER__partner_artifacts ou la mémoire Cortex (recall 'EULER partner reco surface mcpb node typescript 2026-06-20'). Si la loi ne se vérifie pas, tous les verdicts 'gap' sur surface Python/Rust/Swift sont infondés. C'est le point d'appui zététique le plus load-bearing et le seul sans preuve.
- **userActions — session-optimizer scope ruling** — manque : Aucune action USER ne couvre session-optimizer (ni les 3 libs parity/core). Le périmètre des composants à statuer pour le Directory est incomplet: l'utilisateur n'est pas invité à confirmer que session-optimizer reste un plugin marketplace hors Directory.
  - action : Ajouter à userActions: 'Confirmer que session-optimizer (+ neural-graph-visualizer déjà noté) restent des plugins Claude Code marketplace HORS du Directory MCP — ce ne sont pas des serveurs MCP.' Ferme le périmètre des décisions de scope.

---

## Annexe — lignes d'audit


### memory · consolidated-ts · cap=memory
- runtime=TypeScript/Node · surface=local-stdio · verdict=**partial** · action=already-shipped · conf=high
- packaging: mcpb=True published=True version=0.3.1 gate=passing
- notes: SHIPPED gold confirmed. GitHub release memory-v0.3.1 (commit e72c033, 'fix(memory): route consolidation/ingest logs to stderr', #96) is non-draft/non-prerelease, published 2026-06-19T18:33Z, with exactly 3 platform bundles + per-bundle sha256: agentic-memory-0.3.1-{darwin-arm64,linux-arm64,linux-x64}.mcpb(.sha256). darwin-x64 intentionally removed (onnxruntime-node@1.25.1 has no Intel-macOS binary — workflow lines 75-81, sourced+dated). Bootable+offline gate is real and wired: workflow step 'Runtime smoke-test the packed .mcpb (offline)' (lines 145-157) runs scripts/smoke-mcpb.mjs with HF_HUB_OFFLINE=1/TRANSFORMERS_OFFLINE=1/HF_ENDPOINT=127.0.0.1:9, asserting MCP initialize, tools/list>=48, remember+recall (offline embedding) and FlashRank ONNX CE discrimination (offline rerank). Models bundled BY DEFAULT (pack-mcpb.mjs: MiniLM-L6-v2 embeddings + ms-marco tokenizer + FlashRank ONNX). Version drift note: plugin manifest at plugins/memory/.claude-plugin/plugin.json is 0.3.2 while engine package.json/mcpb manifest are 0.3.1 and shipped tag is memory-v0.3.1.
- hazards: H1=absent H2=present
  - ⚠ H1 VERIFIED ABSENT in shipped v0.3.1: all 3 background workers use the CORRECT basename idiom — consolidate-background.ts:375 / grooming-background.ts:321 / ingest-codebase-background.ts:118 all `process.argv[1]?.endsWith("X.js") === true`, with sourced comments explaining the esbuild import.meta.url rewrite trap. Confirmed at the memory-v0.3.1 git tag.
  - ⚠ H1 BOMB PRESENT IN STALE LOCAL ARTIFACT ONLY (not shipped): packages/mcp-servers/memory/dist-mcpb/bundle/dist/index.js:46741-46748 contains the live BOMB `var isCliEntry=(()=>{...fileURLToPath(import.meta.url)===process.argv[1]...})(); if(isCliEntry){runConsolidateCycle().then(()=>process.exit(0))}` with ZERO basename idioms. This bundle is the pre-fix v0.3.0 artifact (manifest+package.json=0.3.0, built Jun-19 11:22, BEFORE the H1 fix landed in source Jun-19 19:03). It is an un-cleaned local build, NOT the published bundle. ACTION: delete dist-mcpb/ to avoid confusion.
  - ⚠ H2 RESIDUAL stdout pollution in shipped v0.3.1 source (2 sites, runtime-conditional, NOT boot-path): packages/memory/src/shared/content-hardening.ts:52 console.warn (fires on oversized-content truncation during remember/ingest) and packages/memory/src/consolidation/stages/homeostatic.ts:452 console.warn (fires when cohort-correction fails to reduce bimodality during consolidate). Both reachable via MCP tool calls on the stdio JSON-RPC channel -> would corrupt framing mid-operation. Notably homeostatic.ts:461 RIGHT BELOW correctly uses console.error with comment 'stderr only — stdout is the MCP JSON-RPC channel', proving the rule was known and these two were simply missed by the #96 sweep. Boot path itself is clean (index.ts uses only process.stderr.write; the 5 process.stdout.write in hooks/ are gated behind isCliEntry basename checks and never fire under the MCP server). Fix: change both console.warn -> console.error.
- counterpart: /Users/cdeust/Developments/anthropic-partnership/cortex (Python Cortex). Relation: independent TypeScript RE-IMPLEMENTATION (port), not a dependency or copy. The TS memory engine carries 1741 `source: cortex@<sha> mcp_server/...py::...` citations mapping each TS method to a specific Python original (e.g. index.ts:165 -> cortex@ed33435 sqlite_store_search.py::vec_search). plugin.json describes itself "TS port of Cortex". DB-isolation guard (index.ts:98-117) explicitly refuses to connect to the Python plugin's `cortex` PostgreSQL database — confirming the two are parallel, co-existing, deliberately non-overlapping systems.
  - ? Version drift: plugin.json reports 0.3.2 while engine package.json + mcpb manifest + shipped tag are all 0.3.1. Is 0.3.2 an in-flight unreleased bump or an accidental drift? The runtime serverInfo.version reads from the engine package.json (0.3.1), so the advertised version is 0.3.1 regardless.
  - ? Residual H2 (content-hardening.ts:52, homeostatic.ts:452 console.warn) is a latent stdio-framing corruption reachable via remember/ingest/consolidate tool calls. The offline smoke-gate sets CORTEX_CONSOLIDATION_DISABLED=1 and uses small content, so it does NOT exercise these two paths — meaning the gate would not have caught them. Should both be flipped to console.error and a targeted lint (no-console except error) added to packages/memory/src?
  - ? Stale local artifact dist-mcpb/bundle (v0.3.0 with live H1 bomb) sits in the working tree. It is not shipped, but should be deleted so future audits/builds don't mistake it for the release bundle.
  - ? Did a lint/CI rule get added to prevent future console.log/info/warn regressions on the memory engine, or was #96 a one-time manual sweep? If manual, H2 will recur.
- evidence:
  - .github/workflows/release-memory-mcpb.yml:72-74 — 3-platform matrix (darwin-arm64, linux-x64, linux-arm64)
  - .github/workflows/release-memory-mcpb.yml:75-81 — darwin-x64 intentionally excluded, sourced (onnxruntime-node 1.25.1 no Intel-macOS binary), verified 2026-06-19
  - .github/workflows/release-memory-mcpb.yml:124-143 — shasum -a 256 per bundle
  - .github/workflows/release-memory-mcpb.yml:145-157 — offline runtime smoke-test gate (boot+tools+embedding+reranker, HF network blackholed)
  - packages/mcp-servers/memory/scripts/smoke-mcpb.mjs:34-50,87-103,107-130 — offline env, MCP initialize/tools-list>=48/remember+recall/FlashRank-CE gate
  - packages/mcp-servers/memory/scripts/pack-mcpb.mjs:144-161 — postProcessBundle strips double shebang (the v0.3.0 boot break) + adds createRequire shim
  - packages/mcp-servers/memory/scripts/pack-mcpb.mjs:188-274 — offline models bundled by default (MiniLM embeddings + ms-marco tokenizer + FlashRank ONNX)
  - packages/mcp-servers/memory/scripts/pack-mcpb.mjs:276-296,303-305 — arch-stamped filename + OS-gate manifest narrowing
  - packages/mcp-servers/memory/src/index.ts:18-22,78-80,107-110,132-148,332-337 — boot path logs ONLY via process.stderr.write; header documents 'Logging: ONLY to stderr'
  - packages/memory/src/hooks/consolidate-background.ts:375 — isCliEntry = process.argv[1]?.endsWith("consolidate-background.js") === true (H1 CORRECT)
  - packages/memory/src/hooks/grooming-background.ts:321 + ingest-codebase-background.ts:118 — same correct basename idiom; comments at :317/:114 explain the esbuild import.meta.url trap
  - git tag memory-v0.3.1 = e72c033 'fix(memory): route consolidation/ingest logs to stderr (stdout is the MCP channel) (#96)' 2026-06-19 — H2 sweep commit IS the tag
  - gh release memory-v0.3.1: draft=false prerelease=false published=2026-06-19T18:33Z, assets = 3x .mcpb + 3x .sha256 (darwin-arm64/linux-arm64/linux-x64)
  - HAZARD-STALE: packages/mcp-servers/memory/dist-mcpb/bundle/dist/index.js:46741-46748 — live H1 BOMB in un-cleaned v0.3.0 local artifact (manifest 0.3.0, built Jun-19 11:22 pre-fix); grep: 1x import.meta.url===argv, 0x basename idiom
  - HAZARD-RESIDUAL H2: packages/memory/src/shared/content-hardening.ts:52 + consolidation/stages/homeostatic.ts:452 — console.warn on stdio channel (runtime-conditional, not boot); homeostatic.ts:461 just below correctly uses console.error
  - counterpart: 1741 'source: cortex@<sha>' citations in packages/memory/src/**/*.ts → independent TS port of /Users/cdeust/Developments/anthropic-partnership/cortex (Python)
  - index.ts:98-117 — guard refuses DATABASE_URL named 'cortex' (Python plugin's DB) → confirms parallel non-overlapping systems

### codebase · consolidated-ts · cap=codebase
- runtime=Mixed · surface=not-a-server · verdict=**partial** · action=Phase2-port · conf=high
- packaging: mcpb=False published=False version=0.1.0 (TS) / 0.0.4 (Rust crate) gate=none
- notes: Consolidated-ts side has NO mcpb/server packaging — TS package is a private library adapter; Rust crate is an internal subprocess engine. Binary is NOT statically embedded: resolved at runtime via AI_ARCH_BIN env or @agentic/codebase-rust/target/release/ai-architect-mcp, requiring a local `cargo build --release` (rust-binary-resolver.ts:31-78). No prebuilt binaries shipped on this side. The release-codebase-binaries.yml workflow is BROKEN against this tree: it builds from `plugins/codebase/src-rust` producing bin `automatised-pipeline`, but that path does not exist in agentic-ai (plugins/ holds only memory/prd) — the workflow is a verbatim lift of the counterpart's recipe pointed at the counterpart's layout, so no working offline/bootable gate exists here.
- hazards: H1=n/a H2=absent
  - ⚠ H1 n/a: Rust binary, no fileURLToPath/import.meta.url idiom; fn main() (main.rs:3467) IS the JSON-RPC read loop with no detached background worker spawned at boot.
  - ⚠ H2 absent (real grep): Rust stdout discipline clean — only write_message() writes JSON-RPC to stdout (main.rs:120-124); ALL diagnostics use eprintln!/stderr (main.rs:3468,3476,3486). Sole println! is inside a test-fixture diff string (git_diff.rs:430), not runtime. TS adapter emits diagnostics exclusively via process.stderr.write (rust-binary-resolver.ts:57,71).
  - ⚠ Divergence risk: codebase-rust frozen at 0.0.4 while counterpart advanced to 0.5.0 — 8-language parser gap and missing ZERA crate; consolidating from the stale copy would lose capability.
- counterpart: anthropic-partnership/automatised-pipeline — relation = COPY that has DIVERGED (stale fork). Same Cargo package name `ai-architect-mcp`; counterpart is v0.5.0 with bin renamed to `automatised-pipeline`, codebase-rust is the frozen v0.0.4 import (README: "verbatim copy of ai-automatised-pipeline as of 2026-04-27"). Counterpart is the canonical Phase-1 shipped product (mcpb manifest 0.4, server.json, launch.sh, ensure-binary fast-path, 11 tree-sitter parsers); codebase-rust has only 3 parsers (python/rust/ts) and no packaging. The source repo will be archived in Phase 6 per PHASE_3_PLAN.md, after which codebase-rust is meant to become canonical.
  - ? Is the agentic-ai monorepo intended to ship codebase as a user-facing MCP server at all, or only consume @agentic/codebase as an internal library? No mcpb/server.json exists on this side — the shippable product is the counterpart automatised-pipeline.
  - ? Should codebase-rust (v0.0.4, 3 parsers) be re-synced from the now-divergent counterpart (v0.5.0, 11 parsers + ZERA) before any consolidation, or is the counterpart the surviving artifact and codebase-rust to be retired?
  - ? release-codebase-binaries.yml references plugins/codebase/src-rust which does not exist — is this workflow dead, or pending a not-yet-committed plugins/codebase tree?
  - ? Does any monorepo package actually instantiate createCodebaseAdapter at runtime (consumer search found only codebase-rust referencing @agentic/codebase) — confirm whether the adapter is wired or currently dead code.
- evidence:
  - packages/codebase/package.json:5 — "TS adapter for the Rust automatised-pipeline binary. Implements CodebasePort over a JSON-RPC stdio subprocess." (library, not server)
  - packages/codebase/src/index.ts:104-114 — createCodebaseAdapter wires ProcessSupervisor -> JsonRpcClient -> RustPipelineAdapter, returns CodebasePort; no MCP server registration
  - packages/codebase/src/adapters/rust-binary-resolver.ts:31-78 — binary resolved at runtime via AI_ARCH_BIN env or @agentic/codebase-rust/target/release/ai-architect-mcp; NOT statically embedded, requires local cargo build
  - packages/codebase-rust/README.md:8-12 — "verbatim copy of the ai-automatised-pipeline source as of 2026-04-27"; canonical after Phase 6 archival
  - packages/codebase-rust/Cargo.toml:10-18 — package ai-architect-mcp v0.0.4, bin ai-architect-mcp; 3 parsers (python/rust/ts)
  - automatised-pipeline/Cargo.toml:11-17 — same package ai-architect-mcp but v0.5.0, bin renamed automatised-pipeline; 11 tree-sitter parsers + crates/zera
  - packages/codebase-rust/src/main.rs:120-124 (write_message -> stdout JSON only) + :3468/:3476/:3486 (eprintln! diagnostics to stderr) — H2 absent
  - packages/codebase-rust/src/git_diff.rs:430 — sole println! is test-fixture diff string, not runtime stdout
  - .github/workflows/release-codebase-binaries.yml:111-141 — builds from plugins/codebase/src-rust (path absent in repo; plugins/ holds only memory,prd) and produces bin automatised-pipeline — workflow does not match this tree
  - automatised-pipeline/manifest.json:1-6 + server.json — counterpart ships mcpb 0.4 manifest v0.5.0, server.json io.github.cdeust/automatised-pipeline: the actual Phase-1 product lives on the SOURCE side, not consolidated-ts

### reasoning · consolidated-ts · cap=memory
- runtime=TypeScript/Node · surface=local-stdio · verdict=**partial** · action=Phase3-harden · conf=high
- packaging: mcpb=False published=False version=0.0.5 (plugin.json) / 2.13.1 (package.json+marketplace.json) / 0.1.0 (source pkg mcp-servers/reasoning) — three divergent version numbers gate=none
- notes: No .mcpb, no npm publish, no 3-platform smoke gate, no sha256. release.yml runs test suite + GitHub release only; ci.yml runs memory test suites + zetetic-checker. No embedded offline models (n/a: pure subprocess wrapper around memory-tool.sh). Bootability is brittle: default backend path resolves 8 levels above dist/ to a sibling zetetic-team-subagents repo that is absent from the published plugin tree (ls of the hardcoded default path returned No such file or directory); boot relies on MEMORY_BACKEND_CMD override or a co-located sibling checkout.
- hazards: H1=absent H2=absent
  - ⚠ main() invoked unconditionally at top-level (src/index.ts:128; bundle dist/index.js:14194) — no import.meta.url===argv[1] guard exists, so no isCliEntry-bomb is even possible; no detached background worker
  - ⚠ Single fileURLToPath(import.meta.url) at src/backend.ts:28 / dist/index.js:13888 computes _SCRIPT_DIR for the backend path, NOT an entry guard
  - ⚠ All 10 console.log occurrences in the plugin bundle dist/index.js (lines 12576-13289) are inside JSDoc @example comment blocks of bundled @modelcontextprotocol/sdk@1.29.0 (requestStream/experimental tasks) — every line prefixed ' * ', never executed; source-package bundle mcp-servers/reasoning/dist/index.js has 0 console.log
  - ⚠ Boot banner uses process.stderr.write (src/index.ts:123-125); fatal handler uses process.stderr.write (src/index.ts:128-131); source comments src/index.ts:26-27 and src/backend.ts:17-18 explicitly document stderr-only logging discipline
  - ⚠ Brittle hardcoded relative backend path (8x ../) coupling the TS plugin to an external sibling repo — not a JSON-RPC hazard but a deployment/bootability hazard
- counterpart: anthropic-partnership/zetetic-team-subagents — independent TS reimplementation + hard runtime dependency. src/index.ts:5 documents the server as a "TypeScript port of zetetic@HEAD tools/memory-mcp-server.py"; every handler cites memory-mcp-server.py:NNN line provenance. At runtime backend.ts:46 shells out to that repo's tools/memory-tool.sh via hardcoded relative path '../../../../../../../../zetetic-team-subagents/tools/memory-tool.sh'. Both source files exist in the counterpart at /Users/cdeust/Developments/anthropic-partnership/zetetic-team-subagents/tools/ (memory-mcp-server.py 16750B, memory-tool.sh 56181B). NOT the genius-patterns counterpart the hint guessed — the MCP surface is memory, not reasoning patterns.
  - ? Why three divergent version numbers (plugin.json 0.0.5 vs package.json/marketplace.json 2.13.1 vs source pkg 0.1.0)? Which is authoritative for release?
  - ? How is dist/index.js (the plugin bundle) produced from packages/mcp-servers/reasoning/src? No esbuild config or build script was found under packages/reasoning/scripts/ — the bundle copy provenance/refresh process is unverified.
  - ? At install time, does the published plugin ship/symlink the zetetic-team-subagents memory-tool.sh, or is the default backend path expected to be unsatisfied and MEMORY_BACKEND_CMD always required? The hardcoded 8-level relative path only resolves in the author's dual-repo dev layout (which here is split across agentic-ai and anthropic-partnership), so the published artifact's boot path is unverified.
  - ? Is a .mcpb package planned for this plugin, or is it distributed only via the Claude Code marketplace (marketplace.json references zetetic-team-subagents at the repo root, not this packages/reasoning subdir)?
  - ? memory.ts and memory-extensions.ts tool input schemas were not fully read — the precise enum of subcommands surfaced to clients was inferred from backend.ts mappers (view/create/str_replace/insert/delete/rename + search/scopes/preamble/sync-status/drain-sync/commit-sync/release-sync/ttl-sweep/audit), not from the schema definitions themselves.
- evidence:
  - .claude-plugin/plugin.json:21-28 — mcpServers.reasoning {command:node, args:[${CLAUDE_PLUGIN_ROOT}/dist/index.js]}
  - .claude-plugin/plugin.json:3-4 — advertises '97 genius reasoning patterns ... Includes a stdio MCP server'; version 0.0.5
  - package.json:3 — version 2.13.1; marketplace.json:9 — version 2.13.1; mcp-servers/reasoning/package.json:3 — version 0.1.0 (three divergent versions)
  - src/index.ts:6-9 — 'Exposes two MCP tools over stdio (JSON-RPC 2.0): memory, memory_extensions'
  - src/index.ts:88-90 — ListToolsRequestSchema returns [MEMORY_TOOL_SCHEMA, MEMORY_EXTENSIONS_TOOL_SCHEMA] (exactly 2 tools)
  - src/index.ts:120-126 — main() uses StdioServerTransport + process.stderr.write for boot banner
  - src/index.ts:128-131 — main().catch -> process.stderr.write + process.exit(1); top-level unconditional call (no CLI-entry guard)
  - src/index.ts:26-27 — 'Logging: ONLY to stderr. Never to stdout (corrupts JSON-RPC framing)' with modelcontextprotocol.io source citation
  - src/backend.ts:28 — _SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)) (path derivation, not entry guard)
  - src/backend.ts:45-46 — DEFAULT_BACKEND_CMD = ${_SCRIPT_DIR}/../../../../../../../../zetetic-team-subagents/tools/memory-tool.sh (hardcoded relative dependency)
  - src/backend.ts:100-141 — runBackend execFileSync('bash',[memory-tool.sh,...]) — pure subprocess wrapper, no embedded models
  - dist/index.js:14189-14195 — bundled main(): StdioServerTransport, server.connect, process.stderr.write boot banner, main().catch->process.exit(1)
  - dist/index.js:12576-13289 — 10 console.log all inside JSDoc @example comments of bundled @modelcontextprotocol/sdk@1.29.0 (verified each line prefixed ' * ')
  - grep console.log on mcp-servers/reasoning/dist/index.js = 0; grep import.meta.url===/argv[1] = 0 matches
  - ls /Users/cdeust/Developments/anthropic-partnership/zetetic-team-subagents/tools/memory-mcp-server.py (16750B) + memory-tool.sh (56181B) — counterpart source confirmed present
  - ls of hardcoded DEFAULT_BACKEND_CMD path (sibling zetetic-team-subagents next to agentic-ai) = No such file or directory — default boot path unsatisfied in this layout
  - .github/workflows/release.yml — runs tests/run-all.sh + zetetic-checker (informational) + GitHub release; NO npm publish, NO mcpb build, NO offline/smoke/sha256 (grep mcpb|offline|smoke|sha256 = no matches)
  - .github/workflows/ci.yml:17-58 — memory test suites (e2e, concurrency, stale-lock, mcp, agent-id, PII) + agent-auditor + zetetic-checker

### prd-pipeline · consolidated-ts · cap=prd
- runtime=TypeScript/Node · surface=local-stdio · verdict=**partial** · action=Phase1-ship · conf=high
- packaging: mcpb=False published=False version=0.1.0 (plugins/prd) / 0.3.0 (.claude-plugin marketplace) consolidated; counterpart 0.4.0 gate=none
- notes: CONSOLIDATED side: no manifest.json, no server.json, no .mcpb; release.yml (consolidated) only verifies bundle freshness + plain GitHub release — no .mcpb pack, no sha256, no smoke. COUNTERPART (partnership) HAS .mcpb machinery (manifest v0.4 entry_point mcp-server/index.js; server.json registry_type=mcpb) but NOT actually shipped: `git tag` returns EMPTY so the v0.4.0 release (release.yml triggers on tags v*.*.*) NEVER fired; server.json file_sha256 is placeholder 0000...; .mcpb download URL points at a nonexistent release. Release workflow runs on ubuntu-latest ONLY (linux-x64) — NO 3-platform smoke (darwin-arm64/linux-arm64 absent), NO bootable+offline boot test (only a git-diff bundle-freshness gate). Bundle is NOT fully offline-self-contained: better-sqlite3 + ajv are esbuild --external, provisioned by first-run `npm install` via launch.sh/ensure-deps.sh (both redirect to >&2). No ML models in this server, so the model-offline-embed leg of the recipe is n/a.
- hazards: H1=absent H2=absent
  - ⚠ Bundle bloat: benchmark + calibration CLI modules got pulled into mcp-server/index.js (2.66 MB consolidated, 1.12 MB plugins/prd) via the dependency graph — dead code on the stdio path but inflates the bundle. They are correctly argv-guarded (process.argv[1]?.endsWith('runner.js'/'mismatch-fire-rate.js'/'calibrate-gates*.js')) so they never fire as index.js.
  - ⚠ console.warn x3 on the LIVE conclude_verification tool path (packages/mcp-server/src/build-conclude-opts.ts:78,143,152) — Node routes console.warn to STDERR not stdout, so JSON-RPC is NOT corrupted; flagged only as a stylistic deviation from the console.error house rule.
  - ⚠ First-run `npm install` side effect: launch.sh / ensure-deps.sh provision externalized deps (ajv, better-sqlite3) on first boot — breaks strict offline-self-contained .mcpb expectation, though install output is correctly redirected to >&2 and better-sqlite3 is optional (tryCreateEvidenceRepository degrades gracefully).
- counterpart: anthropic-partnership/prd-spec-generator — DIVERGENT COPY / extraction twin (same codebase lineage, same byte-identical esbuild bundle script, identical 17-tool surface, identical packages/mcp-server/src/index.ts). The partnership repo is the EXTRACTED STANDALONE and is AHEAD: v0.4.0 with full .mcpb machinery (manifest.json + server.json + bin/ensure-deps.sh) vs consolidated v0.1.0/0.3.0 with none. NOT independent reimplementation — it is the same source split out, partnership side leading. (The partnership bundle even retains internal path comments referencing packages/prd-pipeline/...). Relation = doublon to consolidate, partnership repo is the canonical Phase-1 ship target.
  - ? Does an actual published GitHub release / .mcpb artifact exist for prd-spec-generator anywhere (e.g. pushed from a clean checkout outside this working copy)? Local `git tag` is empty and server.json sha256 is a zero placeholder, so as of this audit it is unpublished — confirm with `gh release list -R cdeust/prd-spec-generator`.
  - ? Consolidation decision: which side is the Phase-1 ship target? The two are the same source diverged (partnership v0.4.0 ahead with .mcpb scaffolding; consolidated v0.1.0/0.3.0 with none). Need an explicit dedup ruling before shipping to avoid publishing two near-identical PRD MCP servers.
  - ? Should the benchmark/calibration CLI modules be excluded from the MCP bundle (esbuild entry hygiene / tree-shake or separate build) to drop ~1.5 MB of guarded-dead-code and eliminate the only stdout-bearing (but unreachable) console.log calls?
  - ? Is the first-run `npm install` of ajv/better-sqlite3 acceptable under the strict offline .mcpb gate, or must those be vendored/prebuilt into the .mcpb to satisfy the bootable+offline requirement on air-gapped hosts?
- evidence:
  - /Users/cdeust/Developments/agentic-ai/packages/prd-pipeline/.mcp.json:3-10 — prd-gen server: command=node, args=${CLAUDE_PLUGIN_ROOT}/mcp-server/index.js (direct node, no launcher)
  - /Users/cdeust/Developments/agentic-ai/plugins/prd/.claude-plugin/plugin.json — mcpServers.prd: command=bash launch.sh ${CLAUDE_PLUGIN_ROOT}; PRD_GEN_EVIDENCE_DB=${HOME}/.agentic-ai/prd-gen/evidence.db
  - /Users/cdeust/Developments/agentic-ai/plugins/prd/scripts/launch.sh — first-run npm install --omit=dev redirected to >&2; exec node dist/index.js (clean stdout)
  - /Users/cdeust/Developments/agentic-ai/packages/prd-pipeline/packages/mcp-server/src/index.ts:48 — __dirname=dirname(fileURLToPath(import.meta.url)) used ONLY for config-path resolution, NOT for CLI-entry detection (no bomb)
  - index.ts:379-399 — main() invoked UNCONDITIONALLY (dedicated MCP entry); only console.error on health-fail (387) and start-fail (397); no console.log/info
  - GREP H1 source: only correct idiom — benchmark/src/runner.ts:268 `if (process.argv[1]?.endsWith("runner.js"))`
  - GREP H2 source live path: build-conclude-opts.ts:78,143,152 console.warn (→stderr); benchmark/src/runner.ts console.log is CLI-only
  - GREP bundle mcp-server/index.js: 21 console.log but ALL guarded — 35377 `if (process.argv[1]?.endsWith("runner.js"))`, 35764 mismatch-fire-rate guard, 22663/36142 calibrate-gates `invokedDirectly` guard; remainder are JSDoc-comment examples (32760-33473)
  - GREP bundle: zero `import_meta...===` / `argv[1] ===` bomb pattern (correct endsWith idiom only)
  - Bundle tails (both): main().catch(...process.exit(1)); SIGTERM/SIGINT closeReliabilityRepo — clean
  - /Users/cdeust/Developments/anthropic-partnership/prd-spec-generator/server.json:8-15 — registry_type mcpb, version 0.4.0, file_sha256=0000...0000 (PLACEHOLDER), download URL to v0.4.0 release
  - git -C anthropic-partnership/prd-spec-generator tag → EMPTY (no tags; release.yml on push tags v*.*.* never fired → v0.4.0 unpublished)
  - anthropic-partnership/prd-spec-generator/.github/workflows/release.yml — runs-on: ubuntu-latest ONLY; Assemble+Pack .mcpb + shasum -a 256 on single platform; NO darwin-arm64/linux-arm64 matrix, NO bootable boot-smoke step
  - anthropic-partnership/prd-spec-generator/bin/ensure-deps.sh — installs ajv+better-sqlite3 (esbuild --external) on first run, all output >&2, then exec node; better-sqlite3 optional/graceful
  - package.json bundle script (both repos identical): esbuild packages/mcp-server/dist/index.js --bundle --platform=node --format=esm --external:better-sqlite3

### orchestrator · consolidated-ts · cap=orchestration
- runtime=TypeScript/Node · surface=api-sdk · verdict=**partial** · action=Phase2-port · conf=high
- packaging: mcpb=False published=False version=0.1.0 gate=n/a
- notes: Not an MCP server -> .mcpb/bootable+offline gate is n/a. package.json:4 private:true => not npm-published. Included in .github/workflows/release.yml:47 which pnpm-packs it into a flat tarball, but no publish/registry step. No bin field, no server.json/plugin.json/.mcpb anywhere.
- hazards: H1=absent H2=absent
  - ⚠ H1 caveat: CLI guard uses `process.argv[1] === new URL(import.meta.url).pathname` (src/index.ts:127, dist/index.js:89) — NOT the recommended basename endsWith('X.js') idiom. The H1 esbuild-rewrite failure mode does NOT apply because dist/index.js is plain tsc output (94 lines, bare `import Anthropic from "@anthropic-ai/sdk"` preserved, structure mirrors src) — NOT esbuild-bundled. Guard is sub-optimal vs the proven recipe (URL().pathname can mismatch argv[1] under symlink/relative invocation) but the CLI branch spawns only the skeleton, no detached background worker, no stdout-polluting code path.
  - ⚠ H2: all 5 diagnostic writes correctly go to process.stderr.write (src:101,104,109,117,120 / dist:75,76,78,85,86); zero console.log/info/warn in src or dist. Also not a stdio JSON-RPC server, so stdout cleanliness is not load-bearing here regardless.
  - ⚠ Hardcoded model string 'claude-opus-4-5' in CLI default (src:130) is stale/placeholder vs current model lineup, but it is a skeleton default, not load-bearing.
- counterpart: No source-side counterpart. Net-new consolidation-side skeleton unique to the agentic-ai monorepo. Closest conceptual analog is the live Cortex/Claude-Code host that attaches MCP servers, but that is a runtime, not a ported repo. Relation: none (net-new).
  - ? Is the Agent SDK (@anthropic-ai/claude-agent-sdk) the intended target for the deferred Phase-6 wiring, or will it stay on the raw messages API + mcp_servers beta? Partner reco for 'agents' surface is Agent SDK — current skeleton uses raw API SDK.
  - ? Will the orchestrator skeleton ever be implemented (Phase 6), or is it dead scaffolding? It compiles + exports types but has no real caller driving a conversation — risk of unwired code per coding-standards §9.
  - ? Hardcoded default model 'claude-opus-4-5' (src:130) — intended placeholder, or should it track the current model lineup before any real ship?
  - ? Release tarball is produced (release.yml:47) but private:true blocks npm publish — is the tarball consumed internally (workspace cutover) or is its inclusion in release.yml vestigial?
- evidence:
  - package.json:2-5 — name @agentic/orchestrator, version 0.1.0, private:true, desc 'Top-level orchestrator: spawns Claude with all four MCP servers attached via @anthropic-ai/sdk'
  - package.json:19-22 — deps @anthropic-ai/sdk ^0.91.1 + @agentic/mcp-server-memory workspace:*; NO @modelcontextprotocol/sdk, NO @anthropic-ai/claude-agent-sdk
  - src/index.ts:26 / dist/index.js:25 — `import Anthropic from "@anthropic-ai/sdk"` (raw API SDK, not Agent SDK)
  - src/index.ts:116 / dist/index.js:84 — `const _client = new Anthropic()`; comments src:82-83/dist reference Beta.messages.stream + mcp_servers config (deferred)
  - src/index.ts:1-23 — docstring: 'Skeleton', 'Real conversation logic is post-Phase-5', memory=live(46 tools), codebase/reasoning/prd=pending
  - src/index.ts:121 / dist:86 — 'skeleton only — real conversation wiring is Phase 6'
  - grep (src+dist): zero console.log/info/warn; 5 process.stderr.write at src:101,104,109,117,120 (H2 absent)
  - src/index.ts:127 / dist/index.js:89 — CLI guard `process.argv[1] === new URL(import.meta.url).pathname` (H1 idiom sub-optimal but esbuild-rewrite trap N/A: tsc output)
  - grep: no StdioServerTransport/McpServer/setRequestHandler/@modelcontextprotocol => NOT an MCP server
  - grep: no bin field, no mcpb/.mcpb, no server.json/plugin.json in package
  - wc -l dist/index.js = 94 (plain tsc, not bundled) — H1 esbuild precondition absent
  - .github/workflows/release.yml:44-53 — orchestrator is pnpm-pack'd into a flat tarball alongside core/memory/mcp-servers
  - tsconfig.json:1-9 — extends ../../tsconfig.base.json, rootDir src / outDir dist (standard tsc build, no bundler)

### memory-dashboard · consolidated-ts · cap=viz
- runtime=TypeScript/Node · surface=dashboard-ui · verdict=**partial** · action=Phase3-harden · conf=high
- packaging: mcpb=False published=False version=0.1.2 gate=n/a
- notes: private:true, not published to npm (package.json:3-4). No own .mcpb/manifest/server.json — it is a dashboard-ui, not an MCP server, so the .mcpb gate is n/a. It is consumed by the memory MCP server (packages/mcp-servers/memory) whose pack-mcpb.mjs esbuild-inlines all pure-JS workspace deps incl. @agentic/memory-dashboard/launcher. PACKAGING GAP: pack-mcpb.mjs copies NO dashboard server.js/static into the bundle (only esbuild src/index.ts + native node_modules). launcher.spawnServer resolves path.resolve(__dirname,'server.js') — under esbuild __dirname=bundle root, so open_visualization in the shipped .mcpb would spawn a non-existent server.js. Build is plain tsc (build script line 23), NOT esbuild, within this package — so import.meta.url is preserved correctly here. DASHBOARD_VERIFICATION.md documents a Popper-falsification UI gate (2026-05-06) for the served views, separate from any .mcpb gate.
- hazards: H1=absent H2=absent
  - ⚠ Server-side Node code (src/*.ts, dist/*.js excluding static/) has ZERO console.log/info/warn — grep confirmed clean; only console.error not even present server-side.
  - ⚠ server.ts:179-182 CLI-entry guard uses the CORRECT basename-compare idiom fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*///,'')) — not raw === equality. AND server.ts is NOT imported by the MCP server; launcher spawns it as a fresh `node dist/server.js` process (launcher.ts:112-119), so no detached worker fires at MCP boot.
  - ⚠ launcher.ts (the part esbuild-inlines into the memory .mcpb) has NO CLI-entry guard at all — import.meta.url used only for __dirname (launcher.ts:29). H1 idiom-bomb cannot trigger from the inlined code.
  - ⚠ The ONLY stdout write is intentional: server.ts:186 process.stdout.write(JSON.stringify({url,pid})+'\n') — a launcher handshake read by spawnServer via piped child stdout (stdio:['ignore','pipe','ignore'], launcher.ts:117). It is on the dashboard's OWN stdout, isolated from the MCP server's JSON-RPC pipe. Correct.
  - ⚠ All console.log/warn hits (graph.js, polling.js, wiki.js, timeline.js, etc.) are in src/static/js/*.js = BROWSER client assets served to the UI — they run in the browser, never on any JSON-RPC/stdio pipe. Not a hazard.
  - ⚠ db-guard.assertNotForbiddenDatabase() runs at boot and may process.exit(78) (db-guard.ts:66) but writes nothing to stdout — boot is stdout-clean.
  - ⚠ Security positive: binds 127.0.0.1 loopback only (server.ts:79, never 0.0.0.0); CORS strict-reflect loopback-only (server.ts:110-122); browser-open regex restricts to http://127.0.0.1 (launcher.ts:170); idle-timeout watchdog auto-closes after 10min.
- counterpart: cortex-viz + neural-graph-visualizer (both at /Users/cdeust/Developments/anthropic-partnership/). Relation: independent reimplementation/divergent. memory-dashboard is a TS port of the Python cortex HTTP standalone server (cortex@ed33435 mcp_server/server/), serving its own Fastify routes + bundled static Three.js UI. cortex-viz is a separate cortex-plugin MCP (open_visualization/get_methodology_graph) reading the shared Cortex PostgreSQL read-only; neural-graph-visualizer is a skill bundle. No code-sharing/dependency between them — parallel viz surfaces over the same memory domain, not a copy or doublon.
  - ? Does the memory .mcpb actually ship the dashboard? pack-mcpb.mjs copies no dist/server.js nor src/static/ into the bundle. Under esbuild, the inlined launcher's __dirname=bundle root, so launchDashboard would spawn a non-existent server.js and open_visualization would fail inside the shipped .mcpb. Needs end-to-end verification: install the agentic-memory-*.mcpb and call open_visualization. If confirmed, this is a Phase3-harden packaging fix (add a cpSync of the dashboard dist + static into BUNDLE, or invoke the launcher differently).
  - ? Is the dashboard meant to ship at all in the .mcpb, or only run from a dev checkout? If dev-only, document that open_visualization is non-functional in the packaged directory build.
  - ? Are the src/static/js/*.js browser console.warn/log calls acceptable for the dashboard-ui (they are — browser console), or does any directory-policy lint flag them? Confirm no false-positive in the .mcpb stdout-pollution gate that greps all bundled JS indiscriminately.
- evidence:
  - package.json:3-4 version 0.1.2 private:true (not published)
  - package.json:7,19-21 main=./dist/server.js, bin memory-dashboard→./dist/server.js
  - package.json:5 description 'HTTP dashboard server for the 3D constellation map — TS port of cortex@ed33435 mcp_server/server/'
  - package.json:23 build script = 'tsc --project tsconfig.json' (plain tsc, NO esbuild in this package → import.meta.url preserved)
  - server.ts:106 Fastify({logger:false}); server.ts:138-144 registers 7 route groups; server.ts:160 fastify.listen — confirms HTTP server, not MCP
  - server.ts:79 host=127.0.0.1 loopback-only; server.ts:110-122 CORS loopback-only
  - server.ts:179-182 CLI-entry guard = endsWith(basename(argv[1])) CORRECT idiom (NOT raw ===)
  - server.ts:186 process.stdout.write({url,pid}) — intentional launcher handshake, only stdout write
  - launcher.ts:29 import.meta.url used ONLY for __dirname (no CLI guard); launcher.ts:112-119 spawn(process.execPath,[server.js],{detached,stdio:['ignore','pipe','ignore']}) — child stdout isolated, server.js spawned as separate process not imported
  - grep server-side console.log/info/warn → 'NONE — clean server-side'; all 20+ console hits are in src/static/js/*.js browser assets
  - packages/mcp-servers/memory/src/tools/ingest.ts:29,328 imports launchDashboard from @agentic/memory-dashboard/launcher and calls it in open_visualization tool
  - packages/mcp-servers/memory/package.json:27 depends @agentic/memory-dashboard workspace:*
  - release-memory-mcpb.yml:108 builds @agentic/memory-dashboard before packing; pack-mcpb.mjs:116-141 esbuild --bundle inlines pure-JS workspace deps (incl launcher), natives external
  - pack-mcpb.mjs cpSync calls (lines 251,254,264,288) copy ONLY models + icon.png; NO dashboard server.js/static copied → dashboard not shipped in .mcpb (packaging gap)
  - DASHBOARD_VERIFICATION.md:1-7 Popper-falsification UI gate dated 2026-05-06 for served views
  - __tests__/ contains routes.test.ts, dashboard-xss.test.ts, file-diff-security.test.ts, plugin-mcp-config.test.ts, smoke/heat tests

### cortex (hypermnesia-mcp, Python memory source) · source · cap=memory
- runtime=Python · surface=local-stdio · verdict=**gap** · action=user-action · conf=high
- packaging: mcpb=True published=True version=3.24.0 gate=partial
- notes: dist/hypermnesia-mcp-3.24.0.mcpb present (27MB), Python/uv bundle: manifest.json server.type=uv, command=uv, runtimes.python>=3.10, manifest_version 0.4; bundle carries CPython native .so (cpython-313/314-darwin) + vendored deps/. server.json (registry schema 2025-07-09, registry_type pypi, transport stdio). PyPI published as hypermnesia-mcp via PEP 740 OIDC Trusted Publisher (up to >=3.14.7), marked DEPRECATED/best-effort in release.yml:7-18 (marketplace is the supported path per ADR-0050). NO mcpb build step in any .github/workflows (ci.yml, release.yml) — bundle built manually via .mcpbignore. Offline model gate only PARTIAL: sentence-transformers + flashrank promoted to base deps (pyproject.toml:36-38) so recall ships full-quality, but uv resolves deps at install time (not vendored as runnable offline models in the bundle) and HF model is downloaded (release.yml:78-79 pre-download is continue-on-error); no 3-platform smoke-gate+sha256 evidence found. Backend defaults to SQLite local-first (manifest user_config.store_backend=sqlite) so it boots with zero external services.
- hazards: H1=n/a H2=absent
  - ⚠ H1 isCliEntry-bomb is Node-specific (fileURLToPath/import.meta.url/esbuild) → n/a for Python.
  - ⚠ H2 Python stdout-pollution equivalent AUDITED via AST over 335 files in the stdio MCP path (server/handlers/core/infrastructure/validation/errors/__main__): exactly 1 non-stderr print found = mcp_server/handlers/wiki_migrate.py:239, and it sits inside an 'if __name__ == "__main__":' CLI guard (line 234), NOT the tool handler path (handler() returns a dict at line 231). JSON-RPC stdio channel is therefore CLEAN.
  - ⚠ All other prints in the MCP path explicitly use file=sys.stderr (verified e.g. mcp_client.py:419/437/443, scanner.py:181, mcp_client_pool.py:134).
  - ⚠ 58 raw print() exist repo-wide but the rest are in CLI diagnostics (doctor.py/doctor_mcp.py) and Claude Code plugin hooks (session_start/session_lifecycle/ingest_codebase_background) — separate processes, not the stdio MCP server.
  - ⚠ __main__.py installs SIGTERM/SIGINT handlers and closes the client pool on shutdown (no detached background worker spawned at boot, unlike the Node isCliEntry-bomb root cause).
- counterpart: consolidated-ts memory MCP server (the Node/TypeScript memory connector shipped at v0.3.1). Relation: superseded-by / independent reimplementation — this Python repo is the upstream feature source; the TS server is the law-conformant re-port (local .mcpb must be Node/TS) that replaces this one for Directory submission. The TS counterpart is NOT a sibling in this partnership tree; it lives in the consolidated-ts repo set. Note: sibling dir 'Cortex' (capital C) is the SAME inode 81191915 as 'cortex' — macOS case-insensitive FS, one repo, not a second copy.
  - ? Where exactly does the consolidated-ts memory (Node/TS) counterpart live, and is its .mcpb the v0.3.1-conformant artifact intended to replace this Python one in the Directory? (Not present as a sibling in this partnership tree.)
  - ? Is the Python hypermnesia-mcp ALREADY submitted/listed in the Anthropic MCP Directory under io.github.cdeust/hypermnesia-mcp? If so, the user action is to withdraw/supersede that Directory entry in favor of the TS server (gap is a policy/surface mismatch, not a code defect).
  - ? Offline-model gate: does the local .mcpb actually run fully offline, or does first boot pull all-MiniLM-L6-v2 + flashrank ONNX from HuggingFace at install? No vendored-model or 3-platform smoke-gate+sha256 evidence found in this repo.
  - ? Does the manifest's win32 platform claim (manifest.json:8-12) hold given the bundle ships only darwin .so natives in dist/ — are linux/win wheels resolved at install via uv rather than bundled?
- evidence:
  - manifest.json:44-66 — server.type=uv, mcp_config.command=uv, args run -m mcp_server (Python runtime, NOT Node)
  - manifest.json:13-15 — compatibility.runtimes.python>=3.10; manifest_version 0.4 (manifest.json:39)
  - pyproject.toml:6-7 — name=hypermnesia-mcp version 3.24.0, build-backend hatchling (Python package)
  - server.json:9-18 — version 3.24.0, packages[0].registry_type=pypi, identifier hypermnesia-mcp, transport.type=stdio
  - dist/hypermnesia-mcp-3.24.0.mcpb — 27MB bundle; unzip -l shows deps/_cffi_backend.cpython-313-darwin.so + cpython-314 natives (Python, not Node); bundle manifest server.type=uv command=uv
  - mcp_server/__main__.py:82 — mcp.run(transport="stdio"); lines 74-81 SIGTERM/SIGINT shutdown + close_all() (clean lifecycle, no boot-time detached worker)
  - mcp_server/handlers/wiki_migrate.py:234-239 — the single non-stderr print is under 'if __name__=="__main__":' CLI guard, not the handler() tool path (return at line 231)
  - AST scan (335 files, stdio MCP path): print()->stdout count = 1 (the guarded CLI one); all infra/client prints use file=sys.stderr (mcp_client.py:419-446, scanner.py:181-184, mcp_client_pool.py:134-138)
  - .github/workflows/release.yml:3-18,113-171 — marketplace is SUPPORTED path (ADR-0050), PyPI DEPRECATED best-effort via OIDC Trusted Publishing (continue-on-error, skip-existing); no .mcpb build job in any workflow
  - .mcpbignore:1-24 — bundle built manually via uv runtime (deps resolved at install from pyproject.toml+uv.lock), excludes .venv/benchmarks/CI
  - pyproject.toml:36-38 — sentence-transformers + flashrank promoted from extras to base so every distribution ships full-quality recall (offline-model intent)
  - README.md:50,90-95,319 — .mcpb is the single-click Directory connector (43 tools, no hooks); PyPI hypermnesia-mcp deprecated; SQLite default zero-setup
  - ls -di cortex Cortex → both inode 81191915: case-insensitive macOS FS, ONE repo (no duplicate)

### automatised-pipeline (source) · source · cap=codebase
- runtime=Rust · surface=local-stdio · verdict=**partial** · action=Phase3-harden · conf=high
- packaging: mcpb=True published=True version=0.5.0 gate=partial
- notes: v0.5.0 GitHub release IS published with the three platform tarballs + .sha256 companions (macos-aarch64, linux-x86_64, linux-aarch64), verified via gh release view. BUT two real gaps: (1) The .mcpb bundle itself is MISSING from the v0.5.0 release assets — only the .tar.gz platform binaries are present; the package_mcpb workflow job either did not run or failed for this tag, so the bundle server.json advertises does not exist at its download URL. (2) server.json:13 file_sha256 is a 64-zero PLACEHOLDER, not the workflow-computed shasum — the MCP-registry manifest points at releases/download/v0.5.0/automatised-pipeline.mcpb with a fake hash and a non-existent artifact. The release.yml workflow (.github/workflows/release.yml:108-117, 175-186) DOES compute real sha256 for each tarball and for the .mcpb, and builds across the 3 required platforms via a build matrix — but it never BOOTS the binary to verify a clean stdio JSON-RPC handshake, so the 'bootable' half of the v0.3.1 gate is unproven in CI (ci.yml only runs cargo test / graph_accuracy gate). 'Offline models embedded' is n/a: this is deterministic graph/BM25 intelligence with no LLM or embedded ML model (grep for onnx/gguf/model/embedding in src returned nothing).
- hazards: H1=n/a H2=absent
  - ⚠ H1 (fileURLToPath/import.meta.url esbuild CLI-entry bomb) is Node-specific → n/a for this pure-Rust binary. Rust equivalent (a detached background worker spawned at server boot that pollutes stdout) is ABSENT: grep for thread::spawn/tokio::spawn returned nothing; the only Command::new uses (git_diff.rs:344, lsp_client.rs:118/220, history/mod.rs:159/199/409) run on-demand inside tool handlers, never detached at boot. main() at src/main.rs:4352 is a plain synchronous stdin read loop.
  - ⚠ H2 (stdout pollution on stdio JSON-RPC) ABSENT after real grep: the ONLY stdout write is write_message() at src/main.rs:126-133 (io::stdout().lock() + writeln! one JSON line + flush) — the legitimate JSON-RPC framing. Every diagnostic/log uses eprintln! (stderr, the Rust-correct equivalent of console.error): boot banner main.rs:4353, stdin/parse errors 4361/4371, plus resolver.rs:34/234, lsp_resolver.rs:343, clustering/process.rs:245, indexer/mod.rs:181/196/198, indexer/walk.rs:74, indexer/persist.rs:151. The single `println!` grep hit at src/git_diff.rs:506 is INSIDE A TEST FIXTURE STRING (a sample unified-diff literal in #[test] test_parse_unified_diff_new_file, escaped quotes \"hello\"), not a runtime stdout write. No dist/ bundle exists to grep (no Node/esbuild).
  - ⚠ Misleading task indices: 'TS 296 + Rust 84 + Py 50' does NOT describe runtime composition. Runtime is 100% Rust (84 .rs files, no package.json/tsconfig/dist anywhere). The 50 .py and 4 .ts files are ALL test fixtures (tests/fixtures/graph_accuracy/ — sample codebases the indexer parses) and dev tooling (tools/zera_*.py benchmark/viz scripts). Python appears at runtime only as the .mcp.json bootstrap launcher one-liner (python3 -c '... os.execvp(binary)') which locates and exec's the Rust binary; it is a build/install convenience, not server logic. So 'Mixed-runtime' is a false signal — this is single-runtime Rust.
- counterpart: agentic-ai/packages/codebase-rust (consolidated-ts side) — PORT/COPY relationship: same crate name `ai-architect-mcp`, same `src/main.rs` lineage but lagging (v0.0.4, main.rs 3489 lines vs this repo's v0.5.0, 4374 lines); its Cargo.toml comment explicitly declares it a monorepo port that dropped the benches/harness member and names this repo as the upstream source. A second sibling, agentic-ai/packages/codebase (`@agentic/codebase` v0.1.0, TS), is an INDEPENDENT TS reimplementation of the same capability in the consolidated monorepo. This repo is the more canonical/advanced of the two Rust copies.
  - ? Why is automatised-pipeline.mcpb missing from the v0.5.0 GitHub release? Did the package_mcpb job fail/skip, or was the .mcpb published to a different channel (glama.json present suggests a Glama registry path)? Until resolved, server.json's download URL 404s.
  - ? server.json file_sha256 is a 64-zero placeholder — is there a post-release step (manual or scripted) intended to inject the real .mcpb shasum into server.json before registry submission? If not, the registry entry is unverifiable. Phase3 fix: wire the workflow-computed .mcpb.sha256 back into server.json.
  - ? Is the v0.3.1 bootable gate satisfied anywhere? No CI job boots the binary and sends an initialize/health_check JSON-RPC handshake across the 3 platforms — boot-cleanliness is currently asserted only by code inspection (eprintln! discipline), not proven end-to-end in CI.
  - ? Reconciliation/dedup intent between this canonical source and agentic-ai/packages/codebase-rust (lagging port at v0.0.4) and agentic-ai/packages/codebase (TS @agentic/codebase): three implementations of one capability. Which is the intended ship artifact for the partnership, and should the Rust port be re-synced from v0.5.0 or retired in favor of the TS package?
  - ? The Cargo.toml port comment in codebase-rust names a THIRD upstream path (/Users/cdeust/Developments/anthropic/ai-automatised-pipeline) distinct from this repo's path — is that a stale reference or a separate upstream mirror that also needs auditing?
- evidence:
  - server.json:3-16 — registry manifest, name io.github.cdeust/automatised-pipeline, v0.5.0, registry_type mcpb, transport stdio; identifier points to releases/download/v0.5.0/automatised-pipeline.mcpb
  - server.json:13 — file_sha256 is 64 zeros (placeholder, not the real workflow shasum) — registry references a fake hash
  - manifest.json:1-31 — manifest_version 0.4, server.type=binary, entry_point launch.sh, platforms [darwin, linux], 24 tools enumerated (tools_generated:true)
  - Cargo.toml:11-18 — crate ai-architect-mcp v0.5.0, [[bin]] name automatised-pipeline → src/main.rs; deps tree-sitter (10 grammars), lbug (LadybugDB), tantivy (BM25) — no LLM/embedding dep
  - src/main.rs:1-18 — header: 'Transport: stdio JSON-RPC 2.0, hand-rolled (no MCP SDK)'; references upstream ai-architect
  - src/main.rs:126-133 — write_message(): the ONLY stdout write, JSON-RPC framing via io::stdout().lock()+writeln!+flush
  - src/main.rs:4352-4374 — main(): eprintln! boot banner (stderr), synchronous stdin read loop, errors to eprintln!; no thread/process spawn
  - grep println!/print! over src/ → only hit is src/git_diff.rs:506 inside a #[test] unified-diff fixture string (not runtime); all 13 other logging sites use eprintln! (stderr)
  - grep thread::spawn/tokio::spawn over src/ → zero hits (no detached boot worker; H1 Rust-equivalent absent)
  - launch.sh:29-57 — .mcpb launcher: dispatches to bin/{macos-aarch64,linux-x86_64,linux-aarch64}/automatised-pipeline, errors to >&2, exec replaces process
  - .mcp.json:3-9 — install bootstrap is a python3 -c one-liner that finds target/release/automatised-pipeline (runs bin/ensure-binary.sh if missing) and os.execvp's it — Python is launcher glue, not server runtime
  - .github/workflows/release.yml:46-129 — build matrix over the 3 required platforms, cargo build --release, strip, tar + shasum -a 256 companion, upload
  - .github/workflows/release.yml:131-195 — package_mcpb job downloads the 3 tarballs, assembles bundle (manifest/launch.sh/binaries), packs via @anthropic-ai/mcpb or zip fallback, computes .mcpb.sha256
  - .github/workflows/ci.yml:25-93 — CI runs cargo test + graph_accuracy ratchet gate only; NO binary boot / JSON-RPC handshake smoke test
  - gh release view v0.5.0 → assets are ONLY the 6 tarball+sha256 files; automatised-pipeline.mcpb is ABSENT from the published release (package_mcpb did not deliver for this tag)
  - find tests/fixtures + tools → all 50 .py and 4 .ts are fixtures/dev-tooling, not runtime; no package.json/tsconfig/dist in repo
  - agentic-ai/packages/codebase-rust/Cargo.toml — declares itself a monorepo PORT of this upstream (crate ai-architect-mcp v0.0.4, drops benches/harness, names upstream); main.rs 3489 lines vs this repo's 4374 → this repo is the newer canonical copy
  - agentic-ai/packages/codebase/package.json — @agentic/codebase v0.1.0, separate TS reimplementation of the same capability (independent, not a copy)

### prd-spec-generator · source · cap=prd
- runtime=TypeScript/Node · surface=local-stdio · verdict=**partial** · action=Phase3-harden · conf=high
- packaging: mcpb=False published=False version=0.4.0 gate=partial
- notes: .mcpb ABSENT: no git tags, no published GitHub releases, no local *.mcpb. server.json:13 file_sha256 is the all-zeros placeholder. .github/workflows/release.yml is well-formed (stage→pack via @anthropic-ai/mcpb→sha256→gh-release) but has NEVER fired and runs on ubuntu-latest ONLY — fails the required 3-platform smoke gate (darwin-arm64/linux-x64/linux-arm64); no per-platform sha256 matrix. No offline-model gate, but n/a here (pure-logic server, no embedded models). Version incoherence: mcp-server/package.json:3 = 0.2.0 while package.json/manifest.json/server.json/plugin.json/glama.json all = 0.4.0.
- hazards: H1=absent H2=present
  - ⚠ Version mismatch: mcp-server/package.json:3 declares 0.2.0; all other manifests declare 0.4.0 — stale bundle package.json.
- counterpart: automatised-pipeline (Rust) — COMPLEMENTARY DEPENDENCY, not a duplicate. automatised-pipeline/src/prd_input.rs only PREPARES/VALIDATES PRD input against a code graph (prepare_prd_input, validate_prd_against_graph); it does NOT generate PRDs. prd-spec-generator is the generator and consumes automatised-pipeline upstream via packages/ecosystem-adapters/src/clients/automatised-pipeline-client.ts (codebase-graph intelligence). The 'prd-pipeline' alternative raised in the indices is therefore NOT the canonical prd ship-source — this repo is.
  - ? Are the three build-conclude-opts.ts console.warn calls reachable on a normal (non-error) conclude_verification run, or only on degraded reliability/oracle-unavailable paths? Either way they pollute stdout when fired, but frequency affects severity. Fix = switch to console.error.
  - ? Does the release.yml smoke step actually boot the bundle and assert clean JSON-RPC stdout? Current workflow packs but shows no stdio boot-smoke assertion — would not catch the H2 pollution before publish.
  - ? Is the mcp-server/package.json 0.2.0 intentional (bundle-format version, decoupled from product version) or a forgotten bump? README/manifest are all 0.4.0.
  - ? No 3-platform (darwin-arm64/linux-x64/linux-arm64) matrix or per-platform sha256 in release.yml — required by .mcpb v0.3.1 recipe; needs to be added before first publish.
- evidence:
  - server.json:1-17 — registry_type mcpb, transport stdio, version 0.4.0; file_sha256 line 13 = all-zeros placeholder (artifact never built/hashed)
  - manifest.json:27-38 — server.type=node, entry mcp-server/index.js, manifest_version 0.4, 17 tools listed (39-108)
  - package.json:8 — bundle script: esbuild packages/mcp-server/dist/index.js --bundle --platform=node --format=esm → mcp-server/index.js
  - bin/ensure-deps.sh:42-47 — npm install output correctly redirected to stderr (>&2), then exec node; no stdout pollution from launcher
  - packages/mcp-server/src/index.ts:48 — const __dirname = dirname(fileURLToPath(import.meta.url)) used ONLY for path resolution, NOT as a CLI-entry guard
  - packages/mcp-server/src/index.ts:388-408 — main() runs UNCONDITIONALLY (no import.meta.url===process.argv[1] guard); only console.error used; process.exit only in main().catch — H1 ABSENT, correct for single-purpose MCP server
  - packages/mcp-server/src/build-conclude-opts.ts:78,143,152 — three project-owned console.warn on the live conclude_verification path (reliability/oracle warnings) — H2 stdout pollution in source
  - mcp-server/index.js:78176,78200,78203 — those same three console.warn SURVIVE into the committed JSON-RPC bundle (confirmed by grep of exact strings) — H2 present in shipped artifact
  - mcp-server/index.js — additional vendored console.warn/log from zod-to-json-schema (~16584-20450), mathjs (69069), and MCP SDK tool-name validator (22204-22210); secondary stdout-pollution sources
  - mcp-server/index.js:78862/78866/78870 — process.exit calls are only main().catch + SIGTERM/SIGINT handlers (no detached-worker bomb)
  - .github/workflows/release.yml:14 runs-on ubuntu-latest only; :84-99 packs .mcpb + computes sha256 — single-platform, fails the 3-platform smoke-gate requirement
  - gh release list / git tag -l — EMPTY; no *.mcpb anywhere on disk → unpublished
  - mcp-server/package.json:3 version 0.2.0 vs manifest.json:5/server.json:6/package.json:3 = 0.4.0 — version incoherence
  - README.md:26,33,115 — explicitly states it consumes automatised-pipeline (codebase graph) upstream; packages/ecosystem-adapters/src/clients/automatised-pipeline-client.ts wires the dependency

### neural-graph-visualizer · source · cap=viz
- runtime=TypeScript/Node · surface=local-stdio · verdict=**partial** · action=Phase3-harden · conf=high
- packaging: mcpb=False published=True version=1.1.0 gate=n/a
- notes: Distributed as a Claude Code marketplace plugin (.claude-plugin/marketplace.json + plugin.json), NOT as an .mcpb bundle. No manifest.json/server.json/.mcpb anywhere. scripts/build-cowork-zip.sh produces a plain .zip (source files: .claude-plugin/, .mcp.json, mcp-server/, ui/, config/, skills/, commands/, package.json) — no bundling, no esbuild, no dist/ checked in. package.json version 1.1.0; index.js SERVER_INFO and stderr banner still report v1.0.0 (version drift). Zero npm dependencies (engines node>=18). No CI/.github/workflows, no smoke-gate, no sha256, no multi-platform gate. 'Offline' is trivially satisfied: all data is local files and the only network is a localhost HTTP UI server; no embedded ML models. bootableOfflineGate=n/a because the .mcpb v0.3.1 recipe does not apply to a non-.mcpb plugin distribution.
- hazards: H1=absent H2=absent
  - ⚠ No entry-point guard exists at all in mcp-server/index.js (no require.main / import.meta.url check) — the module runs the stdio JSON-RPC loop unconditionally on load. This is correct here precisely because the file is ONLY ever invoked directly as the MCP server command (node ${CLAUDE_PLUGIN_ROOT}/mcp-server/index.js per .mcp.json) and is never require()'d as a library, and there is no bundler to rewrite import.meta.url. H1 root cause (esbuild + detached background worker) is structurally impossible: no esbuild, no worker_threads, no child_process.fork, no setInterval at boot.
  - ⚠ The only child_process.exec is inside the open_visualization tool handler (visualization-tools.js:16, opens a browser) — runs on tool call, not at boot.
  - ⚠ config-loader.js calls process.exit(1) on config-load failure (mcp-server/config-loader.js loadConfigFile) — a hard exit on bad config, but it writes the reason to stderr first and only fires on genuine load failure, not spuriously at boot.
  - ⚠ Standalone CLI launchers scripts/launch.js and scripts/create-research.js use console.log freely — but these are SEPARATE entry points (npm run launch/create), never imported by the stdio server, so they cannot pollute the JSON-RPC channel.
- counterpart: cortex-viz (/Users/cdeust/Developments/anthropic-partnership/cortex-viz) — shared design lineage / independent reimplementation. cortex-viz is a Python (python3 launcher) read-only MCP bridge over Cortex's PostgreSQL store that ships its OWN Three.js "Cortex Neural Graph" UI (ui/unified/js/). It adopted the neural-graph force-layout visualization concept but is a separate runtime (Python vs Node), separate data source (Postgres vs file-driven JSON/CSV), and a separate UI codebase. NOT a dependency, copy, or doublon — neural-graph-visualizer is the generic file-driven ancestor; cortex-viz is the Cortex-bound descendant. No code import in either direction.
  - ? Is the GitHub repo cdeust/neural-graph-visualizer actually published/installable via the marketplace, and at which version (manifest says 1.1.0 but server reports 1.0.0)? The version drift should be reconciled before any directory submission.
  - ? Is .mcpb packaging intended for this component at all, or is the Claude Code marketplace .zip the only intended distribution channel? If .mcpb is desired (for the broader Anthropic MCP Directory), the v0.3.1 gate (3-platform smoke + sha256) would need to be added — currently none exists.
  - ? Should the cortex-viz (Python, Cortex-bound) and neural-graph-visualizer (Node, file-driven) viz lineage be consolidated, or intentionally kept as two distinct products (generic standalone vs Cortex-integrated)? They share the neural-graph concept but no code; confirm this divergence is deliberate.
  - ? The stdio server hardcodes protocolVersion '2024-11-05' (index.js:39) and ignores the client's requested protocolVersion — acceptable for now but worth confirming against the current MCP spec version expected by the directory.
- evidence:
  - .mcp.json:3-9 — stdio MCP: command 'node', args ['${CLAUDE_PLUGIN_ROOT}/mcp-server/index.js'], env NGV_CONFIG. Correct Node/local-stdio surface.
  - mcp-server/index.js:89-106 — stdio transport: reads stdin line-buffered, JSON.parse per line, writes responses via process.stdout.write (line 100, the ONLY stdout write = JSON-RPC response). All diagnostics go to process.stderr.write (lines 101,103,111).
  - mcp-server/index.js:111 — boot banner uses process.stderr.write (correct, not stdout). index.js:108-109 — SIGTERM/SIGINT close UI server then process.exit(0); these are signal handlers, not boot-time exits.
  - grep -rE 'console.(log|info|warn)|process.stdout.write' over mcp-server/: only hit is index.js:100 (the JSON-RPC response). All other console.log are in scripts/launch.js and scripts/create-research.js (standalone CLIs, not loaded by the server). => H2 absent on stdio path.
  - grep -rE 'import.meta|require.main|fileURLToPath' over mcp-server/: ZERO hits. No esbuild/bundling, no dist/ or build/ dir. process.argv only in scripts/*.js (CLI launchers). => H1 (esbuild import.meta.url detached-worker bomb) structurally impossible.
  - grep -rE 'worker_threads|child_process|fork|spawn|setInterval|setImmediate' over mcp-server/: only child_process.exec in visualization-tools.js:1,16 (browser-open inside a tool handler, not at boot). No background/consolidation/grooming/ingest worker.
  - mcp-server/server/http-server.js:132 — UI HTTP server binds 127.0.0.1 (localhost-only), port 0 (ephemeral) unless options.port; idle-closes after 30min (line 152) logging to stderr (line 150). No remote/OAuth surface.
  - .claude-plugin/plugin.json:10 + marketplace.json — distributed as Claude Code marketplace plugin; no .mcpb, no manifest.json/server.json found anywhere.
  - scripts/build-cowork-zip.sh:13-30 — packaging is a plain `zip -r dist/neural-graph-visualizer.zip` of source dirs; no compile/bundle step, no sha256, no multi-platform smoke gate.
  - package.json:3 version 1.1.0 vs index.js:23 SERVER_INFO version '1.0.0' and index.js:111 banner 'v1.0.0' — version drift between manifest and server-reported version.
  - No .github/workflows directory — no CI, no release automation, no 3-platform smoke gate (darwin-arm64/linux-x64/linux-arm64), no sha256 manifest.

### cortex-vision · source · cap=vision
- runtime=Mixed · surface=local-stdio · verdict=**gap** · action=Phase3-harden · conf=high
- packaging: mcpb=False published=False version=1.0.0 gate=none
- notes: No .mcpb, no server.json, no dist/, no .github/CI/release workflow, no git tag. Single commit (8fa46d4), version 1.0.0 in pyproject.toml:3 + plugin.json:4 + marketplace.json. Distributed as a Claude Code plugin (.claude-plugin/plugin.json + marketplace.json), NOT as a packaged .mcpb. The 0.3.1 bootable+offline+3-platform smoke gate is structurally inapplicable: macOS-only by construction (helper.py:71 raises if sys.platform != 'darwin'; requires swiftc/Xcode CLT + Apple Vision framework). Native viscap helper is compiled lazily on first use into deps/bin/ (README:43-46), so no offline model is embedded — the 'model' is the OS Vision framework. Runtime deps (fastmcp 3.4.2, mcp 1.27.2, etc.) are vendored under deps/ (the '2884 py'); launcher pip-installs missing ones at boot — NOT a sealed offline bundle.
- hazards: H1=n/a H2=absent
  - ⚠ H1 n/a: Python runtime, no esbuild/import.meta.url. CLI guard idiom is correct Python `if __name__ == "__main__"` (__main__.py:50, launcher.py:153). No detached background worker spawned at server boot — server only registers 2 tools and runs stdio (__main__.py:37,44-47).
  - ⚠ H2 absent on the JSON-RPC channel (real grep): all Python print() calls go to file=sys.stderr (launcher.py:94,125,149); zero sys.stdout/stdout.write; no logging.basicConfig/StreamHandler in cortex_vision/ or scripts/. FastMCP owns stdout for JSON-RPC (__main__.py:47).
  - ⚠ Swift helper viscap.swift:29 print(s) writes JSON to stdout, BUT this is a SEPARATE subprocess, not the MCP transport. helper.py drives it via subprocess.run(capture_output=True) (helper.py:90,105-107) and parses the captured JSON line — its stdout never reaches the MCP server's stdio. This is correct subprocess-IPC, not transport pollution.
  - ⚠ Launcher pip-installs deps at runtime if missing (launcher.py:72-120) — install diagnostics correctly routed to stderr; not offline-sealed.
- counterpart: cortex-voice (/Users/cdeust/Developments/anthropic-partnership/cortex-voice) — sibling, independent re-implementation of the same eyes/ears-only capture-then-chain-to-Cortex pattern. Identical architecture: Python FastMCP server + scripts/launcher.py + a Swift native helper (voicecap.swift vs viscap.swift), both modelled on cortex-viz's launcher (launcher.py:11-13). NOT a dependency, copy, or duplicate. No consolidated-TS vision implementation exists; cortex-vision is not listed in the Cortex main marketplace.
  - ? Native-port feasibility: porting Apple Vision (VNRecognizeText/VNClassifyImage/VNDetectBarcodes + ScreenCaptureKit + AVFoundation) to a Node/TS MCP is non-trivial — the on-device capability IS the macOS framework. A Node server would still need to shell out to a Swift/native helper, so a pure-TS conformant rewrite cannot eliminate the native dependency. Should the Node/TS target be waived for inherently-macOS-native capture plugins (vision/voice), keeping them as Python+Swift plugins?
  - ? Should cortex-vision be packaged as .mcpb at all, given it is macOS-only and cannot satisfy the 3-platform (linux-x64/linux-arm64) smoke-gate? The offline-model requirement is also moot since the 'model' is the OS Vision framework.
  - ? Runtime pip-install at boot (launcher.py:72-120) reaches the network on first run — acceptable for a dev plugin but violates the offline-sealed posture of the .mcpb recipe; intended distribution channel (plugin vs packaged) needs confirmation.
  - ? No automated test or smoke harness present; check_vision_setup/look were not executed (would trigger macOS TCC Camera/Screen-Recording prompts) — runtime behavior verified only by code reading.
- evidence:
  - pyproject.toml:15-16 — entry point [project.scripts] cortex-vision = cortex_vision.__main__:main
  - .claude-plugin/plugin.json:41-54 — mcpServers.cortex-vision: python3 ${CLAUDE_PLUGIN_ROOT}/scripts/launcher.py cortex_vision (stdio), userConfig maps VISION_DEFAULT_SOURCE/TASK/MODE
  - cortex_vision/__main__.py:22-47 — FastMCP(name=cortex-vision, version=1.0.0); mcp_tools.register(mcp); mcp.run(transport='stdio')
  - cortex_vision/server/mcp_tools.py — two tools: look (lines 69-138) and check_vision_setup (141-181); both eyes-only, return next_action to chain to Cortex MCP
  - cortex_vision/vision/helper.py:71-99 — macOS-only (raises if not darwin), lazy swiftc compile of viscap into deps/bin, ad-hoc codesign; subprocess.run(capture_output=True) at :90,105-107
  - scripts/viscap.swift:182-233 — VNRecognizeTextRequest (OCR), VNClassifyImageRequest (scene), VNDetectBarcodesRequest; ScreenCaptureKit/AVFoundation/screencapture acquisition; emit() prints JSON to subprocess stdout only
  - REAL grep H2: grep -rn 'print(' cortex_vision/ scripts/ → only stderr prints (launcher.py:94,125,149) + viscap.swift:29 (subprocess JSON); grep 'sys.stdout|stdout.write' → 0 hits; grep 'logging|basicConfig|StreamHandler' → 0 hits
  - Plugin-own code = 457 lines (wc -l on cortex_vision/ + scripts/); deps/ = vendored fastmcp 3.4.2 / mcp 1.27.2 / starlette / pydantic etc. — NOT a vendored Cortex memory lib; README:16-22 confirms eyes-only no-memory-pipeline design
  - find: no server.json, no *.mcpb, no dist/, no .github/ CI-release workflow; git: single commit 8fa46d4, zero tags, remote github.com/cdeust/cortex-vision
  - Counterpart confirmed: cortex-voice/scripts/voicecap.swift + cortex-voice/scripts/launcher.py — same architecture; launcher.py:11-13 states it is modelled on cortex-viz's launcher

### cortex-voice · source · cap=voice
- runtime=Python · surface=local-stdio · verdict=**gap** · action=Phase2-port · conf=high
- packaging: mcpb=False published=False version=1.0.0 gate=none
- notes: Claude Code plugin only (.claude-plugin/plugin.json + marketplace.json, v1.0.0), NOT an .mcpb bundle. No CI/release workflow (no .github/workflows). No 3-platform smoke-gate, no sha256. Single git commit 719e22f, no tags. deps/ is runtime-vendored by launcher.py and gitignored (136 entries on disk, 0 tracked); 14 source files ship. No offline model embedding needed — on-device model is OS-managed (Apple downloads per-locale once). macOS-only hard gate at helper.py:70.
- hazards: H1=n/a H2=absent
  - ⚠ H1/H2 are Node-specific and n/a here (no JS/TS; grep import.meta.url/fileURLToPath/process.argv/console.log|info|warn = NONE).
  - ⚠ Python stdout-pollution equivalent ABSENT: the only 3 print() calls (launcher.py:94, :125, :149) all carry file=sys.stderr; no sys.stdout.write anywhere. FastMCP owns stdout for JSON-RPC.
  - ⚠ Swift helper print(s) at voicecap.swift:24 writes to the helper subprocess's OWN stdout, captured by Python via subprocess.run(capture_output=True) at helper.py:102 and parsed — never reaches the MCP server's stdio channel. Clean isolation.
  - ⚠ Minor robustness: helper.py:111 parses only the LAST stdout line as JSON, tolerating any stray helper chatter — defensive, reinforces no-pollution.
- counterpart: No voice counterpart on the consolidated TS Cortex side (grep for voicecap/SFSpeechRecognizer/cortex-voice in Cortex/ = none; the lone pygments lexer hit is unrelated). Relation: aucune (standalone source repo). Structural twin of sibling cortex-vision (same launcher/Swift-helper/ears-or-eyes-only architecture, independent reimplementation per-capability, not a copy).
  - ? Is a Node/TS port viable at all? Apple Speech (SFSpeechRecognizer/AVAudioEngine) is a macOS-native framework with no Node equivalent — same non-trivial language gap as cortex-vision; a TS .mcpb would still need a native Swift helper subprocess, so 'Node/TypeScript target' may be only partially achievable (TS wrapper + Swift helper).
  - ? If kept as Python, what is the intended distribution for the Directory — does the partner accept a Python local-stdio plugin under §5, or is Node packaging mandatory for listing?
  - ? No .mcpb / no CI: is a 3-platform smoke-gate even meaningful for a macOS-only voice MCP (linux-x64/linux-arm64 cannot run Apple Speech)? The v0.3.1 gate may need a macOS-only exception.
  - ? On-device model is OS-managed (per-locale download once) — confirm whether the 'offline models embarqués' requirement is waived for OS-native recognition or must be otherwise satisfied.
- evidence:
  - pyproject.toml:2-16 — name=cortex-voice, version 1.0.0, requires-python>=3.10, deps fastmcp>=2.0.0/pydantic; entry point cortex-voice = cortex_voice.__main__:main (Python, not Node).
  - cortex_voice/__main__.py:21-45 — FastMCP(name='cortex-voice', version='1.0.0'); mcp.run(transport='stdio') confirms local-stdio MCP surface.
  - cortex_voice/server/mcp_tools.py:47-132 — two tools registered: listen (record+transcribe+classify, returns next_action) and check_voice_setup; neither touches Cortex.
  - cortex_voice/voice/helper.py:70 — hard macOS gate: raise VoiceHelperError('cortex-voice requires macOS (Apple Speech framework).') if sys.platform != 'darwin'; :81-96 lazy swiftc compile of voicecap.swift with embedded Info.plist + ad-hoc codesign.
  - scripts/voicecap.swift:16-26,77-157 — Apple Speech: SFSpeechRecognizer + AVAudioEngine, requiresOnDeviceRecognition, emits one JSON line on its own stdout (print at :24).
  - Hazard grep (real): import.meta.url/fileURLToPath/process.argv/console.log|info|warn = NONE; print() in package/scripts = 3 hits all file=sys.stderr (launcher.py:94 confirmed via sed :94-103, :125, :149); sys.stdout/stdout.write = NONE.
  - helper.py:102 subprocess.run(..., capture_output=True) + :111 parse last stdout line — Swift helper stdout is captured, never leaks to MCP stdio.
  - .claude-plugin/plugin.json:34-46 — mcpServers.cortex-voice.command=python3, args=[launcher.py, cortex_voice]; no .mcpb, no manifest.json/server.json found.
  - find: no .github/workflows, no *.mcpb, no manifest.json/server.json/.mcp.json; git log = single commit 719e22f, no tags.
  - .gitignore:1-5 + git ls-files — deps/ gitignored (0 tracked); 14 source files ship.
  - grep -ril voicecap|SFSpeechRecognizer|cortex-voice over Cortex/ — no consolidated-TS voice counterpart (only unrelated pygments lexer).

### cortex-viz · source · cap=viz
- runtime=Python · surface=local-stdio · verdict=**gap** · action=Phase2-port · conf=high
- packaging: mcpb=False published=False version=1.0.0 gate=none
- notes: version 1.0.0 declared in pyproject.toml:7 + plugin.json:4, but git tags are EMPTY (no v1.0.0 tag despite commit b60a4a0 'release: cut v1.0.0'). No .mcpb, no manifest.json/server.json. No CI/release workflow (.github absent). Distributed via cortex-plugins marketplace (README.md:22-27) as a raw Python plugin launched by scripts/launcher.py. NOT offline: launcher.py:81-129 pip-installs the base+Postgres deps into a deps/ dir at runtime (deps/ is empty, nothing vendored); viz-tile extras (igraph/datashader/pyarrow) are runtime-optional. No 3-platform smoke gate, no sha256, no embedded offline models.
- hazards: H1=n/a H2=absent
  - ⚠ Python runtime, so Node-specific H1/H2 are n/a by rule.
  - ⚠ Python stdout-pollution equivalent verified ABSENT on the stdio JSON-RPC path: real grep of all print() in cortex_viz/ + scripts/ shows every call is either file=sys.stderr (http_server.py:36/199, http_common.py:96/137, graph_build_helpers.py:112/144, graph_build_l6.py:207, graph_build_merge.py:140, http_standalone.py:58, http_standalone_endpoints.py:129), or __main__-guarded bench/self-check (layout_authority_lod.py:182, layout_authority_wire.py:224, layout_authority.py:465, bench_layout_authority.py:316), or in the DETACHED HTTP subprocess (http_standalone.py:193 _announce prints JSON to its OWN subprocess stdout to signal URL to parent then closes stdout — not the MCP channel).
  - ⚠ MCP stdio boot path is minimal and clean: __main__.py imports only mcp_tools->2 handlers; http_server.shutdown_server is lazily imported inside _shutdown(). No import-time print on boot path.
  - ⚠ Security note (not a stdout hazard): open_visualization.py runs subprocess.run on a discovered visualize_bootstrap.py; docstring (lines 70-118) documents prior LACE CVE GHSA-gvpp-v77h-5w8g where CLAUDE_PROJECT_DIR was an attacker-controllable code-exec surface — now hardened (CLAUDE_PROJECT_DIR dropped; CORTEX_DEV_ROOT gated behind CORTEX_DEV_SOURCE_SYNC=1 opt-in).
- counterpart: neural-graph-visualizer (/Users/cdeust/Developments/anthropic-partnership/neural-graph-visualizer) — relation: independent reimplementation, NOT a duplicate. It is a Node.js/Three.js zero-dependency GENERIC 3D knowledge-graph viz (cascade/pipeline/radial layouts, molecule viewer, configurable templates); cortex-viz is a Python/FastMCP read-only bridge specifically over Cortex's PostgreSQL store. Different stack, data source, and product. Distinct provenance counterpart: cortex-viz was EXTRACTED from the Cortex repo (README.md:141 'extracted from Cortex'), so Cortex is its source-of-origin; there is no consolidated-TS counterpart of this viz.
  - ? Is the partner intent to keep cortex-viz as a Python plugin (accepting the Node/TS-target gap as a documented exception) or to port the stdio MCP shell to TypeScript/.mcpb? The heavy Python viz stack (igraph/datashader/numpy/AST graph builders, 125 files) makes a full TS port costly — likely only the thin MCP-tool shell would port, with the HTTP/render engine staying Python behind it.
  - ? No CI/release workflow exists (.github absent) — how is the cortex-plugins marketplace artifact built/published, and where would a future .mcpb + 3-platform smoke gate + sha256 be wired?
  - ? The declared v1.0.0 has no git tag — is 1.0.0 actually released/published anywhere, or is the version string aspirational?
- evidence:
  - plugin.json:28-39 — mcpServers.cortex-viz.command='python3', args=['${CLAUDE_PLUGIN_ROOT}/scripts/launcher.py','cortex_viz'] → local stdio MCP, Python runtime (NOT Node/TS target).
  - cortex_viz/__main__.py:48 — mcp.run(transport='stdio'); FastMCP server name 'cortex-viz' (lines 21-30).
  - server/mcp_tools.py:22-51 — registers exactly two tools: open_visualization + get_methodology_graph.
  - handlers/open_visualization.py:237-314 — launches HTTP server (127.0.0.1:3458) + open_in_browser; reads Cortex store read-only; auto-shutdown after idle.
  - pyproject.toml:7 version='1.0.0'; :23-28 deps fastmcp/pydantic/numpy; :42-56 viz-tile + data extras (psycopg/igraph/datashader) — read-only Postgres bridge.
  - scripts/launcher.py:81-129 — _pip_install runs pip install --target at RUNTIME for fastmcp/psycopg/pgvector trio → not offline/bootable per v0.3.1 recipe; deps/ dir is empty (nothing vendored).
  - git: tags empty, latest commit b60a4a0 'release: cut v1.0.0' but no tag; remote origin github.com/cdeust/cortex-viz.git.
  - README.md:141 — 'visualization stack was extracted from Cortex' (provenance = Cortex repo).
  - Real grep across cortex_viz/+scripts/: all stdio-path print() are file=sys.stderr or __main__-guarded bench; only raw-stdout print is http_standalone.py:193 in the detached HTTP subprocess (closes its own stdout after). stdout pollution ABSENT on JSON-RPC channel.
  - Python file count: 125 in cortex_viz/ package, 134 total incl scripts/tests (matches the '134 Python' hint).
  - neural-graph-visualizer/README.md:1-3 + package.json — Node.js/Three.js zero-dep generic 3D graph viz → independent product, not a duplicate of cortex-viz.