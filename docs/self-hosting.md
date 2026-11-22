# Self-hosting on the masjid's Lightsail server

The site, API, database, auth and photos all run on one AWS Lightsail server
owned by the masjid. Vercel and the hosted Supabase project are retired after
cutover.

```
browser ──► Nginx :80/:443  (deploy/nginx/noorbusiness.conf)
             ├─ /                         static files in /var/www/noorbusiness
             ├─ /api/*, /b/<id>, /sitemap.xml ─► 127.0.0.1:3001  server/index.js  (systemd: noorbusiness-api)
             └─ /rest|auth|storage|realtime/v1 ─► 127.0.0.1:8000  self-hosted Supabase (Docker, /opt/supabase)
```

Supabase is served on the site's own origin, so after cutover
`js/supabase-client.js` points at the site address (e.g. `https://noorbusiness.org`)
with the self-hosted anon key, and the CSP needs no extra host.

## Deploying

```bash
# first time, on the server
sudo git clone https://github.com/Chippy412/noorbusiness /opt/noorbusiness
sudo bash /opt/noorbusiness/deploy/deploy.sh --install
sudo vi /etc/noorbusiness/api.env      # fill in from deploy/api.env.example
sudo bash /opt/noorbusiness/deploy/deploy.sh

# updates
sudo bash /opt/noorbusiness/deploy/deploy.sh            # main
sudo bash /opt/noorbusiness/deploy/deploy.sh my-branch  # a branch
```

`deploy.sh` never touches DNS, TLS, Supabase or secrets.

## TLS

Once DNS for the final address points at the server:
`sudo dnf install -y certbot python3-certbot-nginx && sudo certbot --nginx -d noorbusiness.org -d www.noorbusiness.org`,
then uncomment the HSTS header in the Nginx file.

## API wrapper

`server/index.js` (no dependencies, Node 18+) runs each `api/*.js` handler the
way Vercel did: `req.query`, a parsed `req.body` (skipped for handlers that
export `config.api.bodyParser = false`), and
`res.status().json()/send()`. `GET /healthz` returns `{ok:true}`. Tests:
`node --test tests/server.test.js`.

`SITE_URL` now also drives the canonical links in `/b/<id>`, the sitemap and
the links in notification emails.

## Listing photos

Owners upload a cover photo from the add-listing form or their account page.
The browser resizes it first (`js/photo.js`: longest edge 1600px, re-encoded as
WebP or JPEG, which also drops EXIF data such as GPS location), so originals up
to 20 MB are accepted while stored files stay well under the bucket's 5 MB limit.
The file then goes to the `business-photos` bucket in Supabase Storage at
`<business_id>/<timestamp>.<ext>`, and `businesses.photo_url` points at
`/storage/v1/object/public/business-photos/...`. Listings without a photo, or
whose photo fails to load, show the category icon placeholder.

Storage is the only layer that knows where the bytes live. Today the
self-hosted Storage API uses its file backend (`/opt/supabase/docker/volumes/storage`,
included in the nightly `storage.tar.gz` backup).

### Moving photos to S3 later

No app code changes: the public URLs stay the same because they go through
the Storage API, not straight to the bucket.

1. Create a private S3 bucket and an IAM user limited to it
   (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`).
2. In `/opt/supabase/docker/.env` / the `storage` service of
   `docker-compose.yml` set `STORAGE_BACKEND=s3`, `GLOBAL_S3_BUCKET`, `REGION`,
   and the key pair (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Keep the
   keys in the server's env file only, never in git or chat.
3. Copy the existing files so object keys match, then restart Storage:
   `aws s3 sync /opt/supabase/docker/volumes/storage/stub/stub/ s3://BUCKET/stub/`
   (check the folder layout under `volumes/storage` first; Storage keys objects
   as `<tenant>/<bucket>/<path>`), then `docker compose up -d storage`.
4. Open a listing with a photo and upload a test photo to confirm.
5. Once photos live in S3, `storage.tar.gz` in the nightly backup is empty;
   rely on S3 versioning for the photos instead.
