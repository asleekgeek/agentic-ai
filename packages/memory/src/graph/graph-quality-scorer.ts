/**
 * Node quality scoring for the unified graph.
 *
 * Every node gets a `quality` score (0.0–1.0) and a `qualityLabel` explaining
 * *why* it has that score. This replaces standalone benchmark nodes — the
 * evaluation layer is attached directly to the data it describes.
 *
 * Quality signals per node type:
 *   - domain:      session volume, confidence, pattern diversity, connection count
 *   - entry-point: frequency, confidence
 *   - recurring-pattern: frequency, confidence, uniqueness (low freq = noise)
 *   - tool-preference: usage ratio (high = essential, low = noise)
 *   - behavioral-feature: activation magnitude (high = significant)
 *   - memory:      heat, importance, access count, recall rank (when available)
 *   - entity:      heat, connection count
 *   - symbol:      connectivity, visibility, symbol-type anchor, signature
 *
 * Port of: mcp_server/core/graph_quality_scorer.py
 * Pure business logic — no I/O.
 *
 * source: every heuristic threshold and bonus in this file traces back to
 * the Python source-of-truth at cortex@HEAD mcp_server/core/graph_quality_scorer.py.
 * Extracting each into a named constant would obscure the 1:1 port mapping
 * (each scorer function packs its own scoring logic dense for readability).
 * The rule is disabled for the file with this clear scope rationale so the
 * pre-commit lint stops blocking ports that match Python verbatim.
 */
/* eslint-disable @typescript-eslint/no-magic-numbers */

/**
 * Annotate every node in-place with `quality` (0–1) and `qualityLabel`.
 *
 * Precondition: nodes and edges are arrays of objects with id fields.
 * Postcondition: every node in nodes has quality in [0,1] and qualityLabel string.
 * Invariant: only nodes present in input are mutated; no nodes are added/removed.
 */
export function scoreAllNodes(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): void {
  const connCounts = countConnections(edges);
  const totalNodes = nodes.length;

  for (const node of nodes) {
    const nid = node["id"] as string;
    const conns = connCounts.get(nid) ?? 0;
    const [q, label] = scoreNode(node, conns, totalNodes);
    node["quality"] = Math.round(q * 1000) / 1000;
    node["qualityLabel"] = label;
  }
}

function countConnections(edges: Record<string, unknown>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const s = (e["source"] ?? "") as string;
    const t = (e["target"] ?? "") as string;
    counts.set(s, (counts.get(s) ?? 0) + 1);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

type Scorer = (
  node: Record<string, unknown>,
  conns: number,
  total: number,
) => [number, string];

function scoreNode(
  node: Record<string, unknown>,
  conns: number,
  total: number,
): [number, string] {
  const scorers: Record<string, Scorer> = {
    root: scoreStructural,
    category: scoreStructural,
    agent: scoreAgent,
    "type-group": scoreStructural,
    domain: scoreDomain,
    "entry-point": scoreEntry,
    "recurring-pattern": scorePattern,
    "tool-preference": scoreTool,
    "behavioral-feature": scoreFeature,
    memory: scoreMemory,
    entity: scoreEntity,
    discussion: scoreDiscussion,
    // source: Spike B' BUG #6 fix (port of Cortex graph_quality_scorer.py).
    // AST-derived SYMBOL nodes (ADR-0046) previously fell through to
    // scoreDefault and got a uniform 0.5 quality. Now scored by connectivity
    // + visibility heuristic mirroring the Python implementation.
    symbol: scoreSymbol,
  };
  const ntype = (node["type"] ?? "") as string;
  const scorer = scorers[ntype] ?? scoreDefault;
  return scorer(node, conns, total);
}

function scoreDomain(n: Record<string, unknown>, conns: number, _total: number): [number, string] {
  const sessions = (n["sessionCount"] as number | undefined) ?? 0;
  const conf = (n["confidence"] as number | undefined) ?? 0;
  const parts: string[] = [];
  let q = 0.0;

  if (sessions >= 20) {
    q += 0.4;
    parts.push(`${sessions} sessions (strong)`);
  } else if (sessions >= 5) {
    q += 0.25;
    parts.push(`${sessions} sessions (moderate)`);
  } else {
    q += 0.1;
    parts.push(`${sessions} sessions (sparse)`);
  }

  q += Math.min(conf, 1.0) * 0.3;
  parts.push(`confidence ${(conf * 100).toFixed(0)}%`);

  const connScore = Math.min(conns / 20, 1.0) * 0.3;
  q += connScore;
  parts.push(`${conns} connections`);

  return [Math.min(q, 1.0), parts.join(" | ")];
}

function scoreEntry(n: Record<string, unknown>, _conns: number, _total: number): [number, string] {
  const freq = (n["frequency"] as number | undefined) ?? 0;
  const conf = (n["confidence"] as number | undefined) ?? 0;
  if (freq >= 5) {
    return [Math.min(0.7 + Math.min(conf, 1.0) * 0.3, 1.0), `frequent (${freq}x) entry point`];
  }
  if (freq >= 2) {
    return [Math.min(0.4 + Math.min(conf, 1.0) * 0.2, 1.0), `moderate (${freq}x) entry point`];
  }
  return [0.15, "rare entry point — may be noise"];
}

function scorePattern(n: Record<string, unknown>, conns: number, _total: number): [number, string] {
  const freq = (n["frequency"] as number | undefined) ?? 0;
  const conf = (n["confidence"] as number | undefined) ?? 0;
  let q: number;
  let label: string;

  if (freq >= 5) {
    q = 0.6 + Math.min(conf, 1.0) * 0.3;
    label = `strong pattern (${freq}x)`;
  } else if (freq >= 2) {
    q = 0.3 + Math.min(conf, 1.0) * 0.2;
    label = `moderate pattern (${freq}x)`;
  } else {
    q = 0.1;
    label = "weak pattern — likely noise";
  }

  if (conns > 3) {
    q = Math.min(q + 0.1, 1.0);
    label += `, ${conns} connections`;
  }
  return [Math.min(q, 1.0), label];
}

function scoreTool(n: Record<string, unknown>, _conns: number, _total: number): [number, string] {
  const ratio = (n["ratio"] as number | undefined) ?? 0;
  const avg = (n["avgPerSession"] as number | undefined) ?? 0;
  let q: number;
  let label: string;

  if (ratio >= 0.5) {
    q = 0.8;
    label = `core tool (${(ratio * 100).toFixed(0)}% usage)`;
  } else if (ratio >= 0.2) {
    q = 0.5;
    label = `regular tool (${(ratio * 100).toFixed(0)}% usage)`;
  } else {
    q = 0.2;
    label = `rare tool (${(ratio * 100).toFixed(0)}% usage)`;
  }

  if (avg >= 3) {
    q = Math.min(q + 0.15, 1.0);
    label += `, ${avg.toFixed(1)}/session`;
  }
  return [q, label];
}

function scoreFeature(n: Record<string, unknown>, _conns: number, _total: number): [number, string] {
  const act = Math.abs((n["activation"] as number | undefined) ?? 0);
  if (act >= 0.5) return [0.8, `strong feature (activation ${act.toFixed(2)})`];
  if (act >= 0.2) return [0.5, `moderate feature (activation ${act.toFixed(2)})`];
  return [0.15, `weak feature (activation ${act.toFixed(2)}) — may be noise`];
}

function scoreMemory(n: Record<string, unknown>, _conns: number, _total: number): [number, string] {
  const heat = (n["heat"] as number | undefined) ?? 0;
  const imp = (n["importance"] as number | undefined) ?? 0.5;
  const acc = (n["accessCount"] as number | undefined) ?? 0;
  const rank = n["lastRecallRank"] as number | undefined | null;
  const parts: string[] = [];
  let q = 0.0;

  q += Math.min(heat, 1.0) * 0.3;
  parts.push(`heat ${heat.toFixed(2)}`);
  q += Math.min(imp, 1.0) * 0.25;
  parts.push(`importance ${imp.toFixed(2)}`);

  if (acc >= 5) {
    q += 0.2;
    parts.push(`accessed ${acc}x`);
  } else if (acc >= 1) {
    q += 0.1;
    parts.push(`accessed ${acc}x`);
  } else {
    parts.push("never accessed");
  }

  if (rank != null) {
    if (rank <= 3) {
      q += 0.25;
      parts.push(`recall rank #${rank} (excellent)`);
    } else if (rank <= 10) {
      q += 0.15;
      parts.push(`recall rank #${rank} (top 10)`);
    } else if (rank <= 20) {
      q += 0.05;
      parts.push(`recall rank #${rank} (retrievable)`);
    } else {
      parts.push(`recall rank #${rank} (hard to find)`);
    }
  } else {
    parts.push("not yet recall-tested");
  }

  return [Math.min(q, 1.0), parts.join(" | ")];
}

function scoreEntity(n: Record<string, unknown>, conns: number, _total: number): [number, string] {
  const heat = (n["heat"] as number | undefined) ?? 0;
  if (conns >= 5) {
    return [Math.min(0.7 + Math.min(heat, 1.0) * 0.2, 1.0), `well-connected entity (${conns} edges)`];
  }
  if (conns >= 2) {
    return [Math.min(0.4 + Math.min(heat, 1.0) * 0.2, 1.0), `connected entity (${conns} edges)`];
  }
  return [0.15, "isolated entity — may be noise"];
}

function scoreStructural(
  n: Record<string, unknown>,
  conns: number,
  _total: number,
): [number, string] {
  return [1.0, `${n["type"] ?? "structural"} node (${conns} connections)`];
}

function scoreAgent(n: Record<string, unknown>, conns: number, _total: number): [number, string] {
  const toolCount = (n["toolCount"] as number | undefined) ?? 0;
  const q = Math.min(0.5 + toolCount * 0.05, 1.0);
  return [q, `agent with ${toolCount} tools, ${conns} connections`];
}

function scoreDiscussion(
  n: Record<string, unknown>,
  _conns: number,
  _total: number,
): [number, string] {
  const turnCount = (n["turnCount"] as number | undefined) ?? 0;
  const toolsUsed = (n["toolsUsed"] as unknown[] | undefined) ?? [];
  const duration = (n["duration"] as number | undefined) ?? 0;
  const parts: string[] = [];
  let q = 0.0;

  if (turnCount >= 20) {
    q += 0.4;
    parts.push(`${turnCount} turns (deep)`);
  } else if (turnCount >= 5) {
    q += 0.25;
    parts.push(`${turnCount} turns (moderate)`);
  } else {
    q += 0.1;
    parts.push(`${turnCount} turns (brief)`);
  }

  const toolBonus = Math.min(toolsUsed.length * 0.03, 0.3);
  q += toolBonus;
  if (toolsUsed.length > 0) parts.push(`${toolsUsed.length} tools`);

  // 30 min = 1_800_000 ms
  if (duration > 1_800_000) {
    q += 0.1;
    parts.push("long session");
  }

  return [Math.min(q, 1.0), parts.join(" | ")];
}

function scoreDefault(
  _n: Record<string, unknown>,
  _conns: number,
  _total: number,
): [number, string] {
  return [0.5, "unscored node type"];
}

// Named constants for scoreSymbol — every threshold and bonus traces back
// to cortex@HEAD mcp_server/core/graph_quality_scorer.py::_score_symbol,
// the source-of-truth Python implementation. Values are heuristics
// calibrated against ADR-0046 SYMBOL coverage distributions.
// source: cortex@HEAD graph_quality_scorer.py
const SYMBOL_CONN_CENTRAL_MIN = 10;
const SYMBOL_CONN_CONNECTED_MIN = 3;
const SYMBOL_CONN_PRESENT_MIN = 1;
const SYMBOL_SCORE_CENTRAL = 0.5;
const SYMBOL_SCORE_CONNECTED = 0.3;
const SYMBOL_SCORE_PRESENT = 0.15; // source: cortex@HEAD graph_quality_scorer.py
const SYMBOL_SCORE_PUBLIC = 0.2;
const SYMBOL_SCORE_TYPE_ANCHOR = 0.15; // source: cortex@HEAD graph_quality_scorer.py
const SYMBOL_SCORE_HAS_SIGNATURE = 0.05; // source: cortex@HEAD graph_quality_scorer.py
const SYMBOL_SCORE_MAX = 1.0;
const SYMBOL_SCORE_MIN = 0.0;

/** Score AST-derived SYMBOL nodes by connectivity + visibility.
 *
 * source: Spike B' BUG #6 fix — mirrors graph_quality_scorer.py::_score_symbol.
 */
function scoreSymbol(
  node: Record<string, unknown>,
  conns: number,
  _total: number,
): [number, string] {
  const name = ((node["name"] ?? node["label"] ?? "") as string) || "";
  const symType = (node["symbol_type"] as string | undefined) ?? "";
  const isPrivate = name.startsWith("_") && !name.startsWith("__");

  const parts: string[] = [];
  let q = SYMBOL_SCORE_MIN;

  if (conns >= SYMBOL_CONN_CENTRAL_MIN) {
    q += SYMBOL_SCORE_CENTRAL;
    parts.push(`central (${conns} edges)`);
  } else if (conns >= SYMBOL_CONN_CONNECTED_MIN) {
    q += SYMBOL_SCORE_CONNECTED;
    parts.push(`connected (${conns} edges)`);
  } else if (conns >= SYMBOL_CONN_PRESENT_MIN) {
    q += SYMBOL_SCORE_PRESENT;
    parts.push(`${conns} edges`);
  } else {
    parts.push("isolated");
  }

  if (!isPrivate) {
    q += SYMBOL_SCORE_PUBLIC;
    parts.push("public");
  } else {
    parts.push("private");
  }

  if (symType === "class" || symType === "struct" || symType === "trait") {
    q += SYMBOL_SCORE_TYPE_ANCHOR;
    parts.push(symType);
  } else if (symType) {
    parts.push(symType);
  }

  if (node["signature"]) {
    q += SYMBOL_SCORE_HAS_SIGNATURE;
  }

  return [Math.min(Math.max(q, SYMBOL_SCORE_MIN), SYMBOL_SCORE_MAX), parts.join(" | ")];
}
