#!/usr/bin/env bash
# Stratified sample: pull N memories from each of several tag families
# so the eval covers more than one branch of the classifier.
#
# Usage: sample-diverse.sh <db> <per_stratum>

set -euo pipefail

db="$1"
n="$2"

stratum() {
  local where="$1"
  psql -h localhost -d "$db" -tAq <<SQL
SELECT json_build_object('id', id, 'content', content, 'tags', COALESCE(tags, '[]'::jsonb))::text
  FROM memories
 WHERE length(content) > 100 AND ($where)
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb)) t
      WHERE t IN ('_backfill','imported','session-summary','tool-output','auto-captured',
        'tool:bash','tool:edit','tool:write','tool:multiedit','tool:notebookedit',
        'tool:read','tool:notebookread','tool:glob','tool:grep','tool:webfetch','tool:websearch',
        'seeded','codebase','code-review','stage-1','stage-2','stage-3','stage-4','stage-5',
        'stage-6','stage-7','stage-8','stage-9','stage-10','stage-11',
        'audit','automated','wip','progress')
   )
 ORDER BY random() LIMIT $n;
SQL
}

# Tag-bearing strata
stratum "tags ? 'decision' OR tags ? 'adr'"
stratum "tags ? 'lesson' OR tags ? 'bug-fix'"
stratum "tags ? 'spec' OR tags ? 'design'"
stratum "tags ? 'convention' OR tags ? 'rule' OR tags ? 'standard'"
stratum "tags ? 'note' OR tags ? 'error'"
stratum "tags ? 'code-reference' OR tags ? 'Function' OR tags ? 'Method'"
# Open content (no specific tag, just non-audit)
stratum "true"
