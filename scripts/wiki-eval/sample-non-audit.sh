#!/usr/bin/env bash
# Sample N memories that have at least one explicit knowledge tag and
# no audit tags. Lets the classifier reach the routing stage so we can
# measure kind/lifecycle/audience/provenance agreement between the TS
# port and the Cortex Python classifier.
#
# Usage:
#   sample-non-audit.sh <db_name> <n>

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: sample-non-audit.sh <db_name> <n>" >&2
  exit 2
fi

db="$1"
n="$2"

# Audit-tag set must mirror page-classifier.ts AUDIT_TAGS.
psql -h localhost -d "$db" -tAq <<SQL
WITH non_audit AS (
  SELECT id, content, tags
    FROM memories
   WHERE length(content) > 100
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb)) AS t
        WHERE t IN (
          '_backfill', 'imported', 'session-summary', 'tool-output',
          'auto-captured',
          'tool:bash', 'tool:edit', 'tool:write', 'tool:multiedit',
          'tool:notebookedit', 'tool:read', 'tool:notebookread',
          'tool:glob', 'tool:grep', 'tool:webfetch', 'tool:websearch',
          'seeded', 'codebase', 'code-review',
          'stage-1', 'stage-2', 'stage-3', 'stage-4', 'stage-5',
          'stage-6', 'stage-7', 'stage-8', 'stage-9', 'stage-10',
          'stage-11',
          'audit', 'automated', 'wip', 'progress'
        )
     )
)
SELECT json_build_object(
  'id', id,
  'content', content,
  'tags', COALESCE(tags, '[]'::jsonb)
)::text
FROM non_audit
ORDER BY random()
LIMIT $n;
SQL
