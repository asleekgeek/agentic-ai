/**
 * Tests for extractJsImports — named-symbol parity fix.
 *
 * Verifies that `import { A, B, C } from 'mod'` emits THREE ImportInfo
 * entries (one per named symbol), matching Python parity:
 *   cortex@ed33435 mcp_server/codebase/codebase_parser.py:extractPythonImports
 *   — `from foo import A, B, C` → 3 entities, each linked to module `foo`.
 *
 * The tests use synthetic tree-sitter-shaped node objects.
 * extractJsImports only needs: .type, .children, .startIndex, .endIndex,
 * .childForFieldName — no native bindings required.
 *
 * source: cortex@ed33435 mcp_server/codebase/codebase_parser.py:extractPythonImports
 */

import { describe, expect, it } from "vitest";
import { extractJsImports } from "../../src/codebase-analysis/ast-extractors.js";

// ── Synthetic node builder ───────────────────────────────────────────────────

type MockNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  children: MockNode[];
  fields: Record<string, MockNode>;
  childForFieldName(name: string): MockNode | null;
};

/**
 * Create a mock tree-sitter node backed by a text slice in a Buffer.
 *
 * Precondition: text is a substring present at start in the source Buffer.
 * Postcondition: node.type === type; nodeText(node, source) returns text.
 */
function mkNode(
  type: string,
  text: string,
  bufferOffset: number,
  children: MockNode[] = [],
  fields: Record<string, MockNode> = {},
): MockNode {
  const node: MockNode = {
    type,
    startIndex: bufferOffset,
    endIndex: bufferOffset + Buffer.byteLength(text, "utf8"),
    children,
    fields,
    childForFieldName(name: string) {
      return this.fields[name] ?? null;
    },
  };
  return node;
}

/**
 * Build a synthetic parse tree and source Buffer for a set of import lines.
 *
 * Returns { root, source } ready for extractJsImports(root, source).
 */
function buildNamedImportTree(
  mod: string,
  symbols: string[],
): { root: MockNode; source: Buffer } {
  // Construct the raw source string so nodeText() resolves correctly.
  // Layout: `import { A, B, C } from 'mod'`
  const symbolList = symbols.join(", ");
  const rawSrc = `import { ${symbolList} } from '${mod}'`;
  const buf = Buffer.from(rawSrc, "utf8");

  // Build source node: `'mod'`
  const modText = `'${mod}'`;
  const modStart = rawSrc.indexOf(modText);
  const srcNode = mkNode("string", modText, modStart);

  // Build import_specifier nodes for each symbol.
  const specifiers: MockNode[] = symbols.map((sym) => {
    const symStart = rawSrc.indexOf(sym);
    const symNode = mkNode("identifier", sym, symStart);
    return mkNode("import_specifier", sym, symStart, [], { name: symNode });
  });

  // named_imports: `{ A, B, C }`
  const namedImportsText = `{ ${symbolList} }`;
  const namedStart = rawSrc.indexOf("{");
  const namedNode = mkNode("named_imports", namedImportsText, namedStart, specifiers);

  // import_clause: wraps named_imports
  const clauseStart = rawSrc.indexOf("{");
  const clauseNode = mkNode("import_clause", namedImportsText, clauseStart, [namedNode]);

  // import_statement: the full line
  const stmtNode = mkNode("import_statement", rawSrc, 0, [clauseNode, srcNode], {
    source: srcNode,
    import_clause: clauseNode,
  });

  const root: MockNode = {
    type: "program",
    startIndex: 0,
    endIndex: buf.length,
    children: [stmtNode],
    fields: {},
    childForFieldName: () => null,
  };

  return { root, source: buf };
}

function buildDefaultImportTree(
  mod: string,
  defaultName: string,
): { root: MockNode; source: Buffer } {
  const rawSrc = `import ${defaultName} from '${mod}'`;
  const buf = Buffer.from(rawSrc, "utf8");

  const modText = `'${mod}'`;
  const modStart = rawSrc.indexOf(modText);
  const srcNode = mkNode("string", modText, modStart);

  const idStart = rawSrc.indexOf(defaultName);
  const idNode = mkNode("identifier", defaultName, idStart);

  const clauseNode = mkNode("import_clause", defaultName, idStart, [idNode]);
  const stmtNode = mkNode("import_statement", rawSrc, 0, [clauseNode, srcNode], {
    source: srcNode,
    import_clause: clauseNode,
  });

  const root: MockNode = {
    type: "program",
    startIndex: 0,
    endIndex: buf.length,
    children: [stmtNode],
    fields: {},
    childForFieldName: () => null,
  };

  return { root, source: buf };
}

function buildSideEffectImportTree(mod: string): { root: MockNode; source: Buffer } {
  const rawSrc = `import '${mod}'`;
  const buf = Buffer.from(rawSrc, "utf8");

  const modText = `'${mod}'`;
  const modStart = rawSrc.indexOf(modText);
  const srcNode = mkNode("string", modText, modStart);

  // No import_clause field → side-effect import
  const stmtNode = mkNode("import_statement", rawSrc, 0, [srcNode], { source: srcNode });

  const root: MockNode = {
    type: "program",
    startIndex: 0,
    endIndex: buf.length,
    children: [stmtNode],
    fields: {},
    childForFieldName: () => null,
  };

  return { root, source: buf };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractJsImports — named imports (Residual 1 fix)", () => {
  it("emits THREE ImportInfo entries for import { A, B, C } from 'foo'", () => {
    const { root, source } = buildNamedImportTree("foo", ["A", "B", "C"]);
    const result = extractJsImports(root as unknown, source);

    expect(result).toHaveLength(3);

    const names = result.map((r) => r.names[0]);
    expect(names).toContain("A");
    expect(names).toContain("B");
    expect(names).toContain("C");

    // All must reference module 'foo'
    for (const info of result) {
      expect(info.module).toBe("foo");
      expect(info.isRelative).toBe(false);
    }
  });

  it("emits ONE entry with names=['Foo'] for default import", () => {
    const { root, source } = buildDefaultImportTree("bar", "Foo");
    const result = extractJsImports(root as unknown, source);

    expect(result).toHaveLength(1);
    expect(result[0]!.module).toBe("bar");
    expect(result[0]!.names).toEqual(["Foo"]);
  });

  it("emits ONE entry with names=[''] for side-effect import", () => {
    const { root, source } = buildSideEffectImportTree("polyfill");
    const result = extractJsImports(root as unknown, source);

    expect(result).toHaveLength(1);
    expect(result[0]!.module).toBe("polyfill");
    expect(result[0]!.names).toEqual([""]);
  });

  it("marks relative imports as isRelative=true", () => {
    const { root, source } = buildNamedImportTree("./utils", ["helper"]);
    const result = extractJsImports(root as unknown, source);

    expect(result).toHaveLength(1);
    expect(result[0]!.isRelative).toBe(true);
  });

  it("emits a single ImportInfo for a single named symbol", () => {
    const { root, source } = buildNamedImportTree("react", ["useState"]);
    const result = extractJsImports(root as unknown, source);

    expect(result).toHaveLength(1);
    expect(result[0]!.names[0]).toBe("useState");
    expect(result[0]!.module).toBe("react");
  });
});
