/**
 * advanced.ts — MCP tool adapters for the advanced/automation topic.
 *
 * Tools registered (5):
 *   sync_instructions, create_trigger, add_rule, get_rules,
 *   assess_coverage
 *
 * Phase 7 Group D — DI wiring:
 *   - sync_instructions: calls real syncInstructionsHandler.
 *   - create_trigger: calls real createTriggerHandler.
 *   - add_rule: calls real addRuleHandler.
 *   - get_rules: calls real getRulesHandler.
 *   - assess_coverage: ported inline from cortex@ed33435 assess_coverage.py.
 *
 * query_workflow_graph removed: not present in any Cortex tool_registry_*.py
 * (zero matches for query_workflow_graph / tool_query_workflow). ISO removal.
 *
 * source: worktrees/port-inventory-cortex/inventory/MCP_TOOLS.md §Tier2Advanced
 * source: packages/memory/src/automation/handlers/ (create_trigger, add_rule, get_rules, sync)
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import { syncInstructionsHandler } from "@agentic/memory/automation/handlers/sync-to-claude-md.js";
import type { MemoryReadStore, MemoryRecord } from "@agentic/memory/automation/handlers/sync-to-claude-md.js";
import { createTriggerHandler } from "@agentic/memory/automation/handlers/create-trigger.js";
import type { ProspectiveMemoryStore } from "@agentic/memory/automation/handlers/create-trigger.js";
import { addRuleHandler } from "@agentic/memory/automation/handlers/add-rule.js";
import type { RuleStore } from "@agentic/memory/automation/handlers/add-rule.js";
import { getRulesHandler } from "@agentic/memory/automation/handlers/get-rules.js";
import type { RuleReadStore } from "@agentic/memory/automation/handlers/get-rules.js";

// ── Named constants ───────────────────────────────────────────────────────────
// source: MCP_TOOLS.md §sync_instructions max_insights default=10, min_heat default=0.3
const SYNC_MAX_INSIGHTS_DEFAULT = 10;
const SYNC_MIN_HEAT_DEFAULT = 0.3;
// source: cortex@ed33435 assess_coverage.py stale_days default=14
const ASSESS_STALE_DAYS_DEFAULT = 14;
// source: cortex@ed33435 assess_coverage.py — ms per day = 24h * 3600s * 1000ms
const MS_PER_DAY = 86400000;
// source: cortex@ed33435 assess_coverage.py:95 — score < 0.5 triggers recommendation
const COVERAGE_LOW_THRESHOLD = 0.5;
// source: cortex@ed33435 assess_coverage.py — heat < 0.1 means stale
const STALE_HEAT_THRESHOLD = 0.1;
// source: cortex@ed33435 assess_coverage.py:95 — coverage score rounded to 2 decimal places
const ROUNDING_FACTOR_2DP = 100;

// ── Dependency bundle ─────────────────────────────────────────────────────────

export interface AdvancedDeps {
  store: MemoryStoreExt;
}

// ── Store adapters ────────────────────────────────────────────────────────────
//
// The automation handlers require specific store interfaces. Methods that are
// on MemoryStoreExt are called directly; SQLite-only methods still use limited
// escape-hatch casts with explicit documentation of the limitation.
//
// source: Martin, R. C. (2017). Clean Architecture, Ch. 22 — composition root
//   adapts concrete implementations to the ports callers declare.

function toMemoryReadStore(store: MemoryStoreExt): MemoryReadStore {
  // source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
  const pg = store as unknown as {
    getMemoriesForDirectoryAsync?(dir: string, minHeat?: number): Promise<Record<string, unknown>[]>;
    getHotMemoriesAsync?(minHeat?: number, limit?: number, includeBenchmarks?: boolean): Promise<Record<string, unknown>[]>;
  };
  return {
    getMemoriesForDirectory: async (dir: string, opts: { min_heat: number }) => {
      const raw = typeof pg.getMemoriesForDirectoryAsync === "function"
        ? await pg.getMemoriesForDirectoryAsync(dir, opts.min_heat)
        : store.getMemoriesForDirectory(dir, opts.min_heat);
      return raw.map((m) => m as unknown as MemoryRecord);
    },
    getHotMemories: async (opts: { min_heat: number; limit: number }) => {
      const raw = typeof pg.getHotMemoriesAsync === "function"
        ? await pg.getHotMemoriesAsync(opts.min_heat, opts.limit)
        : store.getHotMemories(opts.min_heat, opts.limit);
      return raw.map((m) => m as unknown as MemoryRecord);
    },
  };
}

function toProspectiveMemoryStore(store: MemoryStoreExt): ProspectiveMemoryStore {
  // LSP-VIOLATION CLOSED: insertProspectiveMemory and countActiveTriggers are
  // now on MemoryStoreExt; both backends implement them. No escape-hatch needed.
  //
  // PgMemoryStore exposes *Async variants — prefer them when available so the
  // caller does not hit the _runSync() throw path. Fall back to the sync
  // interface for SqliteMemoryStore (which has no *Async).
  //
  // source: Martin (2017) Clean Architecture Ch. 22 — composition root adapts
  //   concrete types to port interfaces declared by the handler layer.
  const pgStore = store as unknown as {
    insertProspectiveMemoryAsync?: (r: Parameters<MemoryStoreExt["insertProspectiveMemory"]>[0]) => Promise<number>;
    countActiveTriggersAsync?: () => Promise<number>;
  };
  return {
    insertProspectiveMemory: async (record) => {
      const id = pgStore.insertProspectiveMemoryAsync != null
        ? await pgStore.insertProspectiveMemoryAsync(record)
        : store.insertProspectiveMemory(record);
      return String(id);
    },
    countActiveTriggers: async () => {
      return pgStore.countActiveTriggersAsync != null
        ? pgStore.countActiveTriggersAsync()
        : Promise.resolve(store.countActiveTriggers());
    },
  };
}

function toRuleStore(store: MemoryStoreExt): RuleStore {
  // LSP-VIOLATION CLOSED: insertRule is now on MemoryStoreExt; both backends
  // implement it. No escape-hatch needed.
  //
  // Prefer *Async variant on PgMemoryStore to avoid the _runSync() throw path.
  const pgStore = store as unknown as {
    insertRuleAsync?: (r: Parameters<MemoryStoreExt["insertRule"]>[0]) => Promise<number>;
  };
  return {
    insertRule: async (rule) => {
      return pgStore.insertRuleAsync != null
        ? pgStore.insertRuleAsync(rule)
        : Promise.resolve(store.insertRule(rule));
    },
  };
}

function toRuleReadStore(store: MemoryStoreExt): RuleReadStore {
  // LSP-VIOLATION CLOSED: getAllActiveRules, getRulesForScope,
  // getAllRulesIncludingInactive are now on MemoryStoreExt; both backends
  // implement them. No escape-hatch needed.
  //
  // Prefer *Async variants on PgMemoryStore to avoid the _runSync() throw path.
  const pgStore = store as unknown as {
    getAllActiveRulesAsync?: () => Promise<Record<string, unknown>[]>;
    getRulesForScopeAsync?: (scope: string) => Promise<Record<string, unknown>[]>;
    getAllRulesIncludingInactiveAsync?: () => Promise<Record<string, unknown>[]>;
  };
  return {
    getAllActiveRules: () => pgStore.getAllActiveRulesAsync != null
      ? pgStore.getAllActiveRulesAsync() as ReturnType<RuleReadStore["getAllActiveRules"]>
      : Promise.resolve(store.getAllActiveRules()) as ReturnType<RuleReadStore["getAllActiveRules"]>,
    getRulesForScope: (scope) => pgStore.getRulesForScopeAsync != null
      ? pgStore.getRulesForScopeAsync(scope) as ReturnType<RuleReadStore["getRulesForScope"]>
      : Promise.resolve(store.getRulesForScope(scope)) as ReturnType<RuleReadStore["getRulesForScope"]>,
    getAllRulesIncludingInactive: () => pgStore.getAllRulesIncludingInactiveAsync != null
      ? pgStore.getAllRulesIncludingInactiveAsync() as ReturnType<RuleReadStore["getAllRulesIncludingInactive"]>
      : Promise.resolve(store.getAllRulesIncludingInactive()) as ReturnType<RuleReadStore["getAllRulesIncludingInactive"]>,
  };
}

// ── assess_coverage scope fetch ────────────────────────────────────────────────

// source: cortex@ed33435 assess_coverage.py — get_memories_for_domain(.., limit=1000)
//   and get_all_memories_for_validation(limit=1000)
const ASSESS_FETCH_LIMIT = 1000; // source: cortex assess_coverage.py — get_memories_for_domain/get_all_memories_for_validation limit=1000
// source: cortex@ed33435 assess_coverage.py:240-242 — min_heat=0.0 for all scopes
const ASSESS_MIN_HEAT = 0.0;

/**
 * Fetch memories scoped by directory → domain → global, dispatching the scope
 * to the store (NOT post-filtering a full fetch). Mirrors Cortex
 * _fetch_memories: directory (when != cwd) → getMemoriesForDirectory,
 * domain → getMemoriesForDomain, else → getAllMemoriesForValidation.
 *
 * *Async variants are preferred when present (PgMemoryStore) to avoid the
 * _runSync() throw; SqliteMemoryStore exposes only the sync method, used as
 * the fallback.
 *
 * source: cortex@ed33435 mcp_server/handlers/assess_coverage.py:232-242
 * source: MemoryStoreExt async declarations — memory-store.ts:740,747
 */
async function fetchScopedMemories(
  store: MemoryStoreExt,
  directory: string,
  domain: string,
): Promise<Array<Record<string, unknown>>> {
  const cwd = process.cwd();
  if (directory && directory !== cwd) {
    return store.getMemoriesForDirectoryAsync != null
      ? store.getMemoriesForDirectoryAsync(directory, ASSESS_MIN_HEAT)
      : store.getMemoriesForDirectory(directory, ASSESS_MIN_HEAT);
  }
  if (domain) {
    return store.getMemoriesForDomainAsync != null
      ? store.getMemoriesForDomainAsync(domain, ASSESS_MIN_HEAT, ASSESS_FETCH_LIMIT)
      : store.getMemoriesForDomain(domain, ASSESS_MIN_HEAT, ASSESS_FETCH_LIMIT);
  }
  return store.getAllMemoriesForValidationAsync != null
    ? store.getAllMemoriesForValidationAsync(ASSESS_FETCH_LIMIT)
    : store.getAllMemoriesForValidation(ASSESS_FETCH_LIMIT);
}

// ── Error envelope helper ─────────────────────────────────────────────────────

function errorText(tool: string, err: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `${tool}: ${message}` }) }] };
}

// ── registerAdvancedTools ─────────────────────────────────────────────────────

/**
 * Registers advanced automation and rule-engine MCP tools.
 *
 * precondition:  deps.store is a live MemoryStore.
 * postcondition: 5 tools registered; each body calls the real domain handler.
 *
 * source: MCP_TOOLS.md §"sync_instructions", §"create_trigger", §"add_rule",
 *         §"get_rules", §"assess_coverage"
 */
export function registerAdvancedTools(server: McpServer, deps: AdvancedDeps): void {
  // ── sync_instructions ─────────────────────────────────────────────────────
  server.registerTool(
    "sync_instructions",
    {
      description: "Push top memory insights into CLAUDE.md (or similar instruction file).",
      inputSchema: {
        directory:    z.string().default("").describe("Directory containing CLAUDE.md"),
        max_insights: z.number().int().min(1).default(SYNC_MAX_INSIGHTS_DEFAULT).describe("Max insights to include"),
        min_heat:     z.number().min(0).max(1).default(SYNC_MIN_HEAT_DEFAULT).describe("Min heat for insight inclusion"),
        dry_run:      z.boolean().default(false).describe("Preview without writing"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/automation/handlers/sync-to-claude-md.ts::syncInstructionsHandler
        const response = await syncInstructionsHandler(
          {
            directory:    args.directory,
            max_insights: args.max_insights,
            min_heat:     args.min_heat,
            dry_run:      args.dry_run,
          },
          toMemoryReadStore(deps.store),
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("sync_instructions", err);
      }
    },
  );

  // ── create_trigger ────────────────────────────────────────────────────────
  server.registerTool(
    "create_trigger",
    {
      description: "Create a prospective memory trigger (stored in prospective_memories table).",
      inputSchema: {
        content:           z.string().min(1).describe("Trigger content"),
        trigger_condition: z.string().min(1).describe("Condition that fires the trigger"),
        trigger_type:      z.string().default("keyword").describe("Trigger type"),
        target_directory:  z.string().optional().describe("Directory scope for trigger"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/automation/handlers/create-trigger.ts::createTriggerHandler
        const response = await createTriggerHandler(args, toProspectiveMemoryStore(deps.store));
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("create_trigger", err);
      }
    },
  );

  // ── add_rule ──────────────────────────────────────────────────────────────
  server.registerTool(
    "add_rule",
    {
      description: "Add a neuro-symbolic rule to the memory store.",
      inputSchema: {
        condition:   z.string().min(1).describe("Rule condition"),
        action:      z.string().min(1).describe("Rule action"),
        rule_type:   z.enum(["soft", "hard"]).default("soft").describe("Rule type"),
        scope:       z.enum(["global", "domain", "directory"]).default("global").describe("Rule scope"),
        scope_value: z.string().optional().describe("Scope value (domain name or directory)"),
        priority:    z.number().int().default(0).describe("Rule priority (higher = earlier)"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/automation/handlers/add-rule.ts::addRuleHandler
        const response = await addRuleHandler(args, toRuleStore(deps.store));
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("add_rule", err);
      }
    },
  );

  // ── get_rules ─────────────────────────────────────────────────────────────
  server.registerTool(
    "get_rules",
    {
      description: "List active neuro-symbolic rules.",
      inputSchema: {
        scope:            z.string().optional().describe("Filter by scope"),
        rule_type:        z.string().optional().describe("Filter by type"),
        include_inactive: z.boolean().default(false).describe("Include inactive rules"),
      },
    },
    async (args) => {
      try {
        // source: packages/memory/src/automation/handlers/get-rules.ts::getRulesHandler
        const response = await getRulesHandler(args, toRuleReadStore(deps.store));
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
      } catch (err) {
        return errorText("get_rules", err);
      }
    },
  );

  // ── assess_coverage ───────────────────────────────────────────────────────
  server.registerTool(
    "assess_coverage",
    {
      description: "Evaluate knowledge coverage completeness for the current domain/directory.",
      inputSchema: {
        directory:  z.string().default("").describe("Directory scope"),
        domain:     z.string().default("").describe("Domain scope"),
        stale_days: z.number().int().min(1).default(ASSESS_STALE_DAYS_DEFAULT).describe("Days before a memory is stale"),
      },
    },
    async (args) => {
      try {
        // Fetch scoped by directory → domain → global, mirroring Cortex
        // _fetch_memories (assess_coverage.py:232-242): the store dispatches
        // scoping, NOT an in-memory post-filter over the full set.
        // *Async variants are preferred (PgMemoryStore) to avoid _runSync()
        // throw; SQLite falls back to its sync method.
        // source: cortex@ed33435 assess_coverage.py:232-242 _fetch_memories
        // source: ADR-0042 — async-when-available pattern for PG/SQLite parity.
        const scoped = await fetchScopedMemories(deps.store, args.directory, args.domain);

        const now = Date.now();
        const staleMs = args.stale_days * MS_PER_DAY;
        const stale = scoped.filter((m) => {
          const heat = (m["heat"] as number | undefined) ?? 0;
          const createdAt = m["created_at"] as string | undefined;
          // source: cortex@ed33435 assess_coverage.py — heat < 0.1 means stale
          if (heat < STALE_HEAT_THRESHOLD) return true;
          if (createdAt && now - new Date(createdAt).getTime() > staleMs) return true;
          return false;
        }).length;

        const total = scoped.length;
        // source: cortex@ed33435 assess_coverage.py:95 — score = (total-stale)/total, rounded to 2dp
        const coverageScore = total === 0 ? 0 : Math.round(((total - stale) / total) * ROUNDING_FACTOR_2DP) / ROUNDING_FACTOR_2DP;

        const gaps: string[] = [];
        if (stale > 0) gaps.push(`${stale} stale memories (heat < 0.1 or older than ${args.stale_days} days)`);
        if (total === 0) gaps.push("no memories found for this scope");

        const recommendations: string[] = [];
        if (coverageScore < COVERAGE_LOW_THRESHOLD) recommendations.push("Run consolidate to decay + refresh stale memories.");
        if (total === 0) recommendations.push("Run codebase_analyze or backfill_memories to seed coverage.");

        return { content: [{ type: "text" as const, text: JSON.stringify({
          coverage_score:  coverageScore,
          total_memories:  total,
          stale_count:     stale,
          gaps,
          recommendations,
          directory:       args.directory,
          domain:          args.domain,
        }) }] };
      } catch (err) {
        return errorText("assess_coverage", err);
      }
    },
  );

}
