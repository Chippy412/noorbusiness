#!/usr/bin/env bash
# Compare the hosted (source) and self-hosted (target) databases: row counts for
# every public table, auth.users, auth.mfa_factors and storage objects.
# Exits nonzero if anything differs. Needs SOURCE_DB_URL; the target is reached
# the same way import-selfhosted.sh does (docker exec supabase-db psql).
# usage: verify.sh [export-dir]   (export-dir also checks the photo file count)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

require_env SOURCE_DB_URL
dump=${1:-}

src() { src_pg psql -At -v ON_ERROR_STOP=1 -c "$1"; }
tgt() { tgt_psql -At -c "$1"; }

bad=0
check() { # label sourceValue targetValue
  if [ "$2" = "$3" ]; then
    printf 'ok       %-40s %s\n' "$1" "$2"
  else
    printf 'MISMATCH %-40s source=%s target=%s\n' "$1" "$2" "$3"
    bad=1
  fi
}

tables=$(src "select table_name from information_schema.tables
              where table_schema='public' and table_type='BASE TABLE' order by 1")
for t in $tables; do
  q="select count(*) from public.\"$t\""
  s=$(src "$q")
  # a table missing on the target is a mismatch, not a crash
  g=$(tgt "$q" 2>/dev/null || echo "missing")
  check "public.$t" "$s" "$g"
done

for t in auth.users auth.mfa_factors storage.objects; do
  q="select count(*) from $t"
  check "$t" "$(src "$q")" "$(tgt "$q")"
done
sq="select bucket_id || ':' || count(*) from storage.objects group by bucket_id order by 1"
check "storage.objects per bucket" "$(src "$sq" | paste -sd, -)" "$(tgt "$sq" | paste -sd, -)"

if [ -n "$dump" ] && [ -d "$dump/storage-files" ]; then
  files=$(find "$dump/storage-files" -type f | wc -l | tr -d ' ')
  check "photo files on disk vs target objects" "$files" "$(tgt 'select count(*) from storage.objects')"
fi

if [ "$bad" -ne 0 ]; then
  echo "FAILED: counts differ" >&2
  exit 1
fi
echo "All counts match."
