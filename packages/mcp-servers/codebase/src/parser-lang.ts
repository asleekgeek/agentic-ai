/**
 * parser-lang.ts — Python and Rust source parsers.
 *
 * Extracted from parser.ts to keep that file under the 500-line limit.
 * source: automatised-pipeline/0.0.9/src/parser/python.rs
 * source: automatised-pipeline/0.0.9/src/parser/rust.rs
 */

import type { ExtractedNode, ExtractedRef, ParseResult } from "./parser.js";

// ---------------------------------------------------------------------------
// Shared helpers (duplicated to avoid circular imports)
// ---------------------------------------------------------------------------

// source: parser.ts normalizeFilePath
function normalizeFilePath(filePath: string): string {
  return filePath;
}

// source: parser.ts extractCallsFromBlock
function extractCallsFromBlock(
  lines: string[],
  start: number,
  end: number,
  fromQn: string,
  refs: ExtractedRef[]
): void {
  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i] ?? "";
    const callRegex = /\b(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRegex.exec(line)) !== null) {
      const callee = m[1];
      if (!callee) continue;
      if (["if", "for", "while", "switch", "catch", "function", "class",
           "return", "typeof", "instanceof", "new", "await", "yield"].includes(callee)) continue;
      refs.push({ from_id: fromQn, to_path: callee, kind: "call" });
    }
  }
}

// ---------------------------------------------------------------------------
// Python parser — source: parser/python.rs
// ---------------------------------------------------------------------------

export function parsePython(source: string, filePath: string): ParseResult {
  const nodes: ExtractedNode[] = [];
  const refs: ExtractedRef[] = [];
  const lines = source.split("\n");
  const fileId = normalizeFilePath(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    // Import statements
    const importFrom = line.match(/^from\s+(\S+)\s+import\s+(.+)/);
    if (importFrom) {
      refs.push({ from_id: fileId, to_path: importFrom[1] ?? "", kind: "import" });
      i++; continue;
    }
    const importDirect = line.match(/^import\s+(\S+)/);
    if (importDirect) {
      refs.push({ from_id: fileId, to_path: importDirect[1] ?? "", kind: "import" });
      i++; continue;
    }

    // Function / method definitions
    const indentLevel = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const funcMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (funcMatch) {
      // Regex groups: [1]=indent [2]=name — source: regex above
      const name = funcMatch[2] ?? "";
      const isAsync = line.includes("async ");
      const endLine = findPythonBlockEnd(lines, i, indentLevel);
      const qn = `${fileId}::${name}`;
      const label = indentLevel > 0 ? "Method" : "Function";
      nodes.push({ id: qn, label, name, qualified_name: qn, start_line: lineNum, end_line: endLine,
                   visibility: name.startsWith("_") ? "private" : "pub", is_async: isAsync });
      extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
      i++; continue;
    }

    // Class definitions
    const classMatch = line.match(/^(\s*)class\s+(\w+)(?:\s*\(([^)]*)\))?/);
    if (classMatch && (classMatch[1]?.length ?? 0) === 0) {
      // Regex groups: [1]=indent [2]=name [3]=bases — source: regex above
      /* eslint-disable @typescript-eslint/no-magic-numbers */
      const name = classMatch[2] ?? "";
      const bases = classMatch[3];
      /* eslint-enable @typescript-eslint/no-magic-numbers */
      const endLine = findPythonBlockEnd(lines, i, 0);
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "Struct", name, qualified_name: qn, start_line: lineNum,
                   end_line: endLine, visibility: name.startsWith("_") ? "private" : "pub", is_async: false });
      if (bases) {
        for (const b of bases.split(",")) {
          const t = b.trim();
          if (t && t !== "object") refs.push({ from_id: qn, to_path: t, kind: "extends" });
        }
      }
      i++; continue;
    }
  }

  return { nodes, refs };
}

function findPythonBlockEnd(lines: string[], start: number, baseIndent: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= baseIndent) return i;
  }
  return lines.length;
}

// ---------------------------------------------------------------------------
// Rust parser — source: parser/rust.rs
// ---------------------------------------------------------------------------

export function parseRust(source: string, filePath: string): ParseResult {
  const nodes: ExtractedNode[] = [];
  const refs: ExtractedRef[] = [];
  const lines = source.split("\n");
  const fileId = normalizeFilePath(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    const useMatch = line.match(/^\s*(?:pub\s+)?use\s+([^;]+);/);
    if (useMatch) {
      const usePath = useMatch[1]?.trim() ?? "";
      const isGlob = usePath.endsWith("::*");
      const importId = `${fileId}::import::${usePath.replace(/\W/g, "_")}::${lineNum}`;
      nodes.push({ id: importId, label: "Import", name: usePath, qualified_name: importId,
                   start_line: lineNum, end_line: lineNum,
                   visibility: line.includes("pub use") ? "pub" : "", is_async: false, is_glob: isGlob });
      refs.push({ from_id: fileId, to_path: usePath, kind: "import" });
      continue;
    }

    const vis = line.includes("pub ") ? "pub" : line.includes("pub(crate)") ? "pub(crate)" : "";
    const funcMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*)?\s*\(/);
    if (funcMatch) {
      const name = funcMatch[1] ?? "";
      const isAsync = line.includes("async ");
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "Function", name, qualified_name: qn,
                   start_line: lineNum, end_line: endLine, visibility: vis, is_async: isAsync });
      extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
      i++; continue;
    }

    const structMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?\s*[{(;]/);
    if (structMatch) {
      const name = structMatch[1] ?? "";
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "Struct", name, qualified_name: qn,
                   start_line: lineNum, end_line: endLine, visibility: vis, is_async: false });
      i++; continue;
    }

    const enumMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)(?:<[^>]*>)?\s*\{/);
    if (enumMatch) {
      const name = enumMatch[1] ?? "";
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "Enum", name, qualified_name: qn,
                   start_line: lineNum, end_line: endLine, visibility: vis, is_async: false });
      i++; continue;
    }

    const traitMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?\s*(?::\s*[^{]+)?\s*\{/);
    if (traitMatch) {
      const name = traitMatch[1] ?? "";
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "Trait", name, qualified_name: qn,
                   start_line: lineNum, end_line: endLine, visibility: vis, is_async: false });
      i++; continue;
    }

    const typeMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=\s*([^;]+);/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "";
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "TypeAlias", name, qualified_name: qn,
                   start_line: lineNum, end_line: lineNum, visibility: vis, is_async: false,
                   type_annotation: typeMatch[2]?.trim() });
      continue;
    }

    const constMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)(?::\s*([^=]+))?\s*=/);
    if (constMatch) {
      const name = constMatch[1] ?? "";
      const qn = `${fileId}::${name}`;
      nodes.push({ id: qn, label: "Constant", name, qualified_name: qn,
                   start_line: lineNum, end_line: lineNum, visibility: vis, is_async: false,
                   type_annotation: constMatch[2]?.trim() });
      continue;
    }
  }

  return { nodes, refs };
}

function findRustBlockEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth <= 0) return i + 1;
      }
    }
  }
  return lines.length;
}
