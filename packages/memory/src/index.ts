/**
 * @agentic/memory — public API surface.
 *
 * Sub-modules are exported individually; import the sub-path directly for
 * tree-shaking: `import { applyRules } from "@agentic/memory/automation"`.
 *
 * The automation sub-module is the only one ported in this worktree (#12 in
 * the merge order). Other sub-modules (recall, remember, consolidation, etc.)
 * will be added by their respective worktrees.
 */
export * from "./automation/index.js";
