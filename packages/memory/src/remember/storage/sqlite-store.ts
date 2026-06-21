/* eslint-disable max-lines -- this file is a single-adapter port; split deferred per §4.1 until a second concern boundary appears */
/**
 * sqlite-store.ts — SQLite (better-sqlite3) adapter for MemoryStore.
 *
 * Ports: infrastructure/sqlite_store.py (~480 LOC)
 *
 * Uses better-sqlite3 which is synchronous — all operations complete
 * without async. This is a strict parity with the Python source which
 * uses aiosqlite but exposes a synchronous-style API internally.
 *
 * ADR-0007: better-sqlite3 must be in pnpm.onlyBuiltDependencies.
 * ADR-0003: preconditions here MUST NOT be stronger than MemoryStore's.
 *
 * Atomicity proofs (per task spec):
 *   1. insertMemory: wrapped in a single BEGIN/COMMIT covering memories +
 *      memories_fts rows. If either INSERT fails, the transaction rolls
 *      back and no id is returned.
 *   2. deleteMemory: single transaction deletes memories_fts + memories.
 *   3. bumpHeatRaw: single UPDATE (cannot partially succeed).
 *   4. Read-your-writes: better-sqlite3 uses a single connection; there
 *      is no pool interleaving. A getMemory call after insertMemory on
 *      the same Database instance always sees the committed row.
 *   5. No duplicate inserts: the caller (write gate) is responsible.
 *      The store does NOT check for content duplicates here.
 *
 * Known race condition in the Python source (noted for TS port):
 *   sqlite_store.py insert_memory uses two separate execute() calls —
 *   one for memories and one for memories_fts. Between the two calls
 *   there is no explicit transaction, relying on autocommit mode.
 *   If the FTS INSERT fails, the main row is committed without an FTS
 *   entry, breaking full-text search on that row.
 *   FIX in this port: wrap both INSERTs in an explicit transaction
 *   (BEGIN/COMMIT). This is the correctness obligation noted in the task spec.
 *
 * Source: infrastructure/sqlite_store.py
 */

import { createRequire } from "node:module";
import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { MemoryInsertData, MemoryItem } from "../types.js";
import type {
  EntityRecord,
  HeatUpdate,
  MemoryStoreExt,
  RelationshipRecord,
  VecHit,
} from "./memory-store.js";

// CommonJS require is unavailable inside an ES module; createRequire bridges
// the gap so the optional `sqlite-vec` extension can still be loaded
// dynamically. Without this, every TS port instance fails to load sqlite-vec
// and silently falls back to FTS-only retrieval.
// source: https://nodejs.org/api/module.html#modulecreaterequirefilename
const _require = createRequire(import.meta.url);

// FTS5 token extractor: keep word characters (incl. underscore) and apostrophes
// inside words; everything else (punctuation, ?, !, :, etc.) becomes whitespace.
// Tokens shorter than 2 chars are dropped (FTS5 default tokenizer treats them
// as stopword-like noise; also excludes lone digits from query expansion).
// source: https://www.sqlite.org/fts5.html#tokenizers — default unicode61 tokenizer behaviour
const FTS5_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9_'-]*/g;
const FTS5_MIN_TOKEN_LEN = 2;
// Cap query length at 32 tokens. FTS5 OR-disjunctions are O(N×M) per row;
// every additional token is a scan multiplier, and benchmark queries rarely
// have more than 10 distinct tokens. The cap keeps recall pipeline latency
// bounded for adversarial input. source: empirical — measured on Cortex bench machine 2026-05-06.
const FTS5_MAX_TOKENS = 32;

/**
 * Translate a free-form query string into a permissive FTS5 disjunctive match.
 *
 * Returns an empty string when no usable token survives sanitisation; callers
 * treat that as "no FTS hits" and rely on the vector / hot-pool signals.
 *
 * postcondition: returned string is either "" or a sequence of double-quoted
 *   FTS5 literals separated by " OR ". Each literal is safe to embed verbatim
 *   into an FTS5 MATCH expression (no internal double quotes).
 */
function sanitiseFts5Query(query: string): string {
  if (!query) return "";
  const tokens: string[] = [];
  for (const m of query.toLowerCase().matchAll(FTS5_TOKEN_RE)) {
    const t = m[0];
    if (t.length < FTS5_MIN_TOKEN_LEN) continue;
    // Drop double-quotes from the token before wrapping; they would close the
    // FTS5 literal mid-token and produce a syntax error.
    const safe = t.replace(/"/g, "");
    if (safe.length < FTS5_MIN_TOKEN_LEN) continue;
    tokens.push(`"${safe}"`);
    if (tokens.length >= FTS5_MAX_TOKENS) break;
  }
  return tokens.join(" OR ");
}

// source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 (dim=384)
const EMBEDDING_DIM = 384; // source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 (hidden_size=384)

// ── sqlite-vec virtual table DDL ─────────────────────────────────────────────
// source: Cortex mcp_server/infrastructure/sqlite_schema.py:MEMORIES_VEC_DDL
// source: https://alexgarcia.xyz/sqlite-vec/ — vec0 virtual table format
const MEMORIES_VEC_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  embedding float[${EMBEDDING_DIM}]
)`;

// ── Schema SQL ──────────────────────────────────────────────────────────────
// Verbatim column layout from SCHEMA.md §memories table.
// source: infrastructure/sqlite_schema.py:MEMORIES_DDL
// NOTE: stage_entered_at added by v3_13_0_a3_migration.sql (must be present).

const MEMORIES_DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  directory_context TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
  heat_base REAL NOT NULL DEFAULT 1.0 CHECK (heat_base >= 0.0 AND heat_base <= 1.0),
  heat_base_set_at TEXT NOT NULL DEFAULT '',
  no_decay INTEGER NOT NULL DEFAULT 0,
  surprise_score REAL DEFAULT 0.0,
  importance REAL DEFAULT 0.5,
  emotional_valence REAL DEFAULT 0.0,
  confidence REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  useful_count INTEGER DEFAULT 0,
  plasticity REAL DEFAULT 1.0,
  stability REAL DEFAULT 0.0,
  reconsolidation_count INTEGER DEFAULT 0,
  last_reconsolidated TEXT,
  store_type TEXT DEFAULT 'episodic',
  compressed INTEGER DEFAULT 0,
  compression_level INTEGER DEFAULT 0,
  original_content TEXT,
  is_protected INTEGER DEFAULT 0,
  is_stale INTEGER DEFAULT 0,
  slot_index INTEGER,
  excitability REAL DEFAULT 1.0,
  consolidation_stage TEXT DEFAULT 'labile',
  hours_in_stage REAL DEFAULT 0.0,
  stage_entered_at TEXT,
  replay_count INTEGER DEFAULT 0,
  theta_phase_at_encoding REAL DEFAULT 0.0,
  encoding_strength REAL DEFAULT 1.0,
  separation_index REAL DEFAULT 0.0,
  interference_score REAL DEFAULT 0.0,
  schema_match_score REAL DEFAULT 0.0,
  schema_id TEXT,
  hippocampal_dependency REAL DEFAULT 1.0,
  is_benchmark INTEGER DEFAULT 0,
  agent_context TEXT DEFAULT '',
  is_global INTEGER DEFAULT 0,
  arousal REAL DEFAULT 0.0,
  dominant_emotion TEXT DEFAULT 'neutral'
)`;

// FTS5 with content table: content='memories' means we own the FTS index
// and insert manually. We keep a shadow FTS table for full-text search.
// Note: content_rowid tells FTS5 which rowid column to use in the content table.
// source: infrastructure/sqlite_schema.py:MEMORIES_FTS_DDL
const MEMORIES_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(content, content='memories', content_rowid='id', tokenize='porter ascii')`;

const ENTITIES_DDL = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT '',
  domain TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
  heat REAL DEFAULT 1.0,
  archived INTEGER DEFAULT 0,
  -- Provenance mirror of the PG schema: 'ast_symbol' vs 'text_concept'.
  -- Consumed by core.entity_dedup to exempt code symbols from fuzzy dedup.
  origin TEXT NOT NULL DEFAULT 'text_concept'
)`;

const RELATIONSHIPS_DDL = `
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity_id INTEGER NOT NULL REFERENCES entities(id),
  target_entity_id INTEGER NOT NULL REFERENCES entities(id),
  relationship_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  is_causal INTEGER DEFAULT 0,
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_reinforced TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const MEMORY_ENTITIES_DDL = `
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
)`;

// source: infrastructure/sqlite_store.py:HOMEOSTATIC_STATE_DDL — factor bounds (0, 10) open interval; default 1.0
const HOMEOSTATIC_STATE_FACTOR_DEFAULT = 1.0; // source: infrastructure/sqlite_store.py:HOMEOSTATIC_STATE_DDL
const HOMEOSTATIC_STATE_FACTOR_MAX = 10; // source: infrastructure/sqlite_store.py:HOMEOSTATIC_STATE_DDL
const HOMEOSTATIC_STATE_DDL = `
CREATE TABLE IF NOT EXISTS homeostatic_state (
  domain TEXT PRIMARY KEY,
  factor REAL NOT NULL DEFAULT ${HOMEOSTATIC_STATE_FACTOR_DEFAULT} CHECK (factor > 0 AND factor < ${HOMEOSTATIC_STATE_FACTOR_MAX}),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const SCHEMAS_DDL = `
CREATE TABLE IF NOT EXISTS schemas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_id TEXT UNIQUE NOT NULL,
  domain TEXT DEFAULT '',
  label TEXT DEFAULT '',
  entity_signature TEXT DEFAULT '{}',
  tag_signature TEXT DEFAULT '{}',
  consistency_threshold REAL DEFAULT 0.7,
  formation_count INTEGER DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const OSCILLATORY_STATE_DDL = `
CREATE TABLE IF NOT EXISTS oscillatory_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL DEFAULT '{}'
)`;

// User session-level mood state for MOOD_CONGRUENT_RERANK (Bower 1981).
// Mirrors Cortex sqlite_schema.py USER_MOOD_DDL + USER_MOOD_SEED_DDL: a
// user_id-keyed table with clamped valence/arousal, seeded with a neutral
// default row so getUserMood returns a real signal. better-sqlite3's exec()
// accepts multiple statements, so the table + seed are combined here (Cortex
// splits them only because sqlite3.execute() takes one statement at a time).
// source: cortex@HEAD mcp_server/infrastructure/sqlite_schema.py:247-264
// source: Bower, G.H. (1981). "Mood and Memory." Am. Psychologist 36(2).
const USER_MOOD_DDL = `
CREATE TABLE IF NOT EXISTS user_mood (
  user_id    TEXT PRIMARY KEY DEFAULT 'default',
  valence    REAL NOT NULL DEFAULT 0.0 CHECK (valence >= -1.0 AND valence <= 1.0),
  arousal    REAL NOT NULL DEFAULT 0.0 CHECK (arousal >= -1.0 AND arousal <= 1.0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO user_mood (user_id, valence, arousal) VALUES ('default', 0.0, 0.0);`;

// ── Indexes ──────────────────────────────────────────────────────────────────

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_memories_heat_base ON memories(heat_base)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_store_type ON memories(store_type)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_agent_context ON memories(agent_context)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id)`,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function clampHeat(h: number): number {
  return Math.max(0.0, Math.min(1.0, h));
}

// Mood valence is a bipolar signal in [-1, +1] (Russell 1980 circumplex
// valence axis), unlike heat which is unipolar [0, 1].
// source: cortex@HEAD mcp_server/infrastructure/sqlite_store_mood.py:set_user_mood
function clampValence(v: number): number {
  return Math.max(-1.0, Math.min(1.0, v));
}

function boolToInt(v: boolean | undefined | null): number {
  return v ? 1 : 0;
}

function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── SqliteMemoryStore ────────────────────────────────────────────────────────

export class SqliteMemoryStore implements MemoryStoreExt {
  private readonly _db: DatabaseType;

  /**
   * Whether the sqlite-vec extension was successfully loaded.
   * Set once in _tryLoadVec(); immutable thereafter.
   * source: Cortex mcp_server/infrastructure/sqlite_store.py:_has_vec flag
   */
  private _hasVec = false;

  // Prepared statements: built once, reused many times.
  // Invariant: these are always prepared against the current schema.
  private _stmtInsertMemory!: Statement;
  private _stmtInsertFts!: Statement;
  private _stmtGetMemory!: Statement;
  private _stmtDeleteMemory!: Statement;
  private _stmtDeleteFts!: Statement;
  private _stmtBumpHeat!: Statement;
  private _stmtGetHomeostatic!: Statement;
  private _stmtUpsertHomeostatic!: Statement;
  private _stmtGetEntityByName!: Statement;
  private _stmtUpsertEntity!: Statement;
  private _stmtLinkMemoryEntity!: Statement;
  private _stmtUpsertRelationship!: Statement;
  private _stmtGetSchemas!: Statement;
  private _stmtLoadOscillatory!: Statement;
  private _stmtSaveOscillatory!: Statement;
  private _stmtUpdateImportance!: Statement;
  private _stmtUpdateAccess!: Statement;
  private _stmtUpdateMetamemory!: Statement;
  private _stmtSetProtected!: Statement;
  private _stmtMarkStale!: Statement;
  private _stmtUpdateContent!: Statement;
  private _stmtSetSupersededBy!: Statement;
  private _stmtAnchorMemory!: Statement;

  /**
   * Create an SqliteMemoryStore.
   *
   * precondition:  dbPath is a valid filesystem path or ':memory:'.
   * postcondition: schema is initialised; all prepared statements are ready.
   *
   * source: infrastructure/sqlite_store.py:SqliteMemoryStore.__init__
   */
  constructor(dbPath = ":memory:") {
    this._db = new Database(dbPath);
    // WAL mode: allows concurrent readers while a writer is active.
    // Foreign keys: enforce referential integrity.
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("foreign_keys = ON");
    this._initSchema();
    this._runMigrations();
    this._tryLoadVec();
    this._prepareStatements();
  }

  // ── Schema initialization ──────────────────────────────────────────────

  private _initSchema(): void {
    const ddls = [
      MEMORIES_DDL,
      MEMORIES_FTS_DDL,
      ENTITIES_DDL,
      RELATIONSHIPS_DDL,
      MEMORY_ENTITIES_DDL,
      HOMEOSTATIC_STATE_DDL,
      SCHEMAS_DDL,
      OSCILLATORY_STATE_DDL,
      // User session-level mood state for MOOD_CONGRUENT_RERANK (Bower 1981).
      // Mirrors Cortex sqlite_schema.py USER_MOOD_DDL — user_id PK keyed table
      // with a clamped valence column. Inlined here (not in sqlite-schema.ts)
      // so getUserMood/setUserMood have a table to read/write.
      // source: cortex@HEAD mcp_server/infrastructure/sqlite_schema.py:247-256
      // source: Bower, G.H. (1981). "Mood and Memory." Am. Psychologist 36(2).
      USER_MOOD_DDL,
      ...INDEXES,
    ];
    for (const ddl of ddls) {
      try {
        this._db.exec(ddl);
      } catch {
        // Tolerate IF NOT EXISTS errors from concurrent or duplicate init.
      }
    }
  }

  /**
   * Add columns that may be missing from older databases.
   * Idempotent: ALTER TABLE fails silently if the column already exists.
   *
   * source: infrastructure/sqlite_store.py:_run_migrations
   */
  private _runMigrations(): void {
    const migrations: Array<[string, string, string]> = [
      ["memories", "stage_entered_at", "TEXT"],
      ["memories", "arousal", "REAL DEFAULT 0.0"],
      ["memories", "dominant_emotion", "TEXT DEFAULT 'neutral'"],
      ["memories", "heat_base_set_at", "TEXT NOT NULL DEFAULT ''"],
      ["memories", "no_decay", "INTEGER NOT NULL DEFAULT 0"],
      // Supersession edges (MEM-G1): plain INTEGER, NULL default → byte-identical.
      // source: cortex main mcp_server/infrastructure/sqlite_schema.py:336-337
      ["memories", "supersedes_id", "INTEGER"],
      ["memories", "superseded_by_id", "INTEGER"],
      // prospective_memories.created_by: NOT NULL DEFAULT '' → byte-identical.
      // source: cortex main mcp_server/infrastructure/sqlite_schema.py
      ["prospective_memories", "created_by", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [table, col, def] of migrations) {
      try {
        this._db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      } catch {
        // Column already exists — expected on re-init.
      }
    }
  }

  // ── sqlite-vec extension ───────────────────────────────────────────────

  /**
   * Attempt to load the sqlite-vec extension and create the memories_vec
   * virtual table. Gracefully degrades: _hasVec stays false if the
   * extension is not installed (vector search returns []).
   *
   * precondition:  _db is open and schema is initialised.
   * postcondition: _hasVec = true iff the extension loaded and the virtual
   *   table was created; otherwise _hasVec = false and vector search is disabled.
   *
   * source: Cortex mcp_server/infrastructure/sqlite_store.py:_try_load_vec
   * source: https://alexgarcia.xyz/sqlite-vec/ — Node.js usage with better-sqlite3
   * source: https://www.npmjs.com/package/sqlite-vec — loadable extension pattern
   */
  private _tryLoadVec(): void {
    try {
      // Dynamic require — sqlite-vec is an optional dependency.
      // If not installed, the require() throws and we degrade gracefully.
      // The CJS-style require() bound at module top resolves package paths
      // relative to this source file; the global ESM `require` is undefined.
      const sqliteVec = _require("sqlite-vec") as {
        load: (db: DatabaseType) => void;
      };
      sqliteVec.load(this._db);
      this._db.exec(MEMORIES_VEC_DDL);
      this._hasVec = true;
    } catch {
      // sqlite-vec not installed or extension load failed — degrade gracefully.
      // Vector search will return [] (consistent with Python fallback).
      this._hasVec = false;
    }
  }

  /** Exposed for tests that need to inspect vec availability. */
  get hasVec(): boolean {
    return this._hasVec;
  }

  // ── Prepared statements ────────────────────────────────────────────────

  private _prepareStatements(): void {
    this._stmtInsertMemory = this._db.prepare(`
      INSERT INTO memories (
        content, tags, source, domain, directory_context, created_at,
        last_accessed, heat_base, heat_base_set_at, surprise_score, importance,
        emotional_valence, confidence, store_type, is_protected,
        consolidation_stage, theta_phase_at_encoding, encoding_strength,
        separation_index, interference_score, schema_match_score, schema_id,
        hippocampal_dependency, is_benchmark, agent_context, is_global,
        stage_entered_at, arousal, dominant_emotion, supersedes_id
      ) VALUES (
        @content, @tags, @source, @domain, @directory_context, @created_at,
        @last_accessed, @heat_base, @heat_base_set_at, @surprise_score,
        @importance, @emotional_valence, @confidence, @store_type, @is_protected,
        @consolidation_stage, @theta_phase_at_encoding, @encoding_strength,
        @separation_index, @interference_score, @schema_match_score, @schema_id,
        @hippocampal_dependency, @is_benchmark, @agent_context, @is_global,
        @stage_entered_at, @arousal, @dominant_emotion, @supersedes_id
      )`);

    this._stmtInsertFts = this._db.prepare(
      `INSERT INTO memories_fts(rowid, content) VALUES (?, ?)`,
    );

    this._stmtGetMemory = this._db.prepare(
      `SELECT * FROM memories WHERE id = ?`,
    );

    this._stmtDeleteMemory = this._db.prepare(
      `DELETE FROM memories WHERE id = ?`,
    );

    this._stmtDeleteFts = this._db.prepare(
      `DELETE FROM memories_fts WHERE rowid = ?`,
    );

    this._stmtBumpHeat = this._db.prepare(
      `UPDATE memories SET heat_base = ?, heat_base_set_at = ? WHERE id = ?`,
    );

    this._stmtGetHomeostatic = this._db.prepare(
      `SELECT COALESCE(MAX(factor), 1.0) AS factor FROM homeostatic_state WHERE domain = ?`,
    );

    this._stmtUpsertHomeostatic = this._db.prepare(`
      INSERT INTO homeostatic_state (domain, factor, updated_at)
        VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE
        SET factor = excluded.factor, updated_at = excluded.updated_at`);

    this._stmtGetEntityByName = this._db.prepare(
      `SELECT * FROM entities WHERE name = ? LIMIT 1`,
    );

    // source: cortex main mcp_server/infrastructure/sqlite_store_entities.py:41-54 — origin column (no on-conflict upgrade, mirrors oracle sqlite)
    this._stmtUpsertEntity = this._db.prepare(`
      INSERT INTO entities (name, type, domain, origin, created_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE
        SET last_accessed = excluded.last_accessed
      RETURNING id`);

    this._stmtLinkMemoryEntity = this._db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id)
        VALUES (?, ?)`);

    this._stmtUpsertRelationship = this._db.prepare(`
      INSERT INTO relationships
        (source_entity_id, target_entity_id, relationship_type, weight, created_at, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`);

    this._stmtGetSchemas = this._db.prepare(
      `SELECT * FROM schemas WHERE domain = ?`,
    );

    this._stmtLoadOscillatory = this._db.prepare(
      `SELECT state_json FROM oscillatory_state WHERE id = 1`,
    );

    this._stmtSaveOscillatory = this._db.prepare(`
      INSERT INTO oscillatory_state (id, state_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`);

    this._stmtUpdateImportance = this._db.prepare(
      `UPDATE memories SET importance = ? WHERE id = ?`,
    );

    this._stmtUpdateAccess = this._db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1
        WHERE id = ?`);

    this._stmtUpdateMetamemory = this._db.prepare(`
      UPDATE memories SET access_count = ?, useful_count = ?, confidence = ?
        WHERE id = ?`);

    this._stmtSetProtected = this._db.prepare(
      `UPDATE memories SET is_protected = ? WHERE id = ?`,
    );

    this._stmtMarkStale = this._db.prepare(
      `UPDATE memories SET is_stale = ? WHERE id = ?`,
    );

    this._stmtUpdateContent = this._db.prepare(
      `UPDATE memories SET content = ?, tags = ? WHERE id = ?`,
    );

    // Supersession back-pointer (MEM-G1): newId in SET, oldId in WHERE.
    // source: cortex main mcp_server/infrastructure/sqlite_store.py:set_superseded_by
    this._stmtSetSupersededBy = this._db.prepare(
      `UPDATE memories SET superseded_by_id = ? WHERE id = ?`,
    );

    // Atomic anchor write: single UPDATE setting the eight anchor columns,
    // incl. no_decay = 1. Params: heat_base_set_at, tags, content, is_global, id.
    // source: cortex@HEAD mcp_server/handlers/anchor.py:141-147
    this._stmtAnchorMemory = this._db.prepare(
      `UPDATE memories SET heat_base = 1.0, heat_base_set_at = ?, no_decay = 1, ` +
        `is_protected = 1, importance = 1.0, tags = ?, content = ?, is_global = ? ` +
        `WHERE id = ?`,
    );
  }

  // ── Memory CRUD ────────────────────────────────────────────────────────

  /**
   * Insert a memory and return its integer ID.
   *
   * precondition:  data.content is non-empty.
   * postcondition: returned id > 0; row exists in memories AND memories_fts.
   *
   * Atomicity: both INSERTs happen in a single transaction (fixes the race
   * condition present in sqlite_store.py where they ran in autocommit).
   * source: infrastructure/sqlite_store.py:insert_memory
   */
  insertMemory(data: MemoryInsertData): number {
    const now = nowIso();
    const params = {
      content: data.content,
      tags: JSON.stringify(data.tags ?? []),
      source: data.source ?? "",
      domain: data.domain ?? "",
      directory_context: data.directory_context ?? "",
      created_at: data.created_at ?? now,
      last_accessed: now,
      heat_base: clampHeat(data.heat ?? 1.0),
      heat_base_set_at: now,
      surprise_score: data.surprise_score ?? 0.0,
      // source: infrastructure/sqlite_store.py default importance
      importance: data.importance ?? 0.5, // eslint-disable-line @typescript-eslint/no-magic-numbers
      emotional_valence: data.emotional_valence ?? 0.0,
      confidence: data.confidence ?? 1.0,
      store_type: data.store_type ?? "episodic",
      is_protected: boolToInt(data.is_protected),
      consolidation_stage: data.consolidation_stage ?? "labile",
      theta_phase_at_encoding: data.theta_phase_at_encoding ?? 0.0,
      encoding_strength: data.encoding_strength ?? 1.0,
      separation_index: data.separation_index ?? 0.0,
      interference_score: data.interference_score ?? 0.0,
      schema_match_score: data.schema_match_score ?? 0.0,
      schema_id: data.schema_id ?? null,
      hippocampal_dependency: data.hippocampal_dependency ?? 1.0,
      is_benchmark: boolToInt(data.is_benchmark),
      agent_context: data.agent_context ?? "",
      is_global: boolToInt(data.is_global),
      stage_entered_at: data.stage_entered_at ?? data.created_at ?? now,
      arousal: data.arousal ?? 0.0,
      dominant_emotion: data.dominant_emotion ?? "neutral",
      // Supersession forward edge (MEM-G1): null unless curation supersedes.
      // source: cortex main mcp_server/infrastructure/sqlite_store.py:insert_memory
      supersedes_id: data.supersedes_id ?? null,
    };

    // Wrap in a transaction: if FTS insert fails the main row rolls back.
    const insertTx = this._db.transaction(() => {
      const info = this._stmtInsertMemory.run(params);
      const memoryId = info.lastInsertRowid as number;
      this._stmtInsertFts.run(memoryId, data.content);
      return memoryId;
    });

    return insertTx();
  }

  /**
   * Retrieve a memory by id.
   *
   * postcondition: returns null iff id not found.
   * source: infrastructure/sqlite_store.py:get_memory
   */
  getMemory(memoryId: number): MemoryItem | null {
    const row = this._stmtGetMemory.get(memoryId) as
      | Record<string, unknown>
      | undefined;
    if (row == null) return null;
    return this._normalizeRow(row);
  }

  /**
   * Hard-delete a memory row and its FTS entry.
   *
   * postcondition: returns true iff a row was actually deleted.
   * Atomicity: FTS + main row in one transaction.
   * source: infrastructure/sqlite_store.py:delete_memory
   */
  deleteMemory(memoryId: number): boolean {
    const deleteTx = this._db.transaction(() => {
      this._stmtDeleteFts.run(memoryId);
      const info = this._stmtDeleteMemory.run(memoryId);
      return info.changes > 0;
    });
    return deleteTx();
  }

  /**
   * Canonical A3 heat writer.
   *
   * Writes heat_base AND refreshes heat_base_set_at so effective_heat()
   * computes decay from the bump timestamp.
   * source: docs/program/phase-3-a3-migration-design.md §3.1
   * source: infrastructure/sqlite_store.py:bump_heat_raw
   */
  bumpHeatRaw(memoryId: number, newHeatBase: number): void {
    this._stmtBumpHeat.run(clampHeat(newHeatBase), nowIso(), memoryId);
  }

  /** Thin wrapper: calls bumpHeatRaw. */
  updateMemoryHeat(memoryId: number, heat: number): void {
    this.bumpHeatRaw(memoryId, heat);
  }

  /**
   * Batch heat writer. Single transaction for all rows.
   *
   * source: issue #13; phase-3-a3-migration-design.md §3.8
   * source: infrastructure/sqlite_store.py:update_memories_heat_batch
   */
  updateMemoriesHeatBatch(updates: HeatUpdate[]): number {
    if (updates.length === 0) return 0;
    const now = nowIso();
    const batchTx = this._db.transaction((rows: HeatUpdate[]) => {
      for (const [id, heat] of rows) {
        this._stmtBumpHeat.run(clampHeat(heat), now, id);
      }
      return rows.length;
    });
    return batchTx(updates);
  }

  /** Update importance for a single memory row. */
  updateMemoryImportance(memoryId: number, importance: number): void {
    this._stmtUpdateImportance.run(importance, memoryId);
  }

  /** Increment access_count and refresh last_accessed. */
  updateMemoryAccess(memoryId: number): void {
    this._stmtUpdateAccess.run(nowIso(), memoryId);
  }

  /**
   * Update metamemory fields atomically.
   *
   * postcondition: access_count, useful_count, confidence are all written
   *   in a single UPDATE statement.
   * source: infrastructure/sqlite_store.py:update_memory_metamemory
   */
  updateMemoryMetamemory(
    memoryId: number,
    accessCount: number,
    usefulCount: number,
    confidence: number,
  ): void {
    this._stmtUpdateMetamemory.run(accessCount, usefulCount, confidence, memoryId);
  }

  setMemoryProtected(memoryId: number, protected_: boolean): void {
    this._stmtSetProtected.run(boolToInt(protected_), memoryId);
  }

  markMemoryStale(memoryId: number, stale: boolean): void {
    this._stmtMarkStale.run(boolToInt(stale), memoryId);
  }

  /**
   * Update content and tags for a single memory row.
   *
   * precondition:  memoryId > 0; content is non-empty.
   * postcondition: memories.content = content AND memories.tags = JSON.stringify(tags).
   *   Single prepared-statement run — atomic within SQLite's default autocommit.
   *
   * source: cortex main mcp_server/handlers/anchor.py:143-146
   *   UPDATE memories SET … tags = %s::jsonb, content = %s … WHERE id = %s
   */
  updateMemoryContent(memoryId: number, content: string, tags: string[]): void {
    this._stmtUpdateContent.run(content, JSON.stringify(tags), memoryId);
  }

  /**
   * Close the supersession back-pointer (MEM-G1): stamp the OLD memory's
   * superseded_by_id with the NEW memory id. newId in SET, oldId in WHERE.
   * source: cortex main mcp_server/infrastructure/sqlite_store.py:set_superseded_by
   */
  setSupersededBy(oldId: number, newId: number): void {
    this._stmtSetSupersededBy.run(newId, oldId);
  }

  /**
   * Atomic anchor write — single UPDATE replacing the four non-atomic anchor
   * writes. Sets no_decay=1 (previously never set) alongside heat_base,
   * heat_base_set_at, is_protected, importance, tags, content, is_global.
   * Wrapped in a transaction so it is atomic even though it is one statement,
   * matching the insert/delete transaction pattern in this adapter.
   *
   * source: cortex@HEAD mcp_server/handlers/anchor.py:141-147
   *   acquire_interactive() single UPDATE
   */
  anchorMemory(args: { memoryId: number; content: string; tags: string[]; isGlobal: boolean }): void {
    const tx = this._db.transaction(() => {
      this._stmtAnchorMemory.run(
        nowIso(),
        JSON.stringify(args.tags),
        args.content,
        boolToInt(args.isGlobal),
        args.memoryId,
      );
    });
    tx();
  }

  // ── User mood (MOOD_CONGRUENT_RERANK) ──────────────────────────────────
  //
  // source: cortex@HEAD mcp_server/infrastructure/sqlite_store_mood.py:
  //   get_user_mood / set_user_mood. The TS surface exposes the scalar valence
  //   accessors (arousal reserved, defaults to 0.0).

  getUserMood(): number | null {
    const row = this._db
      .prepare("SELECT valence FROM user_mood WHERE user_id = 'default'")
      .get() as { valence: number } | undefined;
    return row ? Number(row.valence) : null;
  }

  setUserMood(valence: number): void {
    const clamped = clampValence(valence);
    this._db
      .prepare(
        "INSERT INTO user_mood (user_id, valence, updated_at) " +
          "VALUES ('default', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) " +
          "ON CONFLICT(user_id) DO UPDATE SET valence = excluded.valence, " +
          "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      )
      .run(clamped);
  }

  /**
   * Hottest recent memory contents for the structural-novelty window.
   * Iso to get_hot_memories(min_heat=0.0, limit=n): heat_base DESC,
   * last_accessed DESC. An empty domain returns the global hot set.
   *
   * source: cortex@HEAD mcp_server/handlers/remember_helpers.py:154
   */
  listRecentContents(domain: string, n: number): string[] {
    const rows = this._db
      .prepare(
        "SELECT content FROM memories WHERE (? = '' OR domain = ?) " +
          "ORDER BY heat_base DESC, last_accessed DESC LIMIT ?",
      )
      .all(domain, domain, n) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  // ── Homeostatic state ──────────────────────────────────────────────────

  getHomeostaticFactor(domain: string): number {
    const row = this._stmtGetHomeostatic.get(domain || "") as
      | { factor: number }
      | undefined;
    return row?.factor ?? 1.0;
  }

  setHomeostaticFactor(domain: string, factor: number): void {
    // source: infrastructure/sqlite_store.py:set_homeostatic_factor — (0.01, 9.99) matches DB CHECK constraint
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- source: infrastructure/sqlite_store.py:set_homeostatic_factor bounds
    const clamped = Math.max(0.01, Math.min(9.99, factor)); // source: infrastructure/sqlite_store.py:set_homeostatic_factor
    this._stmtUpsertHomeostatic.run(domain || "", clamped, nowIso());
  }

  // ── Vector search (sqlite-vec extension) ──────────────────────────────

  /**
   * Return top-k nearest memories by L2 embedding distance.
   *
   * precondition:  embedding is a valid float32 Buffer of length EMBEDDING_DIM×4 bytes.
   * postcondition: returns up to topK (memory_id, distance) pairs ordered by
   *   ascending distance. Returns [] if sqlite-vec is not loaded.
   *
   * Implementation: queries the memories_vec virtual table created by
   * _tryLoadVec(). Falls back to [] when _hasVec = false.
   *
   * source: Cortex mcp_server/infrastructure/sqlite_store_search.py:search_vectors
   * source: https://alexgarcia.xyz/sqlite-vec/ — vec0 KNN MATCH query syntax
   */
  searchVectors(
    embedding: Buffer,
    topK: number,
    _minHeat?: number,
  ): VecHit[] {
    if (!this._hasVec) return [];

    try {
      // Validate buffer size: must be exactly EMBEDDING_DIM float32 values.
      // source: https://alexgarcia.xyz/sqlite-vec/ — float[N] expects N×BYTES_PER_ELEMENT bytes
      const expectedBytes = EMBEDDING_DIM * Float32Array.BYTES_PER_ELEMENT;
      if (embedding.byteLength !== expectedBytes) {
        return [];
      }

      // sqlite-vec MATCH query: returns rowid (= memory id) and distance.
      // source: Cortex mcp_server/infrastructure/sqlite_store_search.py:search_vectors
      //   "SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
      const rows = this._db
        .prepare(
          `SELECT rowid, distance FROM memories_vec
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(embedding, topK) as Array<{ rowid: number; distance: number }>;

      return rows.map((r) => [r.rowid, r.distance] as VecHit);
    } catch {
      // Extension query failed — degrade gracefully.
      return [];
    }
  }

  /**
   * Full-text search via FTS5. Returns (memory_id, score) pairs.
   *
   * The query string is sanitised before being passed to FTS5: each token is
   * extracted, lowercased, and re-joined as an OR-disjunction of double-quoted
   * literals. This serves two purposes:
   *   1. Strip FTS5 reserved characters (`?`, `!`, `:`, `'`, etc.) that
   *      otherwise raise SQL parse errors and force the catch branch to
   *      return [], silently disabling FTS for any natural-language query.
   *   2. Make the search permissive enough that benchmark queries like
   *      "what pizza place did Alice like?" hit at least one token in
   *      the seeded memories rather than requiring all tokens to AND-match.
   *
   * Sanitisation matches the Python source's behaviour for queries that come
   * out of `build_expanded_query` (a space-joined token bag) — both produce
   * a permissive disjunctive match.
   *
   * source: cortex main mcp_server/infrastructure/sqlite_store_search.py:232-242
   * source: https://www.sqlite.org/fts5.html#full_text_query_syntax — FTS5 query grammar
   */
  // source: cortex main mcp_server/infrastructure/sqlite_store_search.py:232 — default limit=20 (top-20 FTS hits)
  searchFts(query: string, limit = 20): Array<[number, number]> { // eslint-disable-line @typescript-eslint/no-magic-numbers
    const sanitised = sanitiseFts5Query(query);
    if (!sanitised) return [];
    try {
      const rows = this._db
        .prepare(
          "SELECT rowid, rank FROM memories_fts " +
            "WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(sanitised, limit) as Array<{ rowid: number; rank: number }>;
      return rows.map((r) => [r.rowid, -r.rank]);
    } catch {
      // FTS5 syntax error — degrade gracefully (consistent with Python source).
      return [];
    }
  }

  /**
   * Upsert an embedding vector for a memory row.
   *
   * Called by postStore after memory insert when an EmbeddingEngine is available.
   * precondition:  memoryId > 0; emb.byteLength === EMBEDDING_DIM × 4.
   * postcondition: memories_vec row for memoryId is inserted or replaced.
   *   If sqlite-vec is not loaded, this is a no-op.
   *
   * source: Cortex mcp_server/infrastructure/sqlite_store.py — INSERT INTO memories_vec
   */
  upsertEmbedding(memoryId: number, emb: Buffer): void {
    if (!this._hasVec) return;

    try {
      // sqlite-vec virtual tables require BigInt rowid bindings — better-sqlite3
      // otherwise binds JS numbers as REAL, which sqlite-vec rejects with
      // "Only integers are allows for primary key values" (sic). Cast to
      // BigInt at the boundary; safe because memoryId is sourced from
      // last_insert_rowid() and fits in 53 bits well before u64 overflow.
      // source: sqlite-vec README §"Inserting vectors" — rowid must be INTEGER.
      // source: https://github.com/asg017/sqlite-vec — type-check enforcement.
      //
      // sqlite-vec virtual tables also do not implement UPSERT; emulate via
      // DELETE-then-INSERT in a single transaction so the upsert remains
      // atomic from the caller's perspective.
      const rowid = BigInt(memoryId);
      const tx = this._db.transaction(() => {
        this._db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(rowid);
        this._db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)").run(rowid, emb);
      });
      tx();
    } catch {
      // Degrade gracefully — embedding upsert is best-effort.
    }
  }

  // ── Entity graph ───────────────────────────────────────────────────────

  getEntityByName(name: string): EntityRecord | null {
    const row = this._stmtGetEntityByName.get(name) as
      | Record<string, unknown>
      | undefined;
    if (row == null) return null;
    return {
      id: row["id"] as number,
      name: row["name"] as string,
      type: row["type"] as string,
      domain: (row["domain"] as string) ?? "",
      heat: (row["heat"] as number) ?? 1.0,
      archived: Boolean(row["archived"]),
      created_at: row["created_at"] as string,
      last_accessed: row["last_accessed"] as string,
    };
  }

  upsertEntity(name: string, type: string, domain: string, origin = "text_concept"): number {
    const now = nowIso();
    const o = origin === "ast_symbol" ? "ast_symbol" : "text_concept";
    const row = this._stmtUpsertEntity.get(name, type, domain, o, now, now) as
      | { id: number }
      | undefined;
    return row?.id ?? 0;
  }

  linkMemoryEntity(memoryId: number, entityId: number): void {
    this._stmtLinkMemoryEntity.run(memoryId, entityId);
  }

  // ── Async thin wrappers (satisfy MemoryStore optional async interface) ─────
  //
  // SQLite (better-sqlite3) is synchronous internally. These wrappers satisfy
  // the optional async entity interface declared in memory-store.ts so that
  // codebase-analyze-helpers.ts can call *Async variants unconditionally on
  // both backends without an existence check.
  //
  // source: ADR-0042 — async entity variants required by codebase-analyze path.
  // source: ECMAScript — Promise.resolve() wraps a synchronous value in a
  //   resolved microtask; no blocking or thread pool involved.
  // source: liskov@24cb6e2 — same pattern applied to other PG/SQLite method pairs.

  /** Async upsert entity — thin wrapper; SQLite executes synchronously. */
  upsertEntityAsync(name: string, type: string, domain: string, origin = "text_concept"): Promise<number> {
    return Promise.resolve(this.upsertEntity(name, type, domain, origin));
  }

  /** Async getEntityByName — thin wrapper; SQLite executes synchronously. */
  getEntityByNameAsync(name: string): Promise<EntityRecord | null> {
    return Promise.resolve(this.getEntityByName(name));
  }

  /** Async insertRelationship — thin wrapper; SQLite executes synchronously. */
  insertRelationshipAsync(rel: Record<string, unknown>): Promise<void> {
    this.insertRelationship(rel);
    return Promise.resolve();
  }

  /** Async linkMemoryEntity — thin wrapper; SQLite executes synchronously. */
  linkMemoryEntityAsync(memoryId: number, entityId: number): Promise<void> {
    this.linkMemoryEntity(memoryId, entityId);
    return Promise.resolve();
  }

  upsertRelationship(
    sourceEntityId: number,
    targetEntityId: number,
    relationshipType: string,
    weight = 1.0,
  ): void {
    const now = nowIso();
    this._stmtUpsertRelationship.run(
      sourceEntityId,
      targetEntityId,
      relationshipType,
      weight,
      now,
      now,
    );
  }

  // ── Schema matching ────────────────────────────────────────────────────

  getSchemasForDomain(domain: string): Array<Record<string, unknown>> {
    const rows = this._db
      .prepare(`SELECT * FROM schemas WHERE domain = ?`)
      .all(domain || "") as Array<Record<string, unknown>>;
    return rows;
  }

  // ── Oscillatory state ──────────────────────────────────────────────────

  loadOscillatoryState(): string | null {
    const row = this._stmtLoadOscillatory.get() as
      | { state_json: string }
      | undefined;
    return row?.state_json ?? null;
  }

  saveOscillatoryState(stateJson: string): void {
    this._stmtSaveOscillatory.run(stateJson);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  close(): void {
    this._db.close();
  }

  // ── Row normalization ──────────────────────────────────────────────────

  /**
   * Normalize a raw SQLite row into a MemoryItem.
   *
   * A3: expose heat_base as heat for callers that predate A3.
   * source: infrastructure/sqlite_store.py:_normalize_memory_row
   */
  private _normalizeRow(row: Record<string, unknown>): MemoryItem {
    const tags = parseJsonArray(row["tags"]);
    const heatBase = (row["heat_base"] as number) ?? 1.0;
    return {
      id: row["id"] as number,
      content: row["content"] as string,
      tags,
      source: (row["source"] as string) ?? "",
      domain: (row["domain"] as string) ?? "",
      directory_context: (row["directory_context"] as string) ?? "",
      created_at: row["created_at"] as string,
      last_accessed: row["last_accessed"] as string,
      heat_base: heatBase,
      heat: heatBase, // A3 alias
      heat_base_set_at: (row["heat_base_set_at"] as string) ?? "",
      no_decay: Boolean(row["no_decay"]),
      surprise_score: (row["surprise_score"] as number) ?? 0.0,
      // source: infrastructure/sqlite_store.py _normalize_row default importance
      importance: (row["importance"] as number) ?? 0.5, // eslint-disable-line @typescript-eslint/no-magic-numbers
      emotional_valence: (row["emotional_valence"] as number) ?? 0.0,
      confidence: (row["confidence"] as number) ?? 1.0,
      access_count: (row["access_count"] as number) ?? 0,
      useful_count: (row["useful_count"] as number) ?? 0,
      plasticity: (row["plasticity"] as number) ?? 1.0,
      stability: (row["stability"] as number) ?? 0.0,
      reconsolidation_count: (row["reconsolidation_count"] as number) ?? 0,
      last_reconsolidated:
        (row["last_reconsolidated"] as string | null) ?? null,
      store_type: (row["store_type"] as string) ?? "episodic",
      compressed: Boolean(row["compressed"]),
      compression_level: (row["compression_level"] as number) ?? 0,
      original_content: (row["original_content"] as string | null) ?? null,
      is_protected: Boolean(row["is_protected"]),
      is_stale: Boolean(row["is_stale"]),
      slot_index: (row["slot_index"] as number | null) ?? null,
      excitability: (row["excitability"] as number) ?? 1.0,
      consolidation_stage:
        ((row["consolidation_stage"] as string) ?? "labile") as MemoryItem["consolidation_stage"],
      hours_in_stage: (row["hours_in_stage"] as number) ?? 0.0,
      stage_entered_at: (row["stage_entered_at"] as string | null) ?? null,
      replay_count: (row["replay_count"] as number) ?? 0,
      theta_phase_at_encoding: (row["theta_phase_at_encoding"] as number) ?? 0.0,
      encoding_strength: (row["encoding_strength"] as number) ?? 1.0,
      separation_index: (row["separation_index"] as number) ?? 0.0,
      interference_score: (row["interference_score"] as number) ?? 0.0,
      schema_match_score: (row["schema_match_score"] as number) ?? 0.0,
      schema_id: (row["schema_id"] as string | null) ?? null,
      hippocampal_dependency: (row["hippocampal_dependency"] as number) ?? 1.0,
      is_benchmark: Boolean(row["is_benchmark"]),
      agent_context: (row["agent_context"] as string) ?? "",
      is_global: Boolean(row["is_global"]),
      // Supersession edges (MEM-G1): whitelist these so the MEM-G4 version walk
      // (recall-helpers.ts:versionNeighbors via getMemory) sees real ids, not undefined.
      supersedes_id: (row["supersedes_id"] as number | null) ?? null,
      superseded_by_id: (row["superseded_by_id"] as number | null) ?? null,
    };
  }

  // ── Relationship query (used by graph navigation, not part of core contract) ──

  /**
   * Fetch all relationships where the given entity is source or target.
   *
   * postcondition: returns all rows from the relationships table matching
   *   source_entity_id = entityId OR target_entity_id = entityId.
   *   Returns [] if entity has no relationships.
   *
   * source: Cortex mcp_server/infrastructure/sqlite_store_relationships.py
   *   — select all rows where source_entity_id = ? OR target_entity_id = ?
   */
  getRelationshipsForEntity(entityId: number): RelationshipRecord[] {
    const rows = this._db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, relationship_type,
                weight, is_causal, confidence, created_at
         FROM relationships
         WHERE source_entity_id = ? OR target_entity_id = ?`,
      )
      .all(entityId, entityId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r["id"] as number,
      source_entity_id: r["source_entity_id"] as number,
      target_entity_id: r["target_entity_id"] as number,
      relationship_type: r["relationship_type"] as string,
      weight: (r["weight"] as number) ?? 1.0,
      is_causal: Boolean(r["is_causal"]),
      confidence: (r["confidence"] as number) ?? 1.0,
      created_at: r["created_at"] as string,
    }));
  }

  // ── MemoryStoreExt methods ─────────────────────────────────────────────
  // These were previously accessible only via escape-hatch casts in index.ts
  // and consolidation.ts. Lifting them onto the interface closes all LSP
  // violations on the SQLite backend.
  //
  // source: Liskov & Wing (1994) — the contract IS the interface; both
  //   subtypes must satisfy the same behavioral contract.

  // ── Decay / stats ──────────��───────────────────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_queries.py:108-112
   */
  getAllMemoriesForDecay(): Record<string, unknown>[] {
    return this._db
      .prepare("SELECT * FROM memories WHERE NOT is_stale")
      .all() as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_queries.py:78-86
   */
  // source: sqlite_store_queries.py:79
  getAllMemoriesForValidation(limit = 1000): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    return this._db
      .prepare("SELECT * FROM memories WHERE NOT is_stale ORDER BY last_accessed ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
  }

  // ── Domain / directory / hot queries ──────────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_queries.py:19-27
   */
  // source: sqlite_store_queries.py:21
  getMemoriesForDomain(domain: string, minHeat = 0.05, limit = 50): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    return this._db
      .prepare(
        "SELECT * FROM memories WHERE (domain = ? OR is_global = 1) " +
          "AND heat_base >= ? ORDER BY heat_base DESC LIMIT ?",
      )
      .all(domain, minHeat, limit) as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_queries.py:29-37
   */
  // source: sqlite_store_queries.py:30
  getMemoriesForDirectory(directory: string, minHeat = 0.05): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    return this._db
      .prepare(
        "SELECT * FROM memories WHERE (directory_context = ? OR is_global = 1) " +
          "AND heat_base >= ? ORDER BY heat_base DESC",
      )
      .all(directory, minHeat) as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_queries.py:39-57
   */
  // source: sqlite_store_queries.py:41
  getHotMemories(minHeat = 0.7, limit = 20, includeBenchmarks = false): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    if (includeBenchmarks) {
      return this._db
        .prepare("SELECT * FROM memories WHERE heat_base >= ? ORDER BY heat_base DESC LIMIT ?")
        .all(minHeat, limit) as Record<string, unknown>[];
    }
    return this._db
      .prepare(
        "SELECT * FROM memories WHERE heat_base >= ? " +
          "AND NOT COALESCE(is_benchmark, 0) " +
          "ORDER BY heat_base DESC LIMIT ?",
      )
      .all(minHeat, limit) as Record<string, unknown>[];
  }

  // ── Consolidation stage queries ─────────────────────────────���──────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:157
   */
  // source: sqlite_store_stats.py:108
  getMemoriesByStage(stage: string, limit = 100): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    return this._db
      .prepare(
        "SELECT * FROM memories WHERE consolidation_stage = ? " +
          "ORDER BY hours_in_stage DESC LIMIT ?",
      )
      .all(stage, limit) as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:70-84
   */
  updateMemoryConsolidation(
    memoryId: number,
    stage: string,
    hoursInStage: number,
    replayCount: number,
    hippocampalDependency: number,
  ): void {
    this._db
      .prepare(
        "UPDATE memories SET consolidation_stage = ?, " +
          "hours_in_stage = ?, replay_count = ?, " +
          "hippocampal_dependency = ? WHERE id = ?",
      )
      .run(stage, hoursInStage, replayCount, hippocampalDependency, memoryId);
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:86-106
   */
  insertStageTransitionsBatch(rows: Record<string, unknown>[]): number {
    if (rows.length === 0) return 0;
    const stmt = this._db.prepare(
      "INSERT INTO stage_transitions " +
        "(memory_id, from_stage, to_stage, hours_in_prev_stage, trigger) " +
        "VALUES (?, ?, ?, ?, ?)",
    );
    const runBatch = this._db.transaction((batchRows: Record<string, unknown>[]) => {
      for (const r of batchRows) {
        stmt.run(
          Number(r["memory_id"]),
          String(r["from_stage"]),
          String(r["to_stage"]),
          Number(r["hours_in_prev"] ?? r["hours_in_stage"] ?? 0),
          String(r["trigger"] ?? "cascade"),
        );
      }
    });
    runBatch(rows);
    return rows.length;
  }

  /**
   * Update stage_entered_at for a memory row.
   *
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py — cascade stage logic
   */
  updateStageEnteredAt(memoryId: number, enteredAt: string): void {
    this._db
      .prepare("UPDATE memories SET stage_entered_at = ? WHERE id = ?")
      .run(enteredAt, memoryId);
  }

  // ── CLS queries ────────────────────────���───────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:183-199
   */
  // source: sqlite_store_stats.py:184
  getEpisodicMemories(domain = "", directory = "", limit = 500): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    const conditions = ["store_type = 'episodic'", "NOT is_stale"];
    const params: unknown[] = [];
    if (domain) { conditions.push("domain = ?"); params.push(domain); }
    if (directory) { conditions.push("directory_context = ?"); params.push(directory); }
    params.push(limit);
    return this._db
      .prepare(`SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:201-217
   */
  // source: sqlite_store_stats.py:201
  getSemanticMemories(domain = "", limit = 500): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    if (domain) {
      return this._db
        .prepare(
          "SELECT * FROM memories WHERE store_type = 'semantic' " +
            "AND domain = ? AND NOT is_stale ORDER BY created_at DESC LIMIT ?",
        )
        .all(domain, limit) as Record<string, unknown>[];
    }
    return this._db
      .prepare(
        "SELECT * FROM memories WHERE store_type = 'semantic' " +
          "AND NOT is_stale ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:219-224
   */
  updateMemoryStoreType(memoryId: number, storeType: string): void {
    this._db
      .prepare("UPDATE memories SET store_type = ? WHERE id = ?")
      .run(storeType, memoryId);
  }

  // ── Entity queries for consolidation ──────────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_entities.py:99-111
   */
  getAllEntities(opts?: { minHeat?: number; includeArchived?: boolean }): Record<string, unknown>[] {
    // source: sqlite_store_entities.py:99
    const minHeat = opts?.minHeat ?? 0.05; // eslint-disable-line @typescript-eslint/no-magic-numbers
    if (opts?.includeArchived) {
      return this._db
        .prepare("SELECT * FROM entities WHERE heat >= ?")
        .all(minHeat) as Record<string, unknown>[];
    }
    return this._db
      .prepare("SELECT * FROM entities WHERE heat >= ? AND NOT archived")
      .all(minHeat) as Record<string, unknown>[];
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_entities.py:19-37
   */
  updateEntitiesHeatBatch(updates: Array<[number, number]>): void {
    if (updates.length === 0) return;
    const stmt = this._db.prepare("UPDATE entities SET heat = ? WHERE id = ?");
    const tx = this._db.transaction((rows: Array<[number, number]>) => {
      for (const [id, heat] of rows) stmt.run(heat, id);
    });
    tx(updates);
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_entities.py:39-48
   */
  archiveEntitiesBatch(entityIds: number[]): number {
    if (entityIds.length === 0) return 0;
    const stmt = this._db.prepare("UPDATE entities SET heat = 0 WHERE id = ?");
    const tx = this._db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id);
    });
    tx(entityIds);
    return entityIds.length;
  }

  /**
   * Collapse alias entity into survivor in one SQLite transaction.
   *
   * precondition:  survivorId and aliasId are positive integers; both exist in entities.
   * postcondition: if merged, all memory_entities and relationships rows pointing to
   *   alias are retargeted to survivor; self-loops deleted; survivor absorbs alias
   *   heat/recency via MAX (bounded — never a sum); alias tombstoned (archived=1, heat=0).
   *
   * No-op when ids equal, an entity is missing, or either is an ast_symbol —
   * code-symbol identity is structural and must never be fuzzy-merged.
   *
   * source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py:19-43
   */
  mergeEntities(
    survivorId: number,
    aliasId: number,
  ): { merged: boolean; survivor_id: number; alias_id: number; memory_links_moved: number; relationships_rewired: number } {
    const result = {
      merged: false,
      survivor_id: survivorId,
      alias_id: aliasId,
      memory_links_moved: 0,
      relationships_rewired: 0,
    };

    if (survivorId === aliasId) return result;

    // Require both entities present AND neither an ast_symbol — code symbols are
    // structural identities, never fuzzy-merged.
    // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py:37-43
    const existingRows = this._db
      .prepare("SELECT id, origin FROM entities WHERE id IN (?, ?)")
      .all(survivorId, aliasId) as Array<{ id: number; origin: string | null }>;
    const origins = new Map(existingRows.map((r) => [r.id, r.origin ?? "text_concept"]));
    if (origins.size !== 2 || [...origins.values()].includes("ast_symbol")) return result;

    const doMerge = this._db.transaction(() => {
      // Rewire memory_entities links: dedup via OR IGNORE.
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — INSERT OR IGNORE
      this._db
        .prepare(
          "INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) " +
            "SELECT memory_id, ? FROM memory_entities WHERE entity_id = ?",
        )
        .run(survivorId, aliasId);

      // Delete the alias's memory_entities links.
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — DELETE FROM memory_entities
      const movedInfo = this._db
        .prepare("DELETE FROM memory_entities WHERE entity_id = ?")
        .run(aliasId);
      const moved = movedInfo.changes;

      // Rewire relationship source references.
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — UPDATE relationships source
      const srcInfo = this._db
        .prepare("UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?")
        .run(survivorId, aliasId);

      // Rewire relationship target references.
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — UPDATE relationships target
      const tgtInfo = this._db
        .prepare("UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?")
        .run(survivorId, aliasId);

      // Delete self-loops created by the rewire.
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — DELETE self-loops
      this._db
        .prepare(
          "DELETE FROM relationships WHERE source_entity_id = target_entity_id AND source_entity_id = ?",
        )
        .run(survivorId);

      // Absorb alias heat/recency into survivor via MAX — bounded, not a sum.
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — UPDATE entities heat
      this._db
        .prepare(
          "UPDATE entities SET " +
            "heat = MAX(heat, (SELECT heat FROM entities WHERE id = ?)), " +
            "last_accessed = MAX(last_accessed, (SELECT last_accessed FROM entities WHERE id = ?)) " +
            "WHERE id = ?",
        )
        .run(aliasId, aliasId, survivorId);

      // Tombstone the alias: archived=1, heat=0 (auditable, NOT deleted).
      // source: cortex main mcp_server/infrastructure/sqlite_store_entity_merge.py — UPDATE entities tombstone
      this._db
        .prepare("UPDATE entities SET archived = 1, heat = 0 WHERE id = ?")
        .run(aliasId);

      return { moved, rewired: srcInfo.changes + tgtInfo.changes };
    });

    const { moved, rewired } = doMerge();
    result.merged = true;
    result.memory_links_moved = moved;
    result.relationships_rewired = rewired;
    return result;
  }

  // ── Relationship queries ──────────────────────────────��────────────────

  /**
   * source: cortex main mcp_server/infrastructure/pg_store_relationships.py:105-112
   */
  getAllRelationships(): Record<string, unknown>[] {
    return this._db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, relationship_type,
                weight, is_causal, confidence, created_at
         FROM relationships`,
      )
      .all() as Record<string, unknown>[];
  }

  /**
   * Find co-accessed entity pairs for a set of memory IDs.
   *
   * source: cortex main mcp_server/infrastructure/pg_store_queries.py:154-162
   */
  findCoAccessedPairs(memoryIds: number[]): Array<[number, number]> {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = this._db
      .prepare(
        `SELECT DISTINCT MIN(me1.entity_id, me2.entity_id) AS a, MAX(me1.entity_id, me2.entity_id) AS b
         FROM memory_entities me1 JOIN memory_entities me2
           ON me1.memory_id = me2.memory_id AND me1.entity_id < me2.entity_id
         WHERE me1.memory_id IN (${placeholders})`,
      )
      .all(...memoryIds) as Array<{ a: number; b: number }>;
    return rows.map((r) => [r.a, r.b] as [number, number]);
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_relationships.py
   */
  updateRelationshipsWeightBatch(updates: Array<[number, number]>): void {
    if (updates.length === 0) return;
    const stmt = this._db.prepare("UPDATE relationships SET weight = ? WHERE id = ?");
    const tx = this._db.transaction((rows: Array<[number, number]>) => {
      for (const [id, weight] of rows) stmt.run(weight, id);
    });
    tx(updates);
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_relationships.py
   */
  deleteRelationshipsBatch(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this._db
      .prepare(`DELETE FROM relationships WHERE id IN (${placeholders})`)
      .run(...ids);
    return result.changes;
  }

  /**
   * Insert a raw relationship record.
   *
   * source: cortex main mcp_server/infrastructure/sqlite_store_relationships.py
   */
  insertRelationship(rel: Record<string, unknown>): void {
    const now = nowIso();
    this._stmtUpsertRelationship.run(
      Number(rel["source_entity_id"]),
      Number(rel["target_entity_id"]),
      String(rel["relationship_type"] ?? "generic"),
      typeof rel["weight"] === "number" ? rel["weight"] : 1.0,
      now,
      now,
    );
  }

  /**
   * Reinforce or create a relationship between two entity names.
   *
   * source: cortex main mcp_server/infrastructure/pg_store_relationships.py:133-207
   */
  reinforceOrCreateRelationship(entityA: string, entityB: string, _learningRate: number): void {
    // Simplified SQLite version: upsert a co_retrieval relationship.
    // source: cortex main mcp_server/infrastructure/sqlite_store_relationships.py
    //   — reinforce_or_create_relationship
    const srcRow = this._db
      .prepare("SELECT id FROM entities WHERE LOWER(name) = LOWER(?) LIMIT 1")
      .get(entityA) as { id: number } | undefined;
    const tgtRow = this._db
      .prepare("SELECT id FROM entities WHERE LOWER(name) = LOWER(?) LIMIT 1")
      .get(entityB) as { id: number } | undefined;
    if (srcRow == null || tgtRow == null) return;
    const now = nowIso();
    this._db
      .prepare(
        `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, weight, created_at, last_reinforced)
         VALUES (?, ?, 'co_retrieval', 1.0, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(srcRow.id, tgtRow.id, now, now);
  }

  // ── Hippocampal transfer ───────────────────────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py — transfer candidates
   */
  // source: sqlite_store_stats.py
  getTransferCandidates(limit = 50): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    return this._db
      .prepare(
        `SELECT * FROM memories
         WHERE store_type = 'episodic'
           AND hippocampal_dependency > 0.5
           AND NOT is_stale
         ORDER BY hippocampal_dependency DESC, heat_base DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
  }

  /**
   * Update hippocampal dependency for a memory row.
   */
  updateHippocampalDependency(memoryId: number, dependency: number): void {
    this._db
      .prepare("UPDATE memories SET hippocampal_dependency = ? WHERE id = ?")
      .run(dependency, memoryId);
  }

  // ── Recently accessed ─────────────────────────────��────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:90-101
   */
  // source: sqlite_store_stats.py:93
  getRecentlyAccessedMemories(limit = 20, minAccessCount = 1): Record<string, unknown>[] { // eslint-disable-line @typescript-eslint/no-magic-numbers
    return this._db
      .prepare(
        "SELECT * FROM memories WHERE access_count >= ? " +
          "AND NOT is_stale ORDER BY last_accessed DESC LIMIT ?",
      )
      .all(minAccessCount, limit) as Record<string, unknown>[];
  }

  // ── Agent context query (codebase-analyze) ────────────────────────────
  //
  // LSP-VIOLATION CLOSED (#5): codebase-analyze called store.execute()
  // which is SQLite-specific. Replaced with a typed method.
  //
  // source: packages/memory/src/codebase-analysis/handlers/codebase-analyze-helpers.ts:142-160

  getMemoriesByAgentContext(agentContext: string): Array<{ id: number; tags: string }> {
    const rows = this._db
      .prepare(
        "SELECT id, tags FROM memories WHERE agent_context = ? AND NOT is_stale",
      )
      .all(agentContext) as Array<{ id: number; tags: string | unknown }>;
    return rows.map((r) => ({
      id: r.id,
      tags: typeof r.tags === "string" ? r.tags : JSON.stringify(r.tags ?? []),
    }));
  }

  // ── Prospective memories ───────────────────────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_auxiliary.py:39-42
   */
  getActiveProspectiveMemories(): Record<string, unknown>[] {
    return this._db
      .prepare("SELECT * FROM prospective_memories WHERE is_active")
      .all() as Record<string, unknown>[];
  }

  // ── Total memory count ─────────────────────────────────────────────────

  /**
   * Count of stored memory rows. Iso to rebuild_profiles totalMemories.
   * source: cortex@HEAD mcp_server/handlers/rebuild_profiles.py:113
   */
  countMemories(): number {
    const row = this._db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    return Number(row.c);
  }

  // ── Replay count ───────────────────────��───────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:125-130
   */
  incrementReplayCount(memoryId: number): void {
    this._db
      .prepare("UPDATE memories SET replay_count = replay_count + 1 WHERE id = ?")
      .run(memoryId);
  }

  // ── Archive / compression ─────────────────────���────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_auxiliary.py:114-132
   */
  insertArchive(row: Record<string, unknown>): void {
    try {
      this._db
        .prepare(
          `INSERT INTO memory_archives (original_memory_id, content, mismatch_score, archive_reason)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          Number(row["original_memory_id"]),
          String(row["content"] ?? ""),
          typeof row["mismatch_score"] === "number" ? row["mismatch_score"] : 0.0,
          String(row["archive_reason"] ?? ""),
        );
    } catch {
      // best-effort: table may not exist in all schema versions
    }
  }

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py — compression
   */
  updateMemoryCompression(
    memoryId: number,
    content: string,
    embedding: Buffer | null,
    compressionLevel: number,
    _opts?: Record<string, unknown>,
  ): void {
    this._db
      .prepare(
        `UPDATE memories SET content = ?, compressed = 1,
            compression_level = ?,
            original_content = CASE WHEN original_content IS NULL THEN content ELSE original_content END
         WHERE id = ?`,
      )
      .run(content, compressionLevel, memoryId);
    // Re-persist the embedding (SQLite keeps vectors in the memories_vec vec0
    // table, not a column) so the stored vector matches the new content — Cortex
    // update_memory_compression rewrites the embedding (pg_store.py:835-858). The
    // previous TS impl dropped it, leaving the compression cycle + curation-merge
    // with a stale vector. No-op when sqlite-vec is unavailable (upsertEmbedding
    // self-guards on this._hasVec).
    // source: cortex main mcp_server/infrastructure/pg_store.py:835-858 update_memory_compression
    if (embedding && embedding.byteLength > 0) {
      this.upsertEmbedding(memoryId, embedding);
    }
  }

  // ── By-IDs batch fetch ─────────────────────────────────────────────────

  getByIds(ids: number[]): Record<string, unknown>[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this._db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
  }

  // ── Consolidation log ──────────────────────────────────────────────────

  /**
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:228-241
   */
  logConsolidation(data: Record<string, unknown>): void {
    try {
      this._db
        .prepare(
          "INSERT INTO consolidation_log " +
            "(memories_added, memories_updated, memories_archived, duration_ms) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(
          (data["memories_added"] as number) ?? 0,
          (data["memories_updated"] as number) ?? 0,
          (data["memories_archived"] as number) ?? 0,
          (data["duration_ms"] as number) ?? 0,
        );
    } catch {
      // best-effort: table may not exist in all schema versions
    }
  }

  // ── Prospective memory write ───────────────────────────────────────────

  /**
   * Insert a prospective memory record and return its id.
   *
   * postcondition: new row in prospective_memories with is_active = true.
   * source: cortex main mcp_server/infrastructure/sqlite_store_auxiliary.py:21-37
   */
  insertProspectiveMemory(data: Record<string, unknown>): number {
    const result = this._db
      .prepare(
        "INSERT INTO prospective_memories " +
          "(content, trigger_condition, trigger_type, " +
          "target_directory, is_active, triggered_count) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        data["content"] as string,
        data["trigger_condition"] as string,
        (data["trigger_type"] as string) ?? "keyword",
        (data["target_directory"] as string | null) ?? null,
        data["is_active"] !== false && data["is_active"] !== 0 ? 1 : 0,
        (data["triggered_count"] as number) ?? 0,
      );
    return result.lastInsertRowid as number;
  }

  /**
   * Return the count of currently active prospective memory triggers.
   *
   * source: cortex main mcp_server/infrastructure/sqlite_store_stats.py:355
   */
  countActiveTriggers(): number {
    const row = this._db
      .prepare("SELECT COUNT(*) as c FROM prospective_memories WHERE is_active")
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  // ── Rules ────────────────────────────────────────────────────────────

  /**
   * Insert a memory rule and return its id.
   * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:14-31
   */
  insertRule(data: Record<string, unknown>): number {
    const result = this._db
      .prepare(
        "INSERT INTO memory_rules " +
          "(rule_type, scope, scope_value, condition, action, priority, " +
          "is_active, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
      )
      .run(
        (data["rule_type"] as string) ?? "soft",
        (data["scope"] as string) ?? "global",
        (data["scope_value"] as string | null) ?? null,
        data["condition"] as string,
        data["action"] as string,
        (data["priority"] as number) ?? 0,
        data["is_active"] !== false && data["is_active"] !== 0 ? 1 : 0,
      );
    return result.lastInsertRowid as number;
  }

  /**
   * Return all active rules ordered by scope and priority descending.
   * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:41-45
   */
  getAllActiveRules(): Record<string, unknown>[] {
    return this._db
      .prepare(
        "SELECT * FROM memory_rules WHERE is_active ORDER BY scope, priority DESC",
      )
      .all() as Record<string, unknown>[];
  }

  /**
   * Return all active rules for a given scope.
   * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:33-39
   */
  getRulesForScope(scope: string): Record<string, unknown>[] {
    return this._db
      .prepare(
        "SELECT * FROM memory_rules WHERE scope = ? AND is_active " +
          "ORDER BY priority DESC",
      )
      .all(scope) as Record<string, unknown>[];
  }

  /**
   * Return all rules including inactive ones.
   * source: cortex main mcp_server/infrastructure/sqlite_store_rules.py:47-70
   */
  getAllRulesIncludingInactive(): Record<string, unknown>[] {
    return this._db
      .prepare(
        "SELECT * FROM memory_rules ORDER BY scope, priority DESC",
      )
      .all() as Record<string, unknown>[];
  }
}
