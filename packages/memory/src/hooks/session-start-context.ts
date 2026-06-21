/**
 * session-start-context.ts — context formatting for the SessionStart hook.
 *
 * Separated from the main entry point to keep each file ≤500 LOC.
 *
 * Happens-before invariant (Lamport 1978):
 *   I1: anchors MUST be fetched before hot memories, so anchor IDs can
 *       be excluded from the hot set. (causal dependency, not wall-clock)
 *   I2: checkpoint is fetched independently; it may be null.
 *   I3: team decisions exclude anchor IDs (same deduplication invariant).
 */

import { type CheckpointRow, type MemoryRow } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 120;
// Display N "next steps" from a checkpoint. Sized to match the checkpoint
// summary shown in the Cortex preamble — three steps fits the eye-scan
// budget without overflowing the context block.
// source: cortex main mcp_server/hooks/session_start.py — top-3 next-steps
const NEXT_STEPS_DISPLAY_LIMIT = 3;
// Heat-bar rendering: the bar is built from "+" repeated up to N chars.
// Five chars matches the bar width of the Cortex Python preamble.
// source: cortex main mcp_server/hooks/session_start.py — "+" * min(5, …)
const HEAT_BAR_MAX_LENGTH = 5;
// Multiplier mapping the [0,1] heat value to a 0..5 integer for the bar.
// source: cortex main mcp_server/hooks/session_start.py — int(heat * 5)
const HEAT_BAR_SCALE = 5;

// ── Utilities ─────────────────────────────────────────────────────────────

export function shorten(text: string, maxLen = MAX_CONTENT_LENGTH): string {
  const flat = text.trim().replace(/\n/g, " ");
  return flat.length <= maxLen ? flat : flat.slice(0, maxLen - 1) + "...";
}

// ── Checkpoint section ────────────────────────────────────────────────────

function formatCheckpointSection(checkpoint: CheckpointRow): string[] {
  const lines: string[] = ["### Last Session State"];
  lines.push(`**Task:** ${checkpoint.current_task ?? ""}`);
  if (checkpoint.directory_context) {
    lines.push(`**Directory:** \`${checkpoint.directory_context}\``);
  }
  const nextSteps = Array.isArray(checkpoint.next_steps)
    ? checkpoint.next_steps
    : [];
  if (nextSteps.length > 0) {
    lines.push("**Next steps:**");
    for (const step of nextSteps.slice(0, NEXT_STEPS_DISPLAY_LIMIT)) {
      lines.push(`- ${step}`);
    }
  }
  const activeErrors = Array.isArray(checkpoint.active_errors)
    ? checkpoint.active_errors
    : [];
  if (activeErrors.length > 0) {
    lines.push("**Active errors:**");
    for (const err of activeErrors.slice(0, 2)) {
      lines.push(`- ${err}`);
    }
  }
  const openQuestions = Array.isArray(checkpoint.open_questions)
    ? checkpoint.open_questions
    : [];
  if (openQuestions.length > 0) {
    lines.push("**Open questions:**");
    for (const q of openQuestions.slice(0, 2)) {
      lines.push(`- ${q}`);
    }
  }
  lines.push("");
  return lines;
}

// ── Main context builder ──────────────────────────────────────────────────

export function buildContext(
  anchors: MemoryRow[],
  hot: MemoryRow[],
  checkpoint: CheckpointRow | null,
  teamDecisions: MemoryRow[],
  pendingCurations: number = 0,
  pendingDrift: number = 0,
  pendingCoverage: number = 0,
): string {
  if (
    !anchors.length && !hot.length && !checkpoint &&
    !teamDecisions.length && !pendingCurations &&
    !pendingDrift && !pendingCoverage
  ) {
    return "";
  }

  const lines: string[] = ["## Cortex Memory Context\n"];

  if (checkpoint?.current_task) {
    lines.push(...formatCheckpointSection(checkpoint));
  }

  if (anchors.length > 0) {
    lines.push("### Anchored Memories (critical)");
    for (const a of anchors) {
      lines.push(`- ${shorten(a.content)}`);
    }
    lines.push("");
  }

  // Team decisions from other agents.
  // Implements TMS directory layer (Wegner 1987): team members know WHAT
  // was decided, regardless of WHO decided it.
  if (teamDecisions.length > 0) {
    lines.push("### Team Decisions");
    for (const d of teamDecisions) {
      const agent = d.agent_context ?? "";
      const prefix = agent ? `[${agent}] ` : "";
      lines.push(`- ${prefix}${shorten(d.content)}`);
    }
    lines.push("");
  }

  if (hot.length > 0) {
    lines.push("### Hot Memories");
    for (const m of hot) {
      const heat = m.heat ?? 0;
      const heatBar = "+".repeat(Math.min(HEAT_BAR_MAX_LENGTH, Math.floor(heat * HEAT_BAR_SCALE)));
      const domainHint = m.domain ? ` [${m.domain}]` : "";
      lines.push(`- [${heatBar}]${domainHint} ${shorten(m.content)}`);
    }
    lines.push("");
  }

  // 2026-05-17: surface pending wiki authoring work to the in-session
  // LLM. The auto-curator (wiki/handlers/curate-wiki.ts) detects high-
  // heat topic clusters of PG memories that warrant a curated wiki
  // page; the in-session LLM (Opus 4.7) is the authoring agent.
  // Without this nudge the LLM has no way to know there's
  // documentation work waiting — surfacing it here lets it happen
  // "without a human asking", per the 2026-05-17 user directive.
  // source: cortex main mcp_server/hooks/session_start.py:463-479
  //
  // 2026-05-18 (Phase C): pendingDrift + pendingCoverage land in the
  // same section. The LLM gets one consolidated maintenance prompt
  // instead of three separate ones.
  // source: packages/memory/src/wiki/maintenance-stats.ts
  if (pendingCurations > 0 || pendingDrift > 0 || pendingCoverage > 0) {
    lines.push("### Pending Wiki Maintenance");
    const lineParts: string[] = [];
    if (pendingCurations > 0) {
      lineParts.push(
        `**${pendingCurations}** topic cluster${pendingCurations === 1 ? "" : "s"} ` +
        "warrant a new curated page",
      );
    }
    if (pendingDrift > 0) {
      lineParts.push(
        `**${pendingDrift}** page${pendingDrift === 1 ? "" : "s"} cite ` +
        "source files newer than the page (drift)",
      );
    }
    if (pendingCoverage > 0) {
      lineParts.push(
        `**${pendingCoverage}** source file${pendingCoverage === 1 ? "" : "s"} ` +
        "have no wiki page yet (coverage gap)",
      );
    }
    lines.push("Auto-curator detected: " + lineParts.join("; ") + ".");
    lines.push(
      "Call `curate_wiki` with " +
      [
        "{}",
        pendingDrift > 0 ? "include_drift: true" : null,
        pendingCoverage > 0 ? "include_file_coverage: true, project_root: <abs path>, domain: <name>" : null,
      ].filter(Boolean).join(", ").replace("{}, ", "") +
      " to fetch authoring jobs. Each job carries a structured prompt; " +
      "write via `wiki_write`. No human needs to ask — the queue works itself.",
    );
    lines.push("");
  }

  lines.push(
    "*Use `recall` to retrieve full memories. " +
      "Use `anchor` to protect critical facts.*",
  );

  return lines.join("\n");
}

// ── Cold start messages ───────────────────────────────────────────────────

export interface SetupResult {
  status: "ready" | "needs_install" | string;
  memories?: number;
  session_files?: number;
  message?: string;
}

export function buildColdStartMessage(
  setupResult: SetupResult | null,
  autoImportedCount?: number,
): string {
  const lines: string[] = ["## Cortex — First Run\n"];

  if (setupResult?.status === "needs_install") {
    lines.push(
      "Cortex needs PostgreSQL to store memories. Here's how to set it up:\n",
    );
    lines.push("```bash");
    lines.push("# macOS");
    lines.push("brew install postgresql@17 pgvector");
    lines.push("brew services start postgresql@17");
    lines.push("");
    lines.push("# Then restart Claude Code");
    lines.push("```\n");
    lines.push("Cortex will auto-create the database and schema on next start.");
    return lines.join("\n");
  }

  if (setupResult && setupResult.status !== "ready") {
    const msg = setupResult.message ?? "Unknown setup error";
    lines.push(`Setup issue: ${msg}\n`);
    lines.push(
      "Check the [Cortex README](https://github.com/cdeust/Cortex) " +
        "for installation help.",
    );
    return lines.join("\n");
  }

  const memories = setupResult?.memories ?? 0;
  const sessionFiles = setupResult?.session_files ?? 0;

  if (memories === 0 && sessionFiles > 0) {
    if (autoImportedCount != null && autoImportedCount > 0) {
      lines.push(
        `Cortex auto-imported **${autoImportedCount} memories** from your conversation history.\n`,
      );
      lines.push(
        "Memories will consolidate naturally as you use them " +
          "(recall = replay = consolidation).",
      );
    } else {
      lines.push(
        "Cortex is set up and ready. Auto-import found no memorable items.\n",
      );
      lines.push(
        "Start working normally — Cortex will automatically remember " +
          "important decisions, fixes, and patterns as you go.",
      );
    }
    return lines.join("\n");
  }

  if (memories === 0) {
    lines.push("Cortex is set up and ready. No previous sessions found.\n");
    lines.push(
      "Start working normally — Cortex will automatically remember " +
        "important decisions, fixes, and patterns as you go.",
    );
    return lines.join("\n");
  }

  return "";
}

// ── External source detection ─────────────────────────────────────────────

export interface ExternalSource {
  name: string;
  count: number;
  path: string;
}

export function formatExternalSources(sources: ExternalSource[]): string {
  if (!sources.length) return "";
  const lines: string[] = ["\n### External Memory Sources Detected\n"];
  for (const s of sources) {
    const countStr = s.count > 0 ? ` (${s.count} items)` : "";
    lines.push(`- **${s.name}**${countStr} — \`${s.path}\``);
  }
  lines.push("\nUse `/cortex-import` to import these into Cortex.");
  return lines.join("\n");
}
