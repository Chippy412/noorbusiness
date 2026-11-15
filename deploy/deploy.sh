#!/usr/bin/env bash
# deploy/deploy.sh — run ON the Lightsail server (Amazon Linux 2023) as ec2-user.
#
#   First time:  sudo git clone https://github.com/Chippy412/noorbusiness /opt/noorbusiness
#                sudo bash /opt/noorbusiness/deploy/deploy.sh --install
#   Updates:     sudo bash /opt/noorbusiness/deploy/deploy.sh [branch]
#
# Pulls the repo, copies the public files to /var/www/noorbusiness, installs
# the Nginx site and the API service, and restarts both. It does not touch
# DNS, TLS certificates, Supabase or any secret: /etc/noorbusiness/api.env
# must be filled in by hand (see deploy/api.env.example).
set -euo pipefail

APP=/opt/noorbusiness
WEB=/var/www/noorbusiness
ENVF=/etc/noorbusiness/api.env
INSTALL=0
BRANCH=main
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    *) BRANCH="$a" ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
cd "$APP"

echo "== updating $APP to origin/$BRANCH"
git config --global --add safe.directory "$APP" >/dev/null 2>&1 || true
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH" 2>/dev/null || git checkout --quiet -b "$BRANCH" "origin/$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
git log -1 --oneline

if [ "$INSTALL" = 1 ]; then
  echo "== first-time install"
  id noorbusiness >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin noorbusiness
  install -d -m 755 "$WEB"
  install -d -m 750 /etc/noorbusiness
  if [ ! -f "$ENVF" ]; then
    install -m 600 deploy/api.env.example "$ENVF"
    echo "!! created $ENVF from the example; fill in the secrets, then re-run this script"
  fi
  install -m 644 deploy/systemd/noorbusiness-api.service /etc/systemd/system/noorbusiness-api.service
  systemctl daemon-reload
  systemctl enable noorbusiness-api
fi

echo "== static files -> $WEB"
STAGE=$(mktemp -d)
cp -r noor-business.html 404.html manifest.webmanifest robots.txt js images "$STAGE"/
rsync -a --delete "$STAGE"/ "$WEB"/ 2>/dev/null || { rm -rf "${WEB:?}"/*; cp -r "$STAGE"/. "$WEB"/; }
rm -rf "$STAGE"

# Point the browser at this server instead of Vercel / hosted Supabase:
# Supabase is same-origin (Nginx proxies it), the anon key is the self-hosted
# one, and canonical / sitemap links use SITE_URL. Values come from api.env.
if [ -f "$ENVF" ]; then
  SITE_URL=$(grep -E '^SITE_URL=' "$ENVF" | cut -d= -f2- || true)
  ANON=$(grep -E '^SUPABASE_ANON_KEY=' "$ENVF" | cut -d= -f2- || true)
  if [ -n "$ANON" ]; then
    sed -i -E \
      -e 's#var SUPABASE_URL = "[^"]*";#var SUPABASE_URL = window.location.origin;#' \
      -e "s#var SUPABASE_ANON_KEY = \"[^\"]*\";#var SUPABASE_ANON_KEY = \"$ANON\";#" \
      "$WEB/js/supabase-client.js"
  else
    echo "!! SUPABASE_ANON_KEY missing in $ENVF; the site still talks to hosted Supabase"
  fi
  if [ -n "$SITE_URL" ]; then
    sed -i "s#https://nicc-business.vercel.app#${SITE_URL%/}#g" "$WEB/noor-business.html" "$WEB/robots.txt" "$WEB/404.html"
  fi
fi
chmod -R a+rX "$WEB"

echo "== nginx"
install -m 644 deploy/nginx/noorbusiness.conf /etc/nginx/conf.d/noorbusiness.conf
nginx -t
systemctl reload nginx

echo "== api"
node --test tests/api.test.js tests/server.test.js tests/guide.test.js >/dev/null && echo "tests ok"
systemctl restart noorbusiness-api
sleep 1
curl -fsS http://127.0.0.1:3001/healthz && echo
curl -fsS -o /dev/null -w "site via nginx: %{http_code}\n" http://127.0.0.1/
echo "== done"
