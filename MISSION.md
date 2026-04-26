# Worktree Mission — `core-types`

> Phase 0 deliverable. This worktree produces the FROZEN type surface
> `@agentic/core` that every parallel Phase 4 worktree builds against.
> No code starts in a parallel worktree until this MISSION is signed off
> by `architect` + `liskov`.

---

## 1. Source

This worktree surveys types across four source repositories:

### 1.1 prd-spec-generator (TypeScript) — primary prior art
- **Repo**: `github.com/cdeust/prd-spec-generator`
- **Language**: TypeScript (strict)
- **Type files surveyed**:
  - `packages/core/src/domain/agent.ts` (AgentIdentity, GeniusAgent, TeamAgent, Claim, JudgeVerdict, JudgeRequest, SubagentInvocation, SubagentResponse)
  - `packages/core/src/domain/capabilities.ts` (Capabilities)
  - `packages/core/src/domain/clarification.ts` (ClarificationAnswer, ClarificationState)
  - `packages/core/src/domain/hard-output-rule.ts` (HardOutputRule, 64-member enum)
  - `packages/core/src/domain/prd-context.ts` (PRDContext, PRDContextConfig)
  - `packages/core/src/domain/prd-document.ts` (PRDSection, PRDDocument)
  - `packages/core/src/domain/section-type.ts` (SectionType, 17-member enum)
  - `packages/core/src/domain/thinking-strategy.ts` (ThinkingStrategy, StrategyTier)
  - `packages/core/src/domain/validation-result.ts` (HardOutputRuleViolation, ValidationReport, CrossRefValidationResult)
  - `packages/core/src/domain/verdict.ts` (Verdict, 5-level enum)
  - `packages/core/src/persistence/evidence-repository.ts` (StrategyExecution, PRDQualityScore, AdaptiveThreshold, StrategyPerformanceSummary)
- **Lines surveyed**: ~650 across domain files

### 1.2 Cortex (Python) — memory + reasoning + profile types
- **Repo**: `github.com/cdeust/Cortex`
- **Language**: Python 3.12 (Pydantic v2)
- **Type files surveyed**:
  - `mcp_server/shared/memory_types.py` (Memory, Entity, Relationship, ProspectiveTrigger, Checkpoint, MemoryArchive, ConsolidationLog, MemoryStats, RecallResult)
  - `mcp_server/shared/types.py` (ConversationMeta, MemoryMeta, GraphNode, GraphEdge, GraphData, TopSignal, BehavioralFeature, SparseActivation, AttributionNode, AttributionEdge, AttributionGraph, PersonaVector, PersistentFeature, FeatureDictionary)
  - `mcp_server/shared/types_profiles.py` (EntryPoint, RecurringPattern, ToolPreference, SessionShape, CognitiveStyle, GlobalStyle, Bridge, BlindSpot, DetectionContext, AlternativeDomain, DetectionResult, DomainProfile, ProfilesV2, SessionLogEntry, SessionLog)
  - `mcp_server/tool_registry_memory.py` (remember / recall tool schemas)
  - `mcp_server/handlers/recall.py` (RecallResult JSON schema)
  - `mcp_server/core/wiki_pages.py` (PageDocument, wiki kind enum: adr, spec, note, file_doc, lessons, conventions)

### 1.3 ai-automatised-pipeline (Rust) — codebase graph types
- **Repo**: `github.com/cdeust/anthropic/ai-automatised-pipeline`
- **Language**: Rust (serde_json JSON-Schema)
- **Type files surveyed**:
  - `src/tool_schemas.rs` (23 tool input schemas extracted as JSON Schema objects)
  - Tools: health_check, extract_finding, refine_finding, start_verification, append_clarification, finalize_verification, abort_verification, index_codebase, query_graph, get_symbol, resolve_graph, cluster_graph, get_processes, get_impact, search_codebase, get_context, analyze_codebase, lsp_resolve, prepare_prd_input, validate_prd_against_graph, check_security_gates, verify_semantic_diff, detect_changes

### 1.4 zetetic-team-subagents (Bash + MD) — agent identity
- **Repo**: `github.com/cdeust/zetetic-team-subagents`
- **Language**: Markdown (agent definitions), Bash (tooling)
- **Files surveyed**:
  - `agents/genius/*.md` — 97 genius agent files (each file = one GeniusAgent enum member)
  - `agents/*.md` — 19 team agent files (each file = one TeamAgent enum member)
  - `memory/templates/agent-memory-block.genius.md` — genius agent memory template
  - `memory/templates/agent-memory-block.team.md` — team agent memory template
- **Note**: Agent types already ported to prd-spec-generator `agent.ts`; this repo is
  the authoritative source for the enum member list.

---

## 2. Target

- **Target package**: `packages/core/src/`
- **Package name**: `@agentic/core`
- **Target language**: TypeScript (strict, NodeNext modules)
- **Runtime validation**: Zod 3.x — every public type has a co-located Zod schema

### 2.1 Public API surface (exported symbols)

**Memory domain** (`src/domain/memory/`):
- `MemorySchema`, `Memory`
- `RecallRequestSchema`, `RecallRequest`
- `RecallResponseSchema`, `RecallResponse`
- `RememberRequestSchema`, `RememberRequest`
- `RememberResponseSchema`, `RememberResponse`
- `MemoryStoreTypeSchema`, `MemoryStoreType`
- `MemorySourceSchema`, `MemorySource`

**Codebase domain** (`src/domain/codebase/`):
- `IndexCodebaseInputSchema`, `IndexCodebaseInput`
- `QueryGraphInputSchema`, `QueryGraphInput`
- `GetSymbolInputSchema`, `GetSymbolInput`
- `SearchCodebaseInputSchema`, `SearchCodebaseInput`
- `DetectChangesInputSchema`, `DetectChangesInput`
- `CodebaseLanguageSchema`, `CodebaseLanguage`
- `SymbolKindSchema`, `SymbolKind`

**Reasoning domain** (`src/domain/reasoning/`):
- `AgentIdentitySchema`, `AgentIdentity`
- `GeniusAgentSchema`, `GeniusAgent`
- `TeamAgentSchema`, `TeamAgent`
- `SubagentInvocationSchema`, `SubagentInvocation`
- `SubagentResponseSchema`, `SubagentResponse`
- `ThinkingStrategySchema`, `ThinkingStrategy`

**PRD domain** (`src/domain/prd/`):
- `PRDContextSchema`, `PRDContext`
- `PRDSectionSchema`, `PRDSection`
- `PRDDocumentSchema`, `PRDDocument`
- `SectionTypeSchema`, `SectionType`
- `ClaimSchema`, `Claim`
- `JudgeVerdictSchema`, `JudgeVerdict`
- `JudgeRequestSchema`, `JudgeRequest`
- `VerdictSchema`, `Verdict`
- `HardOutputRuleSchema`, `HardOutputRule`
- `ClarificationAnswerSchema`, `ClarificationAnswer`

**Cross-cutting** (`src/domain/common/`):
- `ISODateTimeSchema`
- `NonNegativeIntSchema`
- `ConfidenceScoreSchema`
- `UUIDSchema`

### 2.2 Ports provided (`src/ports/`):
- `MemoryPort` — recall + remember
- `CodebasePort` — index + query + detect-changes
- `ReasoningPort` — invoke a subagent
- `PRDPort` — start_pipeline + submit_action_result

### 2.3 Ports consumed: none (core has no upstream dependencies)

---

## 3. Acceptance Contract

### 3.1 Completeness
- [ ] Every type in `design/TYPE_INVENTORY.md` maps to exactly one type in `design/CORE_TYPESPACE.md`.
- [ ] No parallel worktree import hits a missing type (verified by `tsc --noEmit` across all worktrees).

### 3.2 Economy (Pāṇinian)
- [ ] No two types in the type space are semantically equivalent.
- [ ] Every type is constructable from composition of smaller types in this package (no opaque monoliths).
- [ ] Coverage ratio: types-generated / schemas-written >= 2.5 (achieved through union/intersection composition).

### 3.3 Freeze compliance
- [ ] `design/FREEZE_RULES.md` defines the amendment process.
- [ ] No parallel worktree has modified `packages/core/src/` directly (enforced by CODEOWNERS).

### 3.4 Type contracts
- [ ] No `any`, no `unknown` outside explicit `z.unknown()` boundaries.
- [ ] `liskov`: every Port adapter substitutable; no postcondition weakened.
- [ ] `tsc --strict` passes.

### 3.5 Layer rules
- [ ] `packages/core/` imports: `zod` only (no infrastructure, no node:fs, no network).
- [ ] `packages/core/src/ports/` declares interfaces only; zero implementations.

---

## 4. Genius Panel

- **`panini`** — Type space completeness + economy audit. Signs off that the rule system generates every valid entity and no invalid one. **Sign-off**: ☐
- **`liskov`** — Port substitutability. Every adapter can substitute for the port without weakening postconditions. **Sign-off**: ☐
- **`feynman`** — Rederive at least one Zod schema from the Pydantic source and confirm semantic equivalence. **Sign-off**: ☐
- **`code-reviewer`** — coding-standards.md §1–§10 compliance. **Sign-off**: ☐

---

## 5. Findings & Actions

| ID | Severity | Pattern | Description | Status |
|---|---|---|---|---|
| F-001 | MED | reconciliation | Cortex `Memory.id` is `int \| None`; unified as `number \| null` with Zod `.nullable()` | closed |
| F-002 | MED | reconciliation | `RecallResponse` differs between Cortex (full Memory object) and prd-spec-generator (excerpt string); unified as array of `RecallResultItem` with both shapes represented | closed |
| F-003 | LOW | gap | No `WikiPage` / `KindSchema` type existed in TS ecosystem; introduced from Cortex wiki_pages.py `kind` enum | closed |

---

## 6. Merge Conditions

1. §3.1–§3.5 all checked.
2. Genius panel signed off.
3. All CRIT/HIGH findings closed.
4. Human reviewer approves PR.

Merge order: `port/core-types` merges BEFORE any parallel Phase 4 worktree.

---

## 7. Daily Log

- **2026-04-26**: Initial type inventory, unified type space, ports, and freeze rules authored. Package skeleton created. All four source repos surveyed.
