/**
 * clustering.ts — Stage 3c: Louvain community detection + BFS process tracing.
 *
 * TypeScript port of clustering.rs.
 *
 * Louvain algorithm:
 *   source: Blondel et al. (2008) "Fast unfolding of communities in large networks"
 *   J. Stat. Mech. P10008. DOI: 10.1088/1742-5468/2008/10/P10008
 *
 * C2 repair (split disconnected communities):
 *   source: Traag et al. (2019) "From Louvain to Leiden: guaranteeing well-connected communities"
 *   Scientific Reports 9(1), 5233. Section 3.2.
 *
 * BFS process tracing:
 *   source: stages/stage-3c.md §3.2
 *
 * source: automatised-pipeline/0.0.9/src/clustering.rs
 */

// The Louvain algorithm uses in-bounds array access on indices derived from
// adjacency construction. Non-null assertions here are correct by invariant.
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import type { GraphStore } from "./graph-store.js";

// ---------------------------------------------------------------------------
// Algorithm constants — source: clustering.rs
// ---------------------------------------------------------------------------

// source: Blondel 2008 Table 1 — convergence observed <50 iterations; 100 provides headroom.
const MAX_PASSES_LOUVAIN_CONST = 100; // source: Blondel 2008

// ---------------------------------------------------------------------------
// Public types — source: clustering.rs:20-33
// ---------------------------------------------------------------------------

export interface ClusteringResult {
  communities: number;
  modularity: number;
  processes: number;
  elapsedMs: number;
}

export interface ProcessInfo {
  name: string;
  entryPoint: string;
  entryKind: string;
  depth: number;
  nodeCount: number;
}

export interface ImpactResult {
  communities: string[];
  processes: string[];
}

// ---------------------------------------------------------------------------
// Edge weight table — source: clustering.rs:135-149
// ---------------------------------------------------------------------------

// source: clustering.rs:136-149 — edge_weight() semantic weights
// Calls are the strongest coupling signal; HasMethod/HasField represent structural containment.
const W_CALLS = 3.0; // source: clustering.rs:137 — Calls_ weight
const W_IMPLEMENTS = 2.0; // source: clustering.rs:138 — Implements_/Extends_ weight
const W_IMPORTS = 1.0; // source: clustering.rs:139 — Imports_/Uses_ weight
const W_STRUCT = 5.0; // source: clustering.rs:140 — HasMethod_/HasField_/HasVariant_ weight

function edgeWeight(relName: string): number {
  if (relName.startsWith("Calls_")) return W_CALLS;
  if (relName.startsWith("Implements_") || relName.startsWith("Extends_")) return W_IMPLEMENTS;
  if (relName.startsWith("Imports_") || relName.startsWith("Uses_")) return W_IMPORTS;
  if (relName.startsWith("HasMethod_") || relName.startsWith("HasField_") ||
      relName.startsWith("HasVariant_")) return W_STRUCT;
  return 0.0;
}

// Relationship tables used for clustering — source: clustering.rs:230-256
const EDGE_REL_TABLES = [
  ["Calls_Function_Function", "Function", "Function"],
  ["Calls_Function_Method", "Function", "Method"],
  ["Calls_Method_Function", "Method", "Function"],
  ["Calls_Method_Method", "Method", "Method"],
  ["Imports_File_Function", "File", "Function"],
  ["Imports_File_Struct", "File", "Struct"],
  ["Imports_File_Enum", "File", "Enum"],
  ["Imports_File_Trait", "File", "Trait"],
  ["Implements_Struct_Trait", "Struct", "Trait"],
  ["Implements_Enum_Trait", "Enum", "Trait"],
  ["Extends_Trait_Trait", "Trait", "Trait"],
  ["Uses_Function_Struct", "Function", "Struct"],
  ["Uses_Function_Enum", "Function", "Enum"],
  ["Uses_Function_Trait", "Function", "Trait"],
  ["Uses_Method_Struct", "Method", "Struct"],
  ["Uses_Method_Enum", "Method", "Enum"],
  ["Uses_Method_Trait", "Method", "Trait"],
  ["HasMethod_Struct_Method", "Struct", "Method"],
  ["HasMethod_Enum_Method", "Enum", "Method"],
  ["HasMethod_Trait_Method", "Trait", "Method"],
  ["HasField_Struct_Field", "Struct", "Field"],
  ["HasField_Enum_Field", "Enum", "Field"],
  ["HasVariant_Enum_Variant", "Enum", "Variant"],
] as const;

// Symbol labels included in clustering — source: clustering.rs:156-159
const SYMBOL_LABELS = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Constant", "TypeAlias", "Module",
] as const;

// ---------------------------------------------------------------------------
// Adjacency extraction — source: clustering.rs:174-228
// ---------------------------------------------------------------------------

interface Adjacency {
  nodeIds: string[];
  nodeLabels: string[];
  idToIdx: Map<string, number>;
  neighbors: Array<Array<[number, number]>>; // [idx, weight]
  totalWeight: number;
}

async function extractAdjacency(store: GraphStore): Promise<Adjacency> {
  const nodeIds: string[] = [];
  const nodeLabels: string[] = [];
  const idToIdx = new Map<string, number>();

  // Collect all symbol nodes — source: clustering.rs:181-203
  for (const label of SYMBOL_LABELS) {
    const nodes = await store.nodesOfLabel(label);
    for (const node of nodes) {
      const id = String(node["id"] ?? "");
      if (!id || idToIdx.has(id)) continue;
      idToIdx.set(id, nodeIds.length);
      nodeIds.push(id);
      nodeLabels.push(label);
    }
  }

  const n = nodeIds.length;
  const neighbors: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  let totalWeight = 0;

  // Collect weighted edges — source: clustering.rs:206-228
  for (const [relType] of EDGE_REL_TABLES) {
    const w = edgeWeight(relType);
    if (w === 0) continue;
    const edges = await store.edgesOfType(relType);
    for (const edge of edges) {
      const a = idToIdx.get(edge.from_id);
      const b = idToIdx.get(edge.to_id);
      if (a === undefined || b === undefined) continue;
      neighbors[a]!.push([b, w]);
      neighbors[b]!.push([a, w]);
      totalWeight += w;
    }
  }

  return { nodeIds, nodeLabels, idToIdx, neighbors, totalWeight };
}

// ---------------------------------------------------------------------------
// Louvain algorithm — source: clustering.rs:263-323
// source: Blondel et al. 2008, eq. from section III
// ---------------------------------------------------------------------------

function louvain(adj: Adjacency, gamma: number): [number[], number] {
  const n = adj.nodeIds.length;
  if (n === 0) return [[], 0.0];
  const m = adj.totalWeight;
  if (m === 0) return [Array.from({ length: n }, (_, i) => i), 0.0];
  const twoM = 2.0 * m;

  // k[i] = sum of neighbor weights (degree) — source: clustering.rs:275-277
  const k: number[] = adj.neighbors.map(nbrs =>
    nbrs.reduce((acc, [, w]) => acc + w, 0)
  );

  // Initial assignment: each node in its own community
  const comm: number[] = Array.from({ length: n }, (_, i) => i);
  const sigmaTot: number[] = [...k];

  // source: clustering.rs:283-318 — greedy modularity maximization
  for (let pass = 0; pass < MAX_PASSES_LOUVAIN_CONST; pass++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      const oldC = comm[i]!;
      const ki = k[i]!;

      // Weights from i to each neighboring community
      const kiIn = new Map<number, number>();
      for (const [nbr, w] of adj.neighbors[i]!) {
        const c = comm[nbr]!;
        kiIn.set(c, (kiIn.get(c) ?? 0) + w);
      }

      // Remove i from its community
      sigmaTot[oldC]! -= ki;

      // Compute gain for each neighboring community
      // source: Blondel 2008 eq. section III: gain = ki_in_c - gamma * sigma_tot_c * ki / (2m)
      const kiInOld = kiIn.get(oldC) ?? 0;
      let bestC = oldC;
      let bestGain = kiInOld - gamma * sigmaTot[oldC]! * ki / twoM;

      for (const [c, kiInC] of kiIn) {
        const gain = kiInC - gamma * sigmaTot[c]! * ki / twoM;
        if (gain > bestGain) {
          bestGain = gain;
          bestC = c;
        }
      }

      comm[i] = bestC;
      sigmaTot[bestC]! += ki;
      if (bestC !== oldC) improved = true;
    }
    if (!improved) break;
  }

  const renumbered = renumberCommunities(comm);
  const q = computeModularity(adj.neighbors, renumbered, k, m);
  return [renumbered, q];
}

function renumberCommunities(comm: number[]): number[] {
  // source: clustering.rs:325-338
  const map = new Map<number, number>();
  let next = 0;
  return comm.map(c => {
    if (!map.has(c)) map.set(c, next++);
    return map.get(c)!;
  });
}

/**
 * Newman 2004: Q = (1/2m) * sum_ij [A_ij - ki*kj/(2m)] * delta(ci,cj)
 * source: clustering.rs:341-361
 */
function computeModularity(
  neighbors: Array<Array<[number, number]>>,
  comm: number[],
  k: number[],
  m: number
): number {
  if (m === 0) return 0;
  const twoM = 2.0 * m;
  let q = 0;
  for (let i = 0; i < neighbors.length; i++) {
    for (const [j, w] of neighbors[i]!) {
      if (comm[i] === comm[j]) {
        q += w - k[i]! * k[j]! / twoM;
      }
    }
  }
  return q / twoM;
}

// ---------------------------------------------------------------------------
// C2 repair — source: clustering.rs:367-420
// source: Traag et al. 2019 Scientific Reports 9(1), 5233, section 3.2
// ---------------------------------------------------------------------------

function repairC2(adj: Adjacency, comm: number[]): void {
  void comm.length; // n not used — size comes from comm.map
  const numComms = Math.max(...comm) + 1;
  let nextComm = numComms;

  for (let c = 0; c < numComms; c++) {
    const members = comm.map((v, i) => v === c ? i : -1).filter(i => i >= 0);
    if (members.length <= 1) continue;

    const components = connectedComponentsWithin(members, adj.neighbors, comm, c);
    if (components.length <= 1) continue;

    for (let ci = 1; ci < components.length; ci++) {
      for (const node of components[ci]!) {
        comm[node] = nextComm;
      }
      nextComm++;
    }
  }

  const renumbered = renumberCommunities(comm);
  comm.splice(0, comm.length, ...renumbered);
}

function connectedComponentsWithin(
  members: number[],
  neighbors: Array<Array<[number, number]>>,
  comm: number[],
  community: number
): number[][] {
  const memberSet = new Set(members);
  const visited = new Set<number>();
  const components: number[][] = [];

  for (const start of members) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const queue: number[] = [start];
    visited.add(start);
    while (queue.length > 0) {
      const node = queue.shift()!;
      component.push(node);
      for (const [nbr] of neighbors[node]!) {
        if (memberSet.has(nbr) && comm[nbr] === community && !visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    components.push(component);
  }
  return components;
}

// ---------------------------------------------------------------------------
// Persist communities — source: clustering.rs:426-473
// ---------------------------------------------------------------------------

async function persistCommunities(
  store: GraphStore,
  adj: Adjacency,
  comm: number[],
  modularity: number,
  gamma: number
): Promise<number> {
  const numComms = comm.length > 0 ? Math.max(...comm) + 1 : 0;
  if (numComms === 0) return 0;

  const counts = new Map<number, number>();
  for (const c of comm) counts.set(c, (counts.get(c) ?? 0) + 1);

  // Insert Community nodes — source: clustering.rs:443-457
  const communityRows: Array<Record<string, unknown>> = [];
  for (let c = 0; c < numComms; c++) {
    const cid = `community::louvain::${gamma}::${c}`;
    communityRows.push({
      id: cid,
      name: `community_${c}`,
      algorithm: "louvain+c2",
      resolution_param: gamma,
      member_count: counts.get(c) ?? 0,
      modularity_contribution: modularity,
    });
  }
  await store.bulkInsertNodes("Community", communityRows);

  // Create MemberOf edges — source: clustering.rs:461-472
  const byRel = new Map<string, Array<{ from: string; to: string }>>();
  for (let idx = 0; idx < comm.length; idx++) {
    const c = comm[idx]!;
    const nodeId = adj.nodeIds[idx]!;
    const label = adj.nodeLabels[idx]!;
    const cid = `community::louvain::${gamma}::${c}`;
    const rel = `MemberOf_${label}_Community`;
    if (!byRel.has(rel)) byRel.set(rel, []);
    byRel.get(rel)!.push({ from: nodeId, to: cid });
  }
  for (const [rel, edges] of byRel) {
    const knownMemberOfRels = [
      "MemberOf_Function_Community", "MemberOf_Method_Community",
      "MemberOf_Struct_Community", "MemberOf_Enum_Community",
      "MemberOf_Trait_Community", "MemberOf_Constant_Community",
      "MemberOf_TypeAlias_Community", "MemberOf_Module_Community",
    ];
    if (!knownMemberOfRels.includes(rel)) continue;
    await store.bulkInsertEdges(rel, edges);
  }

  return numComms;
}

// ---------------------------------------------------------------------------
// Entry point detection — source: clustering.rs:515-566
// ---------------------------------------------------------------------------

interface EntryPoint {
  id: string;
  label: string;
  name: string;
  qualifiedName: string;
  kind: string;
  confidence: number;
}

async function detectEntryPoints(store: GraphStore): Promise<EntryPoint[]> {
  const entries: EntryPoint[] = [];

  // main functions — source: clustering.rs:517
  const mainFuncs = await store.nodesOfLabel("Function");
  for (const node of mainFuncs) {
    const name = String(node["name"] ?? "");
    const id = String(node["id"] ?? "");
    const qn = String(node["qualified_name"] ?? id);
    if (name === "main") {
      entries.push({ id, label: "Function", name, qualifiedName: qn, kind: "main", confidence: 1.0 });
    } else if (name.startsWith("test_") || name.startsWith("test")) {
      entries.push({ id, label: "Function", name, qualifiedName: qn, kind: "test", confidence: 1.0 });
    } else if (name.startsWith("do_") || name.endsWith("_handler") || name.endsWith("Handler")) {
      entries.push({ id, label: "Function", name, qualifiedName: qn, kind: "handler", confidence: 0.8 });
    }
  }

  // lib entries: pub functions at top level of a file
  // source: clustering.rs:543-566
  for (const node of mainFuncs) {
    const vis = String(node["visibility"] ?? "");
    const id = String(node["id"] ?? "");
    const qn = String(node["qualified_name"] ?? id);
    if ((vis === "pub" || vis === "export") && !entries.find(e => e.id === id)) {
      const parts = qn.split("::");
      if (parts.length === 2) {
        entries.push({ id, label: "Function", name: String(node["name"] ?? ""), qualifiedName: qn, kind: "lib_entry", confidence: 0.6 });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// BFS process tracing — source: clustering.rs:572-617
// ---------------------------------------------------------------------------

const MAX_BFS_DEPTH = 20; // source: clustering.rs:572 — MAX_BFS_DEPTH = 20 (empirical: any realistic call chain is < 20 hops)

async function traceProcesses(store: GraphStore): Promise<ProcessInfo[]> {
  const entries = await detectEntryPoints(store);

  // Build call adjacency from Calls_ edges
  const callEdges = new Map<string, string[]>();
  const idToLabel = new Map<string, string>();

  for (const label of ["Function", "Method"]) {
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      idToLabel.set(String(n["id"] ?? ""), label);
    }
  }

  for (const [relType] of [
    ["Calls_Function_Function"], ["Calls_Function_Method"],
    ["Calls_Method_Function"], ["Calls_Method_Method"],
  ] as const) {
    const edges = await store.edgesOfType(relType);
    for (const e of edges) {
      if (!callEdges.has(e.from_id)) callEdges.set(e.from_id, []);
      callEdges.get(e.from_id)!.push(e.to_id);
    }
  }

  const processes: ProcessInfo[] = [];
  for (const entry of entries) {
    const processId = `process::${entry.qualifiedName}`;
    const { visited, maxDepth } = bfsFromEntry(entry.id, callEdges);

    // Persist Process node — source: clustering.rs:619-644
    await store.insertNode("Process", {
      id: processId,
      name: processId,
      entry_point_id: entry.id,
      entry_kind: entry.kind,
      entry_confidence: entry.confidence,
      depth: maxDepth,
      symbol_count: visited.size,
    });

    // EntryPointOf edge
    const epRel = `EntryPointOf_${entry.label}_Process`;
    const knownEpRels = ["EntryPointOf_Function_Process", "EntryPointOf_Method_Process"];
    if (knownEpRels.includes(epRel)) {
      try {
        await store.insertEdge(epRel, entry.id, processId, { confidence: entry.confidence });
      } catch { /* duplicate */ }
    }

    // ParticipatesIn edges — source: clustering.rs:647-683
    const byRel = new Map<string, Array<{ from: string; to: string; props: Record<string, unknown> }>>();
    for (const nodeId of visited) {
      const label = idToLabel.get(nodeId);
      if (!label) continue;
      const rel = `ParticipatesIn_${label}_Process`;
      const knownPartRels = ["ParticipatesIn_Function_Process", "ParticipatesIn_Method_Process"];
      if (!knownPartRels.includes(rel)) continue;
      if (!byRel.has(rel)) byRel.set(rel, []);
      byRel.get(rel)!.push({ from: nodeId, to: processId, props: { depth: 0 } });
    }
    for (const [rel, edges] of byRel) {
      await store.bulkInsertEdges(rel, edges.map(e => ({
        from: e.from, to: e.to,
        props: e.props,
      })));
    }

    processes.push({
      name: processId,
      entryPoint: entry.qualifiedName,
      entryKind: entry.kind,
      depth: maxDepth,
      nodeCount: visited.size,
    });
  }

  return processes;
}

function bfsFromEntry(
  startId: string,
  callEdges: Map<string, string[]>
): { visited: Set<string>; maxDepth: number } {
  // source: clustering.rs:594-617
  const visited = new Set<string>();
  const queue: Array<[string, number]> = [[startId, 0]];
  visited.add(startId);
  let maxDepth = 0;

  while (queue.length > 0) {
    const [nodeId, depth] = queue.shift()!;
    if (depth > maxDepth) maxDepth = depth;
    if (depth >= MAX_BFS_DEPTH) continue;
    for (const target of callEdges.get(nodeId) ?? []) {
      if (!visited.has(target)) {
        visited.add(target);
        queue.push([target, depth + 1]);
      }
    }
  }
  return { visited, maxDepth };
}

// ---------------------------------------------------------------------------
// Main entry point — source: clustering.rs:480-498 cluster_graph()
// ---------------------------------------------------------------------------

export async function clusterGraph(
  store: GraphStore,
  gamma = 1.0
): Promise<ClusteringResult> {
  const startMs = Date.now();

  const adj = await extractAdjacency(store);
  const [comm, modularity] = louvain(adj, gamma);
  repairC2(adj, comm);

  const communities = await persistCommunities(store, adj, comm, modularity, gamma);
  const processInfos = await traceProcesses(store);

  await store.updatePhase("clustered");

  return {
    communities,
    modularity,
    processes: processInfos.length,
    elapsedMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// collect_cluster_memberships — source: clustering.rs:55-103
// ---------------------------------------------------------------------------

export interface ClusterMembership {
  qualified_name: string;
  community_id: string;
  cluster_id: number;
}

export interface ClusterMemberships {
  entries: ClusterMembership[];
  truncatedAt?: number;
  total: number;
}

// source: clustering.rs:44 — CLUSTERS_RESPONSE_CAP = 10_000
const CLUSTERS_RESPONSE_CAP = 10_000;

// source: clustering.rs:46-49 — MEMBEROF_LABELS
const MEMBEROF_LABELS = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Constant", "TypeAlias", "Module",
] as const;

export async function collectClusterMemberships(
  store: GraphStore
): Promise<ClusterMemberships> {
  const entries: ClusterMembership[] = [];

  for (const label of MEMBEROF_LABELS) {
    const rel = `MemberOf_${label}_Community`;
    const edges = await store.edgesOfType(rel);
    for (const e of edges) {
      const nodeQn = await (async () => {
        const n = await store.findNodeById(e.from_id);
        return n ? String(n["qualified_name"] ?? e.from_id) : e.from_id;
      })();
      const cid = e.to_id;
      entries.push({
        qualified_name: nodeQn,
        community_id: cid,
        cluster_id: clusterIdFromCommunityId(cid),
      });
    }
  }

  // Sort deterministically before capping — source: clustering.rs:86-96
  entries.sort((a, b) =>
    a.qualified_name.localeCompare(b.qualified_name) ||
    a.community_id.localeCompare(b.community_id)
  );

  const total = entries.length;
  let truncatedAt: number | undefined;
  if (total > CLUSTERS_RESPONSE_CAP) {
    entries.splice(CLUSTERS_RESPONSE_CAP);
    truncatedAt = CLUSTERS_RESPONSE_CAP;
  }

  return { entries, truncatedAt, total };
}

/**
 * Extracts the trailing integer from a community_id.
 * source: clustering.rs:110-116 — cluster_id_from_community_id()
 */
export function clusterIdFromCommunityId(communityId: string): number {
  const parts = communityId.split("::");
  const last = parts[parts.length - 1];
  const n = parseInt(last ?? "", 10);
  return isNaN(n) ? -1 : n;
}

// ---------------------------------------------------------------------------
// get_processes — source: clustering.rs:118-130 ProcessInfo
// ---------------------------------------------------------------------------

export async function getProcesses(store: GraphStore): Promise<ProcessInfo[]> {
  const nodes = await store.nodesOfLabel("Process");
  return nodes.map(n => ({
    name: String(n["name"] ?? ""),
    entryPoint: String(n["entry_point_id"] ?? ""),
    entryKind: String(n["entry_kind"] ?? ""),
    depth: Number(n["depth"] ?? 0),
    nodeCount: Number(n["symbol_count"] ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// get_impact — source: staging; uses MemberOf + ParticipatesIn queries
// ---------------------------------------------------------------------------

export async function getImpact(
  store: GraphStore,
  qualifiedName: string
): Promise<ImpactResult> {
  const node = await store.findNode(qualifiedName);
  if (!node) return { communities: [], processes: [] };

  const nodeId = String(node["id"] ?? "");
  const label = String(node["label"] ?? "");

  // Find communities
  const communities: string[] = [];
  const memRel = `MemberOf_${label}_Community`;
  const memEdges = await store.edgesOfType(memRel);
  for (const e of memEdges) {
    if (e.from_id === nodeId) communities.push(e.to_id);
  }

  // Find processes
  const processes: string[] = [];
  for (const partRel of ["ParticipatesIn_Function_Process", "ParticipatesIn_Method_Process"]) {
    const partEdges = await store.edgesOfType(partRel);
    for (const e of partEdges) {
      if (e.from_id === nodeId) processes.push(e.to_id);
    }
  }

  return { communities, processes };
}
