---
name: cortex-setup-project
description: "Bootstrap Cortex for a new project or import ALL existing session history at full scale. Use when the user says 'set up Cortex', 'seed this project', 'import my history', 'backfill memories', 'bootstrap memory', 'initialize Cortex for this project', 'import all repos', 'bootstrap all', or when starting to use Cortex on an existing codebase that already has Claude Code conversation history."
---

# Setup Project — Fully Autonomous Full-Scale Bootstrap (v0.3.1)

Execute all phases sequentially **without asking the user any questions**. If a phase errors, log the error to stderr and continue to the next phase. Never stop the bootstrap on a non-fatal error. Never ask the user to run commands manually or choose between options.

Target end-state: ≥ Cortex Python reference counts
- Memories:         181,717
- Entities:         81,751
- Relationships:    225,679
- Memory-entities:  106,860
- Total nodes:      263,468

---

## Phase 1: Infrastructure Verification

1. Run `pg_isready` via bash to check if PostgreSQL is running.
2. Call `memory:memory_stats({})` to verify database connectivity.
3. If **either** check fails:
   - Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"` automatically. Do not ask for permission.
   - After setup.sh completes, call `memory:memory_stats({})` again to verify.
   - If it still fails, report the error output and **stop**. Do not continue to later phases.
4. If both checks pass, proceed to Phase 2.

---

## Phase 2: Build Methodology Profiles

1. Call `memory:rebuild_profiles({"force": true})` to scan all session history and build cognitive profiles per domain.
2. This creates the domain hubs that memories, entities, and discussions link to. It must run before seeding.
3. Record the domain count for the final summary.

---

## Phase 3: History Import — Pass 1 (standard importance threshold)

**Goal: ~138k memories**

1. Call `memory:backfill_memories({"dry_run": true, "max_files": 5000})` to preview available session files. Record the file count.
2. Call `memory:backfill_memories({"max_files": 5000, "min_importance": 0.3, "force_reprocess": false})`.
   - This is a long-running call. Do NOT abort or time it out; wait for completion.
3. Record the memory count returned for the final summary.

---

## Phase 3b: History Import — Pass 2 (low-importance sweep)

**Goal: +150k more memories → ~280k total**

1. Call `memory:backfill_memories({"max_files": 5000, "min_importance": 0.0, "force_reprocess": true})`.
   - `force_reprocess: true` re-scans files already processed in Pass 1 to capture low-importance signals that were filtered out.
   - This is intentionally the heaviest call in the bootstrap. Do NOT abort; wait for completion.
2. Record the cumulative memory count from the response.

---

## Phase 4: Codebase Seeding

### 4a: Seed current working directory

1. Call `memory:seed_project({"directory": "<cwd>"})` where `<cwd>` is the current working directory.
2. Record the count of discoveries for the final summary.

### 4b: Pipeline Codebase Analysis — ALL repos

Discover every Git repository under `~/Developments/` **and** every path the user passed in `$ARGUMENTS` (space-separated absolute paths). For each discovered directory, run a full codebase analysis.

**Discovery procedure:**

1. Run via bash:
   ```
   find ~/Developments -maxdepth 2 -name ".git" -type d 2>/dev/null | sed 's|/.git$||' | sort
   ```
   Collect the list of repo root paths. Call this list `REPOS`.

2. If `$ARGUMENTS` is non-empty, split on spaces and append each entry to `REPOS` (deduplicate by absolute path).

**Analysis loop — for each path in REPOS:**

For each `repo_path` in `REPOS`:

1. Derive `domain` = basename of `repo_path`.
2. Call with a **10-minute per-repo timeout**:
   ```
   memory:codebase_analyze({
     "directory": "<repo_path>",
     "domain": "<domain>",
     "max_files": 5000,
     "max_file_size_kb": 200,
     "incremental": false
   })
   ```
3. If the call succeeds: record `(domain, wiki_pages, memory_entities, kg_edges)` for the final summary.
4. If the call times out (>10 min wall-clock) or returns an error:
   - Log: `[WARN] codebase_analyze skipped for <repo_path>: <error>`
   - Continue to the next repo. Do NOT stop the bootstrap.

If `codebase_analyze` is unavailable (tool not found / McpConnectionError): skip Phase 4b entirely with a single log line and proceed to Phase 5.

---

## Phase 5: Consolidation and Verification

1. Call `memory:consolidate({})` to run decay, compression, CLS, and causal discovery on all memories.
2. Call `memory:memory_stats({})` to get the final system state. Capture all counts.
3. Call `memory:detect_gaps({})` to identify knowledge gaps.

---

## Final Summary

After all phases complete, print a single summary block. Compute the percentage of each Cortex Python reference count achieved (use the reference figures in the header of this skill):

```
Cortex Bootstrap Complete (v0.3.1)
====================================
Domains:           <count from rebuild_profiles>

History import
  Pass 1 files:    <file count from dry_run>
  Pass 1 memories: <count after pass 1>
  Pass 2 memories: <count after pass 2>

Codebase analysis
  Repos analyzed:  <N of M (M = total discovered)>
  Repos skipped:   <count + names>
  Total KG edges:  <sum across all repos>

Final counts vs Cortex Python reference
  Metric               Actual     Reference  % of target
  ─────────────────────────────────────────────────────
  Memories             <n>        181,717    <pct>%
  Entities             <n>        81,751     <pct>%
  Relationships        <n>        225,679    <pct>%
  Memory-entities      <n>        106,860    <pct>%
  Total nodes          <n>        263,468    <pct>%

Gaps found:        <count and brief description from detect_gaps>
```

Do not print intermediate status updates between phases beyond what the tool calls themselves return. One summary at the end.
