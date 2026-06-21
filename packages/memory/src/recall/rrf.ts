/**
 * Reciprocal Rank Fusion (RRF) for merging heterogeneous ranked lists.
 *
 * Port of: mcp_server/core/unified_search_fusion.py
 *
 * RRF formula:
 *   score(d) = Σ_{r in retrievers} 1 / (K + rank_r(d))
 *
 * source: Cormack, Clarke, Büttcher (2009) "Reciprocal Rank Fusion
 * Outperforms Condorcet and Individual Rank Learning Methods", SIGIR.
 *
 * K=60 per the paper's experimental finding. Cortex uses K=60 for WRRF
 * inside pg_recall (settings.WRRF_K), so this is consistent with the
 * rest of the retrieval stack.
 *
 * Pure logic — no I/O.
 */

// source: Cormack, Clarke, Büttcher (2009) SIGIR — K=60 default
// source: Matches pg_recall settings.WRRF_K = 60
export const DEFAULT_RRF_K = 60;

// ── Rank-pair fusion ──────────────────────────────────────────────────────

/**
 * RRF-fuse an arbitrary number of ranked ID lists.
 *
 * Each entry in `rankedLists` is `[sourceName, [id, id, ...]]`.
 * Returns `[id, rrfScore]` pairs sorted descending by score.
 * Ties are broken by the number of sources that ranked the item, then by id.
 *
 * Port of: mcp_server/core/unified_search_fusion.py::fuse (rank-id variant)
 */
export function rrfFuseIds(
  rankedLists: Array<[string, number[]]>,
  k: number = DEFAULT_RRF_K,
): Array<[number, number]> {
  const scores = new Map<number, number>();
  const sourceCounts = new Map<number, number>();

  for (const [, ids] of rankedLists) {
    for (let rank = 0; rank < ids.length; rank++) {
      const id = ids[rank] as number;
      const delta = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + delta);
      sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
    }
  }

  const entries = Array.from(scores.entries());
  // Sort: descending score, then descending source count (more sources = better), then ascending id
  entries.sort(([idA, scoreA], [idB, scoreB]) => {
    if (scoreB !== scoreA) return scoreB - scoreA;
    const cA = sourceCounts.get(idA) ?? 0;
    const cB = sourceCounts.get(idB) ?? 0;
    if (cB !== cA) return cB - cA;
    return idA - idB;
  });

  return entries;
}

/**
 * RRF-fuse lists of (id, score) score pairs.
 *
 * Each entry in `scoreLists` is `[sourceName, [[id, score], ...]]`.
 * Scores are discarded for ranking purposes — only rank position matters.
 *
 * Port of: inner logic of mcp_server/core/unified_search_fusion.py::fuse
 */
export function rrfFuseScorePairs(
  scoreLists: Array<[string, Array<[number, number]>]>,
  k: number = DEFAULT_RRF_K,
): Array<[number, number]> {
  const idLists: Array<[string, number[]]> = scoreLists.map(
    ([name, pairs]) => [name, pairs.map(([id]) => id)],
  );
  return rrfFuseIds(idLists, k);
}

// ── Multi-signal RRF over named signal lists ──────────────────────────────

/**
 * Fuse a named map of signal score-pair lists using RRF.
 *
 * Used by multi-signal-fusion.ts to merge vector, BM25, heat, n-gram
 * and other signals into a single ranked list.
 */
export function rrfFuseSignals(
  signals: Record<string, Array<[number, number]>>,
  k: number = DEFAULT_RRF_K,
): Array<[number, number]> {
  const lists: Array<[string, Array<[number, number]>]> = Object.entries(
    signals,
  ).filter(([, pairs]) => pairs.length > 0);
  return rrfFuseScorePairs(lists, k);
}

/**
 * Weighted Reciprocal Rank Fusion across multiple signals.
 *
 *   score(d) = Σ_signal weight[signal] / (k + rank_signal(d) + 1)
 *
 * Weighted variant of RRF where each signal contributes proportionally
 * to its weight rather than each contributing equally. Required for
 * parity with the Python recall pipeline, which fuses
 * vector/fts/heat/hopfield/hdc/sr/sa/bm25/ngram with intent-specific
 * weights from BASE_WEIGHTS + INTENT_WEIGHT_OVERRIDES.
 *
 * Without this weighting, signal mixtures collapse to unweighted RRF —
 * for LoCoMo-style literal-retrieval queries that produces a 21pp
 * regression on MRR vs the Python baseline because every signal counts
 * equally regardless of its informativeness for the query intent.
 *
 * precondition: none beyond well-formed inputs. A signal whose weight is absent
 *   is treated as weight 0 and skipped — the oracle builds signal_weights via
 *   weights.get(name, 0.0) then `if weight <= 0: continue`. No throw, no 1.0
 *   default. Non-positive weights skip the signal entirely.
 * postcondition: returned list is sorted by DESCENDING fused score ONLY; ties
 *   keep first-seen (insertion) order via a stable sort — byte-faithful to the
 *   oracle's `sorted(scores.items(), key=score, reverse=True)` over an
 *   insertion-ordered dict. No secondary tie-break key.
 *
 * source: cortex main mcp_server/core/retrieval_dispatch.py wrrf_fuse
 * source: Cormack, Clarke, Büttcher (2009) "Reciprocal Rank Fusion ..." SIGIR.
 */
export function wrrfFuseSignals(
  signals: Record<string, Array<[number, number]>>,
  weights: Record<string, number>,
  k: number = DEFAULT_RRF_K,
): Array<[number, number]> {
  // Oracle wrrf_fuse: signal_weights[i] = weights.get(name, 0.0); a missing
  // weight becomes 0 and `if weight <= 0: continue` skips the signal — it NEVER
  // throws. The zip(strict=True) is a positional length guard over two
  // caller-built parallel lists, not a per-signal presence check. Sort by score
  // only; the oracle's stable sort keeps the dict's insertion order on ties.
  // source: cortex main mcp_server/core/retrieval_dispatch.py wrrf_fuse
  const scores = new Map<number, number>();
  for (const [name, pairs] of Object.entries(signals)) {
    if (pairs.length === 0) continue;
    const w = weights[name] ?? 0.0;
    if (w <= 0) continue;
    for (let rank = 0; rank < pairs.length; rank++) {
      const entry = pairs[rank];
      if (!entry) continue;
      const id = entry[0];
      scores.set(id, (scores.get(id) ?? 0) + w / (k + rank + 1));
    }
  }
  // Score-only descending. Array.prototype.sort is stable (ES2019+), so ties keep
  // insertion order, matching the oracle's stable sort over an insertion-ordered dict.
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
}
