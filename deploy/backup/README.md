# Backups and monitoring

Everything stays inside the masjid's AWS: backups go to the masjid's S3 bucket,
alerts are plain email through Resend (the same provider the API already uses).
No other SaaS.

| File | What it does |
|---|---|
| `backup.sh` | Nightly: `pg_dump -Fc` of the whole `postgres` DB (via `docker exec supabase-db`), roles dump, Supabase storage `tar.gz`, config/secrets `tar.gz`, checksums. Keeps 14 daily + 8 weekly (Sunday) locally in `/var/backups/noorbusiness`, then copies the day to `BACKUP_S3_URI`. |
| `restore-test.sh` | Weekly: restores the latest dump into a throwaway `postgres:15` container (no network), checks `public.businesses` and `auth.users` have rows, removes the container. Exits nonzero on failure. |
| `healthcheck.sh` | Every 5 min: disk, memory+swap, `nginx`/`noorbusiness-api`/`docker` active, `http://127.0.0.1/` and `/healthz`, Supabase containers running and not unhealthy, TLS cert expiry, newest backup age. Emails on failure. |
| `systemd/` | `noorbusiness-backup`, `-restore-test`, `-healthcheck` service+timer pairs, and `noorbusiness-alert@.service` (emails when the backup or restore test unit fails). |
| `install.sh` | Installs the units, creates `/etc/noorbusiness/backup.env`, enables the timers. |
| `backup.env.example` | Template for the env file. |

Schedules: backup 03:15 America/New_York nightly (+ up to 10 min random delay,
`Persistent=true` so a missed run happens at next boot); restore test Sundays
05:00; health check every 5 minutes.

## One-time setup

1. **S3 bucket and IAM user** (AWS console, masjid account). Create a private
   bucket (block all public access, versioning on, default encryption on).
   Add a lifecycle rule to expire objects after e.g. 90 days. Create an IAM
   user with only this policy (Lightsail has no instance role, so it needs
   access keys):

   ```json
   { "Version": "2012-10-17", "Statement": [
     { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::BUCKET" },
     { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::BUCKET/noorbusiness/*" } ] }
   ```

   No delete permission on purpose: a compromised server cannot erase the
   off-server copies.
2. On the server: `sudo bash /opt/noorbusiness/deploy/backup/install.sh`
3. `sudo vi /etc/noorbusiness/backup.env` and fill in `BACKUP_S3_URI`, the AWS
   keys, and `RESEND_API_KEY` / `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM`.
   The file must be mode 600 (the installer sets it).
4. Run once by hand and watch it:
   ```bash
   sudo systemctl start noorbusiness-backup && journalctl -u noorbusiness-backup -f
   sudo systemctl start noorbusiness-restore-test && journalctl -u noorbusiness-restore-test -n 30
   sudo aws s3 ls --recursive "$(sudo grep ^BACKUP_S3_URI /etc/noorbusiness/backup.env | cut -d= -f2)"   # needs the AWS_* vars exported
   sudo systemctl start noorbusiness-healthcheck && journalctl -u noorbusiness-healthcheck -n 20
   ```
5. To test alerting, temporarily stop something harmless
   (`sudo systemctl stop noorbusiness-api`), wait for the next check, then
   start it again; you should get an ALERT and later a RECOVERED email.

If `BACKUP_S3_URI` is empty the backup still runs but logs a warning and
nothing leaves the server. Fill it in.

## Where things are

```
/var/backups/noorbusiness/daily/YYYY-MM-DD/    db.dump  globals.sql  storage.tar.gz  config.tar.gz  SHA256SUMS
/var/backups/noorbusiness/weekly/YYYY-MM-DD/   (hard links to a Sunday daily)
s3://BUCKET/noorbusiness/YYYY-MM-DD/           same files, one folder per night
/var/lib/noorbusiness/alerts/                  alert rate-limit state
```

`config.tar.gz` holds `/opt/supabase/docker/.env` (JWT secret and keys),
`/etc/noorbusiness/api.env` and `backup.env`. It is essential for a rebuild
and contains secrets, which is another reason the bucket must be private.

Logs: `journalctl -u noorbusiness-backup`, `-u noorbusiness-restore-test`,
`-u noorbusiness-healthcheck`. Status: `systemctl list-timers 'noorbusiness-*'`.

## Alerts

Delivered by the Resend API to `ALERT_EMAIL_TO`. The same problem is emailed at
most once every 6 hours (state in `/var/lib/noorbusiness/alerts`); a new
problem alerts immediately, and one "RECOVERED" email is sent when everything
passes again. Thresholds are env-tunable (see `backup.env.example`): disk 85%,
available memory + free swap 300 MB, certificate 14 days, newest backup 36 h.

The health check only sees problems the server itself can report. If the whole
server is down or off the network, it cannot email. As a second layer, set
Lightsail's built-in metric alarms in the console (Lightsail > the instance >
Metrics > Add alarm): at least **StatusCheckFailed** (instance and system) and
sustained high **CPUUtilization**, with email/SMS notification to a
different mailbox than the one the server uses. Lightsail alarms live in
AWS, so they still fire when the server is dead.

## Restoring for real

Pick the backup (usually the newest). Fetch it from S3 if the server was lost:

```bash
sudo -i
set -a; . /etc/noorbusiness/backup.env; set +a      # on a new server, use the AWS keys you saved separately
D=2026-01-15                                         # the date to restore
mkdir -p /root/restore/$D && cd /root/restore/$D
aws s3 cp --recursive "$BACKUP_S3_URI/$D/" .
sha256sum --check SHA256SUMS
```

**A. Rebuilding on a fresh server**

1. Set up the server per `docs/self-hosting.md` (Docker, Nginx, repo in
   `/opt/noorbusiness`, Supabase in `/opt/supabase/docker`).
2. Restore the secrets *before* first starting Supabase, so the JWT secret
   matches the restored users and the anon/service keys the site uses:
   `tar -xzf config.tar.gz -C /` (restores `/opt/supabase/docker/.env`,
   `/etc/noorbusiness/*.env`).
3. Start only the database: `cd /opt/supabase/docker && docker compose up -d db`
   and wait until `docker ps` shows `supabase-db` healthy.
4. Go to step 3 of B below.

**B. Restoring into the running server (data corruption or deleted data)**

1. Keep a safety copy first: `sudo systemctl start noorbusiness-backup`.
2. Stop everything that writes: `systemctl stop noorbusiness-api` and
   `cd /opt/supabase/docker && docker compose stop` then
   `docker compose up -d db` (database only).
3. Restore the database. `--clean --if-exists` drops and recreates objects
   from the dump; `--no-owner` avoids ownership errors. A few harmless
   errors about objects Supabase itself owns or extensions already present are
   normal; errors about your own tables are not.
   ```bash
   docker exec -i supabase-db pg_restore -U postgres -d postgres \
     --clean --if-exists --no-owner < db.dump 2>restore.err
   tail restore.err
   ```
   If the roles are missing (brand-new database that is not the stock Supabase
   image), load `globals.sql` first: `docker exec -i supabase-db psql -U postgres < globals.sql`.
4. Restore photos (replaces the storage volume):
   ```bash
   cd /opt/supabase/docker/volumes
   mv storage storage.old.$(date +%F) 2>/dev/null || true
   tar -xzf /root/restore/$D/storage.tar.gz       # recreates ./storage
   ```
5. Start everything and verify:
   ```bash
   cd /opt/supabase/docker && docker compose up -d
   systemctl start noorbusiness-api
   bash /opt/noorbusiness/deploy/backup/healthcheck.sh
   docker exec supabase-db psql -U postgres -c 'select count(*) from public.businesses'
   ```
   Then open the site and check that listings, logins and photos work.
   Delete `storage.old.*` once you are satisfied.

Practice B's database step on a spare machine, or just rely on the weekly
restore test, which exercises the same dump.

## Notes and limits

- The restore test uses plain `postgres:15`, which lacks some Supabase-only
  extensions, so it expects some `pg_restore` errors and judges success by the
  row counts. It proves the dump is complete and readable, not that every
  extension installs. Match `RESTORE_IMAGE` to the major version of `supabase-db`
  (`docker exec supabase-db postgres --version`).
- Disk: the dump and photo archive are kept 14+8 times locally (weekly copies
  are hard links). Watch `du -sh /var/backups/noorbusiness`; the 85% disk alert
  will fire before the 80 GB disk fills.
- Backup runs as root with low CPU/IO priority; at this data size it takes
  seconds to minutes.
- The scripts run from `/opt/noorbusiness/deploy/backup/`, so `deploy.sh`
  updates them automatically; re-run `install.sh` only after changing unit files.
