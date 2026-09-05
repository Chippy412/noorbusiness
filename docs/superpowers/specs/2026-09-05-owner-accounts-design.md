# Owner Accounts & Backend — Design Spec

Date: 2026-09-05
Status: Draft, pending review

## Purpose

The site (`noor-business.html`) is currently a single static file with business
listings hardcoded in a JS array. Nothing persists across devices, and there is
no way for a real business owner to add or edit their own listing. This spec
covers the minimum backend needed to fix that: real data storage, business
owner accounts, and a claim/edit flow, with a human volunteer approving
changes before they go live.

Out of scope for this spec (explicitly deferred, not forgotten):
- Shopper accounts (browsing, saving, and reviews stay anonymous/local, as today)
- A custom admin panel — moderation happens in Supabase's own Table Editor
- SMS/phone verification for claims
- Migrating off the static single-file site to a framework

## Architecture

- **Hosting**: the site stays a static HTML/CSS/JS file (or a small set of
  them), deployed wherever it is today. No server to run or maintain.
- **Backend**: [Supabase](https://supabase.com) — hosted Postgres, built-in
  auth, and a JS client SDK loaded via `<script>` tag, called directly from
  the existing vanilla JS. No custom API server.
- **Moderation**: a volunteer reviews pending listings/claims directly in
  Supabase's Table Editor (a web UI Supabase provides out of the box) by
  flipping a `status` column. No app code needed for this.

## Data model (Supabase / Postgres tables)

**`businesses`** — replaces the hardcoded `LISTINGS` JS array.
| column | type | notes |
|---|---|---|
| `id` | uuid, pk | |
| `owner_id` | uuid, nullable, fk → `auth.users.id` | null until claimed |
| `name` | text | |
| `category` | text | |
| `neighborhood` | text | |
| `description` | text | short card description |
| `long_description` | text | |
| `address` | text, nullable | |
| `phone` | text, nullable | |
| `hours` | jsonb, nullable | array of `[label, time]` pairs, matches current shape |
| `badges` | text[] | e.g. `{women, community}` |
| `status` | text | `pending` \| `approved` \| `rejected` |
| `created_at` | timestamptz | |

**`claims`** — a request to take ownership of an existing business.
| column | type | notes |
|---|---|---|
| `id` | uuid, pk | |
| `business_id` | uuid, fk → `businesses.id` | |
| `requester_id` | uuid, fk → `auth.users.id` | |
| `note` | text, nullable | how the volunteer can verify them (phone, role) |
| `status` | text | `pending` \| `approved` \| `rejected` |
| `created_at` | timestamptz | |

A volunteer approving a claim sets `businesses.owner_id = claims.requester_id`
and `claims.status = 'approved'`.

Owner accounts themselves are Supabase Auth users — no separate `owners`
table needed; `auth.users` already stores email and handles password/login.

## Migrating the existing 6 real listings

Before the frontend switches from the hardcoded `LISTINGS` array to reading
from Supabase, the 6 real businesses already researched (Meat Moot, Supreme
Fresh, We-Got-Meat, Naska Beauty, Al-Tahoor Quran Institute, Noor Free
Clinic) need to be inserted into the `businesses` table with `owner_id = null`
and `status = 'approved'` — they've already been vetted by research, they're
just not yet claimed by an actual owner. This is a one-time seed script or
manual insert, not something a user does.

## Flows

**Sign up / log in** — Supabase Auth's email+password (or magic link) flow,
called from a new page/route in the existing hash router (`#/account`).

**Add a new business** (replaces today's anonymous "List your business" form)
— must be logged in first. Submits a row into `businesses` with
`status = 'pending'` and `owner_id` set to the submitter immediately (they're
the owner from the start, since they created it). Existing anti-bot gate
(honeypot + timing + challenge) stays as-is on this form.

**Claim an existing business** — logged in, pick a listing, submit a `claims`
row with a short note. Listing stays fully visible and unowned in the
directory while pending — claiming doesn't hide it.

**Edit a listing** — only visible to the logged-in `owner_id` on that row,
via row-level security (below). A straightforward form pre-filled from the
current row; saves go live immediately (no re-approval needed for edits to an
already-approved listing, since the owner is already verified at that point).

**Moderation** — a volunteer with a Supabase login opens the Table Editor,
filters `businesses` or `claims` where `status = 'pending'`, checks it out,
and changes the status. This requires giving the volunteer(s) a Supabase
account with dashboard access — a one-time setup step, not something to
build.

## Security

- **Row-level security (RLS)** policies in Postgres, not application code, so
  even if frontend JS is buggy, the database itself enforces:
  - Anyone can `select` `businesses` where `status = 'approved'`.
  - A logged-in owner can `select`/`update` `businesses` where
    `owner_id = auth.uid()`, regardless of status.
  - A logged-in user can `insert` a new `businesses` row with
    `owner_id = auth.uid()`; `status` is forced to `'pending'` by the policy
    regardless of what the client sends, so no one can insert a
    pre-approved listing.
  - A logged-in user can `insert` a `claims` row for themselves, and `select`
    their own claims.
  - No one but a Supabase-dashboard admin can change `status` columns or
    `owner_id` — that only happens via the Table Editor, using Supabase's
    service role, not the public API.
- Supabase's free tier handles the auth/session tokens; no custom session
  code to write.

## Error handling

- Failed sign-up/login: Supabase SDK returns a typed error (e.g. "email
  already registered," "invalid credentials") — surface that text directly
  in the form's existing `.field.invalid` / error-message pattern already
  built into the site.
- Failed claim/edit submit (network error, RLS rejection): reuse the
  existing `.form-status.error` pattern already on the Contact and List
  Your Business forms.
- A business with no owner yet shows no edit controls to anyone.

## Testing approach

No existing test suite (the site has none today — it's manually verified in
browser, which is how this whole project has been checked so far). For this
feature:
- RLS policies get tested directly in the Supabase SQL editor with sample
  rows before any frontend code depends on them (a policy that's wrong is a
  security hole, not just a bug).
- Frontend flows (sign up, claim, edit) get the same manual-in-browser
  verification pattern already used throughout this project: exercise the
  happy path and the obvious failure paths (wrong password, claiming an
  already-owned listing, editing without being the owner) via the browser
  tool, not an automated suite.

## What this deliberately does not do

- Does not touch the existing anonymous browsing, filtering, saved-listings
  (localStorage), or the Contact form — none of that needs an account.
- Does not add shopper reviews tied to real accounts (still deferred).
- Does not build a custom admin dashboard.
