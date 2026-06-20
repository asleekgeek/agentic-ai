/**
 * Domain resolution for the remember handler.
 *
 * Port of Cortex mcp_server/handlers/remember.py:_resolve_domain (lines 200-220).
 * Resolves the domain a memory belongs to from an optional working directory
 * and/or an optional explicit domain hint, in priority order:
 *
 *   1. git-root / cwd resolution of `directory` (most reliable — Shannon: cwd is
 *      the minimum sufficient statistic for domain identity);
 *   2. normalization of an explicit `domain` hint;
 *   3. best-effort profile-based detection from `directory`, then hint-normalize
 *      the detected domain;
 *   4. otherwise '' (empty — caller falls through to its own default).
 *
 * This is a composition helper (handler layer): like the Python original it
 * wires the shared domain-mapping resolvers to the infrastructure profile store
 * and the methodology domain detector. The remember handler currently sets
 * `domain` verbatim from `args.domain`; this restores the Cortex behaviour.
 *
 * source: cortex mcp_server/handlers/remember.py:200-220 (_resolve_domain)
 *         + mcp_server/shared/domain_mapping.py:resolve_cwd / resolve_domain
 */

import { resolveCwd, resolveDomain as resolveHint } from "../shared/domain-mapping.js";
import { loadProfiles } from "../infrastructure/profile-store.js";
import { detectDomain } from "../methodology/domain-detector.js";
import type { ProfilesStore } from "../methodology/types.js";

/**
 * Resolve the canonical domain for a memory.
 *
 * pre:  `directory` and `domain` are both optional.
 * post: returns a lowercased/trimmed canonical domain, or '' when nothing
 *       resolves. Never throws — profile detection failures degrade to ''.
 *
 * source: remember.py:200-220 (_resolve_domain)
 */
export function resolveDomain(directory?: string, domain?: string): string {
  // 1. git-root resolution first (most reliable).
  if (directory) {
    const resolved = resolveCwd(directory);
    if (resolved) return resolved;
  }

  // 2. Explicit domain hint.
  if (domain) {
    return resolveHint(domain);
  }

  // 3. Fallback to profile-based detection from the directory.
  if (directory) {
    const detected = detectFromProfiles(directory);
    return detected ? resolveHint(detected) : "";
  }

  return "";
}

/**
 * Best-effort profile-based domain detection for a working directory.
 *
 * Mirrors the Python fallback `detect_domain({"cwd": directory}, profiles)`.
 * `loadProfiles()` returns the infrastructure DTO; `detectDomain` consumes the
 * methodology `ProfilesStore` shape. Both expose `.domains`, so this is a
 * boundary adaptation between the two layer-local representations.
 *
 * source: remember.py:215-219
 */
function detectFromProfiles(directory: string): string {
  const profiles = loadProfiles() as unknown as ProfilesStore;
  const detection = detectDomain({ cwd: directory }, profiles);
  return detection.domain ?? "";
}
