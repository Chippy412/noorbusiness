# Self-hosting on the masjid's Lightsail server

The site, API, database, auth and photos all run on one AWS Lightsail server
owned by the masjid. Vercel and the hosted Supabase project are retired after
cutover.

```
browser ──► Nginx :80/:443  (deploy/nginx/noorbusiness.conf)
             ├─ /                         static files in /var/www/noorbusiness
             ├─ /api/*, /b/<id>, /sitemap.xml ─► 127.0.0.1:3000  server/index.js  (systemd: noorbusiness-api)
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
export `config.api.bodyParser = false`, i.e. the Stripe webhook), and
`res.status().json()/send()`. `GET /healthz` returns `{ok:true}`. Tests:
`node --test tests/server.test.js`.

`SITE_URL` now also drives the canonical links in `/b/<id>`, the sitemap and
the links in notification emails.
