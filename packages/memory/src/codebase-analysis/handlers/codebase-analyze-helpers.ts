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
   *   - `root` is an existing directory.
   *   - `maxFiles > 0` and `maxBytes > 0`.
   *
   * Postconditions:
   *   - Returns at most `maxFiles` paths.
   *   - Peak memory footprint is O(maxFiles * CANDIDATE_MULTIPLIER) paths,
   *     not O(tree_size) — see ADR-0045 §R2.
   */
  const langFilter = languages && languages.length > 0 ? new Set(languages) : null;
  const candidateCap = Math.max(maxFiles * CANDIDATE_MULTIPLIER, maxFiles);

  // Collect bounded candidate set
  const candidates: string[] = [];
  for (const p of _walkDir(root)) {
    candidates.push(p);
    if (candidates.length >= candidateCap) break;
  }
  candidates.sort();

  const files: string[] = [];
  for (const p of candidates) {
    if (files.length >= maxFiles) break;
    const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
    const lang = EXT_TO_LANG[ext];
    if (!lang) continue;
    if (langFilter && !langFilter.has(lang)) continue;
    try {
      const st = statSync(p);
      if (st.size > maxBytes) continue;
    } catch {
      continue;
    }
    files.push(p);
  }
  return files;
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
 * source: cortex@ed33435 mcp_server/handlers/codebase_analyze_helpers.py:loadExistingHashes
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

const VALID_KINDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "trait",
  "protocol",
  "constant",
  "struct",
]);

function _getOrCreateEntity(
  store: MemoryStore,
  name: string,
  entityType: string,
  domain: string,
): number {
  try {
    const existing = store.getEntityByName(name) as Record<string, unknown> | null;
    if (existing) return existing["id"] as number;
  } catch {
    // fall through to insert
  }
  return store.upsertEntity(name, entityType, domain);
}

function _persistSymbolEntities(
  store: MemoryStore,
  analysis: FileAnalysis,
  fileEid: number,
  domain: string,
  memoryId: number,
): [number, number] {
  let entities = 0;
  let relationships = 0;
  for (const sym of analysis.definitions) {
    const kind = VALID_KINDS.has(sym.kind) ? sym.kind : "function";
    const symEid = _getOrCreateEntity(store, sym.name, kind, domain);
    entities++;
    // source: cortex@ed33435 mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
    // Links each extracted symbol entity back to the originating memory so
    // memory_entities join table is populated and dashboard entity panels render.
    try { store.linkMemoryEntity(memoryId, symEid); } catch { /* best-effort */ }
    try {
      store.insertRelationship({
        source_entity_id: fileEid,
        target_entity_id: symEid,
        relationship_type: "defines",
        weight: 1.0,
      });
      relationships++;
    } catch {
      // best-effort
    }
  }
  return [entities, relationships];
}

function _persistImportEntities(
  store: MemoryStore,
  analysis: FileAnalysis,
  fileEid: number,
  domain: string,
  memoryId: number,
): [number, number] {
  /**
   * Persist one dependency entity per named import symbol.
   *
   * Parity: cortex@ed33435 mcp_server/codebase/codebase_parser.py:extractPythonImports
   *   Python emits one entity per named symbol (`from foo import A, B, C` → 3 entities).
   *   Each entity name is `module:symbol` (e.g. `foo:A`).
   *   Side-effect / namespace / empty imports fall back to the module name.
   *
   * Precondition:  imp.names is populated by extractJsImports (one name per ImportInfo).
   * Postcondition: each named symbol from each ImportInfo becomes a distinct dependency
   *   entity linked to fileEid via an "imports" relationship.
   *
   * source: cortex@ed33435 mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
   */
  let entities = 0;
  let relationships = 0;
  for (const imp of analysis.imports) {
    // Determine which names to create entities for.
    // extractJsImports emits exactly one name per ImportInfo after the fix.
    // Python path (extractPythonImports) may emit multiple names per ImportInfo —
    // handle both conventions by iterating imp.names.
    const names = imp.names.length > 0 ? imp.names : [""];

    for (const sym of names) {
      // Entity name: `module:symbol` for named symbols; bare module for empty/wildcard.
      // source: cortex@ed33435 mcp_server/codebase/codebase_parser.py — entity name is the symbol
      const entityName = sym && sym !== "*" ? `${imp.module}:${sym}` : imp.module;
      const depEid = _getOrCreateEntity(store, entityName, "dependency", domain);
      entities++;
      // source: cortex@ed33435 mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
      // Same link: import-module entities tied to the file memory that declares them.
      try { store.linkMemoryEntity(memoryId, depEid); } catch { /* best-effort */ }
      try {
        store.insertRelationship({
          source_entity_id: fileEid,
          target_entity_id: depEid,
          relationship_type: "imports",
          weight: 1.0,
        });
        relationships++;
      } catch {
        // best-effort
      }
    }
  }
  return [entities, relationships];
}

export function persistEntities(
  store: MemoryStore,
  analysis: FileAnalysis,
  memoryId: number,
  domain: string,
): [number, number] {
  let entities = 0;
  let relationships = 0;
  try {
    const fileEid = _getOrCreateEntity(store, analysis.path, "file", domain);
    entities++;
    // Link the file entity itself to the memory.
    // source: cortex@ed33435 mcp_server/handlers/codebase_analyze_helpers.py:persist_entities
    try { store.linkMemoryEntity(memoryId, fileEid); } catch { /* best-effort */ }
    const [se, sr] = _persistSymbolEntities(store, analysis, fileEid, domain, memoryId);
    entities += se;
    relationships += sr;
    const [ie, ir] = _persistImportEntities(store, analysis, fileEid, domain, memoryId);
    entities += ie;
    relationships += ir;
  } catch {
    // best-effort
  }
  return [entities, relationships];
}

// ── Graph edge persistence ────────────────────────────────────────────────

export function persistFileEdge(
  store: MemoryStore,
  edges: [string, string][],
  domain: string,
): number {
  let count = 0;
  for (const [srcPath, tgtPath] of edges) {
    try {
      const srcEid = _getOrCreateEntity(store, srcPath, "file", domain);
      const tgtEid = _getOrCreateEntity(store, tgtPath, "file", domain);
      store.insertRelationship({
        source_entity_id: srcEid,
        target_entity_id: tgtEid,
        relationship_type: "imports",
        weight: 1.0,
      });
      count++;
    } catch {
      // best-effort
    }
  }
  return count;
}

export function persistInheritanceEdge(
  store: MemoryStore,
  edges: [string, string][],
  domain: string,
): number {
  let count = 0;
  for (const [child, parent] of edges) {
    try {
      const childEid = _getOrCreateEntity(store, child, "class", domain);
      const parentEid = _getOrCreateEntity(store, parent, "class", domain);
      store.insertRelationship({
        source_entity_id: childEid,
        target_entity_id: parentEid,
        relationship_type: "extends",
        weight: 1.0,
      });
      count++;
    } catch {
      // best-effort
    }
  }
  return count;
}

export function persistCommunityTags(
  store: MemoryStore,
  communities: Map<string, number>,
): void {
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
