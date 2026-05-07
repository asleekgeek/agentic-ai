/**
 * db-guard.ts — ADR-0042 safety guard.
 *
 * Refuses to start if DATABASE_URL targets the standalone Python Cortex's database
 * (`cortex`) on a loopback host. Exits with code 78 (EX_CONFIG).
 *
 * source: /usr/include/sysexits.h:80 — EX_CONFIG = 78 (configuration error)
 *
 * Layer: handlers — executed at server startup before any DDL runs.
 *
 * precondition:  called before any database connection is opened.
 * postcondition: either returns void (safe to proceed) or exits the process with
 *                code 78 and a message to stderr.
 * invariant:     if this function returns, DATABASE_URL (if set) does not point
 *                to a protected database.
 */

// source: /usr/include/sysexits.h:80 — #define EX_CONFIG 78
const EX_CONFIG = 78;

/**
 * Loopback host set that identifies "local machine" PG connections.
 * source: cortex@ed33435 mcp_server/server/http_security.py:22 (_LOOPBACK_HOSTS)
 */
const LOOPBACK_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]); // source: cortex@ed33435 mcp_server/server/http_security.py:22 (_LOOPBACK_HOSTS)

/**
 * The standalone Python Cortex's database name — must never be connected to
 * from the agentic-ai memory plugin dashboard.
 * source: ADR-0042 §constraints — the agentic-ai memory plugin's dashboard must
 *   NEVER read from a postgresql URL where the database name is "cortex".
 */
const FORBIDDEN_DB_NAME = "cortex";

/**
 * assertNotForbiddenDatabase — check DATABASE_URL and exit if it targets the
 * standalone Cortex's database on a loopback host.
 *
 * precondition:  called before any pg connection is opened.
 * postcondition: either returns (safe) or process.exit(78) is called.
 *
 * FAILS_ON: DATABASE_URL whose host is a loopback address AND whose database
 *   name is exactly "cortex". Exits with EX_CONFIG = 78.
 */
export function assertNotForbiddenDatabase(): void {
  const url = process.env["DATABASE_URL"];
  if (!url) return; // No DATABASE_URL → SQLite fallback; nothing to check.

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable URL — let the PG connection fail with its own error.
    return;
  }

  const dbName = parsed.pathname.replace(/^\//, "");
  const host = parsed.hostname ?? "";

  if (dbName === FORBIDDEN_DB_NAME && LOOPBACK_HOSTS.has(host)) {
    process.stderr.write(
      `[memory-dashboard] EX_CONFIG: agentic-ai memory plugin must not connect to standalone Cortex's database.\n` +
      `  DATABASE_URL targets '${dbName}' on host '${host || "(empty)"}' — this is the standalone Python Cortex's production DB.\n` +
      `  Set DATABASE_URL to postgresql://localhost:5432/cortex_agentic (or leave unset for SQLite fallback).\n` // source: ADR-0042 §constraints — default PG URL for the agentic-ai plugin
    );
    process.exit(EX_CONFIG);
  }
}
