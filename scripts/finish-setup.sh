#!/usr/bin/env bash
#
# Finishes the NICC Business setup in one go. Run it yourself (it handles
# secrets, so it is deliberately not something an AI assistant runs):
#
#   bash scripts/finish-setup.sh
#
# What it does:
#   1. Asks for your Amazon SES IAM access key (hidden) and where alerts go.
#   2. Generates a random NOTIFY_SECRET.
#   3. Sets NOTIFY_SECRET, AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY,
#      AWS_SES_REGION, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM
#      on Vercel (production) and redeploys.
#   4. Builds ONE SQL script (lock public inserts + alert triggers, with the
#      secret filled in) and copies it to your clipboard. You paste it into
#      the Supabase SQL editor and click Run.
#
# Re-running is safe: values are replaced and the SQL is idempotent.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERCEL_PROJECT_DIR="${VERCEL_PROJECT_DIR:-/Users/faraz/Documents/GitHub/nicc-business}"
SUPA="https://supabase.com/dashboard/project/jmqljbqvyhwdrxugbwun"

command -v vercel >/dev/null || { echo "vercel CLI not found"; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found"; exit 1; }

vercel_env() {
  (cd "$VERCEL_PROJECT_DIR" && vercel env rm "$1" production -y >/dev/null 2>&1 || true)
  (cd "$VERCEL_PROJECT_DIR" && printf '%s' "$2" | vercel env add "$1" production >/dev/null) \
    && echo "  ✓ $1 set on Vercel" || { echo "  ✗ could not set $1"; exit 1; }
}

echo
echo "1/4  Amazon SES sends the alert emails (noorbusiness.org must be a verified SES identity)."
open "https://console.aws.amazon.com/iam/home#/users" >/dev/null 2>&1 || true
echo "     Create an IAM user whose only permission is ses:SendEmail, then an access key."
read -rp  "     SES region [us-east-1]: " AWS_SES_REGION
AWS_SES_REGION="${AWS_SES_REGION:-us-east-1}"
read -rp  "     Paste the access key ID: " AWS_SES_ACCESS_KEY_ID
read -rsp "     Paste the secret access key (hidden): " AWS_SES_SECRET_ACCESS_KEY; echo
[[ -n "$AWS_SES_ACCESS_KEY_ID" && -n "$AWS_SES_SECRET_ACCESS_KEY" ]] || { echo "No key entered."; exit 1; }
read -rp  "     Who should receive alerts? (comma-separated emails): " NOTIFY_EMAIL_TO
echo "     Sender: any address on the verified domain. Until SES production access"
echo "     is granted, SES only delivers to verified addresses."
read -rp  "     Sender address [NICC Business <alerts@noorbusiness.org>]: " NOTIFY_EMAIL_FROM
NOTIFY_EMAIL_FROM="${NOTIFY_EMAIL_FROM:-NICC Business <alerts@noorbusiness.org>}"

echo
echo "2/4  Setting Vercel environment variables..."
NOTIFY_SECRET="$(openssl rand -hex 24)"
vercel_env NOTIFY_SECRET "$NOTIFY_SECRET"
vercel_env AWS_SES_REGION "$AWS_SES_REGION"
vercel_env AWS_SES_ACCESS_KEY_ID "$AWS_SES_ACCESS_KEY_ID"
vercel_env AWS_SES_SECRET_ACCESS_KEY "$AWS_SES_SECRET_ACCESS_KEY"
vercel_env NOTIFY_EMAIL_TO "$NOTIFY_EMAIL_TO"
vercel_env NOTIFY_EMAIL_FROM "$NOTIFY_EMAIL_FROM"

echo
echo "3/4  Redeploying to production..."
(cd "$VERCEL_PROJECT_DIR" && vercel deploy --prod --yes >/dev/null 2>&1) \
  && echo "  ✓ redeployed" \
  || echo "  ! couldn't redeploy from the CLI: Vercel dashboard > Deployments > latest > Redeploy"

echo
echo "4/4  Database: lock public inserts + alert triggers."
SQL="$(cat "$ROOT/supabase/migrations/2026-10-04-lock-public-inserts.sql"; echo;
       sed "s/__NOTIFY_SECRET__/$NOTIFY_SECRET/" "$ROOT/supabase/migrations/2026-10-04-notify-triggers.sql")"
if command -v pbcopy >/dev/null; then printf '%s' "$SQL" | pbcopy; echo "     The SQL is on your clipboard."
else printf '%s\n' "$SQL" > "$ROOT/.finish-setup.sql"; echo "     Saved to $ROOT/.finish-setup.sql (delete it after use)."; fi
open "$SUPA/sql/new" >/dev/null 2>&1 || true
echo "     Paste into the SQL editor and click Run."
echo
echo "Then send a test message on the Contact page. Within a minute you"
echo "should get an alert email, and the message should still arrive in the"
echo "contact_messages table."
