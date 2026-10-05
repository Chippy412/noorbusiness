# NICC Business

A community business directory for Noor Islamic Cultural Center (NICC) in
Columbus, Ohio.

## Running it locally

This is a single static HTML file with no build step. Serve it with any
static file server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/noor-business.html`. (It needs a server
rather than opening the file directly — some Supabase calls behave
inconsistently under `file://`.)

## Backend

Data (business listings, owner accounts, claims) lives in a shared
Supabase project. `js/supabase-client.js` already points at it with the
public anon key, so cloning this repo is enough to get a working
connection — no per-developer setup needed.

If you ever need to point the site at a **different** Supabase project
(e.g. a personal sandbox), run:

```bash
bash scripts/setup-supabase.sh
```

This is an interactive wizard that walks you through creating a Supabase
project and rewrites `js/supabase-client.js` with the new credentials.

To get access to the actual project dashboard (Table Editor for
moderating listings/claims, Auth users, etc.), ask to be invited as a
team member on the Supabase project — that's separate from repo access
and isn't something `git clone` gives you.

## Project structure

- `api/` — Vercel serverless routes (see below). `tests/` — their tests.
- `noor-business.html` — the entire site: markup, styles, and the inline
  app script (routing, rendering, forms).
- `js/supabase-client.js` — initializes `window.NiccSupabase`.
- `js/businesses-data.js` — loads approved listings for the public site.
- `js/auth.js` — sign up / log in / log out.
- `js/owner-dashboard.js` — an owner's own listings, adding a business,
  claiming an existing one, editing.
- `supabase/schema.sql` — table definitions and row-level security
  policies. Run once against a fresh Supabase project.
- `supabase/seed.sql` — the 6 real, pre-vetted businesses. Run once,
  after `schema.sql`, against a fresh project.
- `scripts/setup-supabase.sh` — the interactive setup wizard described
  above.
- `docs/superpowers/` — the design spec and implementation plan this
  backend was built from.

## Server routes and setup (Vercel)

| Route | What it does |
| --- | --- |
| `/api/submit` | Contact form + footer newsletter. Verifies Turnstile on the server, rate-limits per sender, writes with the service-role key. |
| `/api/notify` | Emails volunteers when something needs moderating (called by Supabase webhooks). |
| `/b/<id>` → `/api/listing` | A crawlable, shareable page for each approved listing (title, Open Graph, schema.org). |
| `/sitemap.xml` → `/api/sitemap` | Home page plus every approved listing. |
| `/api/verify-turnstile`, `/api/turnstile-config` | Turnstile helpers. |

**Environment variables** (Vercel > Settings > Environment Variables):

- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` — already set up via `scripts/setup-turnstile.sh`.
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase > Project Settings > API (the *secret* key). Needed by `/api/submit`. Until it exists the site falls back to inserting from the browser.
- `SUPABASE_AUTH_CAPTCHA=1` — set only after enabling Turnstile in Supabase > Authentication > Attack Protection (paste the Turnstile secret there). Then Supabase itself rejects bot sign-ups.
- Email alerts (optional): `NOTIFY_SECRET` (any long random string), `RESEND_API_KEY`, `NOTIFY_EMAIL_TO` (comma-separated), `NOTIFY_EMAIL_FROM` (a sender verified in Resend).

**Guided setup:** `bash scripts/setup-hardening.sh` walks through all of the steps below (migrations, keys, captcha, alert webhooks).

**Supabase setup, in order:**

1. Run `supabase/migrations/2026-10-04-hardening.sql` in the SQL editor.
2. Add `SUPABASE_SERVICE_ROLE_KEY` in Vercel, redeploy, send a test message from the Contact page.
3. Run `supabase/migrations/2026-10-04-lock-public-inserts.sql` (closes the direct-insert hole on `contact_messages`).
4. For alerts: Supabase > Database > Webhooks > create one webhook per table (`businesses`, `claims`, `reviews`, `contact_messages`), event INSERT, method POST, URL `https://<your-site>/api/notify`, header `Authorization: Bearer <NOTIFY_SECRET>`.

**Tests:** `node --test tests/api.test.js`

## Moderation

Listing edits: when an owner changes the public details of an *approved*
listing (name, description, address, phone, website, photo, category,
neighborhood) it goes back to `pending` until a volunteer re-approves it.
Hours edits go live immediately. Badges (e.g. "Halal verified") and
`featured` can only be set by a volunteer in the Table Editor.


New listings and claims start `pending`. There is no custom admin panel
— a volunteer approves them directly in the Supabase Table Editor by
changing a row's `status` to `approved`.
