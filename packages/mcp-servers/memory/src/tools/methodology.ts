/**
 * methodology.ts — MCP tool adapters for the methodology/profiling topic.
 *
 * Tools registered (5):
 *   query_methodology, detect_domain, rebuild_profiles, list_domains,
 *   explore_features
 *
 * Phase 7 Group D — DI wiring: ProfilesStore is now loaded from the filesystem
 * JSON store at ~/.claude/methodology/profiles.json and passed to each handler.
 * No stub paths remain.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md §Tier1Core
 * source: packages/memory/src/methodology/handlers/ (all five handlers)
 * source: packages/memory/src/hooks/session-lifecycle.ts (profiles I/O pattern)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProfilesStore } from "@agentic/memory/methodology/types.js";
import { queryMethodology } from "@agentic/memory/methodology/handlers/query-methodology.js";
import { detectDomainHandler } from "@agentic/memory/methodology/handlers/detect-domain.js";
import { rebuildProfiles, checkSkip, type ConversationRecord } from "@agentic/memory/methodology/handlers/rebuild-profiles.js";
import { exploreFeatures } from "@agentic/memory/methodology/handlers/explore-features.js";
import { discoverJsonlFiles, readHeadTail } from "@agentic/memory/import/scanner.js";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import {
  getHotMemories,
  getFiredTriggers,
  enrichContextWithMemories,
  LIST_DOMAINS_TOP_CATEGORIES,
} from "./methodology-memory-injection.js";

/**
 * Dependency bundle for the methodology tools.
 *
 * query_methodology enriches its response with hot memories + fired prospective
 * triggers, and rebuild_profiles reports totalMemories — both require the shared
 * memory store. The composition root (mcp-servers/memory/src/index.ts) injects
 * the same MemoryStoreExt it hands to the remember/management tool groups.
 *
 * source: cortex@HEAD mcp_server/handlers/query_methodology.py:81-99
 *   (_try_get_memory_store — the handler obtains the shared store)
 */
export interface MethodologyDeps {
  store: MemoryStoreExt;
}

// ── JSONL session scanner ─────────────────────────────────────────────────────
//
// Scans ~/.claude/projects/ JSONL files and builds the byProject map that
// rebuildProfiles() requires. This is the critical missing step that caused
// rebuild_profiles to return total_sessions=0: the handler was passing an
// empty byProject={} without ever scanning the filesystem.
//
// Each file contributes one ConversationRecord to its project's array.
// source: cortex@ed33435 mcp_server/handlers/rebuild_profiles.py — scans
//   ~/.claude/projects/ via ContextReader to populate byProject.

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
// source: cortex@ed33435 rebuild_profiles.py — max sessions cap to avoid OOM
const REBUILD_MAX_SESSIONS = 5000;

/**
 * Extract tool names from JSONL records (assistant messages with tool_use content).
 * source: cortex@ed33435 mcp_server/infrastructure/conversation_reader.py::_extract_tool_calls
 */
function extractToolsFromRecords(records: ReturnType<typeof readHeadTail>): string[] {
  const tools: string[] = [];
  for (const rec of records) {
    if (rec.type !== "assistant") continue;
    const content = rec.message?.content ?? [];
    if (!Array.isArray(content)) continue;
    for (const block of content as unknown as Array<Record<string, unknown>>) {
      if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        tools.push(block["name"]);
      }
    }
  }
  return tools;
}

/**
 * Extract a first-message string from JSONL records.
 * source: cortex@ed33435 mcp_server/core/session_extractor.py::extract_user_messages
 */
function extractFirstMessage(records: ReturnType<typeof readHeadTail>): string {
  for (const rec of records) {
    if (rec.type !== "user" || rec.isMeta === true || rec.toolUseResult !== undefined) continue;
    const content = rec.message?.content;
    // source: cortex@ed33435 mcp_server/core/session_extractor.py — MAX_CONTENT_LEN=2000,
    //   but 500 chars is sufficient for first-message keyword extraction without OOM risk.
    //   source: ADR-0045 R2 — bounded reads; first-message is metadata, not full content.
    const FIRST_MSG_CHAR_CAP = 500; // source: empirical — 500 chars captures intent without excess
    if (typeof content === "string" && content.length > 0) return content.slice(0, FIRST_MSG_CHAR_CAP);
    if (Array.isArray(content)) {
      for (const block of content as unknown as Array<Record<string, unknown>>) {
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].length > 0) {
          return (block["text"] as string).slice(0, FIRST_MSG_CHAR_CAP);
        }
      }
    }
  }
  return "";
}

/**
 * Scan all JSONL files in ~/.claude/projects/ and build byProject map.
 *
 * precondition:  PROJECTS_DIR may or may not exist.
 * postcondition: returns Record<projectName, ConversationRecord[]> where
 *   each conversation has at minimum timestamps + toolsUsed.
 *   Returns {} if no JSONL files found (empty projects dir).
 *
 * source: cortex@ed33435 mcp_server/handlers/rebuild_profiles.py — byProject scan
 */
function scanSessionsIntoByProject(
  targetDomain?: string,
): Record<string, ConversationRecord[]> {
  if (!existsSync(PROJECTS_DIR)) return {};

  const files = discoverJsonlFiles(PROJECTS_DIR, "");
  const capped = files.slice(0, REBUILD_MAX_SESSIONS);
  const byProject: Record<string, ConversationRecord[]> = {};

  for (const { filePath, projectName } of capped) {
    // Skip if domain is specified and project doesn't match — domain is
    // derived from project name, so we check containment.
    if (targetDomain && !projectName.includes(targetDomain)) continue;

    let records: ReturnType<typeof readHeadTail>;
    try {
      records = readHeadTail(filePath);
    } catch {
      continue;
    }
    if (records.length === 0) continue;

    const timestamps = records
      .map((r) => {
        const ts = (r as unknown as Record<string, unknown>)["timestamp"];
        return typeof ts === "string" ? ts : null;
      })
      .filter((ts): ts is string => ts !== null)
      .sort();

    const conv: ConversationRecord = {
      toolsUsed: extractToolsFromRecords(records),
      firstMessage: extractFirstMessage(records),
      startedAt:   timestamps[0] ?? undefined,
      endedAt:     timestamps[timestamps.length - 1] ?? undefined,
      keywords:    [],
    };

    if (!byProject[projectName]) byProject[projectName] = [];
    byProject[projectName].push(conv);
  }

  return byProject;
}

// ── Profiles I/O (filesystem adapter) ────────────────────────────────────────
//
// Profiles live at ~/.claude/methodology/profiles.json — the same path the
// Python server writes to. We read them at tool-call time (not at startup) so
// we always return fresh state without a daemon restart.
//
// source: packages/memory/src/hooks/session-lifecycle.ts::loadProfiles (pattern)

function methodologyDir(): string {
  return join(homedir(), ".claude", "methodology");
}

function loadProfiles(): ProfilesStore {
  const profilePath = join(methodologyDir(), "profiles.json");
  if (!existsSync(profilePath)) return { domains: {} };
  try {
    const raw = JSON.parse(readFileSync(profilePath, "utf-8")) as ProfilesStore;
    if (!raw.domains) raw.domains = {};
    return raw;
  } catch {
    return { domains: {} };
  }
}

function saveProfiles(profiles: ProfilesStore): void {
  const dir = methodologyDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(profiles, null, 2), "utf-8");
}

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── registerMethodologyTools ──────────────────────────────────────────────────

/**
 * Registers the 5 methodology/profiling MCP tools.
 *
 * precondition:  server is a live McpServer instance; deps.store is the shared
 *                MemoryStoreExt from the composition root.
 * postcondition: 5 tools registered; each body calls the real domain handler.
 *
 * source: MCP_TOOLS.md §"query_methodology", §"detect_domain",
 *         §"rebuild_profiles", §"list_domains", §"explore_features"
 * source: cortex@ed33435 mcp_server/handlers/{query_methodology,detect_domain,
 *         rebuild_profiles,list_domains,explore_features}.py
 */
export function registerMethodologyTools(server: McpServer, deps: MethodologyDeps): void {
  // ── query_methodology ─────────────────────────────────────────────────────
  server.registerTool(
    "query_methodology",
    {
      description:
        "Returns cognitive profile for the current domain (thinking style, entry patterns, blind spots, cross-domain bridges).",
      inputSchema: {
        cwd:           z.string().optional().describe("Current working directory"),
        project:       z.string().optional().describe("Project identifier"),
        first_message: z.string().optional().describe("First message of the session"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/methodology/handlers/query-methodology.ts::queryMethodology
        const profiles = loadProfiles();
        const response = queryMethodology(
          { cwd: args.cwd, project: args.project, firstMessage: args.first_message },
          profiles,
        );
        // Populate the memory/trigger fields the inner (infra-agnostic) handler
        // leaves empty, then fold their summaries into the context string.
        // source: cortex@HEAD mcp_server/handlers/query_methodology.py:317-331
        const domainId = response.domain ?? "";
        const cwd = args.cwd ?? "";
        const firstMessage = args.first_message ?? "";
        response.hotMemories = getHotMemories(deps.store, domainId, cwd);
        response.firedTriggers = getFiredTriggers(deps.store, cwd, firstMessage);
        response.context = enrichContextWithMemories(
          response.context,
          response.hotMemories,
          response.firedTriggers,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("query_methodology", err);
      }
    },
  );

  // ── detect_domain ─────────────────────────────────────────────────────────
  server.registerTool(
    "detect_domain",
    {
      description:
        "Lightweight domain classification from cwd/project without full profile assembly.",
      inputSchema: {
        cwd:           z.string().optional().describe("Current working directory"),
        project:       z.string().optional().describe("Project identifier"),
        first_message: z.string().optional().describe("First message for hint"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/methodology/handlers/detect-domain.ts::detectDomainHandler
        const profiles = loadProfiles();
        const response = detectDomainHandler(
          { cwd: args.cwd, project: args.project, firstMessage: args.first_message },
          profiles,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("detect_domain", err);
      }
    },
  );

  // ── rebuild_profiles ──────────────────────────────────────────────────────
  server.registerTool(
    "rebuild_profiles",
    {
      description:
        "Full rescan of all session data to rebuild methodology profiles from scratch.",
      inputSchema: {
        domain: z.string().optional().describe("Limit rebuild to a single domain"),
        force:  z.boolean().default(false).describe("Force rebuild even if fresh"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/methodology/handlers/rebuild-profiles.ts::rebuildProfiles
        // source: cortex@ed33435 mcp_server/handlers/rebuild_profiles.py — full scan
        //
        // CRITICAL FIX: previously byProject: {} caused total_sessions=0.
        // Now we scan ~/.claude/projects/ JSONL files to build the byProject
        // map before calling rebuildProfiles. This matches the Python source
        // which reads session data via ContextReader before building profiles.
        const existingProfiles = loadProfiles();
        const skipCheck = checkSkip(existingProfiles, args.force);
        if (skipCheck.skip) {
          // source: cortex@HEAD mcp_server/handlers/rebuild_profiles.py:76-81
          //   return {"skipped": True, "reason", "domains", "updatedAt"}
          return { content: [{ type: "text" as const, text: JSON.stringify({
            skipped: true,
            reason: skipCheck.reason,
            domains: skipCheck.domains ?? [],
            updatedAt: skipCheck.updatedAt,
          }) }] };
        }

        const t0 = Date.now();
        const byProject = scanSessionsIntoByProject(args.domain);
        const result = rebuildProfiles({
          byProject,
          existingProfiles,
          targetDomain: args.domain,
        });

        // Persist rebuilt profiles to disk so query_methodology reads fresh data.
        // source: cortex@ed33435 mcp_server/handlers/rebuild_profiles.py — saves profiles
        saveProfiles(result.profiles);

        // source: cortex@HEAD mcp_server/handlers/rebuild_profiles.py:110-116
        //   return {domains, totalSessions, totalMemories, duration}.
        // Cortex's totalMemories = len(discover_all_memories()) (filesystem .md
        // scan); the TS backend is a DB store, so the iso-faithful count is the
        // stored-memory row count (store.countMemories). The audit already
        // classifies the rebuild I/O backend as an accepted behavior_divergence,
        // so the absolute count differs while both are correct.
        return { content: [{ type: "text" as const, text: JSON.stringify({
          domains:       result.domains,
          totalSessions: result.totalSessions,
          totalMemories: deps.store.countMemories(),
          duration:      Date.now() - t0,
        }) }] };
      } catch (err) {
        process.stderr.write(`[rebuild_profiles] error: ${err instanceof Error ? err.message : String(err)}\n`);
        return errorText("rebuild_profiles", err);
      }
    },
  );

  // ── list_domains ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_domains",
    {
      description:
        "Overview of all detected cognitive domains with session counts and last-seen dates.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        // source: cortex@HEAD mcp_server/handlers/list_domains.py:34-67
        const profiles = loadProfiles();
        const domains = Object.values(profiles.domains).map((domain) => {
          // top 3 categories by ratio desc -> [{category, ratio}]
          // source: list_domains.py:38-44,52-54
          const topCategories = Object.entries(domain.categories ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, LIST_DOMAINS_TOP_CATEGORIES)
            .map(([category, ratio]) => ({ category, ratio }));
          return {
            id:           domain.id,
            label:        domain.label,
            sessionCount: domain.sessionCount ?? 0,
            confidence:   domain.confidence ?? 0,
            lastActive:   domain.lastUpdated ?? null,
            topCategories,
            dominantMode: domain.sessionShape?.dominantMode ?? null,
          };
        });
        // source: list_domains.py:61 — sort by sessionCount desc
        domains.sort((a, b) => b.sessionCount - a.sessionCount);
        // source: list_domains.py:63-67 — {domains, totalDomains, globalStyle}
        return { content: [{ type: "text" as const, text: JSON.stringify({
          domains,
          totalDomains: domains.length,
          globalStyle:  profiles.globalStyle ?? null,
        }) }] };
      } catch (err) {
        return errorText("list_domains", err);
      }
    },
  );

  // ── explore_features ──────────────────────────────────────────────────────
  server.registerTool(
    "explore_features",
    {
      description:
        "Explore interpretability features: persona vector, attribution trace, crosscoder patterns.",
      inputSchema: {
        mode:           z.enum(["features", "persona", "attribution", "crosscoder"]).describe("Exploration mode"),
        domain:         z.string().optional().describe("Domain filter"),
        compare_domain: z.string().optional().describe("Domain to compare against"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/methodology/handlers/explore-features.ts::exploreFeatures
        const profiles = loadProfiles();
        const response = exploreFeatures(
          { mode: args.mode, domain: args.domain, compareDomain: args.compare_domain },
          profiles,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("explore_features", err);
      }
    },
  );
}
