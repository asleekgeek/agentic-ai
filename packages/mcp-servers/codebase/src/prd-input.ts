/**
 * prd-input.ts — Stage 4: bundle verified finding + graph intel for PRD generator.
 *
 * TypeScript port of prd_input.rs.
 * source: automatised-pipeline/0.0.9/src/prd_input.rs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphStore } from "./graph-store.js";
import { searchGraph, getContext } from "./search.js";

// source: prd_input.rs:33 — MATCHES_PER_TOKEN = 3
const MATCHES_PER_TOKEN = 3;
// source: prd_input.rs:35 — PREPARER_VERSION
const PREPARER_VERSION = "1.0.0";
// source: prd_input.rs:38 — PRD_INPUT_FILE_NAME
const PRD_INPUT_FILE_NAME = "stage-4.prd_input.json";
// source: prd_input.rs:44 — MIN_TOKEN_LEN = 3
const MIN_TOKEN_LEN = 3;
// source: prd_input.rs:50 — MAX_TOKENS = 32
const MAX_TOKENS = 32;

export interface PrdInputOutcome {
  artifact_path: string;
  matched_symbol_count: number;
  impacted_community_count: number;
  impacted_process_count: number;
}

export async function preparePrdInput(
  store: GraphStore,
  runId: string,
  findingId: string,
  outputDir: string
): Promise<PrdInputOutcome> {
  const findingDir = path.join(outputDir, "runs", runId, "findings", findingId);

  // Load stage-2.verified.json
  const verifiedPath = path.join(findingDir, "stage-2.verified.json");
  if (!fs.existsSync(verifiedPath))
    throw new Error("stage-2.verified.json not found: complete verification first");
  const verified = JSON.parse(fs.readFileSync(verifiedPath, "utf8")) as Record<string, unknown>;

  // Load stage-1.refined.json for title/description
  const refinedPath = path.join(findingDir, "stage-1.refined.json");
  if (!fs.existsSync(refinedPath))
    throw new Error("stage-1.refined.json not found");
  const refined = JSON.parse(fs.readFileSync(refinedPath, "utf8")) as Record<string, unknown>;

  const extracted = (refined["extracted"] ?? {}) as Record<string, unknown>;
  const title = String(extracted["title"] ?? "");
  const description = String(extracted["description"] ?? "");
  const combinedText = `${title} ${description}`;

  // Tokenize description — source: prd_input.rs tokenize_description()
  const tokens = combinedText
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9_:]/g, ""))
    .filter(t => t.length >= MIN_TOKEN_LEN)
    .slice(0, MAX_TOKENS);

  // Search for each token — source: prd_input.rs top-3 matches per token
  const matchedQns = new Set<string>();
  for (const token of tokens) {
    const results = await searchGraph(store, token, { limit: MATCHES_PER_TOKEN });
    for (const r of results) matchedQns.add(r.qualified_name);
  }

  // Get context for each matched symbol
  const communities = new Set<string>();
  const processes = new Set<string>();
  const symbolContexts: unknown[] = [];

  for (const qn of matchedQns) {
    try {
      const ctx = await getContext(store, qn);
      if (ctx.community) communities.add(ctx.community.id);
      for (const p of ctx.processes) processes.add(p.name);
      symbolContexts.push({
        qualified_name: ctx.qualified_name,
        name: ctx.name,
        label: ctx.label,
        community: ctx.community?.id,
        processes: ctx.processes.map(p => p.name),
        calls: ctx.calls.map(c => c.qualified_name),
        called_by: ctx.called_by.map(c => c.qualified_name),
        uses: ctx.uses.map(u => u.qualified_name),
      });
    } catch { /* symbol not found — skip */ }
  }

  const artifact = {
    preparer_version: PREPARER_VERSION,
    prepared_at: new Date().toISOString(),
    run_id: runId,
    finding_id: findingId,
    finding_summary: {
      title,
      description,
      relevance_category: String(extracted["relevance_category"] ?? ""),
    },
    verified_digest: String(verified["transcript_digest"] ?? ""),
    matched_symbols: symbolContexts,
    impacted_communities: [...communities],
    impacted_processes: [...processes],
    graph_stats: {
      node_count: await store.nodeCount(),
      edge_count: await store.edgeCount(),
    },
  };

  const artifactPath = path.join(findingDir, PRD_INPUT_FILE_NAME);
  fs.mkdirSync(findingDir, { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  return {
    artifact_path: artifactPath,
    matched_symbol_count: matchedQns.size,
    impacted_community_count: communities.size,
    impacted_process_count: processes.size,
  };
}

// ---------------------------------------------------------------------------
// PRD validator — source: prd_validator.rs Stage 6
// ---------------------------------------------------------------------------

export interface PrdValidationResult {
  valid: boolean;
  hallucinated_symbols: string[];
  community_consistency_warnings: string[];
  process_impact_contradictions: string[];
  symbol_count: number;
  checked_at: string;
}

export async function validatePrdAgainstGraph(
  store: GraphStore,
  prdPath: string,
  affectedSymbolsPath?: string
): Promise<PrdValidationResult> {
  const prdText = fs.readFileSync(prdPath, "utf8");

  // Extract claimed symbols: from affected_symbols.json if provided, else regex from PRD
  let claimedSymbols: string[] = [];

  if (affectedSymbolsPath && fs.existsSync(affectedSymbolsPath)) {
    const aff = JSON.parse(fs.readFileSync(affectedSymbolsPath, "utf8")) as unknown;
    if (Array.isArray(aff)) {
      claimedSymbols = aff.map(s => typeof s === "string" ? s : String((s as Record<string, unknown>)["qualified_name"] ?? "")).filter(Boolean);
    }
  } else {
    // Regex fallback: extract qualified_name-like patterns from PRD text
    // source: prd_validator.rs regex fallback
    const matches = prdText.matchAll(/`([a-zA-Z0-9/_-]+(?:::[a-zA-Z0-9_]+)+)`/g);
    for (const m of matches) {
      if (m[1]) claimedSymbols.push(m[1]);
    }
  }

  // S1: Symbol hallucination check
  const hallucinated: string[] = [];
  for (const sym of claimedSymbols) {
    const node = await store.findNode(sym);
    if (!node) hallucinated.push(sym);
  }

  // S2: Community consistency
  const communityWarnings: string[] = [];
  const communityIds = new Set<string>();
  for (const sym of claimedSymbols) {
    const node = await store.findNode(sym);
    if (!node) continue;
    const nodeId = String(node["id"] ?? "");
    const edges = await store.outEdges(nodeId);
    const memEdge = edges.find(e => e.rel_type.startsWith("MemberOf_"));
    if (memEdge) communityIds.add(memEdge.to_id);
  }
  // source: prd_validator.rs community consistency check — >3 communities = broad scope warning
  const COMMUNITY_CONSISTENCY_THRESHOLD = 3;
  if (communityIds.size > COMMUNITY_CONSISTENCY_THRESHOLD) {
    communityWarnings.push(
      `Claimed symbols span ${communityIds.size} communities — may indicate broad scope`
    );
  }

  // S3: Process-impact contradictions
  const contradictions: string[] = [];
  const noImpactClaims = prdText.matchAll(/does not affect\s+["`]?([^"`,\n]+)["`]?/gi);
  for (const claim of noImpactClaims) {
    const processName = claim[1]?.trim() ?? "";
    if (!processName) continue;
    for (const sym of claimedSymbols) {
      const node = await store.findNode(sym);
      if (!node) continue;
      const nodeId = String(node["id"] ?? "");
      const edges = await store.outEdges(nodeId);
      for (const e of edges) {
        if (e.rel_type.startsWith("ParticipatesIn_")) {
          const p = await store.findNodeById(e.to_id);
          if (p && String(p["name"] ?? "").includes(processName)) {
            contradictions.push(
              `PRD claims no impact on "${processName}" but ${sym} participates in it`
            );
          }
        }
      }
    }
  }

  return {
    valid: hallucinated.length === 0 && contradictions.length === 0,
    hallucinated_symbols: hallucinated,
    community_consistency_warnings: communityWarnings,
    process_impact_contradictions: contradictions,
    symbol_count: claimedSymbols.length,
    checked_at: new Date().toISOString(),
  };
}
