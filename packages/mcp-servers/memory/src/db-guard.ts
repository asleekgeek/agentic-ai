/**
 * db-guard.ts — DATABASE_URL safety check for the MCP server.
 *
 * Refuses to connect to the standalone Python Cortex database
 * (`cortex` on any localhost-equivalent), which must never be
 * written to by the agentic-ai memory plugin.
 *
 * Exit code 78 = EX_CONFIG (sysexits.h) — "something was found in
 * an unconfigured or misconfigured state."
 * source: <sysexits.h> EX_CONFIG = 78
 *
 * This check is duplicated from packages/memory-dashboard/src/server.ts
 * because the dashboard and the MCP server are separate processes with
 * separate startup paths. A shared lib would require a new workspace
 * package; duplication of ~10 lines is the lesser evil here.
 * source: ADR-0042 — the agentic-ai memory plugin must never touch the
 *   standalone Python Cortex database (db_name=cortex on localhost).
 */

// ── Localhost-equivalent hostnames ───────────────────────────────────────────
// source: RFC 5735 §3 — 127.0.0.0/8 is loopback; ::1 is IPv6 loopback.
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

// ── Forbidden DB name ─────────────────────────────────────────────────────────
// source: ADR-0042 — standalone Python Cortex uses db_name=cortex.
const FORBIDDEN_DB_NAME = "cortex";

// EX_CONFIG = 78 — "configuration error" exit code.
// source: <sysexits.h> BSD/macOS/Linux standard exit codes.
const EX_CONFIG = 78; // source: <sysexits.h> EX_CONFIG

// ── Guard ─────────────────────────────────────────────────────────────────────

/**
 * Check a DATABASE_URL for the forbidden standalone-Cortex database.
 *
 * precondition:  url is a non-empty string.
 * postcondition: if the URL points to db_name=cortex on localhost,
 *   writes a fatal message to stderr and calls process.exit(78).
 *   Otherwise returns without side effects.
 *
 * source: ADR-0042 §guard — "postgresql://localhost:5432/cortex must NEVER
 *   be touched by the agentic-ai memory plugin."
 */
export function assertNotForbiddenDb(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable URL — let pg fail with its own error message.
    return;
  }

  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, "");

  if (LOCALHOST_NAMES.has(host) && dbName === FORBIDDEN_DB_NAME) {
    process.stderr.write(
      "[mcp-server-memory] FATAL: DATABASE_URL points to the standalone " +
        `Python Cortex database (db_name="${FORBIDDEN_DB_NAME}" on localhost). ` +
        "The agentic-ai memory plugin must NEVER write to this database. " +
        "Set DATABASE_URL to a safe database (e.g. cortex_agentic) or " +
        "unset DATABASE_URL to use the SQLite fallback.\n",
    );
    process.exit(EX_CONFIG);
  }
}
