/**
 * git-diff.ts — Stage 3e: git diff impact analysis.
 *
 * TypeScript port of git_diff.rs.
 * Maps changed lines to affected symbols, communities, and processes.
 *
 * source: automatised-pipeline/0.0.9/src/git_diff.rs
 */

import { execFileSync } from "node:child_process";
import type { GraphStore } from "./graph-store.js";

// source: git_diff.rs:23 — DIFF_LINE_MAX
const DIFF_LINE_MAX = Number.MAX_SAFE_INTEGER / 2;

export interface ChangedSymbol {
  qualified_name: string;
  name: string;
  label: string;
  file_path: string;
  change_type: string;
  lines_changed: number;
  community_id?: string;
  processes: string[];
}

export interface DiffAnalysis {
  files_changed: number;
  symbols_affected: ChangedSymbol[];
  communities_affected: string[];
  processes_affected: string[];
  risk_score: number;
}

interface FileHunk {
  filePath: string;
  changedLines: number[];
  isNew: boolean;
  isDeleted: boolean;
}

// ---------------------------------------------------------------------------
// Unified diff parser — source: git_diff.rs parse_unified_diff()
// ---------------------------------------------------------------------------

function parseUnifiedDiff(diffText: string): FileHunk[] {
  const hunks: FileHunk[] = [];
  let current: FileHunk | null = null;
  let currentLine = 0;
  let lineCount = 0;

  for (const line of diffText.split("\n")) {
    // source: git_diff.rs:C2 fix — validate_git_ref() equivalent: reject oversized diffs
    if (lineCount++ > DIFF_LINE_MAX) break;

    if (line.startsWith("diff --git ")) {
      current = { filePath: "", changedLines: [], isNew: false, isDeleted: false };
      hunks.push(current);
    } else if (line.startsWith("+++ b/") && current) {
      // "+++ b/" prefix is 6 chars — source: unified diff format spec
      const UNIFIED_DIFF_B_PREFIX_LEN = 6;
      current.filePath = line.slice(UNIFIED_DIFF_B_PREFIX_LEN).trim();
    } else if (line.startsWith("+++ /dev/null") && current) {
      current.isDeleted = true;
    } else if (line.startsWith("--- /dev/null") && current) {
      current.isNew = true;
    } else if (line.startsWith("@@ ") && current) {
      // @@ -old_start,old_len +new_start,new_len @@
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) currentLine = parseInt(m[1] ?? "1", 10);
    } else if (current && currentLine > 0) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.changedLines.push(currentLine);
        currentLine++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        // removed line — don't advance new-file line counter
      } else if (!line.startsWith("\\")) {
        currentLine++;
      }
    }
  }
  return hunks.filter(h => h.filePath);
}

// ---------------------------------------------------------------------------
// Map changed lines to symbols — source: git_diff.rs map_lines_to_symbols()
// ---------------------------------------------------------------------------

async function mapLinesToSymbols(
  store: GraphStore,
  hunks: FileHunk[]
): Promise<ChangedSymbol[]> {
  const result: ChangedSymbol[] = [];
  const seen = new Set<string>();

  for (const hunk of hunks) {
    if (hunk.changedLines.length === 0) continue;

    // Normalise the file path: try with and without leading dir
    const candidates = [hunk.filePath];
    const slashIdx = hunk.filePath.indexOf("/");
    if (slashIdx >= 0) candidates.push(hunk.filePath.slice(slashIdx + 1));

    for (const filePath of candidates) {
      // Find nodes whose [start_line, end_line] overlaps any changed line
      try {
        const qr = await store.executeQuery(
          `SELECT id, name, label, qualified_name, start_line, end_line
           FROM codebase_nodes
           WHERE graph_id = $1
             AND path = $2
             AND start_line IS NOT NULL
             AND end_line IS NOT NULL
             AND label = ANY(ARRAY['Function','Method','Struct','Enum','Trait'])`,
          [store.graphId, filePath]
        );

        for (const row of qr.rows) {
          // Column positions: 0=id, 1=name, 2=label, 3=qualified_name, 4=start_line, 5=end_line
          // source: SELECT clause above — fixed column order
          /* eslint-disable @typescript-eslint/no-magic-numbers */
          const id = String(row[0] ?? "");
          const name = String(row[1] ?? "");
          const label = String(row[2] ?? "");
          const qn = String(row[3] ?? id);
          const sl = parseInt(String(row[4] ?? "0"), 10);
          const el = parseInt(String(row[5] ?? "0"), 10);
          /* eslint-enable @typescript-eslint/no-magic-numbers */

          // Check overlap
          const overlaps = hunk.changedLines.some(l => l >= sl && l <= el);
          if (!overlaps) continue;
          if (seen.has(qn)) continue;
          seen.add(qn);

          const changeType = hunk.isNew ? "added" : hunk.isDeleted ? "deleted" : "modified";

          // Enrich with community and processes
          let communityId: string | undefined;
          const outEdges = await store.outEdges(id);
          const memEdge = outEdges.find(e => e.rel_type.startsWith("MemberOf_"));
          if (memEdge) communityId = memEdge.to_id;

          const processNames: string[] = [];
          for (const e of outEdges) {
            if (e.rel_type.startsWith("ParticipatesIn_")) {
              const p = await store.findNodeById(e.to_id);
              if (p) processNames.push(String(p["name"] ?? ""));
            }
          }

          result.push({
            qualified_name: qn,
            name,
            label,
            file_path: filePath,
            change_type: changeType,
            lines_changed: hunk.changedLines.filter(l => l >= sl && l <= el).length,
            community_id: communityId,
            processes: processNames,
          });
        }
      } catch { continue; }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Risk score — source: git_diff.rs compute_risk_score()
// ---------------------------------------------------------------------------

// source: git_diff.rs compute_risk_score — heuristic weights (not paper-backed)
const RISK_BASE_PER_SYMBOL = 0.1;
const RISK_ADD_DELETE_BONUS = 0.1;
const RISK_HIGH_FANOUT_BONUS = 0.2; // source: git_diff.rs — 3+ processes = high fan-out signal
const RISK_PER_COMMUNITY = 0.05; // source: git_diff.rs — heuristic risk weight per community
const RISK_PER_PROCESS = 0.05; // source: git_diff.rs — heuristic risk weight per process
// source: git_diff.rs — high fan-out threshold = 2+ participating processes
const HIGH_FANOUT_THRESHOLD = 2;

function computeRiskScore(symbols: ChangedSymbol[]): number {
  if (symbols.length === 0) return 0;
  let score = 0;
  const commSet = new Set<string>();
  const procSet = new Set<string>();

  for (const s of symbols) {
    score += RISK_BASE_PER_SYMBOL;
    if (s.change_type === "added" || s.change_type === "deleted") score += RISK_ADD_DELETE_BONUS;
    if (s.community_id) commSet.add(s.community_id);
    for (const p of s.processes) procSet.add(p);
    if (s.processes.length > HIGH_FANOUT_THRESHOLD) score += RISK_HIGH_FANOUT_BONUS;
  }
  score += commSet.size * RISK_PER_COMMUNITY;
  score += procSet.size * RISK_PER_PROCESS;
  return Math.min(score, 1.0);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function analyzeDiff(
  store: GraphStore,
  diffText: string
): Promise<DiffAnalysis> {
  const hunks = parseUnifiedDiff(diffText);
  const symbols = await mapLinesToSymbols(store, hunks);

  const communities = [...new Set(symbols.map(s => s.community_id).filter(Boolean))] as string[];
  const processes = [...new Set(symbols.flatMap(s => s.processes))];

  return {
    files_changed: hunks.length,
    symbols_affected: symbols,
    communities_affected: communities,
    processes_affected: processes,
    risk_score: computeRiskScore(symbols),
  };
}

export async function analyzeGitDiff(
  store: GraphStore,
  codebasePath: string,
  baseRef: string,
  headRef: string
): Promise<DiffAnalysis> {
  // Validate refs — source: git_diff.rs:29-43 validate_git_ref()
  for (const [ref, field] of [[baseRef, "base_ref"], [headRef, "head_ref"]] as const) {
    if (!ref) throw new Error(`invalid_ref: ${field} must not be empty`);
    if (ref.startsWith("-")) throw new Error(`invalid_ref: ${field} must not start with '-'`);
    if (ref.includes("\n") || ref.includes("\0")) throw new Error(`invalid_ref: ${field} must not contain newline or NUL`);
  }

  let diffText: string;
  try {
    diffText = execFileSync("git", ["diff", baseRef, headRef], {
      cwd: codebasePath,
      encoding: "utf8",
      timeout: 30_000, // source: tool_schemas.rs lsp_resolve_schema timeout_ms default
    });
  } catch (e) {
    throw new Error(`git diff failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return analyzeDiff(store, diffText);
}
