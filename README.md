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
| `/api/submit` | Contact form, footer newsletter, and "Report a problem". Verifies Turnstile on the server, rate-limits per sender, writes with the service-role key. |
| `/api/notify` | Emails volunteers when something needs moderating, and emails owners/reviewers the team's decisions (called by database triggers, see `2026-10-04-notify-triggers.sql`). |
| `/api/billing/plans` | Sponsorship plans and prices (defined in `api/_lib/plans.js`), and whether paying is switched on. |
| `/api/billing/checkout`, `/api/billing/portal` | Opens Stripe Checkout / the Stripe billing portal for a listing's owner. |
| `/api/billing/webhook` | Stripe tells us when a sponsorship starts, renews, changes or ends. |
| `/api/geocode` | Address or ZIP to map coordinates (US Census geocoder, then OpenStreetMap). Used for a visitor's "distance from" point, by a database trigger when a listing's address changes, and by the moderators' "Find map locations" button. |
| `/b/<id>` → `/api/listing` | A crawlable, shareable page for each approved listing (title, Open Graph, schema.org). |
| `/sitemap.xml` → `/api/sitemap` | Home page plus every approved listing. |
| `/api/verify-turnstile`, `/api/turnstile-config` | Turnstile helpers. |

**Environment variables** (Vercel > Settings > Environment Variables):

- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` — already set up via `scripts/setup-turnstile.sh`.
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase > Project Settings > API (the *secret* key). Needed by `/api/submit`. Until it exists the site falls back to inserting from the browser.
- `SUPABASE_AUTH_CAPTCHA=1` — set only after enabling Turnstile in Supabase > Authentication > Attack Protection (paste the Turnstile secret there). Then Supabase itself rejects bot sign-ups.
- Email alerts (optional): `NOTIFY_SECRET` (any long random string), `RESEND_API_KEY`, `NOTIFY_EMAIL_TO` (comma-separated), `NOTIFY_EMAIL_FROM` (a sender verified in Resend). Owners and reviewers are only emailed about decisions once `NOTIFY_EMAIL_FROM` is on a verified domain (not `onboarding@resend.dev`); they always see them on their account page.
- Sponsorship (optional, see below): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_SPOTLIGHT`, `STRIPE_PRICE_FEATURED`, and `SITE_URL` if the site isn't at `https://nicc-business.vercel.app`.

**Setting up a fresh Supabase project, in order** (each `.sql` file is run
once in the SQL editor; all are safe to re-run):

1. `supabase/schema.sql`, then `supabase/seed.sql`
2. `supabase/migrations/2026-09-*.sql`, in date order
3. `2026-10-04-hardening.sql`, then `2026-10-04-insert-column-grants.sql`
4. Add `SUPABASE_SERVICE_ROLE_KEY` in Vercel, redeploy, send a test message
   from the Contact page, then run `2026-10-04-lock-public-inserts.sql`
5. `bash scripts/finish-setup.sh`: sets the email-alert variables in Vercel
   and puts the alert-trigger SQL (`2026-10-04-notify-triggers.sql` with the
   secret filled in) on your clipboard to run
6. `2026-10-05-admin.sql`, `2026-10-06-roles.sql`, `2026-10-07-fixes.sql`,
   `2026-10-08-review-fixes.sql`, `2026-10-09-notifications.sql`,
   `2026-10-10-moderation-tools.sql`, `2026-10-11-sponsorship.sql`,
   `2026-10-12-locations.sql`, then on the Moderation page > All listings,
   click "Find map locations for older listings" until it says all done
7. Add the first moderator (see Moderation below)

Alerts come from database triggers. Do **not** also create Supabase
"Database Webhooks" for the same tables, or every alert arrives twice.

**Tests:**

- `node --test tests/api.test.js`: the serverless routes.
- `python3 tests/db/run.py`: applies `schema.sql`, `seed.sql` and every
  migration (twice, to prove they're re-runnable) to a real local Postgres
  with a Supabase stand-in, then checks every permission rule as visitors,
  owners, volunteers and moderators. Needs `pip3 install --user pgserver "psycopg[binary]"`.
  Add new migrations to `MIGRATIONS` in that file.

## Moderation

Volunteers moderate at **`/#/admin`** (a "Moderation" button appears on the
My account page for moderators). It shows:

- **New listings**: approve or reject.
- **Edits**: when an owner changes an *approved* listing, the live version
  stays public and the edit waits here as a side-by-side comparison. Apply or
  reject it. (Hours changes go live immediately.)
- **Claims**: approving transfers ownership to the person who claimed it.
- **Reviews**: approve or reject.
- **Messages**: contact-form messages, with a reply-by-email link.
- **All listings**: set badges (e.g. Halal verified; volunteers and
  moderators), Featured and status (moderators only, see Roles).

**Notifications for the team:**

- A count of waiting items shows next to *My account* (and on the phone menu
  button) for moderators and volunteers, and on the *Open moderation* button.
- The moderation page checks every minute while open: new items show a
  banner and the count in the browser tab, and *Turn on desktop alerts* adds
  a system notification.
- Emails go to `NOTIFY_EMAIL_TO`. Once `NOTIFY_EMAIL_FROM` is an address on a
  domain verified in Resend (not `onboarding@resend.dev`), every moderator
  and volunteer on the team is emailed as well, automatically.

**Roles** (managed on the Moderation page > **Team**, moderators only):

| | Volunteer | Moderator |
| --- | --- | --- |
| Approve/reject new listings, edits, claims, reviews | yes | yes |
| Work reports (dismiss, mark fixed), add notes | yes | yes |
| Read contact messages, set badges | yes | yes |
| Set Featured, give free sponsorships | no | yes |
| Remove a published review, hide a reported one | no | yes |
| Change or take down an already-published listing | no | yes |
| Add/remove team members, change roles | no | yes |

To add someone, they first create an account on the site and turn on
two-factor (My account). A moderator then enters their email under
Moderation > Team and picks a role. The system always keeps at least one
moderator. Both roles need two-factor to use the page.

**The very first moderator** is added from the Supabase SQL editor:

```sql
insert into admins (user_id, role)
select id, 'moderator' from auth.users where lower(email) = lower('someone@example.com')
on conflict (user_id) do update set role = 'moderator';
```

Every action is enforced in the database (`admin_*` functions require the
caller to be on `admins` AND signed in with their second factor), not just in
the page. Run `supabase/migrations/2026-10-05-admin.sql`, then
`2026-10-06-roles.sql` and `2026-10-07-fixes.sql`, to set this up (after the other `2026-10-04-*` migrations).

**Moderation page sections:** the decision queues (New listings, Edits,
Claims, Reviews, Reports) come first. Rejecting asks for an optional reason,
which the owner, claimant or reviewer sees on their account page and by
email. Then: Messages (mark handled), Published reviews (moderators can
remove one), All listings (search, filter, notes and history per listing,
Featured end dates), Activity (every decision and note, with who made it),
and for moderators, Sponsors and Team.

## Sponsorship (paid placement)

Owners of a live listing can sponsor it from My account. Plans, prices and
perks are in `api/_lib/plans.js` (placeholder pricing: Spotlight $19/month,
Featured $39/month). Sponsored listings carry a "Sponsored" label, come first
in "Recommended" search order, and the Featured plan adds the listing to
"Featured this month" on the home page. Badges can't be bought.

Until the Stripe variables are set, owners see the plans marked "Coming
soon" and nothing can be charged. Moderators can still give free placements
from Moderation > Sponsors.

**Connecting a Stripe account** (e.g. the masjid's), once:

1. In Stripe, create a product for each plan with a monthly recurring price
   matching `api/_lib/plans.js`. Copy each price id (`price_...`).
2. Settings > Billing > Customer portal: turn it on, allow cancelling and
   updating payment methods, and allow switching between the two prices.
3. Developers > Webhooks > Add endpoint:
   `https://nicc-business.vercel.app/api/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy its signing secret (`whsec_...`).
4. In Vercel, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_SPOTLIGHT`, `STRIPE_PRICE_FEATURED`, then redeploy.
5. Test with Stripe's test mode keys first (card `4242 4242 4242 4242`): buy a
   plan from My account, check the listing shows "Sponsored", then cancel
   from Manage billing.

Changing prices later: create new prices in Stripe, update the env vars and
the numbers in `api/_lib/plans.js`. Existing subscribers stay on their old
price until moved in Stripe.

## Distances

Explore can show how far each business is from the visitor ("Use my
location", or a typed address/ZIP), filter by radius, and sort by nearest.
The visitor's own location never leaves their browser; a typed address is
looked up once through `/api/geocode` and not stored. Listing coordinates
(`businesses.lat`/`lng`) are filled in by the server whenever an address is
added or changed. A listing without an address (e.g. online-only) simply
shows no distance.
