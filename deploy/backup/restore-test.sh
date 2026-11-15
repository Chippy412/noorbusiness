#!/usr/bin/env bash
# deploy/backup/restore-test.sh — prove the latest dump actually restores.
#
# Restores the newest db.dump into a throwaway postgres:17 container, checks
# that public.businesses and auth.users have rows, then removes the container.
# Exits nonzero on any failure. The container has no network; the image is
# pulled from Docker Hub the first time if it is not already present.
set -euo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/noorbusiness}
IMAGE=${RESTORE_IMAGE:-postgres:17}
TABLES=${RESTORE_CHECK_TABLES:-"public.businesses auth.users"}
NAME=noorbusiness-restore-test-$$

log() { echo "restore-test: $*"; }
die() { echo "restore-test: FAILED: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
command -v docker >/dev/null || die "docker not found"

LATEST=$(find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' 2>/dev/null | sort | tail -n 1)
[ -n "$LATEST" ] || die "no backups found in $BACKUP_ROOT/daily"
DUMP=$LATEST/db.dump
[ -s "$DUMP" ] || die "$DUMP missing or empty"
log "testing $DUMP"
(cd "$LATEST" && sha256sum --check --quiet SHA256SUMS) || die "checksum mismatch in $LATEST"

ERRLOG=$(mktemp)
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "${ERRLOG:?}"; }
trap cleanup EXIT

docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=restoretest "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
# The entrypoint restarts postgres once after init; wait for it to settle.
sleep 3
for _ in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -q || die "throwaway postgres did not start"

# Supabase's image has roles and extensions that plain postgres:17 lacks, so
# pg_restore prints some errors (extensions like pgsodium, missing roles). We
# skip owners/grants and judge success by the data checks, not its exit code.
log "restoring"
if ! docker exec -i "$NAME" pg_restore -U postgres -d postgres --no-owner --no-acl <"$DUMP" >/dev/null 2>"$ERRLOG"; then
  log "pg_restore reported errors (usually Supabase-only extensions); last lines:"
  tail -n 5 "$ERRLOG" | sed 's/^/  /'
fi

for t in $TABLES; do
  n=$(docker exec "$NAME" psql -U postgres -d postgres -tAc "select count(*) from $t") \
    || die "cannot query $t"
  [ "${n:-0}" -gt 0 ] || die "$t has no rows"
  log "$t: $n rows"
done
log "OK"
