/**
 * methodology-memory-injection.ts — hot-memory + prospective-trigger enrichment
 * for the query_methodology tool.
 *
 * Cortex enriches the query_methodology response with the hottest memories for
 * the current domain/directory and any prospective triggers that fire against
 * the first message, then folds their summaries into the context string. This
 * assembly lives in the infrastructure (tool) layer because the inner
 * methodology handler is infrastructure-agnostic by design (it leaves
 * hotMemories/firedTriggers empty for this layer to populate).
 *
 * source: cortex@HEAD mcp_server/handlers/query_methodology.py:114-233,317-331
 */

import type { HotMemory, FiredTrigger } from "@agentic/memory/methodology/types.js";
import type { MemoryStoreExt } from "@agentic/memory/remember/storage/memory-store.js";
import { checkTrigger } from "@agentic/memory/automation/index.js";
import type { Trigger, TriggerContext } from "@agentic/memory/automation/index.js";
import { parseTags } from "@agentic/memory/recall/recall-helpers.js";

// source: cortex@HEAD query_methodology.py:118 — heat floor for hot-memory pull
const HOT_HEAT_MIN = 0.1;
// source: cortex@HEAD query_methodology.py:122 — heat floor for the no-context branch
const HOT_HEAT_MIN_FALLBACK = 0.3;
// source: cortex@HEAD query_methodology.py:115 — default hot-memory cap
const HOT_LIMIT_DEFAULT = 10;
// source: cortex@HEAD query_methodology.py:129 — heat rounded to 4 decimals
const HEAT_ROUND = 10000;
// source: cortex@HEAD query_methodology.py:132 — importance default when absent
const IMPORTANCE_DEFAULT = 0.5;
// source: cortex@HEAD query_methodology.py:217,229 — content display cap in context bullets
const CONTEXT_CONTENT_CAP = 120;
// source: cortex@HEAD query_methodology.py:215 — only the top hot memories shown in context
const CONTEXT_HOT_PREVIEW = 5;
// source: cortex@HEAD query_methodology.py:216 — heat-bar scale (int(heat*10))
const HEAT_BAR_SCALE = 10;
// source: cortex@HEAD query_methodology.py:38-44 — top-3 categories shown per domain
const TOP_CATEGORIES = 3;

/**
 * Optional store capability: bump triggered_count + triggered_at for a fired
 * prospective trigger. Cortex calls store.trigger_prospective_memory(id) inside
 * _get_fired_triggers (query_methodology.py:166). The method is duck-typed here
 * (the same optional-method pattern Foundation used for getUserMood/setUserMood)
 * so the methodology tool layer does not couple to the concrete store class.
 *
 * source: cortex@HEAD mcp_server/handlers/query_methodology.py:166
 * source: cortex@ed33435 mcp_server/infrastructure/sqlite_store_auxiliary.py:44-50
 */
interface ProspectiveTriggerBump {
  triggerProspectiveMemory?(pmId: number): void;
}

/** Exposed so list_domains can reuse the documented top-categories cap. */
export const LIST_DOMAINS_TOP_CATEGORIES = TOP_CATEGORIES;

/**
 * Retrieve the hottest memories for this domain/directory context.
 *
 * source: cortex@HEAD mcp_server/handlers/query_methodology.py:114-146
 *   (_get_hot_memories: domain -> get_memories_for_domain(min_heat=0.1,limit);
 *    directory -> get_memories_for_directory(min_heat=0.1)[:limit];
 *    else -> get_hot_memories(min_heat=0.3,limit))
 */
export function getHotMemories(
  store: MemoryStoreExt,
  domain: string,
  directory: string,
  limit: number = HOT_LIMIT_DEFAULT,
): HotMemory[] {
  try {
    let rows: Record<string, unknown>[];
    if (domain) {
      rows = store.getMemoriesForDomain(domain, HOT_HEAT_MIN, limit);
    } else if (directory) {
      rows = store.getMemoriesForDirectory(directory, HOT_HEAT_MIN).slice(0, limit);
    } else {
      rows = store.getHotMemories(HOT_HEAT_MIN_FALLBACK, limit);
    }
    return rows.map((m) => ({
      content:    String(m["content"] ?? ""),
      heat:       Math.round((Number(m["heat"]) || 0) * HEAT_ROUND) / HEAT_ROUND,
      domain:     String(m["domain"] ?? ""),
      tags:       parseTags(m["tags"]),
      importance: Number(m["importance"] ?? IMPORTANCE_DEFAULT),
      createdAt:  String(m["created_at"] ?? ""),
    }));
  } catch {
    // source: cortex@HEAD query_methodology.py:144-146 — log + return [] on error
    return [];
  }
}

/**
 * Check all active prospective triggers against the current context. Every
 * matching trigger has its triggered_count bumped (when the store supports the
 * bump); only one copy of each distinct content is returned (dedupe by content).
 *
 * source: cortex@HEAD mcp_server/handlers/query_methodology.py:149-184
 *   (_get_fired_triggers: get_active_prospective_memories; check_trigger;
 *    trigger_prospective_memory(id) FIRST, then dedupe by content)
 */
export function getFiredTriggers(
  store: MemoryStoreExt,
  directory: string,
  content: string,
): FiredTrigger[] {
  try {
    const active = store.getActiveProspectiveMemories();
    const bump = store as unknown as ProspectiveTriggerBump;
    const fired: FiredTrigger[] = [];
    const seenContents = new Set<string>();
    for (const raw of active) {
      const trigger = raw as unknown as Trigger;
      const ctx: TriggerContext = { directory, content, entities: [] };
      if (!checkTrigger(trigger, ctx)) continue;
      // Bump count for EVERY fire (Cortex 166), even duplicates.
      if (typeof bump.triggerProspectiveMemory === "function") {
        bump.triggerProspectiveMemory(Number(raw["id"]));
      }
      const triggerContent = String(raw["content"] ?? "");
      // Dedupe by content AFTER bumping (Cortex 167-171).
      if (seenContents.has(triggerContent)) continue;
      seenContents.add(triggerContent);
      fired.push({
        content:          triggerContent,
        triggerType:      String(raw["trigger_type"] ?? ""),
        triggerCondition: String(raw["trigger_condition"] ?? ""),
        triggeredCount:   Number(raw["triggered_count"] ?? 0) + 1,
      });
    }
    return fired;
  } catch {
    // source: cortex@HEAD query_methodology.py:182-184 — log + return [] on error
    return [];
  }
}

/**
 * Append memory + trigger summary bullets to the context string.
 *
 * source: cortex@HEAD mcp_server/handlers/query_methodology.py:209-233
 *   (## Active Memories header + heat-bar █*int(heat*10) + content[:120];
 *    ## Triggered Reminders header + ⚡ content[:120]; join with newline)
 */
export function enrichContextWithMemories(
  context: string,
  hot: HotMemory[],
  fired: FiredTrigger[],
): string {
  if (hot.length === 0 && fired.length === 0) return context;
  const lines: string[] = [];
  if (hot.length > 0) {
    lines.push(`\n\n## Active Memories (${hot.length} hot)`);
    for (const m of hot.slice(0, CONTEXT_HOT_PREVIEW)) {
      const heatBar = "█".repeat(Math.max(1, Math.trunc(m.heat * HEAT_BAR_SCALE)));
      lines.push(`  [${heatBar}] ${m.content.slice(0, CONTEXT_CONTENT_CAP)}`);
    }
  }
  if (fired.length > 0) {
    lines.push(`\n## Triggered Reminders (${fired.length})`);
    for (const t of fired) {
      lines.push(`  ⚡ ${t.content.slice(0, CONTEXT_CONTENT_CAP)}`);
    }
  }
  return context + lines.join("\n");
}
