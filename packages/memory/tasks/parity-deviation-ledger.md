# Parity Gap Ledger — Cortex Oracle (Python) vs Memory Package (TypeScript)

Generated: 2026-06-21
Source: 25 confirmed parity gaps between `mcp_server/` (oracle, origin/main) and `packages/memory/src/` (TS port).

---

## 1. Executive Summary

**Total gaps: 25**

| Severity | Count |
|---|---|
| High | 17 |
| Medium | 6 |
| Low | 1 |
| (oracle-removed / dead TS) | 1 (counted under medium) |

Severity distribution shows the port is broadly structurally aligned but carries a large cluster of **silent correctness divergences** in the storage and recall layers — the places where the oracle most recently hardened behavior (origin tagging, ingest checkpointing, auto-capture exclusion, tag filtering, connection-rooted scoping).

### The 5 highest-impact items to close first

1. **`pg_schema.py` → recall WRRF pools (HIGH)** — TS `recall_memories()` hot+recency CTEs lack `AND c.source <> 'post_tool_capture'`. This re-introduces the **60× freshness inversion** the oracle fixed: auto-captures pollute the heat/recency pools. Plus `splitStatements()` mis-splits DDL on `;` inside comments → init syntax error. Single most damaging behavioral gap.
2. **`pg_store_entities.py` / `sqlite_store_entities.py` → entity `origin` (HIGH ×2 + codebase consumer)** — TS `insertEntity` has no `origin` column at all. Code symbols default to `text_concept` instead of `ast_symbol`, so the downstream `entity-dedup` guard (`origin === 'ast_symbol'`) silently fails and AST symbols get fuzzy-merged. Corrupts the entity graph on every codebase ingest.
3. **`recall.py` / `recall_helpers.py` → tag filtering + injection guards (HIGH)** — `filter_by_tags` (tags_any/tags_all), `inject_triggered_memories` `_injectable()` guard, `max_inject` cap, and `injected`/`source` observability fields are all absent from the active TS handler path. Auto-capture blobs leak back into recall; positive tag filtering is unsupported end-to-end.
4. **`backfill_helpers.py` / `backfill_memories.py` → `gist_oversized_content` (HIGH ×2)** — no artifact-store / gist gate exists anywhere in the memory package. Oversized imported content is stored raw with no content-addressed pointer, no budget gate, no failure fallback. Requires porting `artifact_store` + `gist_extraction` infra.
5. **`remember.py` / `recall.py` → connection-rooted scoping + rejection shape (HIGH ×2)** — `root_agent_topic()` (`CORTEX_ROOT_AGENT_TOPIC`) override is absent, so the model can write into/omit another agent's scope (isolation breach). Rejection responses also omit `action:'rejected'`, breaking discrimination of the rejected branch.

---

## 2. Storage

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `infrastructure/pg_schema.py` | `pg-schema-tables.ts`, `pg-schema-indexes.ts`, `pg-schema-functions.ts` | High | `recall_memories()` hot+recency CTEs lack `AND c.source <> 'post_tool_capture'` (60× freshness inversion); `splitStatements()` does not strip `--` line comments before splitting on `;` → mis-split DDL; missing `idx_memories_heat_base_id` (keyset viz pagination); missing `prospective_memories.created_by TEXT NOT NULL DEFAULT ''` + migration; missing `ingest_progress` table (run_id PK, last_key_committed, rows_committed, updated_at); missing `idx_entities_lower_name` functional index. | Add `AND c.source <> 'post_tool_capture'` to hot (l.215) + recency (l.224) WHERE clauses; port `_strip_sql_line_comments` + leading-comment drop into `splitStatements`; add `idx_memories_heat_base_id`, `idx_entities_lower_name`, `ingest_progress` table, and `prospective_memories.created_by` column/migration. |
| `infrastructure/pg_store_entities.py` | `pg-store-entities.ts` | High | `insertEntity` has no `origin` param (oracle reads `origin`, clamps to `text_concept` unless `ast_symbol`); existing-row branch does not SELECT `origin` nor promote to `ast_symbol` (UPDATE when incoming is ast_symbol, existing isn't); INSERT omits `origin` column; missing `get_top_entities_for_domain(domain_slug, limit=20)` (ORDER BY heat DESC, mention_count DESC — seeds domain BFS). | Add `origin?: string` to data, normalize to `text_concept` unless `'ast_symbol'`, SELECT `id, origin`, promote existing to ast_symbol via UPDATE when applicable, add `origin` to INSERT; add exported `getTopEntitiesForDomain(client, domainSlug, limit=20)`. |
| `infrastructure/pg_store_queries.py` | `pg-store-queries.ts` | High | `iter_hot_memories_chunked` (NEW) absent — keyset hottest-first stream with columns allowlist, hard_limit, include_benchmarks, chunk_size paging; `get_memories_by_tag` (NEW) absent — `tags @> [tag]::jsonb AND NOT is_stale ORDER BY created_at DESC`; `iter_memories_for_decay` diverges — TS uses LIMIT/OFFSET, oracle uses server-side named cursor in transaction with POOL_DISABLED kill-switch fallback. | Add `iterHotMemoriesChunked(client, {minHeat, includeBenchmarks, chunkSize, columns, hardLimit?})` keyset loop and `getMemoriesByTag(client, tag, limit=20)`; optionally align `iterMemoriesForDecay` with snapshot/kill-switch semantics. |
| `infrastructure/pg_store.py` | `pg-store.ts`, `memory-config.ts`, `consolidate-background.ts`, `hooks/types.ts`, `pg-schema-functions.ts` | High | `_get_database_url`: TS does not `.strip()` `DATABASE_URL` nor treat unexpanded `${...}` as unset — all construction sites read env raw, so a literal `${user_config.database_url}` builds a bogus store instead of falling back to settings default; `_init_schema` hash-gated migration (sha256 of DDL vs `schema_meta.ddl_hash`, `pg_advisory_lock(1357020271)`, double-check + upsert) never ported — `getAllDdl()` has zero callers, no `schema_meta`, no advisory lock. | Add `resolveDatabaseUrl()` in memory-config that trims and falls back when empty OR contains `${`; route all `PgMemoryStore` sites through it. Port `_init_schema` (hash gate + advisory lock) and call `getAllDdl()` at bootstrap. |
| `infrastructure/pg_store_auxiliary.py` | `pg-store-auxiliary.ts` | High | `get_ingest_progress(run_id)` → `('',0)` when no row — absent; `set_ingest_progress(...)` upsert with `ON CONFLICT (run_id) DO UPDATE` + `updated_at=NOW()` + commit — absent; `clear_ingest_progress(run_id)` DELETE + commit — absent; `insert_prospective_memory` now writes 7th `created_by` column (default '') — TS writes only 6. | Add `getIngestProgress`/`setIngestProgress`/`clearIngestProgress` against `ingest_progress` (mirror ON CONFLICT upsert); add `created_by` to `ProspectiveMemoryData` and INSERT (`$7`, default ''). |
| `infrastructure/sqlite_store_auxiliary.py` | `sqlite-store-auxiliary.ts` | High | `insertProspectiveMemory`: oracle added `created_by` (7 cols / 7 placeholders, `data.get('created_by','')`); TS still inserts 6 columns, never persists `created_by`. | Add `created_by` to column list + a 7th `?`; bind `(data["created_by"] as string) ?? ""` after `triggered_count`. |
| `infrastructure/sqlite_store_entities.py` | `sqlite-store-entities.ts` | High | `insertEntity`: no `origin` read/validation (oracle coerces non-`{ast_symbol,text_concept}` to `text_concept`); INSERT omits `origin` column + bound value. | Compute `origin = ['ast_symbol','text_concept'].includes(data.origin) ? data.origin : 'text_concept'`; add `origin` to INSERT after `domain` and bind it. |
| `infrastructure/sqlite_store_search.py` | `sqlite-store-search.ts` | High | `_decode_tags`: TS emits raw `tags` JSON string, not a list; `getHotEmbeddings` still `return []` (oracle: hot-ID select + per-row embedding fetch); `_fetch_embedding_bytes` helper absent; `getTemporalCoAccess` still `return []` (oracle: self-join proximity-decay query). | Add `_decodeTags(raw)` JSON.parse-with-fallback, type `RecallResult.tags` as `string[]`; implement `getHotEmbeddings` (hot-ID select + `_fetchEmbeddingBytes` via memories_vec rowid, guarded by `_hasVec`); implement `getTemporalCoAccess` (self-join, julianday delta, canonical a<b, clamp, access_count/is_stale filters). |
| `infrastructure/sqlite_schema.py` | `sqlite-store.ts`, `sqlite-schema.ts` | Medium | `prospective_memories.created_by` column + migration absent from live DDL in sqlite-store.ts; dead `sqlite-schema.ts` fully stale (single-string `INDEXES_DDL` indexing non-existent `heat`, lacks `idx_memories_heat_base`, `user_mood` table+seed, `created_by`). | Add `created_by TEXT NOT NULL DEFAULT ''` to `PROSPECTIVE_MEMORIES_DDL` + append migration tuple to `_runMigrations()`; optionally delete or resync the unused `sqlite-schema.ts`. |

---

## 3. Recall

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `handlers/recall.py` | `recall-handler.ts`, `recall/types.ts`, `recall-helpers.ts` | High | `tags_any`/`tags_all` positive tag filtering (after low_signal, before max_results) absent everywhere; `memory_id`+`content_offset` fetch-by-id path (`_fetch_by_id` slices content, sets content_length/offset, bound_payload) absent; `root_agent_topic()` (`CORTEX_ROOT_AGENT_TOPIC`) scope override absent; `inject_triggered_memories` `max_inject=max_results` cap absent; empty-query early-return shape diverges (cosmetic); intent enum widening not validated in TS (schema-parity only). | Add `tags_any/tags_all` to schema + `filterByTags` after `filterLowSignal` before cap; add `memory_id/content_offset` request args + `fetchById` branch (slice, set fields, boundPayload); read `CORTEX_ROOT_AGENT_TOPIC` and override `agent_topic`; pass `max_inject=max_results` and cap injected count. |
| `handlers/recall_helpers.py` | `recall-helpers.ts`, `recall-handler.ts` | High | `filter_by_tags()` (OR/AND, lowercased, order-preserving, no-op when empty) absent; `inject_triggered_memories` `max_inject` cap absent in both variants; `_injectable()` guard (reject `source=='post_tool_capture'` OR LOW_SIGNAL_TAGS overlap) absent — injects any non-null mem; result shape omits `injected:True` + `source`; active handler-local `injectTriggeredMemories` (recall-handler.ts:479) lacks all of the above while the closest helper export is unused. | Add `filterByTags(results, tagsAny, tagsAll)` and wire after `filterLowSignal`; add `max_inject` + `_injectable(mem)` guard to the ACTIVE `injectTriggeredMemories`, cap to `k`, add `injected:true` + `source` per record. |
| `core/retrieval_dispatch.py` | `recall/rrf.ts`, `recall/multi-signal-fusion.ts` | Medium | `wrrf_fuse` now uses `zip(..., strict=True)` — raises `ValueError` when signal/weight lengths differ; TS `wrrfFuseSignals` looks up `weights[name] ?? 1.0`, silently defaulting a missing weight; `fuseSignals` silently falls back to plain RRF when weights undefined — no length/count invariant anywhere. | In `wrrfFuseSignals`/`fuseSignals`, assert every active signal name has a weight entry and no extras; throw an `Error` (mirroring `strict=True`) instead of defaulting to 1.0. |
| `handlers/recall_hierarchical.py` | `recall-hierarchical-handler.ts`, `recall/types.ts` | Low | `<3`-embeddings flat fallback: oracle returns top-level `fallback: "flat_recall"` with `hierarchy: {stats: {}}`; TS puts marker at `hierarchy.stats.fallback` = `"too_few_embeddings"`/`"no_embedding_engine"`; schema does not model top-level `fallback`. (`get_shared_store` is a Python-singleton concern — no TS analog.) | Add optional `fallback: z.string().optional()` to the response schema; in both fallback branches return top-level `fallback: "flat_recall"` with `hierarchy: { stats: {} }`. |
| `handlers/memories_page.py` | `recall/handlers/memories-page.ts` | Medium (oracle-removed) | Entire 294-line oracle file deleted in origin/main (commit 77dba678, Phase 6 viz-stack removal) — `serve`/`_build_query`/`_row_to_node`/`_decode_cursor`/`_encode_cursor` gone. TS port (352 lines) still implements keyset pagination, `_row_to_node` shaping, emotion bucketing, SQL builder — dead/divergent code with no oracle counterpart. | Delete `memories-page.ts`, remove its route wiring + export-barrel references, mirroring Phase 6. Confirm no remaining TS consumer depends on `/api/memories` before removal. |

---

## 4. Remember

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `handlers/remember.py` | `remember/handlers/remember.ts`, `block-replica-upsert.ts` | High | Connection-rooted scoping: oracle forces `args['agent_topic']=root_agent_topic()` (`CORTEX_ROOT_AGENT_TOPIC`) before parse so model cannot write into/omit another scope — no such helper anywhere in TS; `no_content` rejection: oracle returns `{stored:false, action:'rejected', reason:'no_content'}` on both empty-args and empty-after-harden; TS omits `action:'rejected'` (remember.ts:140, :309). | Add `rootAgentTopic()` reader (env) in memory-config; force `agentTopic=root` in `remember()/rememberAsync()` before reading args; add `action:'rejected'` to both `no_content` early returns. |
| `handlers/remember_response.py` | `remember/handlers/remember-response.ts` | High | `build_response` normalizes curation action vocabulary to schema-canonical enum: `create`/`link`→`stored`, `merge`→`merged`, `supersede`→`superseded` (unknown pass through); TS `buildResponse` emits `action` verbatim (l.266), leaking internal present-tense ops instead of documented past-tense outcomes. | Map `action` through `{create:'stored',link:'stored',merge:'merged',supersede:'superseded'}[action] ?? action` and assign to response `action`. |
| `core/write_gate.py` | `remember/write-gate.ts` | High | `build_rejection_response` now emits `action:"rejected"` in the response dict; TS `buildRejectionResponse` omits it (only `stored:false` + `reason`), so the rejection branch is not discriminated by `action` while success already sets `action:"stored"`. | In `buildRejectionResponse` (~l.299), add `action: "rejected" as const` to the returned object and its return-type annotation. |

---

## 5. Consolidation

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `core/emergence_metrics.py` | `methodology/emergence-metrics.ts` | Medium | `generate_emergence_report_streamed(memory_chunks, events)` constant-memory streaming entry point absent; `generate_emergence_report` is now a thin wrapper delegating to streamed path — TS still computes directly from lists (list/streaming parity unprovable); helpers absent: `_forgetting_from_bin_means`, `_bins_to_means`, `_schema_acceleration_from_agg`, `_phase_locking_from_agg`, `_fold_schema_cohort`; oracle removed `_compute_stage_distribution`/`_compute_avg_interference` (TS still defines them, harmless). | Port `generate_emergence_report_streamed` (chunked input, bounded reducers) + 5 aggregate helpers; make `generateEmergenceReport` delegate via `[memories]`; drop the now-removed `computeStageDistribution`/`computeAvgInterference`. |

---

## 6. Handlers

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `handlers/backfill_helpers.py` | `import/backfill-helpers.ts`, `import/backfill-memories.ts` | High | `gist_oversized_content()` write-side gate for oversized import content absent; `needs_gist(content)` budget check (`GIST_BUDGET`) absent in `import/`; on oversized, writes FULL raw content to content-addressed artifact via `store_artifact()` — no artifact infra exists in the package; deterministic gist + pointer line `**Artifact:** \`{path}\` ({len} chars full output)` not produced; artifact-write failure fallback to full content absent; two live consumers (backfill-memories.ts + import_sessions) do not gate extracted content. | Add `gistOversizedContent(content)` (port `artifact_store.py` + `gist_extraction.py`): if `needsGist`, write full via `storeArtifact()`, return gist + Artifact pointer, wrap in try/catch falling back to full content; route extracted content through it in backfill-memories.ts and the import-sessions handler. |
| `handlers/backfill_memories.py` | `import/backfill-memories.ts`, `import/backfill-helpers.ts` | High | `gist_oversized_content(content)` applied in `_import_single_item` before tagging (oversized → artifact + gist body + pointer, failure → full content); TS `importSingleItem` stores raw content with no gist/artifact step; `get_shared_store(...)` reuse — TS uses DI param (functionally equivalent, low/NA). | Port `gist_oversized_content` into backfill-helpers.ts and call in `importSingleItem` right after the `length<20` guard: `content = gistOversizedContent(content);` before building tags. |
| `handlers/codebase_analyze_helpers.py` | `codebase-analysis/handlers/codebase-analyze-helpers.ts` | High | `_get_or_create_entity` inserts `origin='ast_symbol'` (exempts code symbols from fuzzy dedup); TS `_getOrCreateEntity` calls `upsertEntityAsync(name,type,domain)` with NO origin → defaults to `text_concept`, eligible for fuzzy dedup (consumer entity-dedup.ts:423 reads `origin==='ast_symbol'` to skip, so tagging silently fails); `persist_god_node_tags(store, god_nodes)` (tags codebase memories with `god-node`) has no TS equivalent. | Extend `upsertEntity`/`upsertEntityAsync` (both stores) with `origin` param, have `_getOrCreateEntity` pass `'ast_symbol'`; add exported `persistGodNodeTags(store, godNodes)` filtering codebase memories whose content includes filePath and appending `god-node` via `updateMemoryContent`. |
| `handlers/ingest_helpers.py` | `codebase-analysis/handlers/ingest-helpers.ts` | High | `graph_path_is_materialised()` (valid only if exists AND non-empty) absent; `find_cached_graph` rewrite — TS returns FIRST tag match unconditionally with no existence/recency/freshness checks (oracle: prefers bounded `get_memories_by_tag(tag,20)`, collects candidates, sorts by recency DESC, returns first materialised + fresh); `_memo_recency_key()` (created_at > heat_base_set_at > last_accessed) absent; `graph_is_fresh()` + `_FRESHNESS_IGNORE_DIRS` (graph mtime vs newest source via pruned walk) absent; `call_upstream` `govern()` concurrency wrapper absent; `get_memories_by_tag` capability probe absent. | Rewrite `findCachedGraph`: use `getMemoriesByTag(tag,20)` when present else full scan, build `(recencyKey, path)` via `_memoRecencyKey`, sort DESC, return first passing `graphPathIsMaterialised()` + `graphIsFresh()`, else null; add `govern()` concurrency wrapper around `pool.call` in `callUpstream`. |
| `handlers/seed_project.py` | `codebase-analysis/handlers/seed-project.ts` | High | Domain auto-detection on EMPTY string (issue #16): oracle `domain = args.get("domain","") or root.name` — empty string falls back to `root.name`; TS `args.domain?.trim() ?? basename(root)` — `??` only fires on null/undefined, so explicit/whitespace-only empty string is kept as `""`, running domain-scoped purge against `domain=""`. | In `parseArgs`: `const domain = (args.domain?.trim() || basename(root));` — use `||` (falsy-coalescing) instead of `??`. |

---

## 7. Hooks

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `hooks/session_start.py` | `session-start.ts`, `session-start-context.ts`, `db.ts`, `session-start-maintenance.ts` | High | `auth_failed` cold-start branch: oracle `_build_cold_start_message` returns dedicated '## Cortex — Database Authentication' banner; TS `buildColdStartMessage` (l.205-228) has no such branch → wrong banner; hot-memory noise exclusion is SQL-side in oracle `_fetch_hot_memories` (AND NOT auto-captured/memory-replica, BEFORE LIMIT); TS `fetchHotMemories` (db.ts:170-176) lacks the SQL filter (post-fetch `isTierNoise()` only) → can return fewer than HOT_LIMIT non-noise rows; `DATABASE_URL` default `localhost`→`127.0.0.1` (cosmetic literal deviation). | Add `if (setupResult?.status === "auth_failed")` branch in `buildColdStartMessage` returning the auth banner before the generic non-ready message; add SQL `AND NOT (tags @> '["auto-captured"]'::jsonb OR tags @> '["memory-replica"]'::jsonb)` in `fetchHotMemories` (keep post-filter as defense-in-depth); optionally update `DATABASE_URL` default. |

---

## 8. Validation

| Oracle file | TS file(s) | Severity | Missing behaviors | Fix sketch |
|---|---|---|---|---|
| `handlers/validate_memory.py` | `recall/handlers/validate-memory-handler.ts` | Medium | `schema.annotations` is still `READ_ONLY` in TS; oracle changed it to `IDEMPOTENT_WRITE` — `validate_memory` mutates `is_stale` (unless dry_run), so the MCP annotation must advertise an idempotent write. (`get_shared_store` change has no TS analog — store is injected.) | In validate-memory-handler.ts: `import { IDEMPOTENT_WRITE } from "../../shared/tool-meta.js"` and set `schema.annotations: IDEMPOTENT_WRITE` (drop `READ_ONLY`). No action for the store-singleton change. |

---

## Appendix — Reflection status counts

| `reflectedInTS` | Count |
|---|---|
| no | 9 |
| partial | 12 |
| oracle-removed | 1 |

The `partial` cluster is the most dangerous class: the structure looks ported and tests may pass, but a recent oracle hardening (a new predicate, a new column, a new guard) was not carried over — these are the silent correctness regressions to prioritize after the explicit `no` gaps.
