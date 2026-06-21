/**
 * Helpers for codebase-analyze — file walking, hashing, entity persistence.
 *
 * Ported from mcp_server/handlers/codebase_analyze_helpers.py
 */

import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";
import { EXT_TO_LANG } from "../codebase-parser.js";
import type { FileAnalysis } from "../types.js";

import type { MemoryStoreExt } from "../../remember/storage/memory-store.js";

// Re-export for callers that import the type from here.
export type { MemoryStoreExt as MemoryStore };

// Internal alias — callers that use the `any` escape hatch should migrate to
// MemoryStoreExt; for now we keep the local alias to minimise diff surface.
// LSP-VIOLATION CLOSED (#5): replaced store.execute() / store.acquireBatch()
// with store.getMemoriesByAgentContext() on the typed interface.
type MemoryStore = MemoryStoreExt;

export const CODEBASE_AGENT_CONTEXT = "codebase";
export const FILE_TAG_PREFIX = "file:";
export const HASH_TAG_PREFIX = "hash:";

// Bounded-candidate multiplier: we take at most `max_files * CANDIDATE_MULTIPLIER`
// paths from the directory walk before sorting. Source: ADR-0045 §R2 — bounded
// streaming for ingestion paths.
const CANDIDATE_MULTIPLIER = 10;

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  ".cargo",
  "vendor",
  ".tox",
  "coverage",
  ".mypy_cache",
  ".pytest_cache",
]);

// ── File walking ──────────────────────────────────────────────────────────

function* _walkDir(root: string): Generator<string> {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* _walkDir(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

/** Return true iff ``path`` is a source file we should keep. */
function _fileMatches(
  path: string,
  langFilter: ReadonlySet<string> | null,
  maxBytes: number,
): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  if (!lang) return false;
  if (langFilter && !langFilter.has(lang)) return false;
  try {
    const st = statSync(path);
    if (st.size > maxBytes) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Bounded-candidate walk: take ``maxFiles * CANDIDATE_MULTIPLIER`` paths
 * then sort for deterministic ordering. See ADR-0045 §R2.
 *
 * source: cortex main mcp_server/handlers/codebase_analyze_helpers.py::_collect_bounded
 */
function _collectBounded(
  root: string,
  langFilter: ReadonlySet<string> | null,
  maxFiles: number,
  maxBytes: number,
): string[] {
  const candidateCap = Math.max(maxFiles * CANDIDATE_MULTIPLIER, maxFiles);
  const candidates: string[] = [];
  for (const p of _walkDir(root)) {
    candidates.push(p);
    if (candidates.length >= candidateCap) break;
  }
  candidates.sort();

  const files: string[] = [];
  for (const p of candidates) {
    if (files.length >= maxFiles) break;
    if (_fileMatches(p, langFilter, maxBytes)) files.push(p);
  }
  return files;
}

/**
 * Walk the entire tree, filter, then sort. Memory O(filteredCount).
 *
 * source: cortex main mcp_server/handlers/codebase_analyze_helpers.py::_collect_unbounded
 */
function _collectUnbounded(
  root: string,
  langFilter: ReadonlySet<string> | null,
  maxBytes: number,
): string[] {
  const survivors: string[] = [];
  for (const p of _walkDir(root)) {
    if (_fileMatches(p, langFilter, maxBytes)) survivors.push(p);
  }
  survivors.sort();
  return survivors;
}

export function collectSourceFiles(
  root: string,
  languages: string[] | null | undefined,
  maxFiles: number,
  maxBytes: number,
): string[] {
  /**
   * Walk directory and collect source files matching language filters.
   *
   * Preconditions:
   *   - ``root`` is an existing directory.
   *   - ``maxBytes > 0``.
   *   - ``maxFiles`` may be any integer; ``<= 0`` means "no limit"
   *     and processes every matching file in the tree.
   *
   * Postconditions:
   *   - When ``maxFiles > 0``: returns at most ``maxFiles`` paths;
   *     peak memory is O(maxFiles * CANDIDATE_MULTIPLIER) paths
   *     (ADR-0045 §R2). On a 10M-file monorepo with maxFiles=5000
   *     we hold at most 50K paths during the sort.
   *   - When ``maxFiles <= 0``: returns every matching path; peak
   *     memory is O(filteredCount) — we never materialise the whole
   *     tree, only the post-filter survivors.
   *   - Each returned path is a regular file whose extension maps to
   *     a known language (and satisfies ``languages`` if supplied),
   *     and whose size is ``<= maxBytes``.
   *
   * source: cortex main mcp_server/handlers/codebase_analyze_helpers.py::collect_source_files
   */
  const langFilter =
    languages && languages.length > 0 ? new Set(languages) : null;
  if (maxFiles <= 0) return _collectUnbounded(root, langFilter, maxBytes);
  return _collectBounded(root, langFilter, maxFiles, maxBytes);
}

// ── Hash-based change detection ───────────────────────────────────────────

function _parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
  return [];
}

function _extractFileHash(tags: string[]): [string, string] {
  let filePath = "";
  let contentHash = "";
  for (const tag of tags) {
    if (typeof tag === "string") {
      if (tag.startsWith(FILE_TAG_PREFIX)) filePath = tag.slice(FILE_TAG_PREFIX.length);
      else if (tag.startsWith(HASH_TAG_PREFIX)) contentHash = tag.slice(HASH_TAG_PREFIX.length);
    }
  }
  return [filePath, contentHash];
}

/**
 * Load existing file→(memoryId, hash) map from the store.
 *
 * LSP-VIOLATION CLOSED (#5): previously called store.execute() (SQLite-only)
 * via an escape-hatch pattern that silently returned an empty Map on PG
 * (causing every PG run to be a full re-ingest with no incremental savings).
 * Now calls store.getMemoriesByAgentContext() which is on MemoryStoreExt and
 * implemented by both SqliteMemoryStore and PgMemoryStore.
 *
 * postcondition: returns Map from filePath → [memoryId, contentHash].
 *   Returns empty Map if no memories exist for the agent context (first run).
 *
 * source: cortex main mcp_server/handlers/codebase_analyze_helpers.py:loadExistingHashes
 */
export function loadExistingHashes(
  store: MemoryStore,
): Map<string, [number, string]> {
  const hashes = new Map<string, [number, string]>();
  try {
    // getMemoriesByAgentContext is defined on MemoryStoreExt — implemented
    // by both SqliteMemoryStore and PgMemoryStore without escape-hatch.
    const rows = store.getMemoriesByAgentContext(CODEBASE_AGENT_CONTEXT);
    for (const row of rows) {
      const memId = row.id;
      const tags = _parseTags(row.tags);
      const [fp, ch] = _extractFileHash(tags);
      if (fp && ch) hashes.set(fp, [memId, ch]);
    }
  } catch {
    // best-effort: returns empty Map on any error (first run behavior)
  }
  return hashes;
}

/**
 * Mark deleted file memories as stale.
 *
 * LSP-VIOLATION CLOSED (#5): previously called store.execute() (SQLite-only)
 * which silently failed on PG. Now calls store.markMemoryStale() which is
 * on the MemoryStore interface and implemented by both backends.
 *
 * The legacy `heat = 0` clause was redundant with `is_stale = TRUE`
 * — every scan filters `NOT is_stale` before the heat signal is
 * consulted, so the heat value on stale rows is never read. A3 drops
 * the redundant zeroing; the heat_base column keeps its last value.
 * source: phase-3-a3-migration-design.md §3.6.
 *
 * postcondition: returns memoryIds.length on success; 0 on error.
 */
export function markStale(store: MemoryStore, memoryIds: number[]): number {
  if (memoryIds.length === 0) return 0;
  try {
    for (const mid of memoryIds) {
      // markMemoryStale is on MemoryStore (base interface) — no escape-hatch needed.
      store.markMemoryStale(mid, true);
    }
    return memoryIds.length;
  } catch {
    return 0;
  }
}

// ── Entity persistence ────────────────────────────────────────────────────
//
// All entity persistence on PG MUST go through *Async methods: the sync
// variants on PgMemoryStore call _runSync() which always throws.
// Both SqliteMemoryStore and PgMemoryStore implement upsertEntityAsync,
// getEntityByNameAsync, and insertRelationshipAsync.
//
// Root-cause: PgMemoryStore.upsertEntity() → _runSync() → throws
//   "PgMemoryStore requires async execution." The exception propagated up
//   through the try/catch in persistEntities and was silently swallowed,
//   returning [0, 0] for every file. A 960-file run produced entities=0.
//
// Fix: make every entity persistence function async; call *Async siblings
// when available (sync fallback present but both backends now have wrappers).
// source: ADR-0042 — async path required for all PG entity writes.
// source: liskov@24cb6e2 — *Async-when-available, sync-fallback pattern.

// source: automatised-pipeline Rust source — symbol kinds emitted by the AST walker.
//   function_item→"function", impl methods→"method", struct_item→"struct",
//   enum_item→"enum", trait_item→"trait", class_declaration→"class",
//   interface_declaration→"interface", type_alias_declaration→"type", const→"constant".
// source: Cortex prod entity types — Method=30,822; Function=11,498; Struct=8,482.
// "method" added: Rust impl methods and JS class methods previously fell through
//   to "function" fallback, masking Method entity count.
const VALID_KINDS = new Set([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "trait",
  "protocol",
  "constant",
  "struct",
]);

async function _getOrCreateEntity(
  store: MemoryStore,
  name: string,
  entityType: string,
  domain: string,
): Promise<number> {
  // precondition:  store implements upsertEntityAsync (both SQLite and PG do).
  // postcondition: returns entity id > 0 for the named entity.
  try {
    const existing = store.getEntityByNameAsync
      ? await store.getEntityByNameAsync(name)
      : (store.getEntityByName(name) as Record<string, unknown> | null);
    if (existing) return (existing as Record<string, unknown>)["id"] as number;
  } catch {
    // fall through to upsert
  }
  // All entities created from codebase AST analysis (symbols, imports, files,
  // classes) are tagged origin='ast_symbol' — exempt from fuzzy entity dedup
  // (core.entity_dedup); identity is structural, not a fuzzy label.
  // source: cortex main mcp_server/handlers/codebase_analyze_helpers.py:208-226
  if (store.upsertEntityAsync) {
    return store.upsertEntityAsync(name, entityType, domain, "ast_symbol");
  }
  return store.upsertEntity(name, entityType, domain, "ast_symbol");
}

async function _persistSymbolEntities(
  store: MemoryStore,
  analysis: FileAnalysis,
  fileEid: number,
  domain: string,
  memoryId: number,
): Promise<[number, number]> {
  let entities = 0;
  let relationships = 0;
  for (const sym of analysis.definitions) {
    const kind = VALID_KINDS.has(sym.kind) ? sym.kind : "function";
    const symEid = await _getOrCreateEntity(store, sym.name, kind, domain);
    entities++;
    // source: cortex main mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
    // Links each extracted symbol entity back to the originating memory so
    // memory_entities join table is populated and dashboard entity panels render.
    try {
      if (store.linkMemoryEntityAsync) {
        await store.linkMemoryEntityAsync(memoryId, symEid);
      } else {
        store.linkMemoryEntity(memoryId, symEid);
      }
    } catch (err) {
      process.stderr.write(
        `[codebase-analyze] linkMemoryEntity failed for memory ${memoryId} / entity ${symEid}: ${(err as Error).message}\n`,
      );
    }
    try {
      if (store.insertRelationshipAsync) {
        await store.insertRelationshipAsync({
          source_entity_id: fileEid,
          target_entity_id: symEid,
          relationship_type: "defines",
          weight: 1.0,
        });
      } else {
        store.insertRelationship({
          source_entity_id: fileEid,
          target_entity_id: symEid,
          relationship_type: "defines",
          weight: 1.0,
        });
      }
      relationships++;
    } catch (err) {
      process.stderr.write(
        `[codebase-analyze] insertRelationship(defines) failed for ${analysis.path}→${sym.name}: ${(err as Error).message}\n`,
      );
    }
  }
  return [entities, relationships];
}

async function _persistImportEntities(
  store: MemoryStore,
  analysis: FileAnalysis,
  fileEid: number,
  domain: string,
  memoryId: number,
): Promise<[number, number]> {
  /**
   * Persist one dependency entity per named import symbol.
   *
   * Parity: cortex main mcp_server/codebase/codebase_parser.py:extractPythonImports
   *   Python emits one entity per named symbol (`from foo import A, B, C` → 3 entities).
   *   Each entity name is `module:symbol` (e.g. `foo:A`).
   *   Side-effect / namespace / empty imports fall back to the module name.
   *
   * Precondition:  imp.names is populated by extractJsImports (one name per ImportInfo).
   * Postcondition: each named symbol from each ImportInfo becomes a distinct dependency
   *   entity linked to fileEid via an "imports" relationship.
   *
   * source: cortex main mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
   * source: liskov@24cb6e2 — *Async-when-available pattern for PG/SQLite parity.
   */
  let entities = 0;
  let relationships = 0;
  for (const imp of analysis.imports) {
    // Determine which names to create entities for.
    // extractJsImports emits exactly one name per ImportInfo after the fix in 8ad9ced.
    // Python path (extractPythonImports) may emit multiple names per ImportInfo —
    // handle both conventions by iterating imp.names.
    const names = imp.names.length > 0 ? imp.names : [""];

    for (const sym of names) {
      // Entity name: `module:symbol` for named symbols; bare module for empty/wildcard.
      // source: cortex main mcp_server/codebase/codebase_parser.py — entity name is the symbol
      const entityName = sym && sym !== "*" ? `${imp.module}:${sym}` : imp.module;
      const depEid = await _getOrCreateEntity(store, entityName, "dependency", domain);
      entities++;
      // source: cortex main mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
      // Same link: import-module entities tied to the file memory that declares them.
      try {
        if (store.linkMemoryEntityAsync) {
          await store.linkMemoryEntityAsync(memoryId, depEid);
        } else {
          store.linkMemoryEntity(memoryId, depEid);
        }
      } catch (err) {
        process.stderr.write(
          `[codebase-analyze] linkMemoryEntity failed for memory ${memoryId} / entity ${depEid}: ${(err as Error).message}\n`,
        );
      }
      try {
        if (store.insertRelationshipAsync) {
          await store.insertRelationshipAsync({
            source_entity_id: fileEid,
            target_entity_id: depEid,
            relationship_type: "imports",
            weight: 1.0,
          });
        } else {
          store.insertRelationship({
            source_entity_id: fileEid,
            target_entity_id: depEid,
            relationship_type: "imports",
            weight: 1.0,
          });
        }
        relationships++;
      } catch (err) {
        process.stderr.write(
          `[codebase-analyze] insertRelationship(imports) failed for ${analysis.path}→${entityName}: ${(err as Error).message}\n`,
        );
      }
    }
  }
  return [entities, relationships];
}

/**
 * Persist caller→callee "calls" relationships from the callsPerFunction map.
 *
 * callsPerFunction is populated by extractCallsPerFunction (ast-extractors.ts)
 * for every file parsed via tree-sitter. Each key is a caller qualified name
 * (e.g. "MyClass.doSomething") and each value is a list of callee basenames.
 *
 * precondition:  analysis.callsPerFunction may be empty ({}) for regex-parsed files.
 * postcondition: returns [0, relationship_count]. entity_count is always 0 because
 *   caller and callee entities are already upserted by _persistSymbolEntities; this
 *   function only adds edges between existing entities.
 *
 * source: automatised-pipeline Rust codebase_parser — emits CALLS edges linking
 *   function/method entities. TS parity closes the method_calls_method gap.
 * source: packages/memory/src/codebase-analysis/ast-extractors.ts::extractCallsPerFunction
 */
async function _persistCallEdges(
  store: MemoryStore,
  analysis: FileAnalysis,
  _domain: string,
): Promise<[number, number]> {
  const callsPerFunction = analysis.callsPerFunction ?? {};
  const callerNames = Object.keys(callsPerFunction);
  if (callerNames.length === 0) return [0, 0];

  let relationships = 0;
  for (const callerName of callerNames) {
    const callees = callsPerFunction[callerName] ?? [];
    if (callees.length === 0) continue;

    // Resolve caller entity — only create edge if caller entity already exists.
    // Best-effort: skip if caller is not in the entity graph.
    let callerEid: number;
    try {
      const existing = store.getEntityByNameAsync
        ? await store.getEntityByNameAsync(callerName)
        : (store.getEntityByName(callerName) as Record<string, unknown> | null);
      if (!existing) continue;
      callerEid = (existing as Record<string, unknown>)["id"] as number;
    } catch {
      continue;
    }

    for (const calleeName of callees) {
      try {
        const calleeExisting = store.getEntityByNameAsync
          ? await store.getEntityByNameAsync(calleeName)
          : (store.getEntityByName(calleeName) as Record<string, unknown> | null);
        if (!calleeExisting) continue;
        const calleeEid = (calleeExisting as Record<string, unknown>)["id"] as number;

        if (store.insertRelationshipAsync) {
          await store.insertRelationshipAsync({
            source_entity_id: callerEid,
            target_entity_id: calleeEid,
            relationship_type: "calls",
            weight: 1.0,
          });
        } else {
          store.insertRelationship({
            source_entity_id: callerEid,
            target_entity_id: calleeEid,
            relationship_type: "calls",
            weight: 1.0,
          });
        }
        relationships++;
      } catch {
        // best-effort: skip individual edge failures
      }
    }
  }
  return [0, relationships];
}

export async function persistEntities(
  store: MemoryStore,
  analysis: FileAnalysis,
  memoryId: number,
  domain: string,
): Promise<[number, number]> {
  // precondition:  store implements *Async entity methods (both backends do).
  // postcondition: returns [entity_count, relationship_count] persisted.
  //   Returns [0, 0] only on unexpected error (logged to stderr).
  let entities = 0;
  let relationships = 0;
  try {
    const fileEid = await _getOrCreateEntity(store, analysis.path, "file", domain);
    entities++;
    // Link the file entity itself to the memory.
    // source: cortex main mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
    try {
      if (store.linkMemoryEntityAsync) {
        await store.linkMemoryEntityAsync(memoryId, fileEid);
      } else {
        store.linkMemoryEntity(memoryId, fileEid);
      }
    } catch (err) {
      process.stderr.write(
        `[codebase-analyze] linkMemoryEntity(file) failed for memory ${memoryId}: ${(err as Error).message}\n`,
      );
    }
    const [se, sr] = await _persistSymbolEntities(store, analysis, fileEid, domain, memoryId);
    entities += se;
    relationships += sr;
    const [ie, ir] = await _persistImportEntities(store, analysis, fileEid, domain, memoryId);
    entities += ie;
    relationships += ir;
    // Persist method→method call edges from callsPerFunction map.
    // source: automatised-pipeline Rust codebase_parser — emits CALLS edges between
    //   function/method entities. These are the "method_calls_method" relationships
    //   that close the workflow graph CALLS edge gap.
    const [, cr] = await _persistCallEdges(store, analysis, domain);
    relationships += cr;
  } catch (err) {
    // Unexpected error — log to stderr so failures aren't silent.
    process.stderr.write(
      `[codebase-analyze] persistEntities failed for ${analysis.path}: ${(err as Error).message}\n`,
    );
  }
  return [entities, relationships];
}

// ── Graph edge persistence ────────────────────────────────────────────────

export async function persistFileEdge(
  store: MemoryStore,
  edges: [string, string][],
  domain: string,
): Promise<number> {
  // precondition:  store implements *Async entity methods (both backends do).
  // postcondition: returns count of file-import edges successfully persisted.
  let count = 0;
  for (const [srcPath, tgtPath] of edges) {
    try {
      const srcEid = await _getOrCreateEntity(store, srcPath, "file", domain);
      const tgtEid = await _getOrCreateEntity(store, tgtPath, "file", domain);
      if (store.insertRelationshipAsync) {
        await store.insertRelationshipAsync({
          source_entity_id: srcEid,
          target_entity_id: tgtEid,
          relationship_type: "imports",
          weight: 1.0,
        });
      } else {
        store.insertRelationship({
          source_entity_id: srcEid,
          target_entity_id: tgtEid,
          relationship_type: "imports",
          weight: 1.0,
        });
      }
      count++;
    } catch (err) {
      process.stderr.write(
        `[codebase-analyze] persistFileEdge failed for ${srcPath}→${tgtPath}: ${(err as Error).message}\n`,
      );
    }
  }
  return count;
}

export async function persistInheritanceEdge(
  store: MemoryStore,
  edges: [string, string][],
  domain: string,
): Promise<number> {
  // precondition:  store implements *Async entity methods (both backends do).
  // postcondition: returns count of inheritance edges successfully persisted.
  let count = 0;
  for (const [child, parent] of edges) {
    try {
      const childEid = await _getOrCreateEntity(store, child, "class", domain);
      const parentEid = await _getOrCreateEntity(store, parent, "class", domain);
      if (store.insertRelationshipAsync) {
        await store.insertRelationshipAsync({
          source_entity_id: childEid,
          target_entity_id: parentEid,
          relationship_type: "extends",
          weight: 1.0,
        });
      } else {
        store.insertRelationship({
          source_entity_id: childEid,
          target_entity_id: parentEid,
          relationship_type: "extends",
          weight: 1.0,
        });
      }
      count++;
    } catch (err) {
      process.stderr.write(
        `[codebase-analyze] persistInheritanceEdge failed for ${child}→${parent}: ${(err as Error).message}\n`,
      );
    }
  }
  return count;
}

export async function persistCommunityTags(
  store: MemoryStore,
  communities: Map<string, number>,
): Promise<void> {
  if (communities.size === 0) return;
  // Get all codebase memories once and filter by filePath in JS.
  // This replaces the SQLite-only store.execute() pattern with
  // getMemoriesByAgentContext() which works on both backends.
  // source: codebase-analyze-helpers.ts — LSP violation #5 fix
  const allCodebaseMemories = (() => {
    try {
      return store.getMemoriesByAgentContext(CODEBASE_AGENT_CONTEXT);
    } catch {
      return [];
    }
  })();

  for (const [filePath, clusterId] of communities) {
    try {
      const rows = allCodebaseMemories.filter((r) =>
        typeof r.tags === "string" && r.tags.includes(filePath) ||
        store.getMemory?.(r.id as number)?.content?.includes(filePath),
      ) as Array<{ id: number; tags: string }>;
      for (const row of rows) {
        const tags = _parseTags(row.tags);
        const tag = `cluster:${clusterId}`;
        if (!tags.includes(tag)) {
          tags.push(tag);
          // Use updateMemoryContent (MemoryStore interface method — works on both backends).
          const mem = store.getMemory(row.id);
          if (mem) store.updateMemoryContent(row.id, mem.content, tags);
        }
      }
    } catch {
      // best-effort
    }
  }
}

export function resolveRelativePath(sourcePath: string, root: string): string {
  try {
    return relative(root, sourcePath) || sourcePath;
  } catch {
    return sourcePath;
  }
}
