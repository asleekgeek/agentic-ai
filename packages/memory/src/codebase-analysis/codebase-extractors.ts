/**
 * Per-language import and symbol extractors for codebase analysis.
 *
 * Ported from mcp_server/core/codebase_extractors.py
 *
 * Regex-based heuristics for Python, TypeScript/JavaScript, Go, Rust,
 * and Swift. No AST parsing — works on raw text.
 *
 * Pure functions — no I/O, no state.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-magic-numbers */

import type { ImportInfo, SymbolDef } from "./types.js";
import { makeImportInfo, makeSymbolDef } from "./types.js";

// Signature truncation cap: 120 chars preserves the parameter list while bounding
//   entity name + signature storage. Same value as ast-extractors.ts:SIG_MAX_CHARS.
const SIG_MAX_CHARS = 120; // source: cortex main mcp_server/core/ast_extractors.py:_extract_python_func — sig[:120]

// ── Import patterns ───────────────────────────────────────────────────────

const PY_IMPORT = /^import\s+([\w.]+)/gm;
const PY_FROM_IMPORT = /^from\s+([\w.]+)\s+import\s+(.+?)$/gm;
const JS_IMPORT =
  /^import\s+(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gm;
const JS_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const GO_IMPORT_SINGLE = /^import\s+"([^"]+)"/gm;
const GO_IMPORT_BLOCK = /^import\s*\(([\s\S]*?)\)/gm;
const GO_IMPORT_LINE = /"([^"]+)"/g;
const RUST_USE = /^use\s+([\w:]+(?:::\{[^}]+\})?)/gm;
const SWIFT_IMPORT = /^import\s+(\w+)/gm;

// ── Symbol patterns ───────────────────────────────────────────────────────

// Top-level Python functions: not indented (no leading whitespace)
const PY_DEF = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
// Python methods: indented def (at least 1 whitespace before def)
// source: automatised-pipeline Rust codebase_parser — indented def → "method" kind
const PY_METHOD = /^[ \t]+(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
const PY_CLASS = /^\s*class\s+(\w+)(?:\(([^)]*)\))?/gm;

const JS_FUNC =
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
// Arrow function and function-expression assignments:
//   export const foo = async (x: T): ReturnType => { ... }
//   const bar = function(y) { ... }
// source: automatised-pipeline Rust codebase_parser — variable_declarator containing
//   arrow_function emits a function entity. Regex approximation for the fallback path.
// Match: const/let/var name = [async] ([...]) [: ReturnType] =>
// The return type annotation (after ')') may contain generics/brackets — we use
// a lazy match: capture up to '=>' on the same line.
const JS_ARROW_FUNC =
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)[^=\n]*=>/gm;
const JS_FUNC_EXPR =
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/gm;
// Method definitions inside class bodies (indented):
//   methodName(args) { ... }  or  async methodName(args) { ... }
// Requires at least 2 spaces / 1 tab of indentation to avoid matching top-level.
const JS_METHOD =
  /^[ \t]{2,}(?:(?:public|private|protected|static|async|override|get|set)\s+)*(\w+)\s*\(([^)]*)\)\s*[{:]/gm;
const JS_CLASS =
  /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/gm;
const JS_INTERFACE = /^(?:export\s+)?interface\s+(\w+)/gm;
const JS_TYPE = /^(?:export\s+)?type\s+(\w+)\s*=/gm;

// Go top-level functions (no receiver)
const GO_FUNC = /^func\s+(\w+)\s*\(([^)]*)\)/gm;
// Go receiver methods: func (r *Type) MethodName(...)
// source: automatised-pipeline Rust codebase_parser — method_declaration → "method" kind
const GO_METHOD = /^func\s+\([^)]+\)\s+(\w+)\s*\(([^)]*)\)/gm;
const GO_TYPE = /^type\s+(\w+)\s+(struct|interface)\b/gm;

const RUST_FN =
  /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*)?\s*\(([^)]*)\)/gm;
// Rust impl block methods (indented fn inside impl blocks)
// source: automatised-pipeline Rust AST parser — impl_item methods emit "method" kind.
const RUST_METHOD =
  /^[ \t]{2,4}(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*)?\s*\(([^)]*)\)/gm;
const RUST_STRUCT = /^(?:pub\s+)?struct\s+(\w+)/gm;
const RUST_ENUM = /^(?:pub\s+)?enum\s+(\w+)/gm;
const RUST_TRAIT = /^(?:pub\s+)?trait\s+(\w+)/gm;

const SWIFT_FUNC =
  /^\s*(?:public\s+|private\s+|internal\s+|open\s+|static\s+)*func\s+(\w+)\s*\(([^)]*)\)/gm;
const SWIFT_CLASS =
  /^\s*(?:public\s+|private\s+|open\s+|final\s+)*class\s+(\w+)/gm;
const SWIFT_STRUCT = /^\s*(?:public\s+|private\s+)*struct\s+(\w+)/gm;
const SWIFT_PROTOCOL = /^\s*(?:public\s+|private\s+)*protocol\s+(\w+)/gm;
const SWIFT_ENUM = /^\s*(?:public\s+|private\s+)*enum\s+(\w+)/gm;

// ── Docstring patterns ────────────────────────────────────────────────────

const PY_MODULE_DOC = /^(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/;
const JS_MODULE_DOC = /^\/\*\*([\s\S]*?)\*\//;

// ── Import extractors ────────────────────────────────────────────────────

function allMatches(re: RegExp, content: string): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(content)) !== null) results.push(m);
  return results;
}

export function extractImportsPython(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (const m of allMatches(PY_IMPORT, content)) {
    imports.push(makeImportInfo(m[1]!));
  }
  for (const m of allMatches(PY_FROM_IMPORT, content)) {
    const module = m[1]!;
    const names = m[2]!.split(",").map((n) => n.trim());
    imports.push(makeImportInfo(module, names, module.startsWith(".")));
  }
  return imports;
}

export function extractImportsJs(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (const m of allMatches(JS_IMPORT, content)) {
    const mod = m[1]!;
    imports.push(makeImportInfo(mod, [], mod.startsWith(".")));
  }
  for (const m of allMatches(JS_REQUIRE, content)) {
    const mod = m[1]!;
    imports.push(makeImportInfo(mod, [], mod.startsWith(".")));
  }
  return imports;
}

export function extractImportsGo(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (const m of allMatches(GO_IMPORT_SINGLE, content)) {
    imports.push(makeImportInfo(m[1]!));
  }
  for (const m of allMatches(GO_IMPORT_BLOCK, content)) {
    const block = m[1]!;
    for (const lm of allMatches(GO_IMPORT_LINE, block)) {
      imports.push(makeImportInfo(lm[1]!));
    }
  }
  return imports;
}

export function extractImportsRust(content: string): ImportInfo[] {
  return allMatches(RUST_USE, content).map((m) => makeImportInfo(m[1]!));
}

export function extractImportsSwift(content: string): ImportInfo[] {
  return allMatches(SWIFT_IMPORT, content).map((m) => makeImportInfo(m[1]!));
}

// ── Symbol extractors ─────────────────────────────────────────────────────

export function extractSymbolsPython(content: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  // Top-level functions (not indented)
  for (const m of allMatches(PY_DEF, content)) {
    defs.push(makeSymbolDef(m[1]!, "function", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  // Method definitions (indented def) — emit "method" kind
  // source: automatised-pipeline Rust codebase_parser — indented def inside class → method
  for (const m of allMatches(PY_METHOD, content)) {
    defs.push(makeSymbolDef(m[1]!, "method", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  for (const m of allMatches(PY_CLASS, content)) {
    defs.push(makeSymbolDef(m[1]!, "class", m[2] ?? ""));
  }
  return defs;
}

export function extractSymbolsJs(content: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  // Named function declarations
  for (const m of allMatches(JS_FUNC, content)) {
    defs.push(makeSymbolDef(m[1]!, "function", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  // Arrow function assignments: `const foo = () => {}`
  // source: automatised-pipeline Rust codebase_parser — variable_declarator
  //   containing arrow_function emits a function entity. Regex fallback path.
  const funcNames = new Set(defs.map((d) => d.name));
  for (const m of allMatches(JS_ARROW_FUNC, content)) {
    if (!funcNames.has(m[1]!)) {
      defs.push(makeSymbolDef(m[1]!, "function"));
      funcNames.add(m[1]!);
    }
  }
  // Function expression assignments: `const foo = function() {}`
  for (const m of allMatches(JS_FUNC_EXPR, content)) {
    if (!funcNames.has(m[1]!)) {
      defs.push(makeSymbolDef(m[1]!, "function"));
      funcNames.add(m[1]!);
    }
  }
  // Method definitions in class bodies (indented)
  // source: tree-sitter JS/TS grammar — method_definition in class_body
  const classNames = new Set<string>();
  for (const m of allMatches(JS_CLASS, content)) {
    defs.push(makeSymbolDef(m[1]!, "class", m[2] ?? ""));
    classNames.add(m[1]!);
  }
  const SKIP_METHODS = new Set([
    "if", "for", "while", "switch", "catch", "try", "do", "return",
    "const", "let", "var", "import", "export", "class", "function",
    "get", "set", "constructor",
  ]);
  for (const m of allMatches(JS_METHOD, content)) {
    const name = m[1]!;
    if (!SKIP_METHODS.has(name) && !funcNames.has(name)) {
      defs.push(makeSymbolDef(name, "method", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
    }
  }
  for (const m of allMatches(JS_INTERFACE, content)) {
    defs.push(makeSymbolDef(m[1]!, "interface"));
  }
  for (const m of allMatches(JS_TYPE, content)) {
    defs.push(makeSymbolDef(m[1]!, "type"));
  }
  return defs;
}

export function extractSymbolsGo(content: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  // Top-level functions (no receiver)
  for (const m of allMatches(GO_FUNC, content)) {
    defs.push(makeSymbolDef(m[1]!, "function", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  // Receiver methods: func (r *Type) Name(...) → "method" kind
  // source: automatised-pipeline Rust codebase_parser — method_declaration → "method" kind
  for (const m of allMatches(GO_METHOD, content)) {
    defs.push(makeSymbolDef(m[1]!, "method", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  for (const m of allMatches(GO_TYPE, content)) {
    // Go struct/interface type declarations
    // source: automatised-pipeline Rust codebase_parser — type_declaration → "struct" or "interface"
    const kind = m[2] === "struct" ? "struct" : "interface";
    defs.push(makeSymbolDef(m[1]!, kind));
  }
  return defs;
}

export function extractSymbolsRust(content: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  // Top-level functions (not indented)
  for (const m of allMatches(RUST_FN, content)) {
    defs.push(makeSymbolDef(m[1]!, "function", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  // Impl block methods (indented) — emit "method" kind
  // source: automatised-pipeline Rust AST parser — impl_item methods emit "method" kind.
  const topLevelFnNames = new Set(defs.map((d) => d.name));
  for (const m of allMatches(RUST_METHOD, content)) {
    if (!topLevelFnNames.has(m[1]!)) {
      defs.push(makeSymbolDef(m[1]!, "method", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
    }
  }
  // source: automatised-pipeline Rust AST parser — struct_item emits kind="struct".
  //   Previous mapping to "class" caused Struct entities to be miscounted.
  for (const m of allMatches(RUST_STRUCT, content)) {
    defs.push(makeSymbolDef(m[1]!, "struct"));
  }
  for (const m of allMatches(RUST_ENUM, content)) {
    defs.push(makeSymbolDef(m[1]!, "enum"));
  }
  for (const m of allMatches(RUST_TRAIT, content)) {
    defs.push(makeSymbolDef(m[1]!, "trait"));
  }
  return defs;
}

export function extractSymbolsSwift(content: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  for (const m of allMatches(SWIFT_FUNC, content)) {
    defs.push(makeSymbolDef(m[1]!, "function", (m[2] ?? "").slice(0, SIG_MAX_CHARS)));
  }
  for (const m of allMatches(SWIFT_CLASS, content)) {
    defs.push(makeSymbolDef(m[1]!, "class"));
  }
  // source: automatised-pipeline Rust AST parser — struct_item emits "struct" kind.
  for (const m of allMatches(SWIFT_STRUCT, content)) {
    defs.push(makeSymbolDef(m[1]!, "struct"));
  }
  for (const m of allMatches(SWIFT_PROTOCOL, content)) {
    defs.push(makeSymbolDef(m[1]!, "protocol"));
  }
  for (const m of allMatches(SWIFT_ENUM, content)) {
    defs.push(makeSymbolDef(m[1]!, "enum"));
  }
  return defs;
}

export function extractDocstring(content: string, language: string): string {
  if (language === "python") {
    const m = PY_MODULE_DOC.exec(content);
    if (m) return ((m[1] ?? m[2]) ?? "").trim().slice(0, 200);
  } else if (language === "javascript" || language === "typescript") {
    const m = JS_MODULE_DOC.exec(content);
    if (m) {
      const text = m[1]!.trim().replace(/^\s*\*\s?/gm, "");
      return text.trim().slice(0, 200);
    }
  }
  for (const line of content.split("\n").slice(0, 5)) {
    const stripped = line.trim();
    if (stripped.startsWith("#") && !stripped.startsWith("#!")) {
      return stripped.replace(/^#+\s*/, "").trim().slice(0, 200);
    }
    if (stripped.startsWith("//")) {
      return stripped.replace(/^\/+\s*/, "").trim().slice(0, 200);
    }
  }
  return "";
}

// ── Registry maps ─────────────────────────────────────────────────────────

export const IMPORT_EXTRACTORS: Record<string, (c: string) => ImportInfo[]> = {
  python: extractImportsPython,
  javascript: extractImportsJs,
  typescript: extractImportsJs,
  go: extractImportsGo,
  rust: extractImportsRust,
  swift: extractImportsSwift,
};

export const SYMBOL_EXTRACTORS: Record<string, (c: string) => SymbolDef[]> = {
  python: extractSymbolsPython,
  javascript: extractSymbolsJs,
  typescript: extractSymbolsJs,
  go: extractSymbolsGo,
  rust: extractSymbolsRust,
  swift: extractSymbolsSwift,
};
