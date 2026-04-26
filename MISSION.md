# Worktree Mission — `port-inventory-zetetic`

> Inventory worktree: read-only analysis of `zetetic-team-subagents`.
> Produces the Phase 4 port plan for `packages/reasoning/`.

---

## 1. Source

- **Source repo**: `github.com/cdeust/zetetic-team-subagents`
- **Local path**: `/Users/cdeust/Developments/zetetic-team-subagents`
- **Source paths** (all content this worktree inventories):
  - `agents/genius/*.md` — 97 genius reasoning-pattern agents (pure LLM-facing Markdown prompts)
  - `agents/*.md` — 19 team specialist agents (pure LLM-facing Markdown prompts)
  - `hooks/*.sh` + `hooks/pre-tool-secret-shield.py` — 16 executable hook scripts (Bash + Python)
  - `rules/coding-standards.md` — 1 canonical coding-standards rule file
  - `tools/*.sh` + `tools/memory-mcp-server.py` — 19 tool scripts (Bash + Python)
  - `commands/**/*.md` — 25 slash-command definitions (Markdown)
  - `skills/**/*.md` — 61 skill definitions (Markdown)
  - `.claude-plugin/plugin.json` — Claude Code plugin discovery manifest (version 2.13.1)
  - `.claude-plugin/marketplace.json` — marketplace metadata
- **Source language**: Markdown (agent prompts / commands / skills), Bash (hooks / tools), Python (1 hook + 1 MCP server tool)
- **Lines of code (approx.)**:
  - Genius agents: ~34,881 lines (97 files, avg ~359 lines each)
  - Team agents: ~8,411 lines (19 files, avg ~443 lines each)
  - Hooks: ~903 lines (16 files)
  - Tools: ~3,895 lines (19 files)
  - Rules: 263 lines (1 file)
- **Cited papers / sources**: Every genius agent embeds a `Primary sources` block in Markdown. The `coding-standards.md` rule file embeds a `## Primary Sources` section. All source citations are inside Markdown prose — no `# source:` code annotations exist in the Bash/Python scripts.

---

## 2. Target

- **Target package**: `packages/reasoning/src/` (monorepo)
- **Target language**: TypeScript (strict) for invocation and registry layer; Markdown agent files MOVE AS-IS
- **Public API surface** (exported symbols this worktree must produce):
  - `invokeGenius(name: string, prompt: string, opts?: InvokeOptions): Promise<AgentResponse>`
  - `invokeByShape(shape: string, prompt: string, opts?: InvokeOptions): Promise<AgentResponse>`
  - `invokeTeamAgent(role: TeamAgentRole, prompt: string, opts?: InvokeOptions): Promise<AgentResponse>`
  - `listAgents(filter?: AgentFilter): AgentDescriptor[]`
  - `AgentDescriptor` interface: `{ name, file, lines, moves, domain, era, style, tools, shapes }`
  - `AgentFilter` interface: `{ domain?: string; era?: string; style?: string; shape?: string; role?: string }`
- **Ports consumed** (declared in `packages/core/src/ports/`):
  - `LLMPort` — the LLM call interface
  - `FileSystemPort` — reads agent `.md` files from the plugin root
- **Ports provided** (this module's interface to the rest of the monorepo):
  - `ReasoningPort` — exported from `packages/reasoning/src/ports/reasoning.port.ts`

---

## 3. Acceptance Contract (load-bearing)

This worktree (inventory phase) is **complete** when:

- [ ] All 7 deliverable files are committed to `port/inventory-zetetic`
- [ ] `inventory/COUNTS.md` exact counts match `find` outputs from source repo
- [ ] `contract/PORT_STRATEGY.md` addresses all six strategy points
- [ ] No writes were made to `/Users/cdeust/Developments/zetetic-team-subagents` (read-only constraint)

---

## 4. Genius Panel

**Ranganathan** — faceted inventory design (this worktree's primary pattern).

**Feynman** — verify that agent descriptions extracted here match what is actually in the source files (no summarization drift).

**Liskov** — verify that the proposed `ReasoningPort` API surface is substitutable across all agent categories.

---

## 5. Known Irregularities

See `inventory/COUNTS.md` for all source-tree irregularities flagged during inventory.

- `agents/genius/INDEX.md` exists alongside the 97 agent files — it is a navigation index, not an agent. Excluded from the 97 count.
- `hooks/session-end-memory-drain.sh` is in `hooks.json` (Stop event) but **absent** from `plugin.json` — registered but not advertised in the plugin manifest.
- `hooks/pre-tool-secret-shield.py` is in `hooks.json` but **absent** from `plugin.json` — same gap.
- Tool count (19) includes `tools/memory-mcp-server.py` (Python MCP server), not a Bash tool.

---

## 6. Daily Log

- **2026-04-26**: Initial inventory of all 97 genius agents, 19 team agents, 16 hooks, 1 rule file, 19 tools, 25 commands, 61 skills. Produced faceted inventory and port strategy.
