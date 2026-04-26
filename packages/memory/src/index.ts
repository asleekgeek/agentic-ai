/**
 * @agentic/memory — public API.
 *
 * Narrative subsystem: session extraction + narrative arc construction.
 */

// Types
export type {
  MemorableItem,
  MemoryRecord,
  NarrativeArc,
  NarrativeFunction,
  NarrativeFunctionType,
  NarrativeRequest,
  NarrativeResponse,
  SessionEvent,
  SessionRecord,
  SessionSummary,
} from "./narrative/types.js";

export {
  MemorableItemSchema,
  MemoryRecordSchema,
  NarrativeArcSchema,
  NarrativeFunctionSchema,
  NarrativeFunctionTypeSchema,
  NarrativeRequestSchema,
  NarrativeResponseSchema,
  SessionEventSchema,
  SessionRecordSchema,
  SessionSummarySchema,
} from "./narrative/types.js";

// Session extractor
export {
  classifyMessage,
  extractMemorableItems,
  extractSessionSummary,
  extractText,
  extractUserMessages,
  scoreImportance,
} from "./narrative/session-extractor.js";

// Narrative builder
export {
  arcFunctionSequence,
  detectArc,
  extractDecisions,
  extractEvents,
  extractHotTopics,
  extractTopEntities,
  generateBriefSummary,
  generateNarrative,
} from "./narrative/narrative-builder.js";

// Handler
export type { MemoryPort } from "./narrative/handlers/narrative.js";
export { narrativeHandler } from "./narrative/handlers/narrative.js";
