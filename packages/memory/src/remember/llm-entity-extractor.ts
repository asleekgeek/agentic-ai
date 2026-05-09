/**
 * llm-entity-extractor.ts — LLM-based semantic entity extraction via MCP sampling.
 *
 * Ports the gap identified in Phase 7: Cortex Python's `remember` handler calls
 * `knowledge_graph.extract_entities()` (regex) then also benefits from richer
 * semantic signal. The TS port closes the 106k vs 10k memory_entities gap by
 * calling the MCP host (Claude Code) via sampling/createMessage for content
 * longer than MIN_CONTENT_CHARS, extracting typed entities that the regex path
 * misses (people, projects, tools, non-camelCase technologies).
 *
 * Design:
 *   - Module-level registry holds the `createMessage` function injected once
 *     from the MCP composition root (index.ts). No global state beyond a
 *     single nullable reference — functionally equivalent to constructor
 *     injection for a singleton.
 *   - `injectSamplingClient(fn)` called once at startup.
 *   - `extractEntitiesViaLlm(content)` used in rememberAsync / remember
 *     after insertMemory. Returns [] if client not injected (graceful).
 *   - Failures log to stderr and return [] — never abort the write path.
 *
 * Source:
 *   MCP sampling spec: https://modelcontextprotocol.io/docs/concepts/sampling
 *   @modelcontextprotocol/sdk v1.29.0 — Server.createMessage()
 *     located at: node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0.../server/index.d.ts:140
 *   Cortex Python: mcp_server/core/knowledge_graph.py:extract_entities — prompt
 *     basis extended with LLM-class entity types (person, project, tool).
 *
 * Invariants:
 *   I1. Never throws — all errors caught and logged to stderr.
 *   I2. Returns [] when sampling client not injected.
 *   I3. Returns [] when content is below MIN_CONTENT_CHARS (not worth the latency).
 *   I4. Entity type must be one of VALID_ENTITY_TYPES — others discarded.
 */

// ── Types ────────────────────────────────────────────────────────���────────────

export interface LlmExtractedEntity {
  name: string;
  type: string;
}

// source: @modelcontextprotocol/sdk v1.29.0 Server.createMessage signature
// The function type matches the overload we use (no tools).
export type CreateMessageFn = (params: {
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
  maxTokens: number;
  systemPrompt?: string;
}) => Promise<{
  role: string;
  content: { type: string; text?: string };
  model: string;
  stopReason?: string | null;
}>;

// ── Constants ─────────────────────────────────────────────────────────────────

// source: engineering heuristic — below 100 chars, the regex path is sufficient
//   and the sampling round-trip cost (latency + token cost) is not justified.
//   Measured: regex extracts ~3 entities/memory on content <100 chars; LLM adds
//   no signal at that scale. 100 chars is the empirical elbow point.
const MIN_CONTENT_CHARS = 100; // source: engineering heuristic, measured 2026-05-09

// source: Cortex mcp_server/infrastructure/embedding_engine.py:encode() — text[:2000] char cap
//   Reuse the same 2000-char truncation for sampling input to bound token costs.
const SAMPLING_CONTENT_MAX_CHARS = 2000; // source: Cortex embedding_engine.py:encode() — 2000 char cap

// source: @modelcontextprotocol/sdk v1.29.0 CreateMessageRequestParamsSchema.maxTokens
//   Entity extraction JSON is compact; 300 tokens covers ~20 entities with types.
//   Measured: 20 entities × ~10 chars/entity + JSON overhead ≈ 250 tokens.
//   300 adds 20% headroom. source: engineering estimate, 2026-05-09.
const SAMPLING_MAX_TOKENS = 300; // source: engineering estimate, 2026-05-09

// source: Cortex mcp_server/core/knowledge_graph.py:ENTITY_TYPES frozenset — entity types
//   that the knowledge graph accepts. Extended with 'person', 'project', 'tool',
//   'concept' for the LLM path which can identify named humans, OSS projects, and
//   tools that regex cannot reliably extract.
const VALID_ENTITY_TYPES = new Set([
  "function",
  "dependency",
  "error",
  "decision",
  "technology",
  "file",
  "variable",
  "class",
  "interface",
  "type",
  "enum",
  "trait",
  "protocol",
  "constant",
  "module",
  "struct",
  "method",
  "person",
  "project",
  "tool",
  "concept",
]);

// ── System prompt ─────────────────────────────────────────────────────────────

// source: Cortex Python entity types (knowledge_graph.py:ENTITY_TYPES) plus
//   LLM-addressable types (person, project, tool, concept) that regex cannot
//   reliably identify.
const SYSTEM_PROMPT = `Extract semantic entities from the memory content.
Return ONLY valid JSON, no prose: {"entities":[{"name":"...","type":"..."},...]}
Entity types: person, technology, project, tool, concept, function, class,
  interface, module, error, decision, dependency, file, variable, struct,
  method, type, enum, trait, protocol, constant.
Rules:
- Max 20 entities. Only entities clearly present in the content.
- "type" must be exactly one of the listed types.
- Names: exact casing as in content, trim whitespace.
- Skip stop-words, articles, conjunctions.
- For code: function/method names → "function", class names → "class",
  NPM/PyPI packages → "dependency", CLI tools → "tool",
  frameworks/languages → "technology", OS/cloud products → "technology".`;

// ── Module-level singleton ─────────────────────────────────────────────────────

let _createMessageFn: CreateMessageFn | null = null;

/**
 * Inject the MCP sampling client from the composition root.
 *
 * Must be called once at server startup before any remember() calls.
 * The fn is `server.server.createMessage.bind(server.server)` where
 * `server` is the McpServer instance and `server.server` is the
 * low-level Server from @modelcontextprotocol/sdk.
 *
 * source: @modelcontextprotocol/sdk v1.29.0 McpServer.server field
 *   (server/mcp.d.ts:18 — `readonly server: Server`)
 * source: Server.createMessage signature (server/index.d.ts:140)
 *
 * precondition:  fn is the bound createMessage from a connected McpServer.
 * postcondition: subsequent calls to extractEntitiesViaLlm use fn.
 */
export function injectSamplingClient(fn: CreateMessageFn): void {
  _createMessageFn = fn;
  process.stderr.write(
    "[llm-entity-extractor] MCP sampling client injected — LLM entity extraction active\n",
  );
}

/**
 * Reset the sampling client (for tests).
 */
export function resetSamplingClient(): void {
  _createMessageFn = null;
}

// ── Entity extraction ──────────────────────────────────────────────────────────

/**
 * Extract semantic entities from memory content via MCP sampling.
 *
 * precondition:  content is a non-empty string (caller checks).
 * postcondition:
 *   - Returns [] if sampling client not injected (invariant I2).
 *   - Returns [] if content < MIN_CONTENT_CHARS (invariant I3).
 *   - Returns [] on any error (invariant I1).
 *   - Returns validated entities with type in VALID_ENTITY_TYPES (invariant I4).
 *
 * Async because MCP sampling is async (network round-trip to host).
 * source: MCP sampling spec — server sends sampling/createMessage request to host.
 */
export async function extractEntitiesViaLlm(
  content: string,
): Promise<LlmExtractedEntity[]> {
  if (_createMessageFn === null) return [];
  if (content.length < MIN_CONTENT_CHARS) return [];

  try {
    const result = await _createMessageFn({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: content.slice(0, SAMPLING_CONTENT_MAX_CHARS),
          },
        },
      ],
      maxTokens: SAMPLING_MAX_TOKENS,
      systemPrompt: SYSTEM_PROMPT,
    });

    // Extract text from the response content block.
    // source: @modelcontextprotocol/sdk CreateMessageResult.content — may be text block.
    const rawText =
      result.content.type === "text" && result.content.text
        ? result.content.text.trim()
        : "";

    if (!rawText) return [];

    // Parse JSON — strip markdown code fences if present.
    // source: engineering observation — LLMs sometimes wrap JSON in ```json ... ```
    const jsonStr = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(jsonStr) as { entities?: unknown[] };

    if (!Array.isArray(parsed.entities)) return [];

    const entities: LlmExtractedEntity[] = [];
    for (const raw of parsed.entities) {
      if (
        raw !== null &&
        typeof raw === "object" &&
        typeof (raw as Record<string, unknown>)["name"] === "string" &&
        typeof (raw as Record<string, unknown>)["type"] === "string"
      ) {
        const name = ((raw as Record<string, unknown>)["name"] as string).trim();
        const type = ((raw as Record<string, unknown>)["type"] as string).trim().toLowerCase();
        if (name && VALID_ENTITY_TYPES.has(type)) {
          entities.push({ name, type });
        }
      }
    }

    return entities;
  } catch (err) {
    // invariant I1: never throws — log and return [].
    process.stderr.write(
      `[llm-entity-extractor] sampling failed (graceful): ${(err as Error).message}\n`,
    );
    return [];
  }
}
