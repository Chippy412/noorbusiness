# Moving the hosted Supabase project to the self-hosted one

Moves project `jmqljbqvyhwdrxugbwun` (hosted) into the self-hosted Supabase on
the Amazon Linux 2023 server (official Docker Compose, Postgres container
`supabase-db`, Kong on `127.0.0.1:8000`, storage file backend).

Needs `bash`, `curl`, `jq`, `docker`, `file` (`sudo dnf install -y jq file`).
No secret is hardcoded or printed: pass them as environment variables.

## Before you start

- **Postgres version.** The hosted database is Postgres 17.11. Use a
  `supabase/postgres:17.x` image for `db:` in the self-hosted
  `docker-compose.yml`. The scripts use the `postgres:17` image for `pg_dump`
  when a local pg_dump 17+ is missing (`PG_IMAGE` to change); `pg_dump` must
  not be older than the server. Data-only, column-named INSERTs load across
  minor differences, but a PG15 target is untested.
- **Schemas.** The self-hosted image already creates the `auth`, `storage`
  and `extensions` schemas and the `anon` / `authenticated` / `service_role`
  roles. The import never creates them: `schema.sql` and the migrations only
  add tables, functions and policies in `public` (plus the `business-photos`
  bucket row and policies in `storage`), which is what they expect.
- **JWT secret.** Hosted sessions stay valid only if the self-hosted
  `JWT_SECRET` matches; otherwise everyone just signs in again. Passwords and
  MFA factors are in the dump either way.
- **Alert triggers.** The migrations point the e-mail and geocode triggers at
  `https://nicc-business.vercel.app` and need the shared secret in place of
  `__NOTIFY_SECRET__`. The import rewrites both on the fly from
  `NOTIFY_BASE_URL` and `NOTIFY_SECRET`. The database calls the API from
  inside the `supabase-db` container, so use the Docker bridge address, e.g.
  `http://172.17.0.1:3000`, and make sure the API is reachable there.
  `pg_net` ships in the Supabase image.
- **Freeze writes** on the hosted site while you export, or accept losing
  anything submitted after the export.

## Run order

On a machine that can reach the hosted project (the server is fine):

```bash
export SOURCE_DB_URL='postgresql://postgres:...@db.jmqljbqvyhwdrxugbwun.supabase.co:5432/postgres'
export SOURCE_SUPABASE_URL='https://jmqljbqvyhwdrxugbwun.supabase.co'
export SOURCE_SERVICE_ROLE_KEY='...'
bash deploy/migrate/export-hosted.sh          # last line: e.g. ./export/20261115T120000Z
```

Then on the server (repo checked out with all migrations, including
`2026-11-02-remove-halal-verification.sql`):

```bash
export NOTIFY_SECRET='...'                     # from /etc/noorbusiness/api.env
export NOTIFY_BASE_URL='http://172.17.0.1:3000'
export TARGET_SUPABASE_URL='http://127.0.0.1:8000'
export TARGET_SERVICE_ROLE_KEY='...'           # self-hosted service_role key
bash deploy/migrate/import-selfhosted.sh ./export/20261115T120000Z

# rewrite stored photo URLs (next section)
docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 \
  -v NEW_BASE="'https://noorbusiness.org'" < deploy/migrate/rewrite-urls.sql

# SOURCE_DB_URL must still be exported; exits nonzero on any mismatch
bash deploy/migrate/verify.sh ./export/20261115T120000Z
```

What the import does, in order: `supabase/schema.sql`; every migration in the
README setup order (same list as `tests/db/run.py`), then any other file in
`supabase/migrations/` in filename order (`2026-10-13-grocery-category`,
`2026-11-02-remove-halal-verification`; if the halal file is missing it warns);
then loads `auth.sql`, `public-data.sql`, `storage-meta.sql` with
`session_replication_role = replica` (no triggers, so no alert e-mails fire);
then uploads each photo through the storage API (same bucket and path,
`x-upsert`). `seed.sql` is not run: the real listings come from the dump.
Re-running is safe (`ON CONFLICT DO NOTHING`, upsert); `SKIP_SCHEMA=1` loads
data only.

Overrides: `DB_CONTAINER` (default `supabase-db`), `DB_USER` (default
`postgres`; if setting `session_replication_role` is refused, use
`DB_USER=supabase_admin`), `DB_NAME`, `TARGET_PSQL` (a full psql command
instead of `docker exec`).

## Rewriting photo URLs

`businesses.photo_url` stores the full URL, e.g.
`https://jmqljbqvyhwdrxugbwun.supabase.co/storage/v1/object/public/business-photos/<owner-uuid>/<file>`.
After the move the host must be the site's own origin (Nginx proxies
`/storage/v1` to Kong), and `_validate_listing_fields` only accepts that path
shape. `rewrite-urls.sql` replaces the old host with the `:NEW_BASE` psql
variable in `businesses.photo_url`, `business_edits.changes` and
`moderation_log.detail`. `businesses.website` holds owners' own sites and is
not touched. It prints leftover counts (all should be 0).

Also update `js/supabase-client.js` and `api/_lib/supa.js`, which still
hardcode the old host.

## Caveats

- `storage.objects` metadata is loaded from the dump, then the upload step
  upserts the files. If hosted and self-hosted storage versions have different
  `storage.objects` columns the metadata load can fail; load only
  `storage.buckets` and let the API upload create the object rows.
- Counts differ if people use the new site before `verify.sh` runs.
