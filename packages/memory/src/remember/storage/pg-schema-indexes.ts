/**
 * pg-schema-indexes.ts — Indexes and migrations DDL.
 * source: cortex main mcp_server/infrastructure/pg_schema.py:530-1353
 */

// source: cortex main mcp_server/infrastructure/pg_schema.py:532-567
export const INDEXES_DDL = `
CREATE INDEX IF NOT EXISTS idx_memories_embedding
    ON memories USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_heat_base ON memories (heat_base);
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories (domain);
CREATE INDEX IF NOT EXISTS idx_memories_store_type ON memories (store_type);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at);
CREATE INDEX IF NOT EXISTS idx_memories_stage ON memories (consolidation_stage);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities (name);
CREATE INDEX IF NOT EXISTS idx_entities_heat ON entities (heat);
CREATE INDEX IF NOT EXISTS idx_prospective_active ON prospective_memories (is_active);
CREATE INDEX IF NOT EXISTS idx_schemas_domain ON schemas (domain);
CREATE INDEX IF NOT EXISTS idx_rel_pair_type
    ON relationships (source_entity_id, target_entity_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_memories_agent_context ON memories (agent_context);
CREATE INDEX IF NOT EXISTS idx_workflow_graph_layout_version ON workflow_graph_layout (layout_version);
CREATE INDEX IF NOT EXISTS idx_workflow_graph_layout_kind ON workflow_graph_layout (kind);
CREATE INDEX IF NOT EXISTS idx_workflow_graph_layout_xy ON workflow_graph_layout (x, y);
`;

// source: cortex main mcp_server/infrastructure/pg_schema.py:1128-1353
export const MIGRATIONS_DDL = `
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'heat')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'heat_base')
    THEN ALTER TABLE memories RENAME COLUMN heat TO heat_base;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'heat_base_set_at')
    THEN
        ALTER TABLE memories ADD COLUMN heat_base_set_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        UPDATE memories SET heat_base_set_at = COALESCE(last_accessed, created_at, NOW());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'no_decay')
    THEN ALTER TABLE memories ADD COLUMN no_decay BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_relationships_canonical_co_retrieval')
    THEN
        CREATE UNIQUE INDEX uq_relationships_canonical_co_retrieval
            ON relationships (source_entity_id, target_entity_id, relationship_type)
            WHERE relationship_type = 'co_retrieval';
    END IF;
END $$;

-- Full directed-tuple UNIQUE index. The pre-existing index above is PARTIAL
-- (co_retrieval only); insertRelationship's unqualified ON CONFLICT needs a
-- non-partial arbiter on (source, target, type). Without it, re-ingest (e.g.
-- incremental codebase re-analysis) silently DUPLICATES every 'calls'/'contains'
-- edge. Dedup keeps MIN(id) and touches only the relationships table — no
-- cross-table repointing (mirrors uq_relationships_canonical_co_retrieval).
-- source: Cortex mcp_server/infrastructure/pg_schema.py — uq_relationships_directed dedup+UNIQUE index migration
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'uq_relationships_directed'
    ) THEN
        DELETE FROM relationships r
        USING (
            SELECT source_entity_id, target_entity_id, relationship_type,
                   MIN(id) AS keep_id
            FROM relationships
            GROUP BY source_entity_id, target_entity_id, relationship_type
            HAVING COUNT(*) > 1
        ) dup
        WHERE r.source_entity_id = dup.source_entity_id
          AND r.target_entity_id = dup.target_entity_id
          AND r.relationship_type = dup.relationship_type
          AND r.id <> dup.keep_id;

        CREATE UNIQUE INDEX uq_relationships_directed
            ON relationships (source_entity_id, target_entity_id, relationship_type);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='is_benchmark')
    THEN ALTER TABLE memories ADD COLUMN is_benchmark BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_not_benchmark ON memories (heat_base DESC) WHERE NOT is_benchmark;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='agent_context')
    THEN ALTER TABLE memories ADD COLUMN agent_context TEXT DEFAULT '';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='is_global')
    THEN ALTER TABLE memories ADD COLUMN is_global BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_is_global ON memories (is_global) WHERE is_global = TRUE;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='stage_entered_at')
    THEN
        ALTER TABLE memories ADD COLUMN stage_entered_at TIMESTAMPTZ;
        UPDATE memories SET stage_entered_at = created_at WHERE stage_entered_at IS NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='ingested_at')
    THEN
        ALTER TABLE memories ADD COLUMN ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        UPDATE memories SET ingested_at = created_at;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='arousal')
    THEN ALTER TABLE memories ADD COLUMN arousal REAL NOT NULL DEFAULT 0.0 CHECK (arousal >= 0.0 AND arousal <= 1.0);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='dominant_emotion')
    THEN ALTER TABLE memories ADD COLUMN dominant_emotion TEXT NOT NULL DEFAULT 'neutral'
        CHECK (dominant_emotion IN ('frustration','satisfaction','confusion','urgency','discovery','neutral'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_dominant_emotion ON memories (dominant_emotion) WHERE dominant_emotion != 'neutral';

-- Supersession edges (MEM-G1): idempotent ADD COLUMN guards for existing DBs.
-- source: Cortex mcp_server/infrastructure/pg_schema.py — supersession ADD COLUMN migration guards
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='supersedes_id')
    THEN ALTER TABLE memories ADD COLUMN supersedes_id INTEGER REFERENCES memories(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='superseded_by_id')
    THEN ALTER TABLE memories ADD COLUMN superseded_by_id INTEGER REFERENCES memories(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Partial indexes for supersession-chain walks (head-of-chain demotion + version walk).
-- source: Cortex mcp_server/infrastructure/pg_schema.py — supersession partial indexes
CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE OR REPLACE FUNCTION normalize_domain() RETURNS trigger AS $$
BEGIN
    NEW.domain := LOWER(COALESCE(NEW.domain, ''));
    IF NEW.domain IN ('jarvis', 'cortex-cowork') THEN NEW.domain := 'cortex'; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_memories_domain_normalize') THEN
        CREATE TRIGGER trg_memories_domain_normalize BEFORE INSERT OR UPDATE OF domain ON memories
        FOR EACH ROW EXECUTE FUNCTION normalize_domain();
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_entities_domain_normalize') THEN
        CREATE TRIGGER trg_entities_domain_normalize BEFORE INSERT OR UPDATE OF domain ON entities
        FOR EACH ROW EXECUTE FUNCTION normalize_domain();
    END IF;
END $$;

-- Migration: entity origin provenance (ast_symbol vs text_concept). Fuzzy
-- entity dedup (core.entity_dedup) must merge only text-extracted concepts;
-- AST-extracted code symbols (class/function/module names, dotted module paths)
-- share long prefixes and must never be label-fuzzy-merged.
-- Backfill: rows whose type is a code-symbol kind, or whose name is a slash
-- path or a dotted module path (>= 2 dots, mirrors entity_dedup_filters.
-- is_structural_identifier), are ast_symbol; everything else stays text_concept.
-- source: cortex main mcp_server/infrastructure/pg_schema.py
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='entities' AND column_name='origin')
    THEN
        ALTER TABLE entities ADD COLUMN origin TEXT NOT NULL DEFAULT 'text_concept'
            CHECK (origin IN ('ast_symbol', 'text_concept'));
        UPDATE entities SET origin = 'ast_symbol'
        WHERE LOWER(type) IN ('function','method','class','struct','module',
                              'file','interface','trait','protocol','enum',
                              'type','constant','variable')
           OR name LIKE '%/%'
           OR (length(name) - length(replace(name, '.', ''))) >= 2;
    END IF;
END $$;
`;
