# Moderation tools, better search, and paid sponsorship

Date: 2026-10-06. Three workstreams, built in this order. Everything new in
the database follows the existing pattern: tables have RLS on, writes go
through `security definer` functions that re-check the caller, and every
migration is safe to re-run and is covered by `tests/db/run.py`.

## 1. Moderation (`2026-10-10-moderation-tools.sql`, `js/admin.js`)

| Gap | Change |
| --- | --- |
| Rejecting tells the owner nothing | Reject buttons open a reason box. The reason lands in a new `owner_notices` table (private to the person it's about) and is emailed to them by `/api/notify`. Rejecting a new listing already acts as "send back for changes": the owner edits it and it re-enters the queue, so the button says that. |
| No audit trail | `moderation_log` (who, what, which item, detail, when). Every `admin_*` action writes to it. New "Activity" tab. |
| All listings doesn't scale | Search box, status filter, and quick filters (no owner, featured, sponsored), 50 rows per page. Each row expands to show internal notes and history. |
| No way to report a problem | `reports` table. "Report a problem" link on each listing and review, sent through `/api/submit` (Turnstile, rate limits, service role). New "Reports" queue: dismiss, or resolve (optionally hiding the review or unpublishing the listing). |
| Published reviews can't be removed | "Published reviews" tab (latest 200), Remove button for moderators, plus removal from a report. |
| Smaller | Messages get a Handled toggle. Internal notes on any listing (stored as log entries). Queue items older than 2 days show a "Waiting N days" tag. New-listing sheets warn about possible duplicates (same name or phone). Bulk publish/reject on the review queue. |

## 2. Search (`noor-business.html` Explore section, `js/businesses-data.js`)

- Text search: every word must match somewhere in name, descriptions,
  category, neighborhood or address.
- "Open now" filter with a best-effort hours parser (listings whose hours
  can't be read are left out while it's on, and the UI says so).
- Minimum rating filter (Any / 3+ / 4+ / 4.5+).
- Badge matching: All / Any switch.
- Sort: Recommended (default: sponsored first, then rating), Highest rated,
  Newest, Name, Neighborhood.
- Not done: "near me". It needs geocoded addresses (an outside API key) and
  the site's Permissions-Policy blocks geolocation. Revisit later.

## 3. Paid sponsorship (`2026-10-11-sponsorship.sql`, `api/billing/*`)

Placeholder pricing, in one file (`api/_lib/plans.js`) so it's easy to change:

| Plan | Price | What it gets |
| --- | --- | --- |
| Spotlight | $19/month | "Sponsored" label, shown first in matching search results |
| Featured | $39/month | Everything in Spotlight, plus a slot in "Featured this month" on the home page |

- Database: `businesses.sponsor_tier` + `businesses.sponsored_until` (public,
  so the site can show the label), and a private `sponsorships` table with
  the Stripe customer/subscription ids. Only the server (service role)
  writes them, plus a moderator override for comped placements.
  `businesses.featured_until` lets editorial Featured expire too.
- Stripe via its REST API (no new npm dependencies):
  - `POST /api/billing/checkout`: owner's Supabase token, listing id, plan.
    Checks they own the approved listing, opens a Stripe Checkout session.
  - `POST /api/billing/portal`: Stripe customer portal (cancel, change card).
  - `POST /api/billing/webhook`: verifies Stripe's signature, then records
    the subscription and sets `sponsored_until` to the end of the paid period
    (+3 days grace). Cancellation or non-payment simply lets it lapse.
- Until `STRIPE_SECRET_KEY` and the price ids are set, the owner dashboard
  shows the plans with "Coming soon" and the routes answer 503. Connecting
  the masjid's Stripe account later is env vars only (README has the steps).
- Owner dashboard: "Promote this listing" panel on each approved listing
  with current status and Manage billing.
- Moderation: "Sponsors" tab (moderators only) with plan, status, renewal
  date and a manual override.
- Trust rules: badges can't be bought; sponsored listings still need
  approval; a taken-down listing isn't shown even while paid; every paid
  placement carries a visible "Sponsored" label.
