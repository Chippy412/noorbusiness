#!/usr/bin/env bash
# Load an export (from export-hosted.sh) into the self-hosted Supabase.
#
# usage: import-selfhosted.sh <export-dir>
#
# Required env:
#   NOTIFY_SECRET            the NOTIFY_SECRET value from /etc/noorbusiness/api.env
#   NOTIFY_BASE_URL          where the database reaches the API, as seen from INSIDE
#                            the supabase-db container, e.g. http://172.17.0.1
#                            (replaces https://nicc-business.vercel.app in the alert triggers)
#   TARGET_SUPABASE_URL      e.g. http://127.0.0.1:8000
#   TARGET_SERVICE_ROLE_KEY  self-hosted service_role key
# Optional env: DB_CONTAINER (supabase-db), DB_USER (postgres), DB_NAME (postgres),
#               TARGET_PSQL (full psql command instead of docker exec),
#               SKIP_SCHEMA=1 (schema and migrations already applied; load data only)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

dump=${1:-}
[ -d "$dump" ] || die "usage: $0 <export-dir>"
require_env NOTIFY_SECRET NOTIFY_BASE_URL TARGET_SUPABASE_URL TARGET_SERVICE_ROLE_KEY
for f in auth.sql public-data.sql storage-meta.sql; do
  [ -f "$dump/$f" ] || die "$dump/$f is missing"
done
command -v jq >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

# Migration order: the README's setup order (the same list tests/db/run.py uses),
# then any other migration files in filename order (2026-10-13-grocery-category,
# 2026-11-02-remove-halal-verification, anything newer).
listed=(
  2026-09-06-business-photos.sql
  2026-09-12-write-rate-limits.sql
  2026-09-13-contact-messages.sql
  2026-09-13-reviews.sql
  2026-09-13-require-mfa-for-owner-writes.sql
  2026-10-04-hardening.sql
  2026-10-04-insert-column-grants.sql
  2026-10-04-lock-public-inserts.sql
  2026-10-04-notify-triggers.sql
  2026-10-05-admin.sql
  2026-10-06-roles.sql
  2026-10-07-fixes.sql
  2026-10-08-review-fixes.sql
  2026-10-09-notifications.sql
  2026-10-10-moderation-tools.sql
  2026-10-11-sponsorship.sql
  2026-10-12-locations.sql
)

# The migrations point the alert triggers at Vercel and carry a placeholder
# secret. Fill both in on the fly; the files on disk are not modified.
apply_migration() {
  log "migration $(basename "$1")"
  sed -e "s|https://nicc-business.vercel.app|${NOTIFY_BASE_URL%/}|g" \
      -e "s|Bearer __NOTIFY_SECRET__|Bearer ${NOTIFY_SECRET//|/\\|}|g" "$1" | tgt_psql -q >/dev/null
}

if [ "${SKIP_SCHEMA:-0}" != 1 ]; then
  # The self-hosted image already creates the auth and storage schemas, the
  # roles (anon, authenticated, service_role) and the extensions schema; schema.sql
  # only creates tables in public, so nothing here recreates them.
  log "schema.sql"
  tgt_psql -q < "$repo/supabase/schema.sql" >/dev/null
  # seed.sql is NOT run: the real listings come from the dump.

  for m in "${listed[@]}"; do
    apply_migration "$repo/supabase/migrations/$m"
  done
  for f in "$repo"/supabase/migrations/*.sql; do
    name=$(basename "$f")
    case " ${listed[*]} " in *" $name "*) continue ;; esac
    apply_migration "$f"
  done
  if [ ! -f "$repo/supabase/migrations/2026-11-02-remove-halal-verification.sql" ]; then
    echo "WARNING: 2026-11-02-remove-halal-verification.sql is not on this branch" >&2
    echo "         (see origin/remove-halal-verification). Apply it with psql afterwards." >&2
  fi
fi

# Data load. session_replication_role=replica turns off triggers (alert emails,
# geocode requests, column guards) and FK checks while rows go in.
load() {
  log "load $1"
  { echo "set session_replication_role = replica;"; cat "$dump/$1"; } | tgt_psql -q >/dev/null
}
load auth.sql
load public-data.sql
load storage-meta.sql

# Photos, through the storage API so the files land in the file backend.
log "upload storage files"
cfg=$(curl_cfg "$TARGET_SERVICE_ROLE_KEY")
trap 'rm -f "$cfg"' EXIT
base=${TARGET_SUPABASE_URL%/}
files="$dump/storage-files"
n=0
if [ -d "$files" ]; then
  while IFS= read -r -d '' path; do
    rel=${path#"$files"/}
    bucket=${rel%%/*}
    obj=${rel#*/}
    ctype=$(file --brief --mime-type "$path" 2>/dev/null || echo application/octet-stream)
    # x-upsert: the metadata load above may already have created the row.
    curl -fsS --config "$cfg" -o /dev/null -X POST \
      -H "Content-Type: $ctype" -H 'x-upsert: true' --data-binary "@$path" \
      "$base/storage/v1/object/$bucket/$(urlpath "$obj")" \
      || die "upload failed for $bucket/$obj"
    n=$((n + 1))
  done < <(find "$files" -type f -print0)
fi
log "uploaded $n files"
echo "Next: rewrite photo URLs (see README.md), then run verify.sh"
