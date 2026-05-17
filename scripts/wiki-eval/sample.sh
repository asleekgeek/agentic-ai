#!/usr/bin/env bash
# Sample N random memories from a Postgres DB and dump (id, content, tags)
# as JSONL on stdout.
#
# Usage:
#   sample.sh <db_name> <n>
#
# Uses psql with COPY TO JSON; avoids needing a Node pg dependency.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: sample.sh <db_name> <n>" >&2
  exit 2
fi

db="$1"
n="$2"

psql -h localhost -d "$db" -tAq -F $'\t' <<SQL
SELECT json_build_object(
  'id', id,
  'content', content,
  'tags', COALESCE(tags, '[]'::jsonb)
)::text
FROM memories
WHERE length(content) > 100
ORDER BY random()
LIMIT $n;
SQL
