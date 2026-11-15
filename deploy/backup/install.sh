#!/usr/bin/env bash
# deploy/backup/install.sh — install backup + monitoring units on the server.
#
#   sudo bash /opt/noorbusiness/deploy/backup/install.sh
#
# Idempotent. Creates /etc/noorbusiness/backup.env from the example if missing
# (it never overwrites an existing one), installs the systemd units, and
# enables the timers. It does not run a backup; see the README for first run.
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENVF=/etc/noorbusiness/backup.env
TIMERS=(noorbusiness-backup.timer noorbusiness-restore-test.timer noorbusiness-healthcheck.timer)

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ "$DIR" = /opt/noorbusiness/deploy/backup ] \
  || echo "warning: the units run scripts from /opt/noorbusiness/deploy/backup, but this checkout is $DIR"

for c in docker curl node openssl; do
  command -v "$c" >/dev/null || echo "warning: '$c' not found; the backup/monitoring needs it"
done
command -v aws >/dev/null || echo "warning: aws CLI not found; off-server copy will fail until it is installed"

chmod 755 "$DIR"/*.sh
install -d -m 750 /etc/noorbusiness
install -d -m 700 /var/backups/noorbusiness /var/lib/noorbusiness
if [ ! -f "$ENVF" ]; then
  install -m 600 "$DIR/backup.env.example" "$ENVF"
  echo "!! created $ENVF from the example; fill in the values before the first run"
fi
chmod 600 "$ENVF"

install -m 644 "$DIR"/systemd/*.service "$DIR"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "${TIMERS[@]}"

echo "== installed. Next run times:"
systemctl list-timers 'noorbusiness-*' --no-pager
