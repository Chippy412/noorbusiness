#!/usr/bin/env bash
# deploy/backup/backup.sh — nightly backup of Postgres + Supabase storage.
#
# Writes /var/backups/noorbusiness/daily/YYYY-MM-DD/{db.dump,globals.sql,
# storage.tar.gz,config.tar.gz,SHA256SUMS}, keeps 14 daily + 8 weekly (Sunday) copies, then
# copies the day to S3 if BACKUP_S3_URI is set. Run as root (systemd does).
# Output goes to stdout/stderr, which journald captures:
#   journalctl -u noorbusiness-backup
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/noorbusiness/backup.env}
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/noorbusiness}
DB_CONTAINER=${DB_CONTAINER:-supabase-db}
SUPABASE_DIR=${SUPABASE_DIR:-/opt/supabase/docker}
STORAGE_DIR=${STORAGE_DIR:-$SUPABASE_DIR/volumes/storage}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
BACKUP_S3_URI=${BACKUP_S3_URI:-}

log()  { echo "backup: $*"; }
warn() { echo "backup: WARNING: $*" >&2; }
die()  { echo "backup: ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
command -v docker >/dev/null || die "docker not found"
[ -d "$STORAGE_DIR" ] || die "storage dir $STORAGE_DIR not found"

TODAY=$(date +%F)
DAILY_DIR=$BACKUP_ROOT/daily
WEEKLY_DIR=$BACKUP_ROOT/weekly
install -d -m 700 "$DAILY_DIR" "$WEEKLY_DIR"

# Build in a .partial directory so an interrupted run is never mistaken for a
# good backup; rename only when everything is written.
WORK=$DAILY_DIR/$TODAY.partial
trap 'rm -rf "${WORK:?}"' EXIT
rm -rf "${WORK:?}"
install -d -m 700 "$WORK"

log "dumping database from container $DB_CONTAINER"
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres -Fc >"$WORK/db.dump"
# Roles/passwords are cluster-wide and not part of pg_dump; keep them for a
# full rebuild (contains password hashes, so this directory is mode 700).
docker exec "$DB_CONTAINER" pg_dumpall -U postgres --globals-only >"$WORK/globals.sql"
[ -s "$WORK/db.dump" ] || die "database dump is empty"

log "archiving storage volume $STORAGE_DIR"
tar -C "$(dirname "$STORAGE_DIR")" -czf "$WORK/storage.tar.gz" "$(basename "$STORAGE_DIR")"

# Config and secrets needed to rebuild the stack (Supabase JWT secret and keys
# live in .env; without them restored users and tokens would not validate).
CONFIG_FILES=()
for f in "$SUPABASE_DIR/.env" /etc/noorbusiness/api.env /etc/noorbusiness/backup.env; do
  [ -f "$f" ] && CONFIG_FILES+=("$f")
done
if [ "${#CONFIG_FILES[@]}" -gt 0 ]; then
  tar -czf "$WORK/config.tar.gz" "${CONFIG_FILES[@]}" 2>/dev/null
else
  warn "no config files found to back up"
fi

# Sanity check: the dump must be readable by pg_restore.
docker exec -i "$DB_CONTAINER" pg_restore --list <"$WORK/db.dump" >/dev/null \
  || die "pg_restore cannot read the new dump"

(cd "$WORK" && sha256sum -- * >SHA256SUMS)
rm -rf "${DAILY_DIR:?}/$TODAY"
mv "$WORK" "$DAILY_DIR/$TODAY"
trap - EXIT
log "wrote $DAILY_DIR/$TODAY ($(du -sh "$DAILY_DIR/$TODAY" | cut -f1))"

# Weekly copy on Sundays (hard links, so no extra disk space).
if [ "$(date +%u)" = 7 ]; then
  rm -rf "${WEEKLY_DIR:?}/$TODAY"
  cp -al "$DAILY_DIR/$TODAY" "$WEEKLY_DIR/$TODAY"
  log "weekly copy $WEEKLY_DIR/$TODAY"
fi

# Retention: dated directory names sort chronologically.
prune() { # dir keep
  local dir=$1 keep=$2 old d
  old=$(find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' | sort | head -n "-$keep")
  [ -z "$old" ] && return 0
  while read -r d; do log "pruning $d"; rm -rf "${d:?}"; done <<<"$old"
}
prune "$DAILY_DIR" "$KEEP_DAILY"
prune "$WEEKLY_DIR" "$KEEP_WEEKLY"

# Off-server copy.
if [ -z "$BACKUP_S3_URI" ]; then
  warn "BACKUP_S3_URI is not set; skipping off-server copy. Backups exist only on this server."
else
  command -v aws >/dev/null || die "aws CLI not found (needed because BACKUP_S3_URI is set)"
  dest=${BACKUP_S3_URI%/}/$TODAY/
  log "uploading to $dest"
  aws s3 cp --only-show-errors --recursive "$DAILY_DIR/$TODAY" "$dest"
  log "upload complete"
fi

log "done"
