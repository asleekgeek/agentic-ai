/**
 * project-roots.ts — auto-derive a project's source-root directory.
 *
 * Phase C of the auto-curation system needs ``project_root`` for two
 * jobs: resolving relative citations during drift detection, and
 * walking for uncovered source files during coverage scans.
 * Hard-coding ``project_root`` per project would require the user to
 * keep a separate config file in sync with their wiki domains, which
 * contradicts the "no human action" auto-doc directive. This module
 * resolves the path from the domain name + a configurable search base.
 *
 * Resolution order, first existing directory wins:
 *   1. process.env.CORTEX_PROJECT_ROOTS_BASE   — explicit override
 *   2. ~/Documents/Developments/<domain>       — the author's layout
 *   3. ~/Developments/<domain>                 — common Linux variant
 *   4. ~/projects/<domain>                     — IDE default
 *   5. ~/src/<domain>                          — older convention
 *
 * Returns null when no directory matches; callers skip drift/coverage
 * for that project rather than erroring.
 *
 * Pure-logic core (resolveProjectRoot) takes an injected
 * ``directoryExists`` predicate so tests are deterministic. Production
 * wires fs.statSync.
 *
 * User feedback 2026-05-18: "No deferral acceptable" — drift +
 * coverage must run automatically across consolidate, SessionStart,
 * and the dashboard, not just opt-in via curate_wiki args.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Candidate base directories searched in order. The first one whose
 * ``<base>/<domain>`` exists wins.
 *
 * source: this module — empirical author layout + common conventions
 */
function candidateBases(): string[] {
  const explicit = process.env["CORTEX_PROJECT_ROOTS_BASE"];
  if (explicit) return [explicit];
  const home = homedir();
  return [
    join(home, "Documents", "Developments"),
    join(home, "Developments"),
    join(home, "projects"),
    join(home, "src"),
  ];
}

/**
 * Resolve a project's source root. Returns the absolute path or null
 * when nothing matches.
 *
 * Pure: takes an injected directory-existence predicate. Tests inject a
 * deterministic stub; production wires the real fs check.
 *
 * source: this module — Phase C composition for drift + coverage
 */
export function resolveProjectRoot(
  domain: string,
  bases: readonly string[],
  directoryExists: (absPath: string) => boolean,
): string | null {
  if (!domain) return null;
  for (const base of bases) {
    const candidate = join(base, domain);
    if (directoryExists(candidate)) return candidate;
  }
  return null;
}

/** Default directory-existence predicate using fs. */
function defaultDirectoryExists(absPath: string): boolean {
  try {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Auto-resolve a project root using the default base list and fs check.
 * Returns null when no candidate matches.
 *
 * source: this module — production wrapper for resolveProjectRoot
 */
export function autoResolveProjectRoot(domain: string): string | null {
  return resolveProjectRoot(domain, candidateBases(), defaultDirectoryExists);
}
