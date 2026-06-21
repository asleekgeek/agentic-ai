/**
 * upstream-governor.ts — per-upstream-server admission governor.
 *
 * Bounds concurrent in-flight calls to a single upstream MCP child process
 * (e.g. the automatised-pipeline binary behind the `codebase` server). The
 * child is ONE OS process shared across Cortex handlers; two handlers that each
 * pass their own per-tool admission can still hit the same child concurrently
 * and drive its RSS until the OS kills it. This governor serialises (or bounds)
 * calls per upstream server NAME, across every handler.
 *
 * Keyed by server name (the constraint is the shared child, not the tool).
 * Default budget = 1 (full serialisation of the single-process child); the
 * first caller's budget fixes the gate. Node is single-threaded async, so a
 * promise-queue counting semaphore is the faithful, loop-agnostic analog of the
 * Python threading.Semaphore.
 *
 * source: cortex main mcp_server/infrastructure/upstream_governor.py
 */

// Permits per upstream server when the config omits maxConcurrentCalls: one =
// serialise the single-process child (conservative default).
// source: cortex main mcp_server/infrastructure/upstream_governor.py (_DEFAULT_MAX_CONCURRENT_CALLS)
const DEFAULT_MAX_CONCURRENT_CALLS = 1;

interface Gate {
  permits: number;
  readonly queue: Array<() => void>;
}

// Process-global registry: one gate per server name, created on first use.
const gates = new Map<string, Gate>();

function getGate(serverName: string, maxConcurrent: number): Gate {
  let gate = gates.get(serverName);
  if (gate === undefined) {
    gate = { permits: Math.max(1, maxConcurrent), queue: [] };
    gates.set(serverName, gate);
  }
  return gate;
}

/**
 * Acquire one admission permit for `serverName`. Resolves immediately when a
 * permit is free, otherwise queues until a holder releases. Returns a release
 * function — call it in a `finally` block. The permit transfers directly to the
 * next waiter on release (never over-grants), mirroring the oracle's bounded
 * semaphore. The first caller's `maxConcurrent` fixes the gate budget.
 *
 * source: cortex main mcp_server/infrastructure/upstream_governor.py (govern)
 */
export async function govern(
  serverName: string,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_CALLS,
): Promise<() => void> {
  const gate = getGate(serverName, maxConcurrent);
  if (gate.permits > 0) {
    gate.permits -= 1;
  } else {
    await new Promise<void>((resolve) => gate.queue.push(resolve));
    // The permit was handed to us directly by the releaser; do not decrement.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = gate.queue.shift();
    if (next !== undefined) {
      next(); // transfer the permit to the next waiter
    } else {
      gate.permits += 1;
    }
  };
}

/** Test-only: clear the process-global gate registry. */
export function _resetGovernor(): void {
  gates.clear();
}
