# Privacy Policy — Agentic Memory

_Last updated: 2026-06-20_

Agentic Memory is a **local-first** memory server for Claude, built on the
open-source Cortex memory engine. It is designed so that your data stays on your
machine. This policy describes exactly what data the server handles, where it is
stored, and what (if anything) leaves your device.

## What data is processed

To build and retrieve memory, the server reads and processes:

- **Content you explicitly store** via the `remember`, `wiki_write`, `anchor`,
  and ingestion tools (decisions, lessons, notes, code/PRD references).
- **Claude session data** under `~/.claude/` — conversation transcripts
  (`projects/*/**.jsonl`), memory notes (`*.md`), and session logs — read **only**
  when you invoke the session-import, backfill, or seed tools.
- **Derived metadata** — keyword/entity extraction, embeddings, heat/decay
  scores, and cognitive-profile statistics computed from the above.

The server does **not** ask for, collect, or process passwords, payment data, or
credentials. If you place such data into a memory yourself, it is stored exactly
like any other memory (locally) — avoid doing so.

## Where your data is stored

- **Default (SQLite):** all memories, entities, the knowledge graph, and profiles
  are stored in a single local database file at `~/.cortex/cortex.db`
  (sqlite-vec + FTS5). Set `CORTEX_DB_PATH` to relocate it. Nothing is uploaded.
- **Optional (PostgreSQL):** if you explicitly set `DATABASE_URL` to a
  PostgreSQL + pgvector database, your data is stored in **your own** database.
  The server never provisions or connects to any database you did not configure.

You own this data. Deleting the database file (or the relevant rows) permanently
removes it. The `forget` tool deletes individual memories.

## What leaves your machine

The extension **bundles** its open-source embedding and reranking models
(`all-MiniLM-L6-v2` embedding + `ms-marco-MiniLM` cross-encoder reranker) and
runs **fully offline by default**: it does not download models and does not send
any content at runtime. There is no telemetry phone-home; the `get_telemetry`
tool reports **local** performance statistics only. The server never transmits
your memories, conversations, or profiles to the author, to Anthropic, or to any
analytics service.

The only outbound network activity is **optional and opt-in**:

1. **LLM-assisted extraction (only if you enable it).** If you set an
   `ANTHROPIC_API_KEY` (or use Claude Desktop's MCP sampling), entity/keyword
   extraction sends the specific text being ingested to the Anthropic API for
   that operation only. Without a key, extraction runs locally and nothing is
   sent.
2. **Integrations you configure.** If you set `DATABASE_URL` to a remote
   PostgreSQL database, or configure optional upstream MCP servers, the server
   communicates only with the endpoints you provided.

## Data sharing

The server does not sell, share, or disclose your data to any third party. There
are no third-party trackers, advertising SDKs, or analytics services.

## Data retention

Data persists in your local store until you delete it. A local thermodynamic
decay/consolidation process compresses or prunes low-value memories over time;
this is a local maintenance operation, not a transfer.

## Your controls

- `forget` — delete a specific memory.
- Delete `~/.cortex/cortex.db` — remove all SQLite-stored data.
- For PostgreSQL, manage retention directly in your database.

## Contact

Questions about this policy: **admin@ai-architect.tools** ·
issues: https://github.com/cdeust/agentic-ai/issues
