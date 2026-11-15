#!/usr/bin/env bash
# deploy/backup/healthcheck.sh — simple server monitoring, run every 5 minutes.
#
#   healthcheck.sh                     run all checks; email on failure
#   healthcheck.sh --notify SUBJECT [BODY]
#                                      send one rate-limited alert (used by
#                                      noorbusiness-alert@.service when a unit fails)
#
# Each distinct problem is emailed (Resend) at most once per 6 hours; state is
# in /var/lib/noorbusiness/alerts. A single "recovered" email is sent when all
# problems clear. Output goes to journald: journalctl -u noorbusiness-healthcheck
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/noorbusiness/backup.env}
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

DISK_MAX_PCT=${DISK_MAX_PCT:-85}
MEM_MIN_MB=${MEM_MIN_MB:-300}
CERT_MIN_DAYS=${CERT_MIN_DAYS:-14}
BACKUP_MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-36}
COMPOSE_PROJECT=${COMPOSE_PROJECT:-supabase}
BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/noorbusiness}
STATE_DIR=${STATE_DIR:-/var/lib/noorbusiness/alerts}
RESEND_COOLDOWN=${RESEND_COOLDOWN:-21600}   # 6 hours
HOST_LABEL=${HOST_LABEL:-$(hostname)}

log() { echo "healthcheck: $*"; }
mkdir -p "$STATE_DIR"

# ---- email -----------------------------------------------------------------

# send_email SUBJECT TEXT ; returns nonzero if it could not be sent.
send_email() {
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ALERT_EMAIL_TO:-}" ] || [ -z "${ALERT_EMAIL_FROM:-}" ]; then
    log "RESEND_API_KEY / ALERT_EMAIL_TO / ALERT_EMAIL_FROM not set; cannot send email"
    return 1
  fi
  local payload
  # node is already required by the API; it gives us correct JSON escaping.
  payload=$(SUBJECT=$1 TEXT=$2 node -e '
    process.stdout.write(JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM,
      to: process.env.ALERT_EMAIL_TO.split(",").map(s => s.trim()),
      subject: process.env.SUBJECT,
      text: process.env.TEXT,
    }));')
  curl -fsS --max-time 20 https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null
}

# alert_key TEXT -> stable file-safe id for a problem
alert_key() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# ---- --notify mode -----------------------------------------------------------
if [ "${1:-}" = "--notify" ]; then
  subject=${2:?usage: healthcheck.sh --notify SUBJECT [BODY]}
  body=${3:-$subject}
  f=$STATE_DIR/$(alert_key "$subject")
  now=$(date +%s)
  last=$(cat "$f" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$RESEND_COOLDOWN" ]; then
    log "suppressed (sent recently): $subject"
    exit 0
  fi
  if send_email "[$HOST_LABEL] $subject" "$body"; then echo "$now" >"$f"; log "sent: $subject"; else exit 1; fi
  exit 0
fi

# ---- checks ------------------------------------------------------------------
FAILURES=()
fail() { FAILURES+=("$1"); log "FAIL: $1"; }

check_disk() {
  local pct
  pct=$(df --output=pcent / | tail -n 1 | tr -dc '0-9')
  [ "$pct" -le "$DISK_MAX_PCT" ] || fail "Disk usage on / is ${pct}% (limit ${DISK_MAX_PCT}%)"
}

check_memory() {
  local avail swap total
  avail=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  swap=$(awk '/^SwapFree:/ {print int($2/1024)}' /proc/meminfo)
  total=$((avail + swap))
  [ "$total" -ge "$MEM_MIN_MB" ] || fail "Low memory: ${avail} MB available + ${swap} MB free swap (minimum ${MEM_MIN_MB} MB)"
}

check_services() {
  local s
  for s in nginx noorbusiness-api docker; do
    systemctl is-active --quiet "$s" || fail "systemd service $s is not active"
  done
}

check_http() {
  curl -fsS -o /dev/null --max-time 10 http://127.0.0.1/ || fail "http://127.0.0.1/ did not return a success status"
  curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:3001/healthz || fail "API /healthz (127.0.0.1:3001) failed"
}

check_containers() {
  local out
  if ! out=$(docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
      --format '{{.Names}}|{{.State}}|{{.Status}}' 2>&1); then
    fail "cannot list docker containers: $out"; return
  fi
  [ -n "$out" ] || { fail "no containers found for compose project '$COMPOSE_PROJECT'"; return; }
  local name state status
  while IFS='|' read -r name state status; do
    if [ "$state" != running ]; then
      fail "container $name is $state"
    elif [[ "$status" == *unhealthy* ]]; then
      fail "container $name is unhealthy"
    fi
  done <<<"$out"
}

check_cert() {
  local cert days end
  for cert in /etc/letsencrypt/live/*/cert.pem; do
    [ -e "$cert" ] || return 0   # no cert yet: nothing to check
    end=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)
    days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
    [ "$days" -ge "$CERT_MIN_DAYS" ] || fail "TLS certificate $(basename "$(dirname "$cert")") expires in ${days} days (renewal failing?)"
  done
}

check_backup_age() {
  [ -d "$BACKUP_ROOT/daily" ] || return 0   # backups not installed yet
  local newest age_h
  newest=$(find "$BACKUP_ROOT/daily" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -printf '%T@\n' | sort -n | tail -n 1)
  [ -n "$newest" ] || { fail "no backups exist in $BACKUP_ROOT/daily"; return; }
  age_h=$(( ($(date +%s) - ${newest%.*}) / 3600 ))
  [ "$age_h" -le "$BACKUP_MAX_AGE_HOURS" ] || fail "Newest backup is ${age_h} hours old (limit ${BACKUP_MAX_AGE_HOURS})"
}

check_disk
check_memory
check_services
check_http
check_containers
check_cert
check_backup_age

# ---- alerting with rate limiting ---------------------------------------------
now=$(date +%s)
if [ "${#FAILURES[@]}" -eq 0 ]; then
  log "all checks passed"
  if compgen -G "$STATE_DIR/*" >/dev/null; then
    rm -f "${STATE_DIR:?}"/*
    send_email "[$HOST_LABEL] RECOVERED: all checks pass" "All health checks are passing again." || true
  fi
  exit 0
fi

# Email only if at least one problem has not been mailed in the last 6 hours;
# the mail lists every current problem.
send=0
for msg in "${FAILURES[@]}"; do
  last=$(cat "$STATE_DIR/$(alert_key "$msg")" 2>/dev/null || echo 0)
  [ $((now - last)) -ge "$RESEND_COOLDOWN" ] && send=1
done
# Forget problems that have cleared so they alert again if they return.
for f in "$STATE_DIR"/*; do
  [ -e "$f" ] || continue
  keep=0
  for msg in "${FAILURES[@]}"; do [ "$(alert_key "$msg")" = "$(basename "$f")" ] && keep=1; done
  [ "$keep" = 1 ] || rm -f "${f:?}"
done

if [ "$send" = 1 ]; then
  body="Problems detected on $HOST_LABEL at $(date -u '+%F %T UTC'):"$'\n\n'
  for msg in "${FAILURES[@]}"; do body+="- $msg"$'\n'; done
  body+=$'\n'"Details: journalctl -u noorbusiness-healthcheck"
  if send_email "[$HOST_LABEL] ALERT: ${#FAILURES[@]} problem(s): ${FAILURES[0]}" "$body"; then
    for msg in "${FAILURES[@]}"; do echo "$now" >"$STATE_DIR/$(alert_key "$msg")"; done
    log "alert email sent"
  fi
else
  log "problems persist but were already emailed within the last $((RESEND_COOLDOWN/3600))h"
fi
exit 1
