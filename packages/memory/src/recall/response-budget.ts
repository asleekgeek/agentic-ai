/**
 * Bounded MCP responses — total payload budget with per-item truncation.
 *
 * An MCP tool response that exceeds the host's tool-result ceiling is
 * rejected wholesale and dumped to a file (Claude Code behaviour, observed
 * 2026-06-10: recall response of 324,429 chars rejected). Bounding must
 * therefore happen on our side of the wire, where we control which bytes
 * survive.
 *
 * Budget derivation (measured, not invented):
 *
 * - Claude Code enforces `MAX_MCP_OUTPUT_TOKENS` on MCP tool results.
 *   source: Claude Code 2.1.170 binary, extracted 2026-06-10 —
 *     default   `d4O = 25000` tokens,
 *     estimator `Xz(text) = round(len(text) / 4)` (4 chars/token),
 *     char cap  `l4O() = limit * 4` → 100,000 chars.
 * - The counted text is the compact-JSON serialization of the payload:
 *   `JSON.stringify(payload)` (no spacing) reproduces Python's
 *   `json.dumps(payload, separators=(",", ":"), ensure_ascii=False)`,
 *   which reproduced Claude Code's reported count exactly
 *   (324,429 == 324,429, measured 2026-06-10 on a rejected recall response).
 * - Safety factor 0.75 applied to the host cap. The host counts JS
 *   `String.length` (UTF-16 code units) while the budget is derived from
 *   code-point counts — non-BMP characters (emoji, rare CJK) count 2:1, so
 *   a payload filled exactly to the host cap can overshoot it. The factor
 *   guarantees no overshoot up to a 1/3 non-BMP code-point fraction
 *   (host_len = len × (1 + f) ≤ cap ⟺ f ≤ 1/3 at 0.75), far above any
 *   observed payload. source: ContextManager.swift budget logic
 *   (`reasoner.contextWindowSize * 0.75`), ai-prd-builder commit
 *   462de01 (2025-09-30) — same estimator-divergence guard, reused here.
 *
 * Truncation policy: priority-weighted water-filling. A hard cap that
 * cuts all items equally destroys exactly the high-relevance content the
 * response exists to deliver, so the surviving budget is allocated
 * proportionally to each item's retrieval priority (`score` from WRRF +
 * rerank fusion, `heat` for hot memories) and the least relevant slots
 * are condensed first. source: ContextDecomposer allocation algorithm,
 * ai-prd-builder commit 462de01 (2025-09-30) — "allocate remaining budget
 * proportionally across priority-ranked slots; condense
 * highest-priority-number [least important] slots first; iteratively
 * [shrink] the least important slot until the prompt fits". Adaptation:
 * slot priority = retrieval score (the system's own relevance estimate);
 * equal weights reduce to plain max-min fairness (the unweighted case).
 *
 * Truncated items carry `truncated: true` plus `content_length`
 * (original size) and keep their id, so truncation is never a dead end:
 * full content stays dynamically loadable by id (`recall` `memory_id`
 * + `content_offset` args, `wiki_read` `offset` arg).
 *
 * Port of: mcp_server/core/response_budget.py
 *          mcp_server/infrastructure/memory_config.py:158 (MAX_RESPONSE_CHARS)
 *
 * Pure logic — no I/O.
 */

// source: Claude Code 2.1.170 binary (see module docstring) —
// MAX_MCP_OUTPUT_TOKENS default 25000 tokens × 4 chars/token.
export const HOST_CAP_CHARS = 100_000; // source: cortex core/response_budget.py — HOST_CAP_CHARS (MAX_MCP_OUTPUT_TOKENS 25000 × 4 chars/token)

// source: ai-prd-builder ContextManager.swift, commit 462de01 (see module
// docstring) — guards the UTF-16-units vs code-points estimator divergence.
export const SAFETY_FACTOR = 0.75; // source: cortex core/response_budget.py — UTF-16 divergence safety factor 0.75

// source: memory_config.py:158 — int(HOST_CAP_CHARS * SAFETY_FACTOR) = 75000.
export const MAX_RESPONSE_CHARS = Math.trunc(HOST_CAP_CHARS * SAFETY_FACTOR);

/**
 * A list of dict items under `payload[key]`, each carrying a text field at
 * `contentKey` that may be truncated.
 *
 * `weightKey` names a positive-number field used as the item's truncation
 * priority (higher = keeps more content). `undefined` means equal shares.
 *
 * Port of: response_budget.py ListTarget (frozen dataclass).
 */
export interface ListTarget {
  readonly kind: "list";
  readonly key: string;
  readonly contentKey: string;
  readonly weightKey?: string;
}

/**
 * A single string field at `payload[key]` that may be truncated.
 *
 * Port of: response_budget.py TextTarget (frozen dataclass).
 */
export interface TextTarget {
  readonly kind: "text";
  readonly key: string;
}

export type BudgetTarget = ListTarget | TextTarget;

/**
 * Construct a {@link ListTarget}. `contentKey` defaults to "content" to
 * mirror response_budget.py ListTarget's field default.
 */
export function listTarget(
  key: string,
  contentKey = "content",
  weightKey?: string,
): ListTarget {
  return { kind: "list", key, contentKey, weightKey };
}

/** Construct a {@link TextTarget}. */
export function textTarget(key: string): TextTarget {
  return { kind: "text", key };
}

type Payload = Record<string, unknown>;

/**
 * One truncatable text plus the bookkeeping keys written on cut.
 *
 * Port of: response_budget.py _Cell (dataclass).
 */
interface Cell {
  readonly container: Record<string, unknown>;
  readonly contentKey: string;
  readonly flagKey: string;
  readonly lengthKey: string;
  readonly weight: number;
}

/**
 * Char count of the payload exactly as the MCP host counts it.
 *
 * `JSON.stringify` with no spacing reproduces Python's compact
 * `separators=(",", ":")` + `ensure_ascii=False` serialization
 * (verified char-exact against a rejected response, 2026-06-10). The
 * spread-into-array length counts code points (matching Python `len()`),
 * not UTF-16 code units, so the SAFETY_FACTOR guard holds as derived.
 *
 * Port of: response_budget.py serialized_length.
 */
export function serializedLength(payload: unknown): number {
  return [...JSON.stringify(payload)].length;
}

/**
 * Item's truncation priority; degenerate values fall back to 1.0
 * (equal share — the unweighted behavior, not an invented constant).
 *
 * Port of: response_budget.py _priority_weight.
 */
function priorityWeight(
  item: Record<string, unknown>,
  weightKey: string | undefined,
): number {
  if (weightKey === undefined) return 1.0;
  const value = item[weightKey];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return 1.0;
}

/**
 * Collect every truncatable cell addressed by the targets.
 *
 * Port of: response_budget.py _collect_cells.
 */
function collectCells(payload: Payload, targets: BudgetTarget[]): Cell[] {
  const cells: Cell[] = [];
  for (const target of targets) {
    if (target.kind === "text") {
      if (typeof payload[target.key] === "string") {
        cells.push({
          container: payload,
          contentKey: target.key,
          flagKey: `${target.key}_truncated`,
          lengthKey: `${target.key}_length`,
          weight: 1.0,
        });
      }
      continue;
    }
    const items = payload[target.key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (isRecord(item) && typeof item[target.contentKey] === "string") {
        cells.push({
          container: item,
          contentKey: target.contentKey,
          flagKey: "truncated",
          lengthKey: `${target.contentKey}_length`,
          weight: priorityWeight(item, target.weightKey),
        });
      }
    }
  }
  return cells;
}

/** Content-string length of a cell as code points (matches Python len()). */
function cellContentLength(cell: Cell): number {
  const content = cell.container[cell.contentKey];
  return typeof content === "string" ? [...content].length : 0;
}

/**
 * Exact serialized chars added when a cell is first marked truncated.
 *
 * Port of: response_budget.py _flag_cost.
 */
function flagCost(cell: Cell): number {
  let cost = 0;
  if (!cell.container[cell.flagKey]) {
    cost += [...`,"${cell.flagKey}":true`].length;
  }
  if (!(cell.lengthKey in cell.container)) {
    const len = cellContentLength(cell);
    cost += [...`,"${cell.lengthKey}":`].length + [...String(len)].length;
  }
  return cost;
}

/**
 * Largest common level L ≥ 0 with
 * `sum(max(0, length - L*weight)) >= needed`.
 *
 * Weighted max-min fairness: cells whose length exceeds L×weight are cut
 * to it, the rest are untouched. Equal weights make this plain
 * water-filling. Returns 0 when even emptying everything cannot free
 * `needed` chars.
 *
 * Port of: response_budget.py _water_level.
 * Exported for parity testing (mirrors the oracle's module-level _water_level,
 * pinned directly in tests_py/core/test_response_budget.py).
 */
export function waterLevel(pairs: Array<[number, number]>, needed: number): number {
  if (pairs.length === 0 || needed <= 0) {
    let maxRatio = 0.0;
    for (const [length, weight] of pairs) {
      const ratio = length / weight;
      if (ratio > maxRatio) maxRatio = ratio;
    }
    return maxRatio;
  }
  const desc = [...pairs].sort((a, b) => b[0] / b[1] - a[0] / a[1]);
  let freed = 0.0;
  let activeWeight = 0.0;
  for (let i = 0; i < desc.length; i++) {
    const pair = desc[i] as [number, number];
    const [length, weight] = pair;
    const ratio = length / weight;
    activeWeight += weight;
    const nxt = i + 1 < desc.length ? (desc[i + 1] as [number, number]) : null;
    const nextRatio = nxt ? nxt[0] / nxt[1] : 0.0;
    const capacity = activeWeight * (ratio - nextRatio);
    if (freed + capacity >= needed) {
      return ratio - (needed - freed) / activeWeight;
    }
    freed += capacity;
  }
  return 0.0;
}

/**
 * Weighted water-fill: cut contents down to a common per-weight level L —
 * each cell keeps up to `floor(L × weight)` chars — so the freed raw chars
 * cover `overflow` plus the exact cost of the flags added in the worst
 * case (every cell gets marked). Survivor budget is thus proportional to
 * priority and low-priority cells condense first (ContextDecomposer
 * allocation; see module docstring).
 *
 * Each raw content char occupies ≥1 serialized char (escapes only widen),
 * so freeing N raw chars frees ≥N serialized chars; floor() only ever
 * cuts deeper, preserving the guarantee.
 *
 * Port of: response_budget.py _truncate_cells.
 */
function truncateCells(cells: Cell[], overflow: number): void {
  let needed = overflow;
  for (const cell of cells) needed += flagCost(cell);
  const pairs = cells.map(
    (c) => [cellContentLength(c), c.weight] as [number, number],
  );
  const level = waterLevel(pairs, needed);
  for (const cell of cells) {
    const content = cell.container[cell.contentKey];
    if (typeof content !== "string") continue;
    const codePoints = [...content];
    const allowed = Math.trunc(level * cell.weight);
    if (codePoints.length <= allowed) continue;
    cell.container[cell.flagKey] = true;
    // Never clobber a caller-set length (wiki_read pre-sets the full page
    // size so offset-paging works across truncated slices).
    if (!(cell.lengthKey in cell.container)) {
      cell.container[cell.lengthKey] = codePoints.length;
    }
    cell.container[cell.contentKey] = codePoints.slice(0, allowed).join("");
  }
}

/**
 * Drop one item from the tail of the longest target list.
 *
 * Tail = lowest-ranked entry of the shipped ordering. Records the running
 * total in `payload.truncation_dropped` so callers can surface that the
 * list was cut. Returns false when no list has items.
 *
 * Port of: response_budget.py _drop_tail_item.
 */
function dropTailItem(payload: Payload, targets: BudgetTarget[]): boolean {
  let longest: unknown[] | null = null;
  for (const target of targets) {
    if (target.kind !== "list") continue;
    const items = payload[target.key];
    if (Array.isArray(items) && items.length > 0) {
      if (longest === null || items.length > longest.length) {
        longest = items;
      }
    }
  }
  if (longest === null) return false;
  longest.pop();
  const dropped = payload["truncation_dropped"];
  payload["truncation_dropped"] = (typeof dropped === "number" ? dropped : 0) + 1;
  return true;
}

/**
 * Mutate `payload` in place until it serializes within budget.
 *
 * Passes: (1) water-fill truncation of target texts; (2) if every target
 * text is already empty, drop list items from the tail; (3) if nothing is
 * left to cut, return the payload as-is (a metadata-only overflow is a bug
 * upstream, not something to mask here).
 * Terminates: every pass strictly shrinks the payload or exhausts cuttable
 * material.
 *
 * Port of: response_budget.py bound_payload.
 */
export function boundPayload<T extends object>(
  payload: T,
  targets: BudgetTarget[],
  budgetChars: number = MAX_RESPONSE_CHARS,
): T {
  // Generic over the caller's concrete response type so handlers keep their
  // typed objects (RecallResponse, MethodologyResponse, WikiReadResult, …)
  // across the call. Internally the algorithm only ever reads/writes string
  // keys, so a single localized cast to the string-keyed Payload view is sound;
  // the object is mutated in place and the same reference is returned.
  const view = payload as Payload;
  for (;;) {
    const total = serializedLength(view);
    if (total <= budgetChars) return payload;
    const cells = collectCells(view, targets);
    const cuttable = cells.filter((c) => cellContentLength(c) > 0);
    if (cuttable.length > 0) {
      truncateCells(cuttable, total - budgetChars);
      continue;
    }
    if (!dropTailItem(view, targets)) return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
