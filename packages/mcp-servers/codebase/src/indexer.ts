/**
 * indexer.ts — Walk + Parse + Persist pipeline.
 *
 * TypeScript port of indexer.rs. Walks a codebase directory, parses source
 * files with the regex-based parser, and persists a code-intelligence graph
 * to PostgreSQL via GraphStore.
 *
 * source: automatised-pipeline/0.0.9/src/indexer.rs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { GraphStore } from "./graph-store.js";
import {
  collectSourceFiles,
  parseFile,
  type Language,
  MAX_PARSE_BYTES,
} from "./parser.js";

// ---------------------------------------------------------------------------
// Public types — source: indexer.rs:46-52 IndexResult
// ---------------------------------------------------------------------------

export interface IndexResult {
  graphId: string;
  graphPath: string; // = output_dir (used as the "graph_path" in MCP responses)
  nodeCount: number;
  edgeCount: number;
  filesIndexed: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Entry point — source: indexer.rs:62-122 index_codebase_with_language()
// ---------------------------------------------------------------------------

export async function indexCodebase(
  codebasePath: string,
  outputDir: string,
  languageFilter?: Language
): Promise<IndexResult> {
  const startMs = Date.now();

  // Resolve codebase path
  const absCodebase = path.resolve(codebasePath);
  const absOutput = path.resolve(outputDir);

  if (!fs.existsSync(absCodebase)) {
    throw new Error(`codebase path does not exist: ${absCodebase}`);
  }

  // Open or create graph
  const store = await GraphStore.create(
    absCodebase,
    absOutput,
    languageFilter ?? "auto"
  );

  // Collect source files
  const sourceFiles = collectSourceFiles(absCodebase, languageFilter);

  let filesIndexed = 0;

  // Insert File nodes for each file, plus Directory nodes
  const dirNodesInserted = new Set<string>();

  for (const filePath of sourceFiles) {
    const relPath = path.relative(absCodebase, filePath);
    const fileSize = (() => {
      try { return fs.statSync(filePath).size; } catch { return 0; }
    })();
    const ext = path.extname(filePath).slice(1);
    const fileName = path.basename(filePath);

    // Insert ancestor directory nodes — source: indexer.rs:99-101
    const parts = relPath.split(path.sep);
    let dirAcc = "";
    for (let d = 0; d < parts.length - 1; d++) {
      const part = parts[d];
      if (!part) continue;
      dirAcc = dirAcc ? path.join(dirAcc, part) : part;
      if (!dirNodesInserted.has(dirAcc)) {
        dirNodesInserted.add(dirAcc);
        await store.insertNode("Directory", {
          id: dirAcc,
          path: dirAcc,
          name: path.basename(dirAcc),
        });
        // Dir → Dir edge
        if (d > 0) {
          const parentDir = parts.slice(0, d).join(path.sep);
          await store.insertEdge("Contains_Dir_Dir", parentDir, dirAcc);
        }
      }
    }

    // Insert File node
    await store.insertNode("File", {
      id: relPath,
      path: relPath,
      name: fileName,
      extension: ext,
      size_bytes: fileSize,
    });

    // Dir → File edge — source: indexer.rs:103-104
    if (parts.length > 1) {
      const parentDir = parts.slice(0, parts.length - 1).join(path.sep);
      await store.insertEdge("Contains_Dir_File", parentDir, relPath);
    }

    // Parse and index the file
    let source: string;
    try {
      const raw = fs.readFileSync(filePath);
      if (raw.length > MAX_PARSE_BYTES) {
        process.stderr.write(`indexer: skipping oversized file (parse limit): ${relPath}\n`);
        continue;
      }
      source = raw.toString("utf8");
    } catch (e) {
      process.stderr.write(`indexer: failed to read ${relPath}: ${e}\n`);
      continue;
    }

    try {
      await indexSingleFile(store, source, relPath);
      filesIndexed++;
    } catch (e) {
      process.stderr.write(`indexer: error indexing ${relPath}: ${e}\n`);
    }
  }

  const nodeCount = await store.nodeCount();
  const edgeCount = await store.edgeCount();
  const elapsedMs = Date.now() - startMs;

  await store.updatePhase("indexed", { node_count: nodeCount, edge_count: edgeCount, files_indexed: filesIndexed, elapsed_ms: elapsedMs });

  return {
    graphId: store.graphId,
    graphPath: absOutput,
    nodeCount,
    edgeCount,
    filesIndexed,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Per-file indexing — source: indexer.rs:230-320 index_single_file()
// ---------------------------------------------------------------------------

async function indexSingleFile(
  store: GraphStore,
  source: string,
  relPath: string
): Promise<void> {
  const parsed = parseFile(relPath, source);
  if (parsed.nodes.length === 0 && parsed.refs.length === 0) return;

  // Bulk-insert nodes
  const nodesByLabel = new Map<string, Array<Record<string, unknown>>>();
  for (const node of parsed.nodes) {
    const bucket = nodesByLabel.get(node.label) ?? [];
    bucket.push({
      id: node.id,
      name: node.name,
      qualified_name: node.qualified_name,
      path: relPath,
      start_line: node.start_line ?? null,
      end_line: node.end_line ?? null,
      visibility: node.visibility ?? null,
      is_async: node.is_async ?? null,
      receiver_type: node.receiver_type ?? null,
      type_annotation: node.type_annotation ?? null,
      alias: node.alias ?? null,
      is_glob: node.is_glob ?? null,
      callee_name: node.callee_name ?? null,
      line: node.line ?? null,
      col: node.col ?? null,
    });
    nodesByLabel.set(node.label, bucket);
  }
  for (const [label, rows] of nodesByLabel) {
    await store.bulkInsertNodes(label, rows);
  }

  // Insert import edges — source: indexer.rs: Defines_File_Import
  for (const node of parsed.nodes) {
    if (node.label === "Import") {
      await store.insertEdge("Defines_File_Import", relPath, node.id);
    } else if (node.label === "Function") {
      await store.insertEdge("Defines_File_Function", relPath, node.id);
    } else if (node.label === "Struct") {
      await store.insertEdge("Defines_File_Struct", relPath, node.id);
    } else if (node.label === "Enum") {
      await store.insertEdge("Defines_File_Enum", relPath, node.id);
    } else if (node.label === "Trait") {
      await store.insertEdge("Defines_File_Trait", relPath, node.id);
    } else if (node.label === "Constant") {
      await store.insertEdge("Defines_File_Constant", relPath, node.id);
    } else if (node.label === "TypeAlias") {
      await store.insertEdge("Defines_File_TypeAlias", relPath, node.id);
    }
    // Method nodes: parent is a Struct/Enum node
    // We insert HasMethod edges during resolver pass
  }

  // Store refs as CallSite nodes for later resolution
  // (resolver.ts will convert them to Calls_ edges)
  const callSites: Array<Record<string, unknown>> = [];
  for (const ref of parsed.refs) {
    if (ref.kind === "call") {
      const csId = `${ref.from_id}::callsite::${ref.to_path}`;
      callSites.push({
        id: csId,
        callee_name: ref.to_path,
        line: 0,
        col: 0,
        // Store from_id and kind as extra info for resolver
        name: ref.from_id,
        qualified_name: `${ref.from_id}::${ref.to_path}`,
      });
    }
  }
  if (callSites.length > 0) {
    await store.bulkInsertNodes("CallSite", callSites);
  }
}
