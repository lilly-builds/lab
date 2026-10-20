#!/usr/bin/env bash
# THIS FILE IS FOR: running the database checks on a plain local Postgres when Docker (supabase start) is not available.
# It does what the whiteboard-db CI job does: migrations applied twice on a clean database, then the policy suite.
# Usage: bash ideas/ai-whiteboard/supabase/tests/scratch.sh [database-name]   (default ai_toolbox_scratch; it is DROPPED and recreated)
# Needs psql, createdb and dropdb on PATH and a superuser login (PGHOST/PGUSER as usual). Never point it at a real project.
set -euo pipefail

db="${1:-ai_toolbox_scratch}"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"

apply() { psql -q -X -d "$db" -v ON_ERROR_STOP=1 -f "$1" > /dev/null; }

# THIS SECTION IS FOR: the repeatability rule, as CI runs it (supabase db reset twice: a clean database each time).
for pass in 1 2; do
  dropdb --if-exists "$db"
  createdb "$db"
  apply "$here/scratch-prelude.sql"
  for f in "$migrations"/*.sql; do apply "$f"; done
  echo "migrations applied on a clean database (pass $pass)"
done

# A migration whose header says it is idempotent must also apply a second time on top of itself.
for f in "$migrations"/*.sql; do
  if head -3 "$f" | grep -qi 'idempotent'; then apply "$f"; echo "re-applied $(basename "$f")"; fi
done

psql -q -X -d "$db" -v ON_ERROR_STOP=1 -f "$here/policy_tests.sql" > /dev/null
