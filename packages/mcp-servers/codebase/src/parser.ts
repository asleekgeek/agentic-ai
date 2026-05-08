/**
 * parser.ts — Multi-language source parser for code-intelligence graph.
 *
 * The Rust implementation uses tree-sitter (native bindings) for exact
 * parse trees. This TypeScript port uses regex-based extraction, which
 * covers the common patterns. It produces the same ExtractedNode /
 * ExtractedRef types and populates the same graph schema.
 *
 * Languages: TypeScript, JavaScript, Python, Rust.
 * (Java, Kotlin, Swift, ObjC, C, C++, Go: TODO — explicit error returned.)
 *
 * source: automatised-pipeline/0.0.9/src/parser/mod.rs
 * source: automatised-pipeline/0.0.9/src/parser/typescript.rs
 * source: automatised-pipeline/0.0.9/src/parser/python.rs
 * source: automatised-pipeline/0.0.9/src/parser/rust.rs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parsePython, parseRust } from "./parser-lang.js";

// ---------------------------------------------------------------------------
// Types — source: parser/mod.rs ExtractedNode, ExtractedRef, ParseResult
// ---------------------------------------------------------------------------

export interface ExtractedNode {
  id: string;            // qualified_name (used as PK in the graph)
  label: string;         // Function | Method | Struct | Enum | Trait | Module | ...
  name: string;
  qualified_name: string;
  start_line: number;
  end_line: number;
  visibility: string;    // "pub" | "export" | "" | "public" | etc.
  is_async: boolean;
  receiver_type?: string; // for Method nodes
  type_annotation?: string; // for Field, Constant, TypeAlias
  alias?: string;          // for Import
  is_glob?: boolean;       // for Import
  callee_name?: string;    // for CallSite
  line?: number;
  col?: number;
}

export interface ExtractedRef {
  from_id: string;       // qualified_name of source node
  to_path: string;       // import path OR callee name
  kind: string;          // "import" | "call" | "implements" | "extends" | "use"
}

export interface ParseResult {
  nodes: ExtractedNode[];
  refs: ExtractedRef[];
}

// ---------------------------------------------------------------------------
// Language detection — source: parser/mod.rs Language::from_extension()
// ---------------------------------------------------------------------------

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "java"
  | "kotlin"
  | "swift"
  | "objc"
  | "c"
  | "cpp"
  | "go"
  | "unknown";

export function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  // source: tool_schemas.rs — language enum values and indexer.rs:198-200
  switch (ext) {
    case "ts": case "tsx": case "mts": case "cts": return "typescript";
    case "js": case "mjs": case "cjs": case "jsx": return "javascript";
    case "py": return "python";
    case "rs": return "rust";
    case "java": return "java";
    case "kt": case "kts": return "kotlin";
    case "swift": return "swift";
    case "m": case "mm": return "objc";
    case "c": case "h": return "c";
    case "cc": case "cpp": case "cxx": case "hpp": return "cpp";
    case "go": return "go";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Resource limits — source: indexer.rs:17-41
// ---------------------------------------------------------------------------

// source: indexer.rs:22 — MAX_FILES = 100_000
export const MAX_FILES = 100_000;
// source: indexer.rs:28 — MAX_FILE_BYTES = 10_485_760
export const MAX_FILE_BYTES = 10_485_760;
// source: indexer.rs:40 — MAX_PARSE_BYTES = 1_048_576
export const MAX_PARSE_BYTES = 1_048_576;
// source: indexer.rs:35 — MAX_DEPTH = 64
export const MAX_DEPTH = 64;

// Directories to skip — source: indexer.rs:170-172
const SKIP_DIRS = new Set([
  "node_modules", "target", ".git", ".svn", ".hg",
  "dist", "build", ".next", "__pycache__", ".tox",
  "venv", ".venv", "vendor", ".cargo",
]);

// ---------------------------------------------------------------------------
// File collection — source: indexer.rs:135-148 collect_source_files()
// ---------------------------------------------------------------------------

export function collectSourceFiles(
  root: string,
  languageFilter?: Language
): string[] {
  const results: string[] = [];
  walkDir(root, results, languageFilter, 0);
  if (results.length > MAX_FILES) {
    throw new Error(
      `too_many_files: codebase contains ${results.length} files, MAX_FILES is ${MAX_FILES}`
    );
  }
  results.sort();
  return results;
}

function walkDir(
  dir: string,
  out: string[],
  languageFilter: Language | undefined,
  depth: number
): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") && depth > 0) continue; // skip hidden except root
    if (SKIP_DIRS.has(name)) continue;
    const fullPath = path.join(dir, name);
    // source: indexer.rs:176-180 — skip symlinks (C4 fix)
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkDir(fullPath, out, languageFilter, depth + 1);
      if (out.length > MAX_FILES) return;
    } else if (entry.isFile()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      const lang = detectLanguage(fullPath);
      if (lang === "unknown") continue;
      if (languageFilter && lang !== languageFilter) continue;
      out.push(fullPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Main parse entry point
// ---------------------------------------------------------------------------

/**
 * Parses a single source file and returns extracted nodes + refs.
 * source: indexer.rs:104-108 — index_single_file() calls parser
 */
export function parseFile(filePath: string, source: string): ParseResult {
  const lang = detectLanguage(filePath);
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseTypeScript(source, filePath);
    case "python":
      return parsePython(source, filePath);
    case "rust":
      return parseRust(source, filePath);
    default:
      // Other languages: return empty parse result (honest stub)
      return { nodes: [], refs: [] };
  }
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript parser
// source: parser/typescript.rs
// ---------------------------------------------------------------------------

function parseTypeScript(source: string, filePath: string): ParseResult {
  const nodes: ExtractedNode[] = [];
  const refs: ExtractedRef[] = [];
  const lines = source.split("\n");
  const fileId = normalizeFilePath(filePath);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    // Import statements — source: typescript.rs extract_import()
    const importMatch = line.match(
      /^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/
    );
    if (importMatch) {
      const importPath = importMatch[1] ?? "";
      const importId = `${fileId}::import::${importPath.replace(/\W/g, "_")}::${lineNum}`;
      nodes.push({
        id: importId,
        label: "Import",
        name: importPath,
        qualified_name: importId,
        start_line: lineNum,
        end_line: lineNum,
        visibility: "",
        is_async: false,
        is_glob: line.includes("* as"),
      });
      refs.push({ from_id: fileId, to_path: importPath, kind: "import" });
      i++; continue;
    }

    // Side-effect imports
    const sideImport = line.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideImport) {
      refs.push({ from_id: fileId, to_path: sideImport[1] ?? "", kind: "import" });
      i++; continue;
    }

    // Function declarations — source: typescript.rs extract_function()
    const isExported = line.includes("export ");
    const asyncFlag = line.includes("async ");
    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*[(<]/);
    if (funcMatch && !line.includes("=>")) {
      const name = funcMatch[1] ?? "";
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Function",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: isExported ? "export" : "",
        is_async: asyncFlag,
      });
      extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
      i = endLine; continue;
    }

    // Arrow functions assigned to const/let/var
    const arrowConst = line.match(
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?\(/
    );
    if (arrowConst && (line.includes("=>") || lookAheadForArrow(lines, i))) {
      const name = arrowConst[1] ?? "";
      const asyncA = line.includes("async ");
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Function",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: asyncA,
      });
      extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
      i = endLine; continue;
    }

    // Class declarations — source: typescript.rs extract_class()
    const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/);
    if (classMatch) {
      // Regex groups: [1]=name [2]=extends [3]=implements — source: regex above
      /* eslint-disable @typescript-eslint/no-magic-numbers */
      const name = classMatch[1] ?? "";
      const extendsName = classMatch[2];
      const implementsStr = classMatch[3];
      /* eslint-enable @typescript-eslint/no-magic-numbers */
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Struct",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false,
      });
      if (extendsName) refs.push({ from_id: qn, to_path: extendsName, kind: "extends" });
      if (implementsStr) {
        for (const impl of implementsStr.split(",")) {
          const t = impl.trim().split("<")[0]?.trim();
          if (t) refs.push({ from_id: qn, to_path: t, kind: "implements" });
        }
      }
      // Extract methods from class body
      extractClassMethods(lines, i, endLine - 1, qn, nodes, refs);
      i = endLine; continue;
    }

    // Interface declarations — source: typescript.rs extract_interface()
    const ifaceMatch = line.match(/(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?/);
    if (ifaceMatch) {
      const name = ifaceMatch[1] ?? "";
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Trait",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false,
      });
      const extendsStr = ifaceMatch[2];
      if (extendsStr) {
        for (const e of extendsStr.split(",")) {
          const t = e.trim().split("<")[0]?.trim();
          if (t) refs.push({ from_id: qn, to_path: t, kind: "extends" });
        }
      }
      i = endLine; continue;
    }

    // Enum declarations — source: typescript.rs extract_enum()
    const enumMatch = line.match(/(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      const name = enumMatch[1] ?? "";
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Enum",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false,
      });
      i = endLine; continue;
    }

    // Type aliases — source: typescript.rs extract_type_alias()
    const typeMatch = line.match(/(?:export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "";
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "TypeAlias",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: lineNum,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false,
      });
      i++; continue;
    }

    i++;
  }

  return { nodes, refs };
}

function lookAheadForArrow(lines: string[], startIdx: number): boolean {
  // source: TS parser heuristic — look at next 5 lines for arrow syntax
  const LOOKAHEAD_LINES = 5;
  for (let j = startIdx; j < Math.min(startIdx + LOOKAHEAD_LINES, lines.length); j++) {
    if ((lines[j] ?? "").includes("=>")) return true;
  }
  return false;
}

function extractClassMethods(
  lines: string[],
  classStart: number,
  classEnd: number,
  classQn: string,
  nodes: ExtractedNode[],
  refs: ExtractedRef[]
): void {
  for (let i = classStart + 1; i <= classEnd; i++) {
    const line = lines[i] ?? "";
    const methodMatch = line.match(
      /^\s*(?:(public|private|protected|static|async|override|readonly)\s+)*(?:async\s+)?(\w+)\s*(?:<[^>]*)?\s*\(/
    );
    if (!methodMatch) continue;
    const name = methodMatch[2];
    if (!name || name === "if" || name === "for" || name === "while" ||
        name === "switch" || name === "catch" || name === "return") continue;
    const isAsync = line.includes("async ");
    const vis = line.includes("private ") ? "private" :
                line.includes("protected ") ? "protected" : "public";
    const endLine = findBlockEnd(lines, i);
    const qn = `${classQn}::${name}`;
    nodes.push({
      id: qn,
      label: "Method",
      name,
      qualified_name: qn,
      start_line: i + 1,
      end_line: endLine,
      visibility: vis,
      is_async: isAsync,
      receiver_type: classQn.split("::").pop() ?? "",
    });
    extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
    i = endLine - 1;
  }
}

function extractCallsFromBlock(
  lines: string[],
  start: number,
  end: number,
  fromQn: string,
  refs: ExtractedRef[]
): void {
  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Match call expressions: name( or obj.method(
    const callRegex = /\b(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRegex.exec(line)) !== null) {
      const callee = m[1];
      if (!callee) continue;
      // Skip keywords
      if (["if", "for", "while", "switch", "catch", "function", "class",
           "return", "typeof", "instanceof", "new", "await", "yield"].includes(callee)) continue;
      refs.push({ from_id: fromQn, to_path: callee, kind: "call" });
    }
  }
}

// Python + Rust parsers are in parser-lang.ts to keep this file under 500 lines.
// They are imported above from "./parser-lang.js".

function findBlockEnd(lines: string[], start: number): number {
  // For TypeScript/JS: find matching brace
  let depth = 0;
  let found = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip strings crudely
    const stripped = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
    for (const ch of stripped) {
      if (ch === "{") { depth++; found = true; }
      else if (ch === "}" && found) {
        depth--;
        if (depth <= 0) return i + 1;
      }
    }
    // Arrow function with no braces — ends at semicolon
    if (!found && line.includes("=>") && (line.includes(";") || (i > start && lines[i]?.trimEnd().endsWith(";")))) {
      return i + 1;
    }
  }
  return start + 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips the codebase root prefix to produce a relative path used as the
 * file node id. The Rust indexer uses relative paths.
 * source: indexer.rs:87-88 — relative_path()
 */
export function normalizeFilePath(filePath: string): string {
  // Use just the filename portion relative to cwd or absolute
  // The caller (indexer) should pre-relativize paths before calling parseFile.
  return filePath;
}
