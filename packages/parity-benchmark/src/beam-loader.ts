/**
 * BEAM dataset loader — port of cortex/benchmarks/beam/data.py + the
 * source-id flattening in cortex/benchmarks/beam/run_benchmark.py:147-209.
 *
 * The BEAM benchmark (Tavakoli et al., ICLR 2026, "Beyond a Million Tokens")
 * lives on HuggingFace as `Mohammadta/BEAM` (splits 100K/500K/1M). It is too
 * large + format-specific (Arrow/Parquet) to vendor or read from TS directly,
 * so the canonical 100K split is exported once to a flat JSON file by
 * cortex/benchmarks/beam/export_100k_json.py (a faithful dump that calls the
 * SAME load_beam_dataset() + extract_conversation_turns() +
 * parse_probing_questions() helpers the production runner uses). This loader
 * reads that JSON — exactly as locomo-loader.ts reads locomo10.json.
 *
 * It mirrors two Python concerns:
 *   1. turns → memories: turns_to_memories (data.py:160-242) — user/assistant
 *      pairs with a "[Date: …]" header, time-anchor propagation into created_at.
 *   2. question → gold: source_chat_ids flattening (run_benchmark.py:147-209) —
 *      list as-is, or dict-of-lists concatenated; the gold proxy is the set of
 *      80-char turn-content prefixes for those source turn ids, plus the answer.
 *
 * source: cortex main benchmarks/beam/data.py:114-242
 * source: cortex main benchmarks/beam/run_benchmark.py:147-274
 * source: Tavakoli et al. (2026). "Beyond a Million Tokens: Benchmarking and
 *   Enhancing Long-Term Memory in LLMs." ICLR 2026.
 */

import { readFileSync, existsSync } from "node:fs";

/** One conversation turn from the exported BEAM JSON. */
export interface BeamTurn {
  readonly id: number;
  readonly role: string;
  readonly content: string;
  readonly time_anchor: string;
  readonly plan_id: string;
}

/** One probing question (only the fields the retrieval proxy reads are typed). */
export interface BeamProbingQuestion {
  readonly question?: string;
  readonly answer?: string | null;
  /** list[int] OR dict-of-lists ({first_statement:[…], …}) OR null. */
  readonly source_chat_ids?: unknown;
}

/** One conversation object from the exported BEAM JSON. */
export interface BeamConversationRaw {
  readonly conversation_id: string;
  readonly turns: readonly BeamTurn[];
  readonly probing_questions: Readonly<Record<string, readonly BeamProbingQuestion[]>>;
}

/** A memory unit ready to seed (mirrors turns_to_memories output). */
export interface BeamMemory {
  /** "[Date: …] [user]: … \n[assistant]: …" blob ingested as one memory. */
  readonly content: string;
  /** Propagated time-anchor used as created_at; "" when none seen yet. */
  readonly created_at: string;
  /** Stage id (plan_id or time-anchor), kept for parity; not load-bearing here. */
  readonly plan_id: string;
}

/** A scored question with its gold proxy (source-prefix set + answer). */
export interface BeamQuestion {
  /** Ability bucket (e.g. "information_extraction"); the report "category". */
  readonly ability: string;
  readonly question: string;
  /** Lowercased, trimmed answer (may be ""). source: run_benchmark.py:213 */
  readonly answer_lower: string;
  /** Lowercased 80-char prefixes of source-turn contents. source: 203-209 */
  readonly source_prefixes: readonly string[];
  /** True only for abstention questions (special scoring). source: 215-223 */
  readonly is_abstention: boolean;
}

/** A conversation decomposed into its seed memories + scored questions. */
export interface BeamConversation {
  readonly conversation_id: string;
  readonly memories: readonly BeamMemory[];
  readonly questions: readonly BeamQuestion[];
}

// Source-turn content shorter than this is too generic to match on.
// source: cortex main benchmarks/beam/run_benchmark.py:208 (len(text) > 10)
const MIN_SOURCE_TURN_LEN = 10;

// Prefix length for the source-content match heuristic — balances specificity
// against prefix variation. source: cortex main run_benchmark.py:198-209 (text[:80])
const SOURCE_PREFIX_LEN = 80;

// Minimum answer length for substring matching. source: run_benchmark.py:229
// (len(answer_lower) > 2)
const MIN_ANSWER_LEN = 2;

/**
 * Flatten source_chat_ids to a flat list of turn ids.
 *
 * The field is either a list[int] (use as-is) or a dict whose values are
 * lists/ints (concat all). Anything else → empty.
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:147-157
 */
export function flattenSourceIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is number => typeof v === "number");
  }
  if (raw !== null && typeof raw === "object") {
    const ids: number[] = [];
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const x of v) if (typeof x === "number") ids.push(x);
      } else if (typeof v === "number") {
        ids.push(v);
      }
    }
    return ids;
  }
  return [];
}

/**
 * Convert conversation turns to memory units (user-assistant pairs).
 *
 * Mirrors turns_to_memories: walk turns, pair a user turn with the following
 * assistant turn (or take a lone turn), prepend "[Date: anchor]" only when the
 * pair originally carried a time_anchor, and propagate the most-recent anchor
 * forward into created_at so recency signals are meaningful.
 *
 * source: cortex main benchmarks/beam/data.py:160-242
 */
export function turnsToMemories(turns: readonly BeamTurn[]): BeamMemory[] {
  const memories: BeamMemory[] = [];
  let lastAnchor = "";
  let i = 0;
  while (i < turns.length) {
    let userContent = "";
    let assistantContent = "";

    const cur = turns[i];
    if (!cur) break;
    if (cur.role === "user") {
      userContent = cur.content;
      if (cur.time_anchor) lastAnchor = cur.time_anchor;
      const next = turns[i + 1];
      if (next && next.role === "assistant") {
        assistantContent = next.content;
        if (next.time_anchor) lastAnchor = next.time_anchor;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      assistantContent = cur.content;
      if (cur.time_anchor) lastAnchor = cur.time_anchor;
      i += 1;
    }

    // display_anchor: only set when the pair's original turns carried an anchor.
    // source: cortex main data.py:201-206
    let displayAnchor = "";
    const pairStart = Math.max(
      0,
      userContent && assistantContent ? i - 2 : i - 1,
    );
    for (let ti = pairStart; ti < Math.min(pairStart + 2, turns.length); ti++) {
      const ta = turns[ti]?.time_anchor;
      if (ta) {
        displayAnchor = ta;
        break;
      }
    }

    let content = "";
    if (displayAnchor) content += `[Date: ${displayAnchor}] `;
    if (userContent) content += `[user]: ${userContent}`;
    if (assistantContent) content += `\n[assistant]: ${assistantContent}`;

    if (content.trim()) {
      const turnPlan = turns[Math.max(0, i - 1)]?.plan_id ?? "";
      const stageId = turnPlan || (lastAnchor || "stage-0");
      memories.push({
        content: content.trim(),
        created_at: lastAnchor || "",
        plan_id: stageId,
      });
    }
  }
  return memories;
}

/**
 * Build the gold proxy for one probing question.
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:193-209
 */
function buildSourcePrefixes(
  sourceIds: readonly number[],
  turnById: Map<number, string>,
): string[] {
  const prefixes: string[] = [];
  const seen = new Set<string>();
  for (const id of sourceIds) {
    const text = turnById.get(id);
    if (!text || text.length <= MIN_SOURCE_TURN_LEN) continue;
    const prefix = text.slice(0, SOURCE_PREFIX_LEN).toLowerCase();
    if (!seen.has(prefix)) {
      seen.add(prefix);
      prefixes.push(prefix);
    }
  }
  return prefixes;
}

/**
 * Decompose one raw conversation into seed memories + scored questions.
 *
 * Mirrors the per-conversation body of run_benchmark.py:343-368 (memories) and
 * the per-question setup of evaluate_retrieval:139-209 (gold proxy). Questions
 * are kept only when they would be evaluated by the Python loop: abstention
 * always; everything else only when it has at least one source id.
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:135-209, 343-368
 */
export function decomposeConversation(
  conv: BeamConversationRaw,
): BeamConversation {
  const memories = turnsToMemories(conv.turns);
  const turnById = new Map<number, string>();
  for (const t of conv.turns) {
    if (typeof t.id === "number") turnById.set(t.id, t.content ?? "");
  }

  const questions: BeamQuestion[] = [];
  for (const [ability, rawQs] of Object.entries(conv.probing_questions)) {
    const qs = Array.isArray(rawQs) ? rawQs : [rawQs];
    for (const q of qs) {
      if (!q || typeof q !== "object") continue;
      const question = typeof q.question === "string" ? q.question : "";
      if (!question) continue;

      const sourceIds = flattenSourceIds(q.source_chat_ids);
      const isAbstention = ability === "abstention";
      // source: run_benchmark.py:160-161 — skip non-abstention without sources.
      if (sourceIds.length === 0 && !isAbstention) continue;

      const answer = typeof q.answer === "string" ? q.answer : "";
      const answerLower = answer.toLowerCase().trim();
      const sourcePrefixes = buildSourcePrefixes(sourceIds, turnById);

      questions.push({
        ability,
        question,
        answer_lower: answerLower,
        source_prefixes: sourcePrefixes,
        is_abstention: isAbstention,
      });
    }
  }
  return { conversation_id: conv.conversation_id, memories, questions };
}

/**
 * Decide whether a retrieved memory content is a hit for a question.
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:224-239
 */
export function isContentHit(
  question: BeamQuestion,
  contentLower: string,
): boolean {
  if (
    question.answer_lower &&
    question.answer_lower.length > MIN_ANSWER_LEN &&
    contentLower.includes(question.answer_lower)
  ) {
    return true;
  }
  for (const src of question.source_prefixes) {
    if (src && contentLower.includes(src)) return true;
  }
  return false;
}

/**
 * Locate the exported BEAM split JSON on disk.
 *
 * Searches in order:
 *   1. CORTEX_BEAM_PATH env var (explicit override)
 *   2. the sibling Cortex repo's benchmarks/beam/beam_<split>.json
 *
 * Returns null when not found; the caller decides whether to skip or fail.
 *
 * source: monorepo convention — sibling-repo path discovery (locomo-loader.ts)
 * source: cortex main benchmarks/beam/export_100k_json.py (output filename)
 */
// source: BEAM split identifier — 100K / 10M (Tavakoli et al., ICLR 2026)
export function findBeamDataset(split: string = "100K"): string | null {
  const explicit = process.env["CORTEX_BEAM_PATH"];
  if (explicit && existsSync(explicit)) return explicit;
  const file = `beam_${split}.json`;
  const candidates = [
    `/Users/cdeust/Developments/anthropic-partnership/Cortex/benchmarks/beam/${file}`,
    `/Users/cdeust/Developments/cortex/benchmarks/beam/${file}`,
    `../cortex/benchmarks/beam/${file}`,
    `../../cortex/benchmarks/beam/${file}`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Load an exported BEAM split JSON and decompose every conversation.
 *
 * precondition: path points to a readable JSON array matching the exported
 *   BEAM schema (one object per conversation: turns + probing_questions).
 * postcondition: returns one BeamConversation per array entry, in order.
 *
 * source: cortex main benchmarks/beam/run_benchmark.py:297-368 (load + per-conv).
 */
export function loadBeam(path: string): BeamConversation[] {
  const raw = readFileSync(path, "utf8");
  const convs = JSON.parse(raw) as BeamConversationRaw[];
  return convs.map(decomposeConversation);
}
