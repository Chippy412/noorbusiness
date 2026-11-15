#!/usr/bin/env bash
# Shared helpers for the migration scripts. Source this; do not run it.
# Nothing here ever prints a connection string or an API key.

# Image used for pg_dump/psql against the HOSTED database when the client tools
# are not installed. pg_dump must be at least as new as the hosted server
# (the hosted project runs Postgres 17.11), so use a 17 client.
PG_IMAGE="${PG_IMAGE:-postgres:17}"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

require_env() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || die "environment variable $v is not set"
  done
}

# Run a Postgres client tool (pg_dump or psql) against the hosted database.
# Via docker the URL goes through the environment; a local tool takes it as an argument.
# A locally installed tool is used only if it is version 17 or newer.
src_pg() {
  local tool=$1; shift
  if command -v "$tool" >/dev/null 2>&1 \
     && [ "$("$tool" --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')" -ge 17 ]; then
    "$tool" "$SOURCE_DB_URL" "$@"
  else
    command -v docker >/dev/null 2>&1 || die "$tool 17+ not installed and docker not available"
    docker run --rm -i -e SOURCE_DB_URL "$PG_IMAGE" \
      sh -c 'tool=$1; shift; exec "$tool" "$SOURCE_DB_URL" "$@"' sh "$tool" "$@"
  fi
}

# Run psql against the SELF-HOSTED database (inside the supabase-db container
# by default). Reads SQL from stdin or takes normal psql arguments.
#   TARGET_PSQL  override the whole command, e.g. "psql postgresql://postgres:pw@127.0.0.1:5432/postgres"
#   DB_CONTAINER container name (default supabase-db)
#   DB_USER      database role (default postgres; use supabase_admin if a
#                "permission denied to set parameter" error appears)
tgt_psql() {
  if [ -n "${TARGET_PSQL:-}" ]; then
    # shellcheck disable=SC2086  # intentional word splitting of the override
    $TARGET_PSQL -v ON_ERROR_STOP=1 "$@"
  else
    docker exec -i "${DB_CONTAINER:-supabase-db}" \
      psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" -v ON_ERROR_STOP=1 "$@"
  fi
}

# Write a private curl config file holding the Authorization headers, so the
# service-role key never appears in `ps` output. Prints the file path.
curl_cfg() {
  local f
  f=$(mktemp)
  chmod 600 "$f"
  printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' "$1" "$1" > "$f"
  echo "$f"
}

# URL-encode each path segment, keeping the slashes.
urlpath() {
  printf '%s' "$1" | jq -sRr 'rtrimstr("\n") | split("/") | map(@uri) | join("/")'
}
