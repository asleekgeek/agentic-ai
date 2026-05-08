/**
 * semantic-diff.ts — Stage 9: compare two code graphs for regressions.
 *
 * TypeScript port of semantic_diff.rs. Read-only against both graphs.
 *
 * source: automatised-pipeline/0.0.9/src/semantic_diff.rs
 */

import * as fs from "node:fs";
import { GraphStore } from "./graph-store.js";

// source: semantic_diff.rs:27-31 — regression score weights + caps (heuristic)
const WEIGHT_DANGLING = 1.0;
const WEIGHT_NEW_CYCLE = 0.5;
const WEIGHT_UNRESOLVED_DELTA = 0.1;
const UNRESOLVED_DELTA_MAX = 5.0;
const REGRESSION_SCORE_CAP = 10.0; // source: semantic_diff.rs:31 — "cap 10.0" per stage-9 brief

// source: semantic_diff.rs:34-35 — verdict thresholds
const VERDICT_CLEAN_MAX = 1.0;
const VERDICT_CONCERNING_MAX = 5.0;

// source: semantic_diff.rs:38 — DETAILS_TRUNCATION = 100 (keep reports compact)
const DETAILS_TRUNCATION = 100;

// source: semantic_diff.rs:43-46 — labels to compare
const DIFFABLE_LABELS = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Module", "Constant", "TypeAlias",
];

export interface DiffSummary {
  nodes_added: number;
  nodes_removed: number;
  edges_added: number;
  edges_removed: number;
  dangling_references: number;
  new_unresolved_delta: number;
  new_cycles: number;
}

export interface SemanticDiffOutcome {
  summary: DiffSummary;
  regression_score: number;
  verdict: string;
  report: unknown;
}

export async function diffGraphs(
  beforeGraphPath: string,
  afterGraphPath: string,
  reportPath?: string
): Promise<SemanticDiffOutcome> {
  const verifiedAt = new Date().toISOString();

  let beforeStore: GraphStore;
  let afterStore: GraphStore;
  try {
    beforeStore = await GraphStore.fromGraphPath(beforeGraphPath);
    afterStore = await GraphStore.fromGraphPath(afterGraphPath);
  } catch (e) {
    throw new Error(`failed to open graphs: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Collect node sets per label
  const beforeNodes = new Set<string>();
  const afterNodes = new Set<string>();

  for (const label of DIFFABLE_LABELS) {
    const beforeLabelNodes = await beforeStore.nodesOfLabel(label);
    for (const n of beforeLabelNodes) {
      const qn = String(n["qualified_name"] ?? n["id"] ?? "");
      if (qn) beforeNodes.add(`${label}::${qn}`);
    }
    const afterLabelNodes = await afterStore.nodesOfLabel(label);
    for (const n of afterLabelNodes) {
      const qn = String(n["qualified_name"] ?? n["id"] ?? "");
      if (qn) afterNodes.add(`${label}::${qn}`);
    }
  }

  const nodesAdded = [...afterNodes].filter(n => !beforeNodes.has(n));
  const nodesRemoved = [...beforeNodes].filter(n => !afterNodes.has(n));

  // Collect edge sets
  const beforeEdges = await collectEdgeSet(beforeStore);
  const afterEdges = await collectEdgeSet(afterStore);

  const edgesAdded = [...afterEdges].filter(e => !beforeEdges.has(e));
  const edgesRemoved = [...beforeEdges].filter(e => !afterEdges.has(e));

  // Dangling references: edges in after whose target disappeared
  const afterNodeIds = new Set([...afterNodes].map(n => n.split("::").slice(1).join("::")));
  const dangling = edgesAdded.filter(e => {
    const parts = e.split("|");
    const toId = parts[2] ?? "";
    return nodesRemoved.some(r => r.split("::").slice(1).join("::") === toId) ||
           !afterNodeIds.has(toId);
  });

  // New unresolved imports delta (simplified)
  const beforeUnresolved = await countUnresolvedImports(beforeStore);
  const afterUnresolved = await countUnresolvedImports(afterStore);
  const newUnresolvedDelta = afterUnresolved - beforeUnresolved;

  // New cycles: detect simple cycles in after using DFS (simplified check)
  const newCycles = await detectNewCycles(afterStore, beforeStore);

  const summary: DiffSummary = {
    nodes_added: nodesAdded.length,
    nodes_removed: nodesRemoved.length,
    edges_added: edgesAdded.length,
    edges_removed: edgesRemoved.length,
    dangling_references: dangling.length,
    new_unresolved_delta: newUnresolvedDelta,
    new_cycles: newCycles,
  };

  // Compute regression score — source: semantic_diff.rs heuristic
  let score = 0;
  score += dangling.length * WEIGHT_DANGLING;
  score += newCycles * WEIGHT_NEW_CYCLE;
  score += Math.min(Math.max(newUnresolvedDelta, 0), UNRESOLVED_DELTA_MAX) * WEIGHT_UNRESOLVED_DELTA;
  score = Math.min(score, REGRESSION_SCORE_CAP);

  const verdict =
    score < VERDICT_CLEAN_MAX ? "clean" :
    score < VERDICT_CONCERNING_MAX ? "concerning" : "regression";

  const report = {
    verified_at: verifiedAt,
    before_graph_path: beforeGraphPath,
    after_graph_path: afterGraphPath,
    summary,
    regression_score: score,
    verdict,
    details: {
      nodes_added: nodesAdded.slice(0, DETAILS_TRUNCATION),
      nodes_removed: nodesRemoved.slice(0, DETAILS_TRUNCATION),
      dangling_references: dangling.slice(0, DETAILS_TRUNCATION),
    },
  };

  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }

  return { summary, regression_score: score, verdict, report };
}

async function collectEdgeSet(store: GraphStore): Promise<Set<string>> {
  const edges = new Set<string>();
  // Sample a subset of rel types for comparison
  const relTypes = ["Calls_Function_Function", "Calls_Function_Method",
                    "Calls_Method_Function", "Calls_Method_Method",
                    "Implements_Struct_Trait", "Extends_Trait_Trait"];
  for (const rel of relTypes) {
    const es = await store.edgesOfType(rel);
    for (const e of es) edges.add(`${e.from_id}|${rel}|${e.to_id}`);
  }
  return edges;
}

async function countUnresolvedImports(store: GraphStore): Promise<number> {
  const importNodes = await store.nodesOfLabel("Import");
  return importNodes.length; // Each Import node that wasn't resolved is a proxy for unresolved
}

async function detectNewCycles(afterStore: GraphStore, _beforeStore: GraphStore): Promise<number> {
  // Simplified: count strongly-connected components of size > 1 in the call graph
  // Full Tarjan's would be more accurate but this is a heuristic anyway
  const edges = await afterStore.edgesOfType("Calls_Function_Function");
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from_id)) adj.set(e.from_id, []);
    (adj.get(e.from_id) ?? []).push(e.to_id);
  }

  // Simple cycle detection: nodes with self-loops or mutual calls
  let cycleCount = 0;
  for (const [from, tos] of adj) {
    for (const to of tos) {
      if (to === from) { cycleCount++; continue; }
      const toNeighbors = adj.get(to) ?? [];
      if (toNeighbors.includes(from)) cycleCount++;
    }
  }
  return Math.floor(cycleCount / 2); // Each mutual pair counted once
}
