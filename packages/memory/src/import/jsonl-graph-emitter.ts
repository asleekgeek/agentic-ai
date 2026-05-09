/**
 * jsonl-graph-emitter.ts — emit graph entities + relationships from JSONL session files.
 *
 * Walks every tool_use block in a Claude Code session transcript and emits:
 *   - Tool entities      (Bash, Read, Edit, Write, Grep, Glob, Task, …)
 *   - MCP entities       (mcp__plugin_X__Y → server X, method Y)
 *   - Skill entities     (slash-command invocations: /memory:cortex-import, /agent:spawn, …)
 *   - Command entities   (Bash tool_use with the first-line of the command)
 *   - Discussion entity  (one per session file, keyed on session_id)
 * And edges:
 *   - session_used_tool        (discussion → tool)
 *   - session_called_mcp       (discussion → mcp)
 *   - session_invoked_skill    (discussion → skill)
 *   - session_ran_command      (discussion → command)
 *   - discussion_touched_file  (discussion → file, from file_path inputs)
 *   - tool_operated_on_file    (tool → file)
 *   - co_occurrence            (every pair of entities seen in the session)
 *
 * source: Cortex mcp_server/infrastructure/workflow_graph_source_jsonl.py
 *   — load_discussions, load_discussion_tool_uses, load_mcp_usage,
 *     load_skill_usage, load_discussion_commands, load_discussion_files
 * source: Cortex mcp_server/core/workflow_graph_builder_relational.py
 *   — ingest_discussion_tool, ingest_mcp_usage, ingest_skill_usage,
 *     ingest_discussion_command, ingest_discussion_file
 *
 * Pure infrastructure — no core imports. Calls store.*Async methods.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ── Internal store interface (minimal structural typing) ──────────────────────
// Matches the optional method extensions defined in MemoryStore (memory-store.ts).
// source: MemoryStore.upsertEntityAsync, upsertEntity, insertRelationshipAsync,
//         upsertRelationship — all declared in packages/memory/src/remember/storage/memory-store.ts

interface GraphStore {
  /** Async upsert entity — preferred on PG (avoids _runSync throw). */
  upsertEntityAsync?: (name: string, type: string, domain: string) => Promise<number>;
  /** Sync upsert entity — available on SQLite. */
  upsertEntity(name: string, type: string, domain: string): number;
  /** Async insert relationship — preferred on PG; takes a record dict. */
  insertRelationshipAsync?: (rel: Record<string, unknown>) => Promise<void>;
  /** Sync upsert relationship — available on SQLite. */
  upsertRelationship(
    sourceEntityId: number,
    targetEntityId: number,
    relationshipType: string,
    weight?: number,
  ): void;
}

// ── Normalization tables ──────────────────────────────────────────────────────

// source: Cortex workflow_graph_source_jsonl.py _TOOL_NORMALIZE
const _TOOL_NORMALIZE: Readonly<Record<string, string>> = {
  Edit: "Edit",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  Write: "Write",
  Read: "Read",
  NotebookRead: "Read",
  Grep: "Grep",
  Glob: "Glob",
  Bash: "Bash",
  Task: "Task",
  Agent: "Task",
};

// source: Cortex workflow_graph_source_jsonl.py _FILE_INPUT_TOOLS
const _FILE_INPUT_TOOLS = new Set([
  "Edit",
  "Write",
  "Read",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
]);

// source: Cortex workflow_graph_source_jsonl.py _MCP_NAME_RE
const _MCP_NAME_RE = /^mcp__([A-Za-z0-9_]+)__([A-Za-z0-9_]+)$/;

// source: Cortex workflow_graph_source_jsonl.py _SLASH_RE
const _SLASH_RE = /^\s*\/([A-Za-z][A-Za-z0-9:_-]*)/;

// source: Cortex workflow_graph_source_jsonl.py _SKIP_SKILL_PREFIXES
const _SKIP_SKILL_PREFIXES = new Set(["help", "clear", "reset"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function cmdHash(cmd: string): string {
  // source: Cortex workflow_graph_source.py _cmd_hash — SHA-1 first 12 chars
  return createHash("sha1").update(cmd, "utf8").digest("hex").slice(0, 12);
}

function firstLine(text: string): string {
  for (const ln of text.split("\n")) {
    const s = ln.trim();
    if (s) return s;
  }
  return text.trim();
}

function readJsonlLines(filePath: string): Record<string, unknown>[] {
  try {
    const text = readFileSync(filePath, "utf8");
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        // skip malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Session-level extraction ──────────────────────────────────────────────────

export interface SessionGraphEntities {
  /** Canonical session id (collapses subagent suffixes). */
  sessionId: string;
  /** Title: first user message, truncated. */
  title: string;
  /** Per-tool normalized name → usage count. */
  tools: Map<string, number>;
  /** MCP server name → {tool, count} */
  mcpServers: Map<string, { tool: string; count: number }>;
  /** Skill (slash command) name → count */
  skills: Map<string, number>;
  /** Bash command first-line → {hash, count} */
  commands: Map<string, { hash: string; count: number }>;
  /** File paths touched (from file_path inputs). */
  filePaths: Map<string, number>;
  /** Tool name → Set of file_paths it touched. */
  toolFilePaths: Map<string, Set<string>>;
}

/**
 * Extract all graph-relevant entities from one session JSONL file.
 *
 * Pre:  filePath is a readable JSONL session transcript.
 * Post: returns SessionGraphEntities; empty maps if the file has no tool_use blocks.
 *
 * source: Cortex workflow_graph_source_jsonl.py — load_discussion_tool_uses,
 *         load_mcp_usage, load_skill_usage, load_discussion_commands,
 *         load_discussion_files
 */
export function extractSessionEntities(filePath: string): SessionGraphEntities {
  const lines = readJsonlLines(filePath);

  let sessionId = "";
  let title = "";
  const tools = new Map<string, number>();
  const mcpServers = new Map<string, { tool: string; count: number }>();
  const skills = new Map<string, number>();
  const commands = new Map<string, { hash: string; count: number }>();
  const filePaths = new Map<string, number>();
  const toolFilePaths = new Map<string, Set<string>>();

  for (const rec of lines) {
    const type = rec["type"] as string | undefined;

    // Extract session id.
    if (!sessionId && rec["sessionId"]) {
      const raw = String(rec["sessionId"]);
      // Collapse subagent suffix: "abc-subagent-xyz" → "abc"
      sessionId = raw.split("-subagent-")[0]!.split("-explore-")[0]!;
    }

    // Extract title from first user message.
    if (!title && type === "user") {
      const content = (rec["message"] as Record<string, unknown> | undefined)?.["content"];
      if (typeof content === "string" && content.trim()) {
        title = content.trim().slice(0, 80);
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>)["type"] === "text"
          ) {
            const t = String((b as Record<string, unknown>)["text"] ?? "").trim();
            if (t) {
              title = t.slice(0, 80);
              break;
            }
          }
        }
      }
    }

    // Skill detection from user messages (slash commands).
    // source: Cortex workflow_graph_source_jsonl.py load_skill_usage
    if (type === "user") {
      const content = (rec["message"] as Record<string, unknown> | undefined)?.["content"];
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>)["type"] === "text"
          ) {
            text = String((b as Record<string, unknown>)["text"] ?? "");
            break;
          }
        }
      }
      const m = _SLASH_RE.exec(text);
      if (m) {
        const skill = m[1]!.split(":").at(-1)!;
        if (!_SKIP_SKILL_PREFIXES.has(skill)) {
          skills.set(skill, (skills.get(skill) ?? 0) + 1);
        }
      }
    }

    // Tool_use extraction from assistant messages.
    if (type === "assistant") {
      const content = (rec["message"] as Record<string, unknown> | undefined)?.["content"];
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_use") continue;
        const rawName = String(b["name"] ?? "");
        const inp = (b["input"] as Record<string, unknown> | undefined) ?? {};

        // MCP detection.
        // source: Cortex workflow_graph_source_jsonl.py load_mcp_usage
        const mcpMatch = _MCP_NAME_RE.exec(rawName);
        if (mcpMatch) {
          const server = mcpMatch[1]!;
          const tool = mcpMatch[2]!;
          const existing = mcpServers.get(server);
          if (existing) {
            existing.count += 1;
          } else {
            mcpServers.set(server, { tool, count: 1 });
          }
          continue; // MCP tools don't normalize as standard tools
        }

        // Standard tool normalization.
        // source: Cortex workflow_graph_source_jsonl.py _TOOL_NORMALIZE
        const toolNorm = _TOOL_NORMALIZE[rawName] ?? "";
        if (!toolNorm) continue;

        tools.set(toolNorm, (tools.get(toolNorm) ?? 0) + 1);

        // Bash command extraction.
        // source: Cortex workflow_graph_source_jsonl.py load_discussion_commands
        if (rawName === "Bash") {
          let cmd = String(inp["command"] ?? "");
          cmd = firstLine(cmd);
          if (cmd) {
            const h = cmdHash(cmd);
            const existing = commands.get(cmd);
            if (existing) {
              existing.count += 1;
            } else {
              commands.set(cmd, { hash: h, count: 1 });
            }
          }
        }

        // File path extraction.
        // source: Cortex workflow_graph_source_jsonl.py load_discussion_files, _FILE_INPUT_TOOLS
        if (_FILE_INPUT_TOOLS.has(rawName)) {
          for (const key of ["file_path", "path", "notebook_path"]) {
            const fp = inp[key];
            if (fp) {
              const fpStr = String(fp);
              filePaths.set(fpStr, (filePaths.get(fpStr) ?? 0) + 1);
              // Track which tool touched which file.
              if (!toolFilePaths.has(toolNorm)) {
                toolFilePaths.set(toolNorm, new Set());
              }
              toolFilePaths.get(toolNorm)!.add(fpStr);
            }
          }
        }
      }
    }
  }

  return {
    sessionId: sessionId || (filePath.split("/").at(-1)?.replace(".jsonl", "") ?? "unknown"),
    title: title || sessionId.slice(0, 40) || "session",
    tools,
    mcpServers,
    skills,
    commands,
    filePaths,
    toolFilePaths,
  };
}

// ── Async store writers ───────────────────────────────────────────────────────

async function upsertEntity(
  store: GraphStore,
  name: string,
  type: string,
  domain: string,
): Promise<number | null> {
  try {
    if (typeof store.upsertEntityAsync === "function") {
      return await store.upsertEntityAsync(name, type, domain);
    }
    if (typeof store.upsertEntity === "function") {
      return store.upsertEntity(name, type, domain);
    }
  } catch {
    // best-effort
  }
  return null;
}

async function upsertRelationship(
  store: GraphStore,
  sourceId: number,
  targetId: number,
  type: string,
  weight = 1.0,
): Promise<void> {
  try {
    if (store.insertRelationshipAsync) {
      // PG path: insertRelationshipAsync takes a record dict.
      // source: MemoryStore.insertRelationshipAsync signature in memory-store.ts
      await store.insertRelationshipAsync({
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: type,
        weight,
      });
      return;
    }
    store.upsertRelationship(sourceId, targetId, type, weight);
  } catch {
    // best-effort
  }
}

// ── Main emitter ─────────────────────────────────────────────────────────────

export interface GraphEmitResult {
  entities_written: number;
  relationships_written: number;
}

/**
 * Emit graph entities and relationships from a session JSONL file.
 *
 * Writes to the entities + relationships tables via store.*Async methods.
 * Idempotent: upsertEntityAsync must be idempotent (ON CONFLICT DO NOTHING
 * or equivalent). Co-occurrence edges between all entity pairs are emitted.
 *
 * Pre:  store exposes upsertEntityAsync + upsertRelationshipAsync (or sync
 *       equivalents). filePath is a readable JSONL session transcript.
 * Post: entities_written + relationships_written counts returned. All errors
 *       are swallowed (best-effort) — one malformed record must not abort
 *       the whole session.
 *
 * source: Cortex mcp_server/infrastructure/workflow_graph_source_jsonl.py
 *   — all load_* functions that extract per-session data.
 * source: Cortex mcp_server/core/workflow_graph_builder_relational.py
 *   — ingest_discussion_tool, ingest_mcp_usage, ingest_skill_usage,
 *     ingest_discussion_command, ingest_discussion_file
 */
export async function emitSessionGraphEntities(
  store: unknown,
  filePath: string,
  domain: string,
): Promise<GraphEmitResult> {
  // Structural check: store must expose at least one entity-write method.
  const gs = store as unknown as GraphStore;
  if (typeof gs.upsertEntityAsync !== "function" && typeof gs.upsertEntity !== "function") {
    // Store doesn't support entity writes — skip silently.
    return { entities_written: 0, relationships_written: 0 };
  }

  const ents = extractSessionEntities(filePath);
  if (ents.sessionId === "unknown" && ents.tools.size === 0) {
    return { entities_written: 0, relationships_written: 0 };
  }

  let entitiesWritten = 0;
  let relationshipsWritten = 0;

  // Collect all entity IDs for co_occurrence at the end.
  const sessionEntityIds: number[] = [];

  // 1. Emit discussion (session) entity.
  // source: Cortex workflow_graph_schema_enums.py NodeKind.DISCUSSION = "discussion"
  const discId = await upsertEntity(gs, ents.sessionId, "discussion", domain);
  if (discId !== null) {
    entitiesWritten += 1;
    sessionEntityIds.push(discId);
  }

  // 2. Emit Tool entities + session_used_tool edges.
  // source: Cortex NodeKind.TOOL_HUB = "tool_hub"
  // We emit type "Tool" (matching Cortex prod entity type column).
  for (const [toolName, count] of ents.tools) {
    const toolId = await upsertEntity(gs, toolName, "Tool", domain);
    if (toolId !== null) {
      entitiesWritten += 1;
      sessionEntityIds.push(toolId);
      if (discId !== null) {
        await upsertRelationship(gs, discId, toolId, "session_used_tool", count);
        relationshipsWritten += 1;
      }
    }
  }

  // 3. Emit MCP entities + session_called_mcp edges.
  // source: Cortex NodeKind.MCP = "mcp"
  for (const [serverName, { tool, count }] of ents.mcpServers) {
    // Entity name: "serverName/tool" to preserve method granularity.
    const mcpEntityName = tool ? `${serverName}/${tool}` : serverName;
    const mcpId = await upsertEntity(gs, mcpEntityName, "MCP", domain);
    if (mcpId !== null) {
      entitiesWritten += 1;
      sessionEntityIds.push(mcpId);
      if (discId !== null) {
        await upsertRelationship(gs, discId, mcpId, "session_called_mcp", count);
        relationshipsWritten += 1;
      }
    }
  }

  // 4. Emit Skill entities + session_invoked_skill edges.
  // source: Cortex NodeKind.SKILL = "skill"
  for (const [skillName, count] of ents.skills) {
    const skillId = await upsertEntity(gs, skillName, "Skill", domain);
    if (skillId !== null) {
      entitiesWritten += 1;
      sessionEntityIds.push(skillId);
      if (discId !== null) {
        await upsertRelationship(gs, discId, skillId, "session_invoked_skill", count);
        relationshipsWritten += 1;
      }
    }
  }

  // 5. Emit Command entities + session_ran_command edges.
  // source: Cortex NodeKind.COMMAND = "command"
  for (const [cmdText, { hash, count }] of ents.commands) {
    // Entity name: hash prefix + truncated command for readability.
    const cmdEntityName = `cmd:${hash}:${cmdText.slice(0, 60)}`;
    const cmdId = await upsertEntity(gs, cmdEntityName, "Command", domain);
    if (cmdId !== null) {
      entitiesWritten += 1;
      sessionEntityIds.push(cmdId);
      if (discId !== null) {
        await upsertRelationship(gs, discId, cmdId, "session_ran_command", count);
        relationshipsWritten += 1;
      }
    }
  }

  // 6. Emit file entities + discussion_touched_file + tool_operated_on_file edges.
  // source: Cortex NodeKind.FILE = "file", EdgeKind.DISCUSSION_TOUCHED_FILE
  for (const [fpStr, count] of ents.filePaths) {
    const fileId = await upsertEntity(gs, fpStr, "file", domain);
    if (fileId !== null) {
      entitiesWritten += 1;
      sessionEntityIds.push(fileId);
      if (discId !== null) {
        await upsertRelationship(gs, discId, fileId, "discussion_touched_file", count);
        relationshipsWritten += 1;
      }
    }
  }

  // tool_operated_on_file edges.
  // source: Cortex EdgeKind.TOOL_USED_FILE = "tool_used_file" (→ tool_operated_on_file in relational)
  for (const [toolName, paths] of ents.toolFilePaths) {
    const toolId = await upsertEntity(gs, toolName, "Tool", domain);
    if (toolId === null) continue;
    for (const fp of paths) {
      const fileId = await upsertEntity(gs, fp, "file", domain);
      if (fileId !== null) {
        await upsertRelationship(gs, toolId, fileId, "tool_operated_on_file", 1.0);
        relationshipsWritten += 1;
      }
    }
  }

  // 7. Co_occurrence edges between every pair of entities in the session.
  // source: Cortex prod relationship type co_occurrence = 156,210 in prod DB.
  // Every pair of distinct entities seen in the same session gets a co_occurrence edge.
  // We emit directed edges (lower_id → higher_id) to avoid duplicates.
  const uniqueIds = Array.from(new Set(sessionEntityIds)).sort((a, b) => a - b);
  for (let i = 0; i < uniqueIds.length; i++) {
    for (let j = i + 1; j < uniqueIds.length; j++) {
      await upsertRelationship(gs, uniqueIds[i]!, uniqueIds[j]!, "co_occurrence", 1.0);
      relationshipsWritten += 1;
    }
  }

  return { entities_written: entitiesWritten, relationships_written: relationshipsWritten };
}
