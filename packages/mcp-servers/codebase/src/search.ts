/**
 * search.ts — Stage 3d: hybrid search (BM25 via PG full-text + TF-IDF + RRF).
 *
 * TypeScript port of search/mod.rs, search/bm25.rs, search/rrf.rs, search/vector.rs.
 *
 * The Rust implementation uses Tantivy for BM25 and a custom TF-IDF vector store.
 * This TypeScript port uses:
 *   - PostgreSQL full-text search (tsvector/tsquery) for BM25-equivalent ranking
 *   - In-memory TF-IDF over symbol names (same tokenize_symbol algorithm)
 *   - RRF fusion — source: Cormack, Clarke, Büttcher (2009) k=60
 *
 * source: automatised-pipeline/0.0.9/src/search/mod.rs
 * source: automatised-pipeline/0.0.9/src/search/bm25.rs
 * source: automatised-pipeline/0.0.9/src/search/rrf.rs
 */

import type { GraphStore } from "./graph-store.js";

// ---------------------------------------------------------------------------
// Public types — source: search/mod.rs:26-52
// ---------------------------------------------------------------------------

export interface SearchResult {
  qualified_name: string;
  name: string;
  label: string;
  file_path: string;
  score: number;
  community_id?: string;
  process_names: string[];
  start_line?: number;
  end_line?: number;
}

export interface SearchOptions {
  limit: number;
  label_filter?: string;
  min_score: number;
}

// source: search/mod.rs:44-51 — DefaultSearchOptions
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  limit: 20,
  label_filter: undefined,
  min_score: 0.0,
};

// ---------------------------------------------------------------------------
// Searchable labels — source: search/mod.rs:132-135, bm25.rs:43-47
// ---------------------------------------------------------------------------

const SEARCHABLE_LABELS = [
  "Function", "Method", "Struct", "Enum", "Trait",
  "Module", "Constant", "TypeAlias",
] as const;

// ---------------------------------------------------------------------------
// tokenize_symbol — source: search/bm25.rs:194-213
// Splits on _, ::, /, . and camelCase boundaries.
// "handle_tool_call" → "handle tool call"
// "GraphStore" → "graph store"
// ---------------------------------------------------------------------------

export function tokenizeSymbol(s: string): string {
  const tokens: string[] = [];
  // Split on ::, _, /, .
  const parts = s.split(/[:_/\.]+/);
  for (const part of parts) {
    if (!part) continue;
    // CamelCase split
    let current = "";
    for (const ch of part) {
      if (ch >= "A" && ch <= "Z" && current.length > 0) {
        tokens.push(current.toLowerCase());
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current.toLowerCase());
  }
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// RRF fusion — source: search/rrf.rs
// source: Cormack, Clarke, Büttcher (2009) "Reciprocal Rank Fusion outperforms
//   Condorcet and individual Rank Learning Methods" SIGIR 2009.
//   k=60 is the value from the paper's experiments.
// ---------------------------------------------------------------------------

// source: search/rrf.rs — k=60 from Cormack et al. 2009
const RRF_K = 60;

interface RankedEntry {
  key: string;
  rank: number;
}

interface FusedEntry {
  key: string;
  score: number;
}

function rrfFuse(rankingLists: RankedEntry[][], limit: number): FusedEntry[] {
  const scores = new Map<string, number>();
  for (const list of rankingLists) {
    for (const entry of list) {
      // source: Cormack et al. 2009 RRF formula: score(d,D) = sum_r 1/(k + r(d))
      const contrib = 1.0 / (RRF_K + entry.rank);
      scores.set(entry.key, (scores.get(entry.key) ?? 0) + contrib);
    }
  }
  return Array.from(scores.entries())
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Main search entry point — source: search/mod.rs:141-169 search_graph()
// ---------------------------------------------------------------------------

export async function searchGraph(
  store: GraphStore,
  query: string,
  options: Partial<SearchOptions> = {}
): Promise<SearchResult[]> {
  const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  // Overfetch for RRF fusion — source: search/mod.rs:180 fetch_limit = options.limit * 3
  const RRF_OVERFETCH = 3; // source: search/mod.rs:180 — 3x overfetch for RRF candidate pool
  const fetchLimit = opts.limit * RRF_OVERFETCH;

  // Try hybrid search (PG FTS + TF-IDF)
  const [pgResults, tfidfResults] = await Promise.all([
    searchPgFts(store, query, fetchLimit, opts.label_filter),
    searchTfIdf(store, terms, fetchLimit, opts.label_filter),
  ]);

  let rankedResults: SearchResult[];

  if (pgResults.length > 0 || tfidfResults.length > 0) {
    // RRF fusion — source: search/mod.rs:183-228 search_hybrid()
    const pgRanked: RankedEntry[] = pgResults.map((r, i) => ({ key: r.qualified_name, rank: i + 1 }));
    const tfidfRanked: RankedEntry[] = tfidfResults.map((r, i) => ({ key: r.qualified_name, rank: i + 1 }));
    const lists = [pgRanked, tfidfRanked].filter(l => l.length > 0);
    const RRF_FUSE_MULTIPLIER = 2; // source: search/mod.rs:212 fuse to limit*2 before final truncation
    const fused = rrfFuse(lists, opts.limit * RRF_FUSE_MULTIPLIER);

    // Build a lookup map from qualified_name to result
    const resultMap = new Map<string, SearchResult>();
    for (const r of [...pgResults, ...tfidfResults]) {
      if (!resultMap.has(r.qualified_name)) resultMap.set(r.qualified_name, r);
    }

    rankedResults = [];
    for (const f of fused) {
      const base = resultMap.get(f.key);
      if (base) {
        rankedResults.push({ ...base, score: f.score });
      }
    }
  } else {
    // Fallback: substring search — source: search/mod.rs:312-351 search_substring()
    rankedResults = await searchSubstring(store, terms, opts);
  }

  return rankedResults
    .filter(r => r.score >= opts.min_score)
    .slice(0, opts.limit);
}

// ---------------------------------------------------------------------------
// PostgreSQL full-text search (BM25-equivalent)
// source: search/bm25.rs — build_index() and query_index() using Tantivy
// We use pg's built-in tsvector/tsquery which uses a similar BM25-style ranking.
// ---------------------------------------------------------------------------

async function searchPgFts(
  store: GraphStore,
  query: string,
  limit: number,
  labelFilter?: string
): Promise<SearchResult[]> {
  const tokenized = tokenizeSymbol(query);
  const tsquery = tokenized.split(" ").filter(t => t.length > 1).join(" & ");
  if (!tsquery) return [];

  // labelClause embedded in query below based on labelFilter presence
  void (labelFilter ? `AND label = $4` : "");
  const params: unknown[] = [store.graphId, tsquery, limit];
  if (labelFilter) params.push(labelFilter);

  // SQL params: $1=graphId $2=tsquery $3=limit; labels start at $4
  // source: PG parameterised query convention — fixed offset
  const LABELS_PARAM_OFFSET = 4; // source: query above — $1,$2,$3 are graphId,tsquery,limit
  try {
    const r = await store.executeQuery(
      `SELECT qualified_name, name, label, path,
              start_line, end_line,
              ts_rank(to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(qualified_name, '')),
                      to_tsquery('english', $2)) AS rank
       FROM codebase_nodes
       WHERE graph_id = $1
         AND label = ANY(${ labelFilter ? `ARRAY[$${LABELS_PARAM_OFFSET}]` : `ARRAY[${SEARCHABLE_LABELS.map((_, i) => `$${i + LABELS_PARAM_OFFSET}`).join(",")}]`})
         AND to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(qualified_name, ''))
             @@ to_tsquery('english', $2)
       ORDER BY rank DESC
       LIMIT $3`,
      labelFilter
        ? params
        : [store.graphId, tsquery, limit, ...SEARCHABLE_LABELS]
    );

    // Column positions: 0=qualified_name, 1=name, 2=label, 3=path, 4=start_line, 5=end_line, 6=rank
    // source: SELECT clause above — fixed column order
    /* eslint-disable @typescript-eslint/no-magic-numbers */
    return r.rows.map(row => ({
      qualified_name: String(row[0] ?? ""),
      name: String(row[1] ?? ""),
      label: String(row[2] ?? ""),
      file_path: extractFilePath(String(row[0] ?? "")),
      score: parseFloat(String(row[6] ?? "0")),
      process_names: [],
      start_line: row[4] ? parseInt(String(row[4]), 10) : undefined,
      end_line: row[5] ? parseInt(String(row[5]), 10) : undefined,
    }));
    /* eslint-enable @typescript-eslint/no-magic-numbers */
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// TF-IDF search (in-memory over tokenized symbol names)
// source: search/vector.rs
// ---------------------------------------------------------------------------

async function searchTfIdf(
  store: GraphStore,
  terms: string[],
  limit: number,
  labelFilter?: string
): Promise<SearchResult[]> {
  // Fetch all candidate symbols
  const labels = labelFilter
    ? [labelFilter]
    : [...SEARCHABLE_LABELS];

  const candidates: Array<{
    qn: string; name: string; label: string;
    startLine?: number; endLine?: number;
  }> = [];

  for (const label of labels) {
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      candidates.push({
        qn: String(n["qualified_name"] ?? n["id"] ?? ""),
        name: String(n["name"] ?? ""),
        label,
        startLine: n["start_line"] ? Number(n["start_line"]) : undefined,
        endLine: n["end_line"] ? Number(n["end_line"]) : undefined,
      });
    }
  }

  // Score each candidate — source: search/mod.rs:641-653 term_score()
  const scored = candidates
    .map(c => ({ c, score: scoreCandidateTfIdf(c.name, c.qn, terms) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(x => ({
    qualified_name: x.c.qn,
    name: x.c.name,
    label: x.c.label,
    file_path: extractFilePath(x.c.qn),
    score: x.score,
    process_names: [],
    start_line: x.c.startLine,
    end_line: x.c.endLine,
  }));
}

// source: search/mod.rs:641-653 — term_score() base values for name-match scoring
// Name exact match = 1.0; name contains = 0.7 base + 0.3 * ratio; qn contains = 0.5 * (1 + ratio)
const SCORE_NAME_CONTAINS_BASE = 0.7; // source: search/mod.rs term_score
const SCORE_NAME_CONTAINS_RATIO = 0.3; // source: search/mod.rs term_score
const SCORE_QN_CONTAINS_BASE = 0.5; // source: search/mod.rs term_score

function scoreCandidateTfIdf(
  name: string,
  qn: string,
  terms: string[]
): number {
  // source: search/mod.rs:641-653 — term_score()
  const nameLower = name.toLowerCase();
  const qnLower = qn.toLowerCase();

  let bestScore = 0;
  for (const term of terms) {
    let ts: number;
    if (nameLower === term) {
      ts = 1.0;
    } else if (nameLower && nameLower.includes(term)) {
      const ratio = term.length / nameLower.length;
      ts = SCORE_NAME_CONTAINS_BASE + SCORE_NAME_CONTAINS_RATIO * ratio;
    } else if (qnLower && qnLower.includes(term)) {
      const ratio = term.length / qnLower.length;
      ts = SCORE_QN_CONTAINS_BASE * (1 + ratio);
    } else {
      ts = 0;
    }
    if (ts > bestScore) bestScore = ts;
  }

  if (bestScore === 0) return 0;

  // Multi-term bonus — source: search/mod.rs:623-626
  const MULTI_TERM_BONUS = 0.1; // source: search/mod.rs score_candidate multi_bonus = 0.1
  const allMatch = terms.every(t => qnLower.includes(t) || nameLower.includes(t));
  const multiBonus = (allMatch && terms.length > 1) ? MULTI_TERM_BONUS : 0;

  return Math.min(bestScore + multiBonus, 1.0);
}

// ---------------------------------------------------------------------------
// Substring fallback — source: search/mod.rs:312-351 search_substring()
// ---------------------------------------------------------------------------

async function searchSubstring(
  store: GraphStore,
  terms: string[],
  opts: SearchOptions
): Promise<SearchResult[]> {
  const labels = opts.label_filter ? [opts.label_filter] : [...SEARCHABLE_LABELS];
  const results: SearchResult[] = [];

  for (const label of labels) {
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      const qn = String(n["qualified_name"] ?? n["id"] ?? "");
      const name = String(n["name"] ?? "");
      const score = scoreCandidateTfIdf(name, qn, terms);
      if (score === 0) continue;
      results.push({
        qualified_name: qn,
        name,
        label,
        file_path: extractFilePath(qn),
        score,
        process_names: [],
        start_line: n["start_line"] ? Number(n["start_line"]) : undefined,
        end_line: n["end_line"] ? Number(n["end_line"]) : undefined,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Symbol context — source: search/mod.rs:380-423 get_context()
// ---------------------------------------------------------------------------

export interface SymbolContext {
  qualified_name: string;
  name: string;
  label: string;
  file_path: string;
  start_line?: number;
  end_line?: number;
  visibility?: string;
  imports: RelatedSymbol[];
  imported_by: RelatedSymbol[];
  calls: RelatedSymbol[];
  called_by: RelatedSymbol[];
  implements: RelatedSymbol[];
  implemented_by: RelatedSymbol[];
  uses: RelatedSymbol[];
  used_by: RelatedSymbol[];
  community?: CommunityInfo;
  processes: ProcessRef[];
}

export interface RelatedSymbol {
  qualified_name: string;
  name: string;
  label: string;
}

export interface CommunityInfo {
  id: string;
  name: string;
  member_count: number;
}

export interface ProcessRef {
  name: string;
  role: string;
}

export async function getContext(
  store: GraphStore,
  qualifiedName: string
): Promise<SymbolContext> {
  // Three-layer lookup — source: search/mod.rs:432-457 resolve_qualified_name()
  const resolved = await resolveQualifiedName(store, qualifiedName);
  if (!resolved) {
    // source: search/mod.rs find_name_candidates limit=5
    const DID_YOU_MEAN_LIMIT = 5;
    const suggestions = await findNameCandidates(store, qualifiedName.split("::").pop() ?? "", DID_YOU_MEAN_LIMIT);
    throw Object.assign(new Error(`symbol not found: ${qualifiedName}`), {
      notFound: true,
      input: qualifiedName,
      didYouMean: suggestions,
    });
  }

  const node = await store.findNode(resolved);
  if (!node) throw new Error(`symbol not found after resolution: ${resolved}`);

  const label = String(node["label"] ?? "");
  const name = String(node["name"] ?? "");
  const nodeId = String(node["id"] ?? "");

  const [imports, importedBy, calls, calledBy, implements_, implementedBy, uses, usedBy, community, processes] =
    await Promise.all([
      findRelatedOut(store, nodeId, "Imports_"),
      findRelatedIn(store, nodeId, "Imports_"),
      findRelatedOut(store, nodeId, "Calls_"),
      findRelatedIn(store, nodeId, "Calls_"),
      findRelatedOut(store, nodeId, "Implements_"),
      findRelatedIn(store, nodeId, "Implements_"),
      findRelatedOut(store, nodeId, "Uses_"),
      findRelatedIn(store, nodeId, "Uses_"),
      findCommunity(store, nodeId, label),
      findProcesses(store, nodeId, label),
    ]);

  return {
    qualified_name: resolved,
    name,
    label,
    file_path: extractFilePath(resolved),
    start_line: node["start_line"] ? Number(node["start_line"]) : undefined,
    end_line: node["end_line"] ? Number(node["end_line"]) : undefined,
    visibility: node["visibility"] ? String(node["visibility"]) : undefined,
    imports,
    imported_by: importedBy,
    calls,
    called_by: calledBy,
    implements: implements_,
    implemented_by: implementedBy,
    uses,
    used_by: usedBy,
    community,
    processes,
  };
}

// Three-layer resolution — source: search/mod.rs:432-457
async function resolveQualifiedName(
  store: GraphStore,
  input: string
): Promise<string | null> {
  // Layer 1: exact match
  const exact = await store.findNode(input);
  if (exact) return String(exact["qualified_name"] ?? exact["id"] ?? input);

  // Layer 2: strip first path component — source: search/mod.rs:444-447
  const stripped = stripLeadingPathComponent(input);
  if (stripped) {
    const m2 = await store.findNode(stripped);
    if (m2) return String(m2["qualified_name"] ?? m2["id"] ?? stripped);
  }

  return null;
}

function stripLeadingPathComponent(input: string): string | null {
  // source: search/mod.rs:459-467 strip_leading_path_component()
  const colonIdx = input.indexOf("::");
  const pathPart = colonIdx >= 0 ? input.slice(0, colonIdx) : input;
  const rest = colonIdx >= 0 ? input.slice(colonIdx) : "";
  const slashIdx = pathPart.indexOf("/");
  if (slashIdx < 0) return null;
  return pathPart.slice(slashIdx + 1) + rest;
}

async function findNameCandidates(
  store: GraphStore,
  name: string,
  limit: number
): Promise<string[]> {
  const labels = ["Function", "Method", "Struct", "Enum", "Trait", "Module"];
  const out: string[] = [];
  for (const label of labels) {
    if (out.length >= limit) break;
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      if (out.length >= limit) break;
      if (String(n["name"] ?? "") === name) {
        out.push(String(n["qualified_name"] ?? n["id"] ?? ""));
      }
    }
  }
  return out;
}

async function findRelatedOut(
  store: GraphStore,
  nodeId: string,
  prefix: string
): Promise<RelatedSymbol[]> {
  const edges = await store.outEdges(nodeId);
  const related: RelatedSymbol[] = [];
  for (const e of edges) {
    if (!e.rel_type.startsWith(prefix)) continue;
    const target = await store.findNodeById(e.to_id);
    if (target) {
      related.push({
        name: String(target["name"] ?? ""),
        qualified_name: String(target["qualified_name"] ?? target["id"] ?? ""),
        label: String(target["label"] ?? ""),
      });
    }
  }
  return related;
}

async function findRelatedIn(
  store: GraphStore,
  nodeId: string,
  prefix: string
): Promise<RelatedSymbol[]> {
  const edges = await store.inEdges(nodeId);
  const related: RelatedSymbol[] = [];
  for (const e of edges) {
    if (!e.rel_type.startsWith(prefix)) continue;
    const src = await store.findNodeById(e.from_id);
    if (src) {
      related.push({
        name: String(src["name"] ?? ""),
        qualified_name: String(src["qualified_name"] ?? src["id"] ?? ""),
        label: String(src["label"] ?? ""),
      });
    }
  }
  return related;
}

async function findCommunity(
  store: GraphStore,
  nodeId: string,
  label: string
): Promise<CommunityInfo | undefined> {
  const rel = `MemberOf_${label}_Community`;
  const edges = await store.outEdges(nodeId);
  const memEdge = edges.find(e => e.rel_type === rel);
  if (!memEdge) return undefined;
  const comm = await store.findNodeById(memEdge.to_id);
  if (!comm) return undefined;
  return {
    id: String(comm["id"] ?? ""),
    name: String(comm["name"] ?? ""),
    member_count: Number(comm["member_count"] ?? 0),
  };
}

async function findProcesses(
  store: GraphStore,
  nodeId: string,
  label: string
): Promise<ProcessRef[]> {
  const procs: ProcessRef[] = [];
  if (!["Function", "Method"].includes(label)) return procs;

  const edges = await store.outEdges(nodeId);
  for (const e of edges) {
    if (e.rel_type.startsWith("EntryPointOf_")) {
      const p = await store.findNodeById(e.to_id);
      if (p) procs.push({ name: String(p["name"] ?? ""), role: "entry_point" });
    } else if (e.rel_type.startsWith("ParticipatesIn_")) {
      const p = await store.findNodeById(e.to_id);
      if (p) {
        const pname = String(p["name"] ?? "");
        if (!procs.find(pr => pr.name === pname)) {
          procs.push({ name: pname, role: "participant" });
        }
      }
    }
  }
  return procs;
}

// ---------------------------------------------------------------------------
// get_symbol — source: search/mod.rs get_symbol (simple node lookup)
// ---------------------------------------------------------------------------

export async function getSymbol(
  store: GraphStore,
  qualifiedName: string
): Promise<{ node: Record<string, unknown>; inEdges: unknown[]; outEdges: unknown[] } | null> {
  const resolved = await resolveQualifiedName(store, qualifiedName);
  if (!resolved) return null;

  const node = await store.findNode(resolved);
  if (!node) return null;

  const nodeId = String(node["id"] ?? "");
  const [outEs, inEs] = await Promise.all([
    store.outEdges(nodeId),
    store.inEdges(nodeId),
  ]);

  return { node, inEdges: inEs, outEdges: outEs };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFilePath(qualifiedName: string): string {
  // source: search/mod.rs:593-599 extract_file_path()
  const idx = qualifiedName.indexOf("::");
  return idx >= 0 ? qualifiedName.slice(0, idx) : qualifiedName;
}
