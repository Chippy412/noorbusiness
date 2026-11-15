#!/usr/bin/env bash
# Export the hosted Supabase project: database data, auth users and photos.
#
# Required env:
#   SOURCE_DB_URL            hosted Postgres connection string (Dashboard > Connect)
#   SOURCE_SUPABASE_URL      https://<project-ref>.supabase.co
#   SOURCE_SERVICE_ROLE_KEY  hosted service_role key
# Optional env:
#   OUT_ROOT  parent folder for the export (default ./export)
#   PG_IMAGE  docker image for pg_dump if 17+ is not installed (default postgres:17)
#
# Writes OUT_ROOT/<timestamp>/ and prints its path on the last line.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

require_env SOURCE_DB_URL SOURCE_SUPABASE_URL SOURCE_SERVICE_ROLE_KEY
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required (sudo dnf install -y jq)"

out="${OUT_ROOT:-./export}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out/storage-files"
base=${SOURCE_SUPABASE_URL%/}

# Column-named INSERTs with ON CONFLICT DO NOTHING: tolerant of column-order
# differences between the hosted and self-hosted versions, and re-runnable.
dump_opts=(--data-only --no-owner --no-privileges --column-inserts --rows-per-insert=100 --on-conflict-do-nothing)

log "public schema data"
src_pg pg_dump "${dump_opts[@]}" --schema=public > "$out/public-data.sql"

log "auth.users, auth.identities, auth.mfa_factors"
src_pg pg_dump "${dump_opts[@]}" \
  --table=auth.users --table=auth.identities --table=auth.mfa_factors > "$out/auth.sql"

log "storage.buckets and storage.objects metadata"
src_pg pg_dump "${dump_opts[@]}" \
  --table=storage.buckets --table=storage.objects > "$out/storage-meta.sql"

log "storage files"
cfg=$(curl_cfg "$SOURCE_SERVICE_ROLE_KEY")
trap 'rm -f "$cfg"' EXIT
api() { curl -fsS --config "$cfg" "$@"; }

# List every object under a prefix, recursing into "folders" (entries with no id).
list_objects() {
  local bucket=$1 prefix=$2 offset=0 page n dir
  while :; do
    page=$(api -X POST -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg p "$prefix" --argjson o "$offset" \
            '{prefix:$p,limit:100,offset:$o,sortBy:{column:"name",order:"asc"}}')" \
      "$base/storage/v1/object/list/$bucket")
    n=$(jq 'length' <<<"$page")
    [ "$n" -gt 0 ] || break
    jq -r --arg p "$prefix" '.[] | select(.id != null) | $p + .name' <<<"$page"
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      list_objects "$bucket" "$prefix$dir/"
    done < <(jq -r '.[] | select(.id == null) | .name' <<<"$page")
    [ "$n" -ge 100 ] || break
    offset=$((offset + n))
  done
}

total=0
while IFS= read -r bucket; do
  [ -n "$bucket" ] || continue
  log "bucket $bucket"
  count=0
  while IFS= read -r obj; do
    [ -n "$obj" ] || continue
    mkdir -p "$out/storage-files/$bucket/$(dirname "$obj")"
    api -o "$out/storage-files/$bucket/$obj" "$base/storage/v1/object/$bucket/$(urlpath "$obj")"
    count=$((count + 1))
  done < <(list_objects "$bucket" "")
  echo "    $count files"
  total=$((total + count))
done < <(api "$base/storage/v1/bucket" | jq -r '.[].name')

{
  echo "exported_at=$(date -u +%FT%TZ)"
  echo "storage_files=$total"
} > "$out/manifest.txt"

log "done: $total files"
echo "$out"
