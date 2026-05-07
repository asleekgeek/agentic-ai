/**
 * db-adapter.ts — DashboardDb interface + SqliteAdapter + PgAdapter.
 *
 * ADR-0042: dashboard reads from PG when DATABASE_URL is set, falls back to SQLite.
 *
 * Layer: infrastructure — implements the DashboardDb port declared here.
 *
 * precondition:  For SqliteAdapter — dbPath is a readable SQLite file.
 *                For PgAdapter — DATABASE_URL is a valid PostgreSQL connection string
 *                pointing to the agentic-ai's own database (not cortex).
 * postcondition: All PreparedQuery methods return resolved Promises.
 * invariant:     Callers use only the DashboardDb interface; dialect drift is
 *                encapsulated entirely in this module.
 */

import type Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";

// ── Port (interface declared by this module, implemented below) ───────────────

/**
 * PreparedQuery — the result of `db.prepare(sql)`.
 *
 * precondition:  sql was passed to DashboardDb.prepare(); args match the
 *                placeholder count in the original SQL.
 * postcondition: all() returns all result rows; get() returns the first or undefined.
 */
export interface PreparedQuery {
  all<T = unknown>(...args: unknown[]): Promise<T[]>;
  get<T = unknown>(...args: unknown[]): Promise<T | undefined>;
}

/**
 * DashboardDb — the single database abstraction used by all routes.
 *
 * precondition:  constructed by buildDashboardDb() in server.ts.
 * postcondition: prepare() returns a PreparedQuery for the given SQL.
 *                close() releases all connections.
 * invariant:     dialect is set at construction and never mutated.
 */
export interface DashboardDb {
  prepare(sql: string): PreparedQuery;
  close(): Promise<void>;
  readonly dialect: "sqlite" | "pg";
}

// ── SqliteAdapter ─────────────────────────────────────────────────────────────

/**
 * SqliteAdapter — wraps better-sqlite3 in the async DashboardDb interface.
 *
 * better-sqlite3 is synchronous; we wrap calls in Promise.resolve() so the
 * interface is uniform with PgAdapter.
 *
 * precondition:  db is an open better-sqlite3 Database instance.
 * postcondition: prepare() wraps synchronous prepare + all/get in a Promise.
 */
export class SqliteAdapter implements DashboardDb {
  readonly dialect = "sqlite" as const;
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  prepare(sql: string): PreparedQuery {
    const stmt = this.#db.prepare(sql);
    return {
      all<T = unknown>(...args: unknown[]): Promise<T[]> {
        return Promise.resolve(stmt.all(...args) as T[]);
      },
      get<T = unknown>(...args: unknown[]): Promise<T | undefined> {
        return Promise.resolve(stmt.get(...args) as T | undefined);
      },
    };
  }

  close(): Promise<void> {
    this.#db.close();
    return Promise.resolve();
  }
}

// ── PgAdapter ─────────────────────────────────────────────────────────────────

/**
 * Rewrite SQLite-style `?` positional placeholders to PG-style `$1, $2, ...`.
 *
 * precondition:  sql uses only `?` placeholders (no named params).
 * postcondition: every `?` is replaced with `$N` in order; result is valid PG SQL.
 * source: node-postgres docs — https://node-postgres.com/features/queries#parameterized-query
 */
function rewritePlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Normalize a single row returned by node-postgres.
 *
 * - Date objects → ISO 8601 string (routes send via reply.send; JSON.stringify
 *   would coerce, but route code may call .slice() on timestamp fields).
 * - JSONB arrays (tags) → kept as-is (already an array; formatMemory's parseTags
 *   handles both array and JSON-string forms).
 *
 * precondition:  row is a plain object from pg.Client / pg.Pool query result.
 * postcondition: all Date-valued fields are ISO strings; all other fields unchanged.
 * source: node-postgres returns Date objects for TIMESTAMPTZ columns — https://node-postgres.com/features/types
 */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/**
 * PgAdapter — wraps a node-postgres Pool in the async DashboardDb interface.
 *
 * Placeholder rewriting (`?` → `$N`) happens at prepare() time so route SQL
 * is written in the SQLite dialect and remains identical across adapters.
 *
 * Pool max = 5 is taken from the existing pg-store.ts default.
 * source: packages/memory/src/remember/storage/pg-store.ts — Pool({ max: 5 })
 *
 * precondition:  connectionString points to a reachable PostgreSQL database.
 * postcondition: prepare() returns a PreparedQuery backed by pool.query().
 * invariant:     the pool is created once and reused for all queries.
 */
export class PgAdapter implements DashboardDb {
  readonly dialect = "pg" as const;
  // Dynamically imported at construction to keep `pg` optional (not bundled unless
  // DATABASE_URL is set). Typed as `any` internally — the public interface is typed.
  // source: ADR-0042 §adapter-shape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #pool: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(pool: any) {
    this.#pool = pool;
  }

  /**
   * Factory: create a PgAdapter from a DATABASE_URL connection string.
   *
   * Pool max = 5.
   * source: packages/memory/src/remember/storage/pg-store.ts — Pool({ max: 5 })
   */
  static async create(connectionString: string): Promise<PgAdapter> {
    // Dynamic import so that `pg` is only required when PG path is taken.
    // Use `any` to avoid the `pg` namespace shape mismatch in @types/pg ESM interop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgModule: any = await import("pg");
    // node-postgres exports Pool on the default export in ESM (pg >= 8.x).
    // source: https://node-postgres.com/apis/pool
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Pool: any = pgModule.Pool ?? pgModule.default?.Pool;
    const pool = new Pool({ connectionString, max: 5 }); // source: packages/memory/src/remember/storage/pg-store.ts — Pool({ max: 5 })
    return new PgAdapter(pool);
  }

  prepare(sql: string): PreparedQuery {
    const rewritten = rewritePlaceholders(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool: any = this.#pool;
    return {
      async all<T = unknown>(...args: unknown[]): Promise<T[]> {
        const result = await pool.query(rewritten, args.length > 0 ? args : undefined);
        return (result.rows as Record<string, unknown>[]).map(normalizeRow) as T[];
      },
      async get<T = unknown>(...args: unknown[]): Promise<T | undefined> {
        const result = await pool.query(rewritten, args.length > 0 ? args : undefined);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        return row !== undefined ? (normalizeRow(row) as T) : undefined;
      },
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * buildDashboardDb — composition-root factory.
 *
 * Chooses the adapter based on whether DATABASE_URL is set:
 *   - set → PgAdapter (agentic-ai's own PG database)
 *   - unset → SqliteAdapter
 *
 * precondition:  if dbPath is provided it resolves to a readable SQLite file.
 *                if DATABASE_URL is set it must have passed the db-guard check.
 * postcondition: returns a fully-wired DashboardDb ready for use.
 * invariant:     the guard must run before this factory is called.
 */
export async function buildDashboardDb(dbPath: string): Promise<DashboardDb> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl) {
    return PgAdapter.create(databaseUrl);
  }
  // SQLite path — lazy import to keep pg optional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bsModule: any = await import("better-sqlite3");
  // better-sqlite3 CJS module exposes constructor as .default in ESM interop.
  // source: https://github.com/WiseLibs/better-sqlite3/issues/871 — ESM interop
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BetterSqlite: any = bsModule.default ?? bsModule;
  const db = new BetterSqlite(dbPath, { readonly: true, fileMustExist: true }) as BetterSqliteDatabase;
  return new SqliteAdapter(db);
}
