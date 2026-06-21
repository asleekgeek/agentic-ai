/**
 * Handler for the query_methodology tool — returns cognitive profile.
 *
 * Entry point most callers use. Reads the cached profiles store, detects
 * the domain, enriches the context string with hot memories and fired
 * triggers, and returns the full methodology response.
 *
 * source: mcp_server/handlers/query_methodology.py
 */

import type { MethodologyQuery, MethodologyResponse, ProfilesStore } from "../types.js";
import { detectDomain } from "../domain-detector.js";
import { generateContext } from "../methodology-engine.js";
import { boundPayload, listTarget, textTarget } from "../../recall/response-budget.js";

/**
 * Bounded I/O: fit the response to the host's tool-result budget. Hot-memory
 * and fired-trigger contents are cut first (they carry ids for full retrieval
 * via recall); the assembled `context` string is the other unbounded text.
 * source: cortex main mcp_server/handlers/query_methodology.py:276-293
 *   (bound_payload([ListTarget("hotMemories", weight_key="heat"),
 *                   ListTarget("firedTriggers"), TextTarget("context")]))
 */
function bounded(resp: MethodologyResponse): MethodologyResponse {
  boundPayload(resp, [
    listTarget("hotMemories", "content", "heat"),
    listTarget("firedTriggers"),
    textTarget("context"),
  ]);
  return resp;
}

// ── Empty response factory ────────────────────────────────────────────────────

function emptyResponse(
  opts: { domain?: string; confidence?: number; coldStart?: boolean; context?: string },
): MethodologyResponse {
  return {
    domain: opts.domain ?? null,
    confidence: opts.confidence ?? 0,
    coldStart: opts.coldStart ?? false,
    context: opts.context ?? "",
    style: null,
    entryPoints: [],
    recurringPatterns: [],
    toolPreferences: {},
    blindSpots: [],
    connectionBridges: [],
    sessionCount: 0,
    lastActive: null,
    hotMemories: [],
    firedTriggers: [],
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Query the methodology profile for a given cwd + first message.
 *
 * The `profiles` argument is injected by the caller — this handler is
 * infrastructure-agnostic (no filesystem access). The infrastructure
 * adapter calls loadProfiles() and passes it here.
 *
 * source: mcp_server/handlers/query_methodology.py handler
 */
export function queryMethodology(
  args: MethodologyQuery,
  profiles: ProfilesStore,
): MethodologyResponse {
  const detection = detectDomain(
    { cwd: args.cwd, project: args.project, firstMessage: args.firstMessage },
    profiles,
  );

  if (detection.coldStart) {
    return bounded(emptyResponse({
      coldStart: true,
      context: detection.context ?? "No cognitive profile yet. Building one as we go.",
    }));
  }

  const domainId = detection.domain;
  const profile = domainId ? profiles.domains[domainId] : undefined;

  // `!domainId ||` is runtime-redundant (profile is undefined whenever domainId
  // is falsy) but narrows domainId to `string` below, removing two non-null
  // assertions the lint forbids.
  if (!domainId || !profile) {
    return bounded(emptyResponse({
      domain: domainId ?? undefined,
      confidence: detection.confidence,
      context: domainId
        ? `Domain "${domainId}" detected but no profile built yet. Run rebuild_profiles to analyze session history.`
        : "Domain not determined.",
    }));
  }

  const context = generateContext(domainId, profile);

  return bounded({
    domain: domainId,
    confidence: profile.confidence ?? detection.confidence,
    coldStart: false,
    context,
    style: profile.metacognitive ?? null,
    entryPoints: profile.entryPoints ?? [],
    recurringPatterns: profile.recurringPatterns ?? [],
    toolPreferences: profile.toolPreferences ?? {},
    blindSpots: profile.blindSpots ?? [],
    connectionBridges: profile.connectionBridges ?? [],
    sessionCount: profile.sessionCount ?? 0,
    lastActive: profile.lastUpdated ?? null,
    alternativeDomains: detection.alternativeDomains,
    hotMemories: [],    // populated by infrastructure layer (memory store not in scope here)
    firedTriggers: [],  // populated by infrastructure layer (prospective triggers not in scope here)
  });
}
