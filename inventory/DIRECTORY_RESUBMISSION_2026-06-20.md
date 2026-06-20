# Anthropic MCP Directory — Re-submission (supersede Python → Node)

_Prepared 2026-06-20. Branding decision: **rebrand to agentic-ai** (provenance coherence)._

## Goal

Supersede the previously-submitted **Python** server `hypermnesia-mcp-3.24.0.mcpb`
(repo `cdeust/Cortex`) — which violates the form's **Built with Node.js**
requirement — with the **Node.js** server `agentic-memory` shipped from
`cdeust/agentic-ai`.

## Form requirements — conformance (verified 2026-06-20)

| Requirement | Status | Evidence |
|---|---|---|
| Publicly on GitHub | ✅ | `cdeust/agentic-ai` PUBLIC; `.mcpb` assets on GitHub Releases |
| MIT licensed | ✅ | root `LICENSE` = MIT; `gh` licenseInfo=mit; manifest `"license":"MIT"` |
| Built with Node.js | ✅ | `server.type=node`, entry `dist/index.js`, `node>=20` |
| manifest author → GitHub profile | ✅ | `author.url = https://github.com/cdeust` |
| Privacy policy (README + manifest) | ✅ (after push) | `https://github.com/cdeust/agentic-ai/blob/main/PRIVACY.md` |

## Artifact to submit

- **Repo:** https://github.com/cdeust/agentic-ai (public, MIT)
- **Release:** `memory-v0.3.2` (PENDING — cut on user OK)
- **Assets (per-arch .mcpb, models bundled → fully offline):**
  - `agentic-memory-0.3.2-darwin-arm64.mcpb`
  - `agentic-memory-0.3.2-linux-arm64.mcpb`
  - `agentic-memory-0.3.2-linux-x64.mcpb`
  - (each gated by `smoke-mcpb.mjs` offline boot+48 tools+remember/recall before upload)
  - darwin-x64 / Intel macOS NOT shipped (onnxruntime-node upstream, no Intel-mac binary)

## What changed vs the Python submission

- **Native Node.js** build (meets "Built with Node.js"); was Python+uv before.
- **Local-first, zero-config SQLite** at `~/.cortex/cortex.db` (sqlite-vec + FTS5) —
  no PostgreSQL, no API key required to run.
- **Fully offline**: embedding + reranking models bundled in the `.mcpb`; no
  runtime download. Only optional outbound = `ANTHROPIC_API_KEY` LLM-assisted
  entity extraction (opt-in) — disclosed in PRIVACY.md.
- 48 tools (remember/recall/WRRF + FlashRank rerank + knowledge graph + methodology
  profiling + wiki).

## Form copy (paste-ready)

**Name:** agentic-memory
**Display name:** Agentic Memory
**Description:** Cortex thermodynamic memory for Claude Desktop — local-first,
zero-config SQLite. Remember/recall with hybrid WRRF retrieval, FlashRank
reranking, knowledge-graph entities, methodology profiling, and a wiki. 48 tools,
no external service required.
**Documentation:** https://github.com/cdeust/agentic-ai
**Privacy policy:** https://github.com/cdeust/agentic-ai/blob/main/PRIVACY.md

## OPEN QUESTION to resolve at the form (not verifiable from here)

The previous entry was `hypermnesia-mcp` (Python). This submission renames it to
`agentic-memory` (Node). **Confirm at the form whether "update existing extension"
treats a name change as an update of the same entry or a NEW submission.** If it
forces a new entry, decide whether to (a) keep the new entry and let the Python
one be withdrawn, or (b) keep the name `hypermnesia-mcp` on the Node artifact for
continuity (would require reverting `manifest.name` before the v0.3.2 pack).
