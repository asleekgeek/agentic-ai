/**
 * scopes-types.ts — Scope type definition shared by scopes.ts and
 * scopes-guides.ts. Extracted so the two modules compose without
 * a circular import.
 *
 * source: cortex/mcp_server/core/wiki_coverage.py:Scope
 */

/**
 * One structural documentation scope.
 *
 * - ``anchorFilenames`` — wiki-relative filenames (without the domain
 *   segment) the coverage scan looks for. First substantive match
 *   counts as coverage.
 * - ``directories`` — wiki subtrees where pages of this scope live.
 * - ``suggestedKind`` — wiki ``kind`` frontmatter value the LLM should
 *   author missing anchor pages under.
 */
export interface Scope {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly anchorFilenames: readonly string[];
  readonly directories: readonly string[];
  readonly suggestedKind: string;
}
