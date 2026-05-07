#!/usr/bin/env bash
# Launch the memory MCP server bundle.
#
# Args:
#   $1 — CLAUDE_PLUGIN_ROOT (the plugin directory after install). Required.
#
# Behavior:
#   1. cd into the plugin dir.
#   2. If node_modules/ is missing, run npm install --omit=dev to fetch native
#      deps declared in package.json (better-sqlite3, onnxruntime-node, pg, etc).
#   3. ADR-0042: if DATABASE_URL is set, attempt PostgreSQL provisioning.
#      - Guard: refuse DATABASE_URL where db name = "cortex" (standalone Cortex production DB).
#      - Check pg_isready. If PG is not available → clear DATABASE_URL (SQLite fallback).
#      - If PG is available: verify the database exists; create it if not; run init-pg.mjs.
#   4. exec node dist/index.js.
#
# Stdout is reserved for MCP JSON-RPC framing. All shell diagnostics go to
# stderr — writing to stdout would corrupt the protocol.
# source: modelcontextprotocol.io/quickstart/server §"Logging in MCP Servers"
set -euo pipefail
PLUGIN_ROOT="${1:?usage: launch.sh <plugin-root>}"
cd "${PLUGIN_ROOT}"

if [ ! -d node_modules ]; then
  echo "memory plugin: installing native deps (first run)..." >&2
  npm install --omit=dev --no-audit --no-fund --silent >&2
fi

# ── ADR-0042: PostgreSQL bootstrap ─────────────────────────────────────────────
# Guard: NEVER connect to a database named "cortex" on a local host — that is
# the standalone Python Cortex's production database.
# source: ADR-0042 §constraints — db-guard.ts mirrors this check at runtime
if [ -n "${DATABASE_URL:-}" ]; then
  DB_NAME="$(echo "${DATABASE_URL}" | sed 's|.*\/||')"
  DB_HOST="$(echo "${DATABASE_URL}" | sed -E 's|.*@([^:/]*).*|\1|')"

  if [ "${DB_NAME}" = "cortex" ] && \
     { [ -z "${DB_HOST}" ] || [ "${DB_HOST}" = "localhost" ] || \
       [ "${DB_HOST}" = "127.0.0.1" ] || [ "${DB_HOST}" = "::1" ]; }; then
    echo "memory plugin [ADR-0042]: DATABASE_URL targets standalone Cortex DB (name='cortex'). Falling back to SQLite." >&2
    unset DATABASE_URL
  elif ! command -v pg_isready &>/dev/null; then
    echo "memory plugin [ADR-0042]: pg_isready not found — falling back to SQLite." >&2
    unset DATABASE_URL
  else
    PG_HOST="$(echo "${DATABASE_URL}" | sed -E 's|.*@([^:/]*).*|\1|')"
    PG_PORT="$(echo "${DATABASE_URL}" | sed -E 's|.*:([0-9]+)/.*|\1|')"
    PG_HOST="${PG_HOST:-localhost}"
    PG_PORT="${PG_PORT:-5432}"

    if ! pg_isready -h "${PG_HOST}" -p "${PG_PORT}" -q 2>/dev/null; then
      echo "memory plugin [ADR-0042]: PostgreSQL not accepting connections at ${PG_HOST}:${PG_PORT} — falling back to SQLite." >&2
      unset DATABASE_URL
    else
      if ! psql "${DATABASE_URL}" -c "SELECT 1" -q &>/dev/null; then
        echo "memory plugin [ADR-0042]: database '${DB_NAME}' not found — provisioning..." >&2
        createdb --host="${PG_HOST}" --port="${PG_PORT}" "${DB_NAME}" 2>/dev/null || true
        psql --host="${PG_HOST}" --port="${PG_PORT}" -d "${DB_NAME}" \
          -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;" \
          -q 2>/dev/null || true
      fi
      INIT_SCRIPT="${PLUGIN_ROOT}/../../packages/memory-dashboard/scripts/init-pg.mjs"
      if [ -f "${INIT_SCRIPT}" ]; then
        echo "memory plugin [ADR-0042]: running init-pg.mjs on ${DATABASE_URL}..." >&2
        DATABASE_URL="${DATABASE_URL}" node "${INIT_SCRIPT}" >&2 || true
      fi
    fi
  fi
fi
# ──────────────────────────────────────────────────────────────────────────────

exec node dist/index.js
