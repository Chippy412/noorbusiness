# Owner Accounts & Supabase Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NICC Business a real backend (Supabase) so business owners can create accounts, add or claim listings, and edit their own listing, with a volunteer approving changes before they go live.

**Architecture:** The site stays a static HTML/CSS/JS file with no build step. A Supabase project provides Postgres storage and auth; the browser talks to it directly via the Supabase JS SDK loaded from a CDN `<script>` tag. New functionality lives in small standalone JS files loaded alongside the existing inline script; the existing hash-router, card rendering, and filtering code is reused, not rewritten.

**Tech Stack:** Supabase (Postgres + Auth), `@supabase/supabase-js` v2 via CDN, vanilla JS (matches the rest of the site), plain SQL for schema/policies.

**Spec:** `docs/superpowers/specs/2026-09-05-owner-accounts-design.md`

## Global Constraints

- No server to run or maintain — the site stays static HTML/CSS/JS (spec: Architecture).
- Backend is Supabase only — no custom API server (spec: Architecture).
- Moderation happens in Supabase's own Table Editor — do not build a custom admin panel (spec: Architecture, "What this deliberately does not do").
- No shopper accounts; browsing, saving, and reviews stay anonymous/local (spec: Purpose, scope-out).
- No SMS/phone verification for claims (spec: scope-out).
- No migration off the static single-file site (spec: scope-out).
- The existing anti-bot gate (honeypot + timing + arithmetic challenge) stays on the "add a new business" form unchanged (spec: Flows, "Add a new business").
- Error messages reuse the site's existing `.field.invalid` / `.form-status.error` patterns — do not invent a new error UI (spec: Error handling).
- No automated test suite for this project. RLS policies are verified with real queries in the Supabase SQL editor; frontend flows are verified manually in the browser tool, exercising both the happy path and the stated failure paths (spec: Testing approach).

---

## File Structure

```
nicc-business/
  noor-business.html          # existing file — modified, not replaced
  js/
    supabase-client.js        # NEW — one exported client instance
    businesses-data.js        # NEW — replaces the hardcoded LISTINGS array
    auth.js                   # NEW — sign up / log in / log out / session
    owner-dashboard.js        # NEW — add / claim / edit listing flows
  supabase/
    schema.sql                # NEW — tables, RLS policies, column privileges
    seed.sql                  # NEW — the 6 real businesses, one-time insert
  docs/superpowers/
    specs/2026-09-05-owner-accounts-design.md   # already exists
    plans/2026-09-05-owner-accounts.md          # this file
```

**Why split into separate JS files:** `noor-business.html` is already ~750KB with all markup, CSS, and JS inline. Adding Supabase-calling code into that same monolithic `<script>` block would make an already large file harder to navigate. Each new file has one job — talking to Supabase for one concern (client setup, business data, auth, or the owner dashboard) — and is loaded via an ordinary `<script src="...">` tag, so no bundler or build step is introduced.

---

### Task 1: Provision Supabase and wire up the client

**Files:**
- Create: `js/supabase-client.js`
- Modify: `noor-business.html` (add two `<script>` tags before the existing inline `<script>` block, near the closing `</body>`)

**Interfaces:**
- Produces: a global `window.NiccSupabase` — the initialized Supabase client, used by every later task.

- [ ] **Step 1: Create a Supabase project (manual, human-only step)**

  This cannot be done by an agent — it requires clicking through Supabase's own signup flow.

  1. Go to https://supabase.com and sign up (or log in).
  2. Click "New project." Name it `nicc-business`. Choose any region close to Columbus, Ohio (e.g. `us-east-1`). Set a database password and save it somewhere safe (a password manager) — it is not needed anywhere in this codebase, only for direct Postgres access if ever needed.
  3. Once the project finishes provisioning, go to Project Settings → API. Copy the **Project URL** and the **anon public** key. You'll paste these into `js/supabase-client.js` in the next step.
  4. Go to Authentication → Providers → Email, and under "Confirm email," turn it **off** for now during development (this avoids needing real inboxes for every manual test in this plan). Turn it back on before this goes live to real users.

- [ ] **Step 2: Write `js/supabase-client.js`**

```javascript
// js/supabase-client.js
// Loaded after the Supabase CDN script (see noor-business.html), which
// exposes a global `supabase` object with `.createClient()`.
(function () {
  "use strict";

  var SUPABASE_URL = "PASTE_YOUR_PROJECT_URL_HERE";
  var SUPABASE_ANON_KEY = "PASTE_YOUR_ANON_KEY_HERE";

  if (SUPABASE_URL.indexOf("PASTE_") === 0) {
    console.error(
      "js/supabase-client.js: replace SUPABASE_URL and SUPABASE_ANON_KEY " +
      "with the values from your Supabase project's Settings > API page."
    );
  }

  window.NiccSupabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
```

  Replace `PASTE_YOUR_PROJECT_URL_HERE` and `PASTE_YOUR_ANON_KEY_HERE` with the real values copied in Step 1. The anon key is safe to ship in client-side code — it is designed for this; row-level security (Task 2) is what actually protects the data.

- [ ] **Step 3: Add the script tags to `noor-business.html`**

  Find the existing `<script>` tag near the end of the file (the large inline script that starts with `(function () { "use strict";`). Immediately before that opening `<script>` tag, add:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="js/supabase-client.js"></script>
```

- [ ] **Step 4: Verify the client connects**

  Open `noor-business.html` in a browser (via a local static server, e.g. `python3 -m http.server 8000` from the project root, then visit `http://localhost:8000/noor-business.html`). Open the browser console and run:

```javascript
window.NiccSupabase
```

  Expected: logs a Supabase client object (not `undefined`, no thrown error). If you see `supabase is not defined`, the CDN script tag did not load before `supabase-client.js` — check the tag order from Step 3.

- [ ] **Step 5: Commit**

```bash
git add js/supabase-client.js noor-business.html
git commit -m "feat: initialize Supabase client"
```

---

### Task 2: Database schema and row-level security

**Files:**
- Create: `supabase/schema.sql`

**Interfaces:**
- Produces: the `businesses` and `claims` tables that Task 3 seeds and every later task reads from or writes to.

- [ ] **Step 1: Write `supabase/schema.sql`**

```sql
-- supabase/schema.sql
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).

create table businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id),
  name text not null,
  category text not null,
  neighborhood text not null,
  description text not null,
  long_description text not null,
  address text,
  phone text,
  hours jsonb not null default '[]'::jsonb,
  badges text[] not null default '{}'::text[],
  featured boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  requester_id uuid not null references auth.users(id),
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

alter table businesses enable row level security;
alter table claims enable row level security;

-- businesses: anyone can read approved listings
create policy "Public can read approved businesses"
  on businesses for select
  using (status = 'approved');

-- businesses: an owner can read their own listing regardless of status
create policy "Owners can read their own businesses"
  on businesses for select
  using (owner_id = auth.uid());

-- businesses: a logged-in user can insert a new listing, but only as
-- pending and only owned by themselves — no one can insert a pre-approved row
create policy "Logged in users can insert their own pending business"
  on businesses for insert
  with check (owner_id = auth.uid() and status = 'pending');

-- businesses: an owner can update their own listing
create policy "Owners can update their own businesses"
  on businesses for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Column-level lock: even though the policy above allows an owner to run
-- UPDATE on their own row, Postgres privileges restrict WHICH columns that
-- UPDATE is allowed to touch. Without this, an owner could set their own
-- status to 'approved' or hand the listing to a different owner_id.
revoke update on businesses from authenticated;
grant update (name, category, neighborhood, description, long_description, address, phone, hours, badges)
  on businesses to authenticated;

-- claims: a logged-in user can create a claim for themselves, only pending
create policy "Users can insert their own claims"
  on claims for insert
  with check (requester_id = auth.uid() and status = 'pending');

-- claims: a user can see their own claims (to show "claim pending" in their dashboard)
create policy "Users can read their own claims"
  on claims for select
  using (requester_id = auth.uid());

-- No one but the Supabase dashboard (service role) can update a claim's
-- status or a business's status/owner_id. The dashboard's Table Editor
-- uses the service role, which bypasses RLS and column grants entirely,
-- so a volunteer can still approve things there.
revoke update on claims from authenticated;
```

- [ ] **Step 2: Run it**

  In the Supabase dashboard, go to SQL Editor → New query, paste the contents of `supabase/schema.sql`, and run it. Expected: "Success. No rows returned."

- [ ] **Step 3: Verify RLS blocks what it should, in the SQL editor**

  Still in the SQL editor, run each of these as separate queries and confirm the noted result. These simulate an anonymous request (the SQL editor runs as the `postgres` superuser by default, which bypasses RLS — so instead, verify by reading the policies back and reasoning through them, then do the real verification against the live anon key in Step 4 below, which is the version that actually exercises RLS).

```sql
select policyname, cmd, qual, with_check
from pg_policies
where tablename in ('businesses', 'claims')
order by tablename, policyname;
```

  Expected: 6 rows — the 4 `businesses` policies and 2 `claims` policies written above, each with the `qual`/`with_check` expressions matching what was written.

- [ ] **Step 4: Verify RLS against the real anon key (this is the test that matters)**

  Open the browser console on `noor-business.html` (same local server as Task 1) and run:

```javascript
// Anonymous read: should succeed and return 0 rows (no businesses yet, none approved)
const { data, error } = await window.NiccSupabase.from('businesses').select('*');
console.log({ data, error });
```

  Expected: `error` is `null`, `data` is `[]`.

```javascript
// Anonymous insert: should be rejected, since there is no logged-in user
// so auth.uid() is null and can never equal a real owner_id
const { data, error } = await window.NiccSupabase.from('businesses').insert({
  name: "Test", category: "Restaurants", neighborhood: "Hilliard",
  description: "x", long_description: "x", owner_id: "00000000-0000-0000-0000-000000000000"
});
console.log({ data, error });
```

  Expected: `error` is not `null` (a row-level security policy violation). `data` is `null`.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add businesses and claims tables with RLS policies"
```

---

### Task 3: Seed the 6 real businesses

**Files:**
- Create: `supabase/seed.sql`

**Interfaces:**
- Consumes: the `businesses` table from Task 2.
- Produces: 6 rows in `businesses`, `status = 'approved'`, `owner_id = null` — the same 6 real businesses currently hardcoded in `noor-business.html`'s `LISTINGS` array, which Task 4 will read from Supabase instead.

- [ ] **Step 1: Write `supabase/seed.sql`**

```sql
-- supabase/seed.sql
-- One-time seed: inserts the 6 real, already-researched businesses.
-- Run this once, after schema.sql, in the Supabase SQL editor.
-- This uses the service role (the SQL editor bypasses RLS), which is
-- correct here — these rows start pre-approved because they were already
-- vetted by research, not submitted through the public form.

insert into businesses
  (name, category, neighborhood, description, long_description, address, hours, badges, featured, status)
values
  (
    'Meat Moot', 'Restaurants', 'Hilliard',
    'Zabihah-listed Mediterranean smoked meats on Fishinger Boulevard.',
    'A Mediterranean smoked meat restaurant on Fishinger Boulevard in Hilliard, listed as halal on Zabihah. New to this directory, this listing has not yet been confirmed directly with the owner.',
    '3708 Fishinger Blvd, Hilliard, OH 43026',
    '[]'::jsonb, '{}'::text[], true, 'approved'
  ),
  (
    'Supreme Fresh Halal Meat & Grocery', 'Grocery & Halal Meat', 'Northland',
    'Fresh halal meat and Indian grocery staples near Polaris.',
    'A halal meat and grocery shop on Sancus Boulevard carrying goat, chicken, and fish alongside a curated selection of Indian pantry staples and spices.',
    '8635 Sancus Blvd, Columbus, OH 43240',
    '[]'::jsonb, '{}'::text[], true, 'approved'
  ),
  (
    'We-Got-Meat', 'Grocery & Halal Meat', 'Dublin',
    'Halal meat market and delivery service on Sawmill Road.',
    'Part of a regional halal meat delivery service, with a Dublin location on Sawmill Road for in-person shopping alongside online ordering.',
    '5833 Sawmill Rd, Dublin, OH 43017',
    '[]'::jsonb, '{}'::text[], false, 'approved'
  ),
  (
    'Naska Beauty', 'Modest Wear', 'Citywide (online)',
    'Mother and daughter modest wear brand, hijabs and abayas shipped worldwide.',
    'An online modest wear brand run by a mother and daughter, designing hijabs, abayas, and prayer wear in house and shipping worldwide from Columbus. No walk-in storefront yet.',
    null,
    '[]'::jsonb, '{women}'::text[], false, 'approved'
  ),
  (
    'Al-Tahoor Quran Institute', 'Education', 'Citywide (online)',
    'Live one-on-one Quran classes for families across central Ohio.',
    'Live, one-on-one Quran instruction from Ijazah-certified teachers, serving families across Columbus, Dublin, and Hilliard through online sessions.',
    null,
    '[]'::jsonb, '{}'::text[], false, 'approved'
  ),
  (
    'Noor Free Clinic', 'Health & Wellness', 'Short North',
    'NICC''s own free clinic, run by volunteer Muslim physicians since 2010.',
    'Run by Noor Islamic Cultural Center in partnership with OSU Wexner Medical Center, this free clinic serves uninsured and underserved patients of any faith background. Call ahead to schedule.',
    '2231 North High St, Columbus, OH 43201 · (614) 516-3075',
    '[["Clinic hours", "Wednesdays, 17:00 - 21:00"], ["To schedule", "Call Mon 10:00-15:00 or Tue 10:00-12:00"]]'::jsonb,
    '{community}'::text[], true, 'approved'
  );
```

  Note the doubled `''` in `NICC''s` — that's how a literal apostrophe is escaped inside a single-quoted SQL string.

- [ ] **Step 2: Run it**

  Paste into the Supabase SQL editor and run. Expected: "Success. 6 rows affected" (or similar row-count confirmation).

- [ ] **Step 3: Verify the seed**

```sql
select name, category, neighborhood, featured, status from businesses order by name;
```

  Expected: exactly 6 rows, `status` is `approved` on all of them, `featured` is `true` for Meat Moot, Supreme Fresh Halal Meat & Grocery, and Noor Free Clinic, `false` for the other three.

- [ ] **Step 4: Commit**

```bash
git add supabase/seed.sql
git commit -m "feat: seed the 6 real researched businesses"
```

---

### Task 4: Load businesses from Supabase instead of the hardcoded array

**Files:**
- Create: `js/businesses-data.js`
- Modify: `noor-business.html` (remove the hardcoded `var LISTINGS = [...]` literal, add a script tag, adjust the boot sequence)

**Interfaces:**
- Consumes: `window.NiccSupabase` (Task 1), the `businesses` table (Tasks 2–3).
- Produces: `window.NiccData.loadBusinesses()` — an async function returning an array of objects shaped exactly like the old `LISTINGS` array: `{ id, name, cat, hood, icon, tone, badges, featured, rating, desc, long, address, verify, hours, reviews }`. This is the exact shape `cardHtml()` and `openListing()` in the existing inline script already expect — this task changes where the array comes from, not what it looks like.

- [ ] **Step 1: Write `js/businesses-data.js`**

```javascript
// js/businesses-data.js
(function () {
  "use strict";

  // Same category -> icon mapping used by the category browse section
  // already in noor-business.html. Kept here so a business's card icon
  // follows its category without storing a redundant column in the DB.
  var CATEGORY_ICONS = {
    "Restaurants": "i-heart",
    "Grocery & Halal Meat": "i-basket",
    "Modest Wear": "i-shirt",
    "Education": "i-book",
    "Health & Wellness": "i-heart",
    "Professional Services": "i-briefcase",
    "Home & Living": "i-sofa",
    "Auto & Repair": "i-car"
  };

  function toneFor(index) {
    return (index % 4) + 1;
  }

  function mapRow(row, index) {
    return {
      id: row.id,
      name: row.name,
      cat: row.category,
      hood: row.neighborhood,
      icon: CATEGORY_ICONS[row.category] || "i-storefront",
      tone: toneFor(index),
      badges: row.badges || [],
      featured: !!row.featured,
      rating: null,
      desc: row.description,
      long: row.long_description,
      address: row.address,
      verify: null,
      hours: row.hours || [],
      reviews: []
    };
  }

  async function loadBusinesses() {
    var result = await window.NiccSupabase
      .from("businesses")
      .select("*")
      .eq("status", "approved")
      .order("name", { ascending: true });

    if (result.error) {
      throw result.error;
    }
    return result.data.map(mapRow);
  }

  window.NiccData = {
    loadBusinesses: loadBusinesses
  };
})();
```

- [ ] **Step 2: Add the script tag to `noor-business.html`**

  Immediately after `<script src="js/supabase-client.js"></script>` (added in Task 1), add:

```html
<script src="js/businesses-data.js"></script>
```

- [ ] **Step 3: Remove the hardcoded `LISTINGS` array and wire up async loading**

  Inside the existing inline `<script>` block, find:

```javascript
var LISTINGS = [
  ... the 6 business objects ...
];
```

  Replace it with:

```javascript
var LISTINGS = [];
```

  Then find this existing block (just below `var BADGE_INFO = {...}`):

```javascript
var results = document.getElementById("results");
var featuredGrid = document.getElementById("featuredGrid");
if (featuredGrid) {
  featuredGrid.innerHTML = LISTINGS.filter(function (l) { return l.featured; }).map(cardHtml).join("");
}
if (results) {
  results.innerHTML = LISTINGS.map(cardHtml).join("");
}
```

  Replace it with:

```javascript
var results = document.getElementById("results");
var featuredGrid = document.getElementById("featuredGrid");

function renderListingCollections() {
  if (featuredGrid) {
    featuredGrid.innerHTML = LISTINGS.filter(function (l) { return l.featured; }).map(cardHtml).join("");
  }
  if (results) {
    results.innerHTML = LISTINGS.map(cardHtml).join("");
    sortResults();
    applyFilters();
  }
}

async function bootBusinessData() {
  if (featuredGrid) featuredGrid.innerHTML = '<p style="color:var(--muted)">Loading listings...</p>';
  if (results) results.innerHTML = '<p style="color:var(--muted)">Loading listings...</p>';
  try {
    LISTINGS = await window.NiccData.loadBusinesses();
  } catch (e) {
    console.error("Failed to load businesses from Supabase", e);
    LISTINGS = [];
  }
  renderListingCollections();
}
```

  Finally, find the existing boot sequence near the very bottom of the script:

```javascript
  /* ============ Boot ============ */
  setToggleIcon(false);
  updateSavedCount();
  newChallenge();
  render(currentRoute());
})();
```

  Replace it with:

```javascript
  /* ============ Boot ============ */
  setToggleIcon(false);
  updateSavedCount();
  newChallenge();
  render(currentRoute());
  bootBusinessData();
})();
```

  This keeps the router, nav, and every non-listing page rendering immediately and synchronously (unchanged from before), while the listing data loads in the background and fills in `#results` / `#featuredGrid` once it arrives. `sortResults()` and `applyFilters()` were previously only called once, at the bottom of the original `if (results) { ... sortResults(); applyFilters(); }` block that ran after the old synchronous `LISTINGS` assignment — moving that call into `renderListingCollections()` preserves that exact original behavior, just triggered after the async load instead of immediately.

- [ ] **Step 4: Verify — same 6 listings, now loaded from Supabase**

  Serve the site locally and open `#/explore` in the browser. Expected: briefly shows "Loading listings..." then renders exactly 6 cards: Meat Moot, Supreme Fresh Halal Meat & Grocery, We-Got-Meat, Naska Beauty, Al-Tahoor Quran Institute, Noor Free Clinic — same names, categories, and neighborhoods as before this task. Open the browser Network tab and confirm a request to your Supabase project's REST endpoint (`.../rest/v1/businesses?...`) returns a 200 with 6 rows.

  Also verify the homepage: `#/home` should show exactly 3 cards in "Featured this month" — Meat Moot, Supreme Fresh Halal Meat & Grocery, Noor Free Clinic.

- [ ] **Step 5: Commit**

```bash
git add js/businesses-data.js noor-business.html
git commit -m "feat: load business listings from Supabase instead of a hardcoded array"
```

---

### Task 5: Sign up, log in, log out

**Files:**
- Create: `js/auth.js`
- Modify: `noor-business.html` (add script tag; add a new `#/account` page following the exact pattern of the existing 6 pages; add "Log in" link to nav)

**Interfaces:**
- Consumes: `window.NiccSupabase` (Task 1).
- Produces: `window.NiccAuth.signUp(email, password)`, `window.NiccAuth.logIn(email, password)`, `window.NiccAuth.logOut()`, `window.NiccAuth.getCurrentUser()` — each returns a Promise. Task 6 uses `getCurrentUser()` to decide what the dashboard shows.

- [ ] **Step 1: Write `js/auth.js`**

```javascript
// js/auth.js
(function () {
  "use strict";

  async function signUp(email, password) {
    var result = await window.NiccSupabase.auth.signUp({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data.user;
  }

  async function logIn(email, password) {
    var result = await window.NiccSupabase.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data.user;
  }

  async function logOut() {
    var result = await window.NiccSupabase.auth.signOut();
    if (result.error) throw result.error;
  }

  async function getCurrentUser() {
    var result = await window.NiccSupabase.auth.getUser();
    if (result.error) return null;
    return result.data.user;
  }

  window.NiccAuth = {
    signUp: signUp,
    logIn: logIn,
    logOut: logOut,
    getCurrentUser: getCurrentUser
  };
})();
```

- [ ] **Step 2: Add the script tag**

  After `<script src="js/businesses-data.js"></script>`, add:

```html
<script src="js/auth.js"></script>
```

- [ ] **Step 3: Add the `#/account` page markup**

  Find the `ROUTES` array near the top of the inline script:

```javascript
var ROUTES = ["home", "explore", "about", "faq", "contact", "list"];
```

  Change it to:

```javascript
var ROUTES = ["home", "explore", "about", "faq", "contact", "list", "account"];
```

  In the HTML `<main>` section, find the closing `</div>` of the `page-list` div (the "List your business" page — the last one before `</main>`), and immediately after it, add a new page following the exact same structure as the other pages:

```html
  <!-- ============ ACCOUNT ============ -->
  <div class="page" id="page-account" hidden>
    <div class="page-head">
      <div class="wrap">
        <h1>Your account</h1>
        <p>Sign up or log in to add a business, claim an existing one, or edit your listing.</p>
      </div>
    </div>

    <section class="tight">
      <div class="wrap-narrow">
        <div id="accountLoggedOut">
          <div class="form-card">
            <h2 style="font-size:1.3rem;margin-bottom:20px">Log in</h2>
            <form id="loginForm" novalidate>
              <div class="form-grid">
                <div class="field full">
                  <label for="loginEmail">Email address</label>
                  <input type="email" id="loginEmail" required>
                  <span class="error">Please enter a valid email address.</span>
                </div>
                <div class="field full">
                  <label for="loginPassword">Password</label>
                  <input type="password" id="loginPassword" required>
                  <span class="error">Please enter your password.</span>
                </div>
              </div>
              <div style="margin-top:22px">
                <button type="submit" class="btn btn-primary">Log in</button>
              </div>
              <p class="form-status" id="loginStatus" role="status"></p>
            </form>
          </div>

          <div class="form-card" style="margin-top:24px">
            <h2 style="font-size:1.3rem;margin-bottom:20px">Sign up</h2>
            <form id="signupForm" novalidate>
              <div class="form-grid">
                <div class="field full">
                  <label for="signupEmail">Email address</label>
                  <input type="email" id="signupEmail" required>
                  <span class="error">Please enter a valid email address.</span>
                </div>
                <div class="field full">
                  <label for="signupPassword">Password</label>
                  <input type="password" id="signupPassword" required minlength="6">
                  <span class="error">Password must be at least 6 characters.</span>
                </div>
              </div>
              <div style="margin-top:22px">
                <button type="submit" class="btn btn-primary">Sign up</button>
              </div>
              <p class="form-status" id="signupStatus" role="status"></p>
            </form>
          </div>
        </div>

        <div id="accountLoggedIn" hidden>
          <div class="form-card">
            <p id="accountEmailDisplay" style="font-weight:700"></p>
            <p style="margin-top:20px">
              <button type="button" class="btn btn-ghost" id="logoutBtn">Log out</button>
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>
```

  Add a "Log in" link to the nav (both the desktop `.nav-links` and the `.mobile-panel`), following the exact pattern of the existing links, e.g. next to "Contact":

```html
<a href="#/account" data-route="account">Log in</a>
```

- [ ] **Step 4: Wire the forms to `js/auth.js`**

  In the inline script's boot area, add (this can go right before the `/* ============ Boot ============ */` comment):

```javascript
  /* ============ Account: login, signup, logout ============ */
  async function refreshAccountView() {
    var loggedOut = document.getElementById("accountLoggedOut");
    var loggedIn = document.getElementById("accountLoggedIn");
    if (!loggedOut || !loggedIn) return;
    var user = await window.NiccAuth.getCurrentUser();
    if (user) {
      loggedOut.hidden = true;
      loggedIn.hidden = false;
      document.getElementById("accountEmailDisplay").textContent = "Logged in as " + user.email;
    } else {
      loggedOut.hidden = false;
      loggedIn.hidden = true;
    }
  }

  var loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var status = document.getElementById("loginStatus");
      try {
        await window.NiccAuth.logIn(
          document.getElementById("loginEmail").value.trim(),
          document.getElementById("loginPassword").value
        );
        status.textContent = "Logged in.";
        status.classList.remove("error");
        status.classList.add("show");
        loginForm.reset();
        refreshAccountView();
      } catch (err) {
        status.textContent = err.message || "Could not log in. Check your email and password.";
        status.classList.add("show", "error");
      }
    });
  }

  var signupForm = document.getElementById("signupForm");
  if (signupForm) {
    signupForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var status = document.getElementById("signupStatus");
      try {
        await window.NiccAuth.signUp(
          document.getElementById("signupEmail").value.trim(),
          document.getElementById("signupPassword").value
        );
        status.textContent = "Account created. You are now logged in.";
        status.classList.remove("error");
        status.classList.add("show");
        signupForm.reset();
        refreshAccountView();
      } catch (err) {
        status.textContent = err.message || "Could not create account.";
        status.classList.add("show", "error");
      }
    });
  }

  var logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async function () {
      await window.NiccAuth.logOut();
      refreshAccountView();
    });
  }
```

  In the `render(route)` function, find where it sets page visibility (the `ROUTES.forEach` block), and immediately after that function's existing body, call `refreshAccountView()` whenever the account route is rendered. Find:

```javascript
  function render(route) {
    ROUTES.forEach(function (r) {
      var page = document.getElementById("page-" + r);
      if (page) page.hidden = (r !== route);
    });
```

  Leave that as-is, but at the end of the `render` function (right before its closing `}`), add:

```javascript
    if (route === "account") refreshAccountView();
```

- [ ] **Step 5: Verify — sign up, log in, log out, and the two failure paths**

  All of these are manual browser checks, per this project's established testing approach (no automated suite).

  1. Go to `#/account`. Sign up with a real email you control (email confirmation is off per Task 1, so this should log you in immediately) and password `test1234`. Expected: "Account created. You are now logged in." message, then the logged-in view shows "Logged in as <your email>".
  2. Click "Log out." Expected: returns to the logged-out view with the login/signup forms.
  3. Log in with the same email and password. Expected: "Logged in." message, then the logged-in view.
  4. Log in with the same email and a wrong password. Expected: an error message appears in `#loginStatus` (not a silent failure, not a JS console error) — Supabase returns "Invalid login credentials," which the code above displays via `err.message`.
  5. Try signing up again with the same email. Expected: an error message appears in `#signupStatus` (Supabase returns "User already registered" or similar).

- [ ] **Step 6: Commit**

```bash
git add js/auth.js noor-business.html
git commit -m "feat: add sign up, log in, and log out"
```

---

### Task 6: Owner dashboard — view your listings, add a new business

**Files:**
- Create: `js/owner-dashboard.js`
- Modify: `noor-business.html` (extend the `#/account` page with a dashboard section and an "add new business" form)

**Interfaces:**
- Consumes: `window.NiccSupabase` (Task 1), `window.NiccAuth.getCurrentUser()` (Task 5).
- Produces: `window.NiccOwner.loadMyBusinesses()` (returns the logged-in user's own businesses regardless of status) and `window.NiccOwner.createBusiness(fields)` — both used by this task's UI and available to Task 7/8.

- [ ] **Step 1: Write `js/owner-dashboard.js`**

```javascript
// js/owner-dashboard.js
(function () {
  "use strict";

  async function loadMyBusinesses() {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) return [];
    var result = await window.NiccSupabase
      .from("businesses")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data;
  }

  async function createBusiness(fields) {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) throw new Error("You must be logged in to add a business.");
    var result = await window.NiccSupabase.from("businesses").insert({
      owner_id: user.id,
      status: "pending",
      name: fields.name,
      category: fields.category,
      neighborhood: fields.neighborhood,
      description: fields.description,
      long_description: fields.longDescription,
      address: fields.address || null
    }).select().single();
    if (result.error) throw result.error;
    return result.data;
  }

  window.NiccOwner = {
    loadMyBusinesses: loadMyBusinesses,
    createBusiness: createBusiness
  };
})();
```

- [ ] **Step 2: Add the script tag**

  After `<script src="js/auth.js"></script>`, add:

```html
<script src="js/owner-dashboard.js"></script>
```

- [ ] **Step 3: Extend the logged-in view with a dashboard and "add new business" form**

  Replace the `#accountLoggedIn` div from Task 5 (currently just the email display and log out button) with:

```html
        <div id="accountLoggedIn" hidden>
          <div class="form-card">
            <p id="accountEmailDisplay" style="font-weight:700"></p>
            <p style="margin-top:12px">
              <button type="button" class="btn btn-ghost" id="logoutBtn">Log out</button>
            </p>
          </div>

          <div class="form-card" style="margin-top:24px">
            <h2 style="font-size:1.3rem;margin-bottom:12px">Your listings</h2>
            <div id="myListings"><p style="color:var(--muted)">Loading...</p></div>
          </div>

          <div class="form-card" style="margin-top:24px">
            <h2 style="font-size:1.3rem;margin-bottom:20px">Add a new business</h2>
            <form id="ownerAddForm" novalidate>
              <div class="form-grid">
                <div class="field full">
                  <label for="ownAddName">Business name</label>
                  <input type="text" id="ownAddName" required>
                  <span class="error">Please enter your business name.</span>
                </div>
                <div class="field">
                  <label for="ownAddCategory">Category</label>
                  <select id="ownAddCategory">
                    <option>Restaurants</option>
                    <option>Grocery &amp; Halal Meat</option>
                    <option>Modest Wear</option>
                    <option>Health &amp; Wellness</option>
                    <option>Professional Services</option>
                    <option>Education</option>
                    <option>Home &amp; Living</option>
                    <option>Auto &amp; Repair</option>
                  </select>
                </div>
                <div class="field">
                  <label for="ownAddHood">Neighborhood</label>
                  <select id="ownAddHood">
                    <option>Short North</option>
                    <option>German Village</option>
                    <option>Clintonville</option>
                    <option>Dublin</option>
                    <option>Westerville</option>
                    <option>Northland</option>
                    <option>Hilliard</option>
                    <option>Citywide (online)</option>
                  </select>
                </div>
                <div class="field full">
                  <label for="ownAddAddress">Address</label>
                  <input type="text" id="ownAddAddress" placeholder="Optional, for online-only businesses">
                </div>
                <div class="field full">
                  <label for="ownAddDesc">Short description</label>
                  <textarea id="ownAddDesc" required placeholder="One sentence for the listing card."></textarea>
                  <span class="error">Please add a short description.</span>
                </div>
                <div class="field full">
                  <label for="ownAddLong">Full description</label>
                  <textarea id="ownAddLong" required placeholder="What you do, and what makes people come back."></textarea>
                  <span class="error">Please add a fuller description.</span>
                </div>
              </div>
              <div style="margin-top:22px">
                <button type="submit" class="btn btn-primary">Submit for review</button>
              </div>
              <p class="form-status" id="ownerAddStatus" role="status"></p>
            </form>
          </div>
        </div>
```

- [ ] **Step 4: Wire the dashboard and add-business form**

  In the inline script, extend `refreshAccountView()` (from Task 5) to also load and render the dashboard. Replace the whole function with:

```javascript
  async function refreshAccountView() {
    var loggedOut = document.getElementById("accountLoggedOut");
    var loggedIn = document.getElementById("accountLoggedIn");
    if (!loggedOut || !loggedIn) return;
    var user = await window.NiccAuth.getCurrentUser();
    if (user) {
      loggedOut.hidden = true;
      loggedIn.hidden = false;
      document.getElementById("accountEmailDisplay").textContent = "Logged in as " + user.email;
      renderMyListings();
    } else {
      loggedOut.hidden = false;
      loggedIn.hidden = true;
    }
  }

  async function renderMyListings() {
    var el = document.getElementById("myListings");
    if (!el) return;
    try {
      var mine = await window.NiccOwner.loadMyBusinesses();
      if (mine.length === 0) {
        el.innerHTML = '<p style="color:var(--muted)">You do not have any listings yet.</p>';
        return;
      }
      el.innerHTML = mine.map(function (b) {
        return '<div class="hours-row"><span>' + b.name + '</span><span>' + b.status + '</span></div>';
      }).join("");
    } catch (err) {
      el.innerHTML = '<p style="color:var(--muted)">Could not load your listings.</p>';
    }
  }

  var ownerAddForm = document.getElementById("ownerAddForm");
  if (ownerAddForm) {
    ownerAddForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var status = document.getElementById("ownerAddStatus");
      var name = document.getElementById("ownAddName").value.trim();
      var desc = document.getElementById("ownAddDesc").value.trim();
      var longDesc = document.getElementById("ownAddLong").value.trim();
      if (!name || !desc || !longDesc) {
        document.getElementById("ownAddName").closest(".field").classList.toggle("invalid", !name);
        document.getElementById("ownAddDesc").closest(".field").classList.toggle("invalid", !desc);
        document.getElementById("ownAddLong").closest(".field").classList.toggle("invalid", !longDesc);
        return;
      }
      try {
        await window.NiccOwner.createBusiness({
          name: name,
          category: document.getElementById("ownAddCategory").value,
          neighborhood: document.getElementById("ownAddHood").value,
          description: desc,
          longDescription: longDesc,
          address: document.getElementById("ownAddAddress").value.trim()
        });
        status.textContent = "Thank you. Your listing has been submitted and a volunteer will review it within two business days.";
        status.classList.remove("error");
        status.classList.add("show");
        ownerAddForm.reset();
        renderMyListings();
      } catch (err) {
        status.textContent = err.message || "Could not submit your listing. Please try again.";
        status.classList.add("show", "error");
      }
    });
  }
```

  This form intentionally does not include the anti-bot challenge from the public "List your business" page — it is only reachable by a logged-in user, which is a stronger gate than the anonymous form's honeypot/timing/challenge combination. The existing anonymous "List your business" page (`#/list`) is left completely unmodified by this task, per the Global Constraints.

- [ ] **Step 5: Verify — add a business as a logged-in owner**

  1. Log in (from Task 5). Go to the dashboard section of `#/account`. Expected: "Your listings" shows "You do not have any listings yet."
  2. Fill in the "Add a new business" form with a real test name (e.g. "Test Bakery") and submit. Expected: success message, and "Your listings" now shows "Test Bakery — pending".
  3. In the Supabase Table Editor, open the `businesses` table. Expected: a new row for "Test Bakery" with `status = pending` and `owner_id` matching your test user's id (visible in Authentication → Users).
  4. Confirm "Test Bakery" does **not** appear anywhere in the public directory (`#/explore`) yet — it is pending, and the public read policy only returns `approved` rows.

- [ ] **Step 6: Commit**

```bash
git add js/owner-dashboard.js noor-business.html
git commit -m "feat: add owner dashboard with listing view and add-business form"
```

---

### Task 7: Claim an existing business

**Files:**
- Modify: `js/owner-dashboard.js` (add claim function)
- Modify: `noor-business.html` (add a "Claim this business" control to the listing modal, and a claims list to the dashboard)

**Interfaces:**
- Consumes: `window.NiccSupabase`, `window.NiccAuth.getCurrentUser()`.
- Produces: `window.NiccOwner.claimBusiness(businessId, note)` and `window.NiccOwner.loadMyClaims()`.

- [ ] **Step 1: Add claim functions to `js/owner-dashboard.js`**

  Add these two functions inside the existing IIFE in `js/owner-dashboard.js`, and add them to the `window.NiccOwner` object at the bottom:

```javascript
  async function claimBusiness(businessId, note) {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) throw new Error("You must be logged in to claim a business.");
    var result = await window.NiccSupabase.from("claims").insert({
      business_id: businessId,
      requester_id: user.id,
      note: note || null
    });
    if (result.error) throw result.error;
  }

  async function loadMyClaims() {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) return [];
    var result = await window.NiccSupabase
      .from("claims")
      .select("*, businesses(name)")
      .eq("requester_id", user.id)
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data;
  }
```

  Update the `window.NiccOwner = {...}` assignment to:

```javascript
  window.NiccOwner = {
    loadMyBusinesses: loadMyBusinesses,
    createBusiness: createBusiness,
    claimBusiness: claimBusiness,
    loadMyClaims: loadMyClaims
  };
```

- [ ] **Step 2: Add a "Claim this business" button to the listing modal**

  Find the modal footer in `noor-business.html`:

```html
  <div class="modal-foot">
    <button class="btn btn-primary" id="modalSave"><svg class="icon"><use href="#i-bookmark"/></svg> Save listing</button>
    <a class="btn btn-ghost" href="#/contact" data-route="contact" id="modalContact">Contact this business</a>
  </div>
```

  Add a claim button after it:

```html
  <div class="modal-foot">
    <button class="btn btn-primary" id="modalSave"><svg class="icon"><use href="#i-bookmark"/></svg> Save listing</button>
    <a class="btn btn-ghost" href="#/contact" data-route="contact" id="modalContact">Contact this business</a>
    <button class="btn btn-ghost" id="modalClaim">Claim this business</button>
  </div>
```

- [ ] **Step 3: Wire the claim button**

  In the inline script, find `openListing(id)` (it sets `currentItem = item;` near the top). After the existing `modalSave` wiring code (the block starting `document.getElementById("modalSave").addEventListener(...)` further down in the file), add:

```javascript
  var modalClaim = document.getElementById("modalClaim");
  if (modalClaim) {
    modalClaim.addEventListener("click", async function () {
      var user = await window.NiccAuth.getCurrentUser();
      if (!user) {
        modal.close();
        location.hash = "#/account";
        toast("Log in first, then claim this listing from its page.");
        return;
      }
      if (!currentItem) return;
      try {
        await window.NiccOwner.claimBusiness(currentItem.id, null);
        toast("Claim submitted. A volunteer will review it.");
        modal.close();
      } catch (err) {
        toast(err.message || "Could not submit claim.");
      }
    });
  }
```

- [ ] **Step 4: Show claims-in-progress in the dashboard**

  In `renderMyListings()` (Task 6), extend it to also show claims. Replace the function with:

```javascript
  async function renderMyListings() {
    var el = document.getElementById("myListings");
    if (!el) return;
    try {
      var mine = await window.NiccOwner.loadMyBusinesses();
      var claims = await window.NiccOwner.loadMyClaims();
      var rows = mine.map(function (b) {
        return '<div class="hours-row"><span>' + b.name + '</span><span>' + b.status + '</span></div>';
      });
      var claimRows = claims.map(function (c) {
        var name = c.businesses ? c.businesses.name : "Unknown listing";
        return '<div class="hours-row"><span>Claim: ' + name + '</span><span>' + c.status + '</span></div>';
      });
      var all = rows.concat(claimRows);
      el.innerHTML = all.length
        ? all.join("")
        : '<p style="color:var(--muted)">You do not have any listings yet.</p>';
    } catch (err) {
      el.innerHTML = '<p style="color:var(--muted)">Could not load your listings.</p>';
    }
  }
```

- [ ] **Step 5: Verify — claim flow, and the "already claimed" edge case**

  1. Log in as a test user. Open any of the 6 real listings (e.g. Meat Moot) and click "Claim this business." Expected: toast "Claim submitted. A volunteer will review it."
  2. Go to `#/account`. Expected: "Your listings" now shows "Claim: Meat Moot — pending".
  3. In the Supabase Table Editor, open `claims`. Expected: one row with `business_id` matching Meat Moot's id, `requester_id` matching your test user, `status = pending`.
  4. Confirm Meat Moot's own row in `businesses` is unchanged — still `owner_id = null`, `status = approved` — claiming does not alter the business itself until a volunteer approves it (matches the spec: "Listing stays fully visible and unowned ... while pending").
  5. Log out, then try to click "Claim this business" while logged out. Expected: redirected to `#/account` with a toast telling you to log in first, no claim row created.

- [ ] **Step 6: Commit**

```bash
git add js/owner-dashboard.js noor-business.html
git commit -m "feat: add claim-an-existing-business flow"
```

---

### Task 8: Edit a listing, and the volunteer approval walkthrough

**Files:**
- Modify: `js/owner-dashboard.js` (add update function)
- Modify: `noor-business.html` (add an edit form to the dashboard for owned, approved listings)

**Interfaces:**
- Consumes: `window.NiccSupabase`, `window.NiccOwner.loadMyBusinesses()`.
- Produces: `window.NiccOwner.updateBusiness(id, fields)`.

- [ ] **Step 1: Add the update function to `js/owner-dashboard.js`**

```javascript
  async function updateBusiness(id, fields) {
    var result = await window.NiccSupabase.from("businesses").update({
      name: fields.name,
      category: fields.category,
      neighborhood: fields.neighborhood,
      description: fields.description,
      long_description: fields.longDescription,
      address: fields.address || null
    }).eq("id", id);
    if (result.error) throw result.error;
  }
```

  Add `updateBusiness: updateBusiness` to the `window.NiccOwner = {...}` object.

- [ ] **Step 2: Add an inline edit form per listing in the dashboard**

  Replace `renderMyListings()` once more, this time generating an edit form for each of the owner's own businesses (not for claims, which have nothing to edit yet):

```javascript
  async function renderMyListings() {
    var el = document.getElementById("myListings");
    if (!el) return;
    try {
      var mine = await window.NiccOwner.loadMyBusinesses();
      var claims = await window.NiccOwner.loadMyClaims();

      var businessBlocks = mine.map(function (b) {
        return '' +
          '<div class="hours-row"><span>' + b.name + '</span><span>' + b.status + '</span></div>' +
          '<form class="owner-edit-form" data-business-id="' + b.id + '" style="margin:10px 0 20px">' +
            '<div class="field"><label>Short description</label><textarea class="edit-desc" required>' + b.description + '</textarea></div>' +
            '<button type="submit" class="btn btn-ghost btn-sm" style="margin-top:8px">Save changes</button>' +
            '<p class="form-status edit-status" role="status"></p>' +
          '</form>';
      });

      var claimRows = claims.map(function (c) {
        var name = c.businesses ? c.businesses.name : "Unknown listing";
        return '<div class="hours-row"><span>Claim: ' + name + '</span><span>' + c.status + '</span></div>';
      });

      var all = businessBlocks.concat(claimRows);
      el.innerHTML = all.length
        ? all.join("")
        : '<p style="color:var(--muted)">You do not have any listings yet.</p>';

      el.querySelectorAll(".owner-edit-form").forEach(function (form) {
        form.addEventListener("submit", async function (e) {
          e.preventDefault();
          var status = form.querySelector(".edit-status");
          var businessId = form.getAttribute("data-business-id");
          var current = mine.filter(function (b) { return b.id === businessId; })[0];
          try {
            await window.NiccOwner.updateBusiness(businessId, {
              name: current.name,
              category: current.category,
              neighborhood: current.neighborhood,
              description: form.querySelector(".edit-desc").value.trim(),
              longDescription: current.long_description,
              address: current.address
            });
            status.textContent = "Saved.";
            status.classList.remove("error");
            status.classList.add("show");
          } catch (err) {
            status.textContent = err.message || "Could not save changes.";
            status.classList.add("show", "error");
          }
        });
      });
    } catch (err) {
      el.innerHTML = '<p style="color:var(--muted)">Could not load your listings.</p>';
    }
  }
```

  This edits only the short description, to keep the verification step below simple and concrete — the same `updateBusiness` function already accepts every editable field, so adding more inputs later is a markup change, not a new interface.

- [ ] **Step 3: Verify — the full loop: submit, approve as a volunteer, edit, and the two access-control failure paths**

  1. As a logged-in test user, submit a new business via the Task 6 form (e.g. "Test Bakery Two").
  2. In the Supabase Table Editor, open `businesses`, find "Test Bakery Two," and change its `status` cell from `pending` to `approved`. This is the volunteer approval step from the spec — done directly in the Table Editor, no app code involved.
  3. Reload `#/explore` in the browser. Expected: "Test Bakery Two" now appears in the public directory.
  4. Go to `#/account`. Expected: "Test Bakery Two" now has an inline "Short description" field pre-filled with its current description.
  5. Change the description text and click "Save changes." Expected: "Saved." message.
  6. Reload `#/explore`, open "Test Bakery Two"'s modal. Expected: the new description shows immediately — no re-approval needed, per the spec's "Edit a listing" flow.
  7. **Access-control check 1 (column privilege):** in the browser console, while logged in as the owner of "Test Bakery Two," run:

```javascript
const { data, error } = await window.NiccSupabase
  .from('businesses')
  .update({ status: 'approved', owner_id: '00000000-0000-0000-0000-000000000000' })
  .eq('id', 'PASTE_TEST_BAKERY_TWO_ID_HERE');
console.log({ data, error });
```

     Expected: `error` is not `null` — Postgres rejects the update because `authenticated` was never granted UPDATE on the `status` or `owner_id` columns (Task 2, Step 1). This is the check that confirms an owner cannot self-approve or hand their listing to someone else.

  8. **Access-control check 2 (row ownership):** log in as a *different* test user (sign up a second account) and, in the console, try to update "Test Bakery Two" (owned by the first test user):

```javascript
const { data, error } = await window.NiccSupabase
  .from('businesses')
  .update({ description: 'Hijacked' })
  .eq('id', 'PASTE_TEST_BAKERY_TWO_ID_HERE');
console.log({ data, error });
```

     Expected: no error is thrown (RLS `update` policies fail closed by matching zero rows rather than raising an error), but `data` is an empty array/`null` and a follow-up read of "Test Bakery Two" shows the description is unchanged — the second user's `auth.uid()` does not match `owner_id`, so the row-level security policy excludes it from the update entirely.

- [ ] **Step 4: Commit**

```bash
git add js/owner-dashboard.js noor-business.html
git commit -m "feat: add listing edit flow and verify RLS access control"
```

---

## Self-Review Notes

**Spec coverage:** Every section of the spec maps to a task — Architecture/hosting (Task 1), Data model (Task 2), the 6-listing migration (Task 3), sign up/log in (Task 5), add a new business (Task 6), claim an existing business (Task 7), edit a listing + moderation walkthrough (Task 8). The one gap found while planning — `featured` had no column in the spec's table definition even though the existing site's data has always carried it — is fixed by adding `featured boolean` to `schema.sql` in Task 2; this is called out to the user separately from this plan, since it's a small addition to an already-approved spec, not a silent change.

**Placeholder scan:** No TBD/TODO/"add appropriate" phrasing anywhere above. The two `PASTE_...` values in Task 1's `supabase-client.js` are real required manual inputs (there is no way to know a specific user's Supabase project URL/key in advance), not deferred work — Step 4 of that task verifies they were actually filled in.

**Type/name consistency:** `window.NiccSupabase` (Task 1) is the name used in every later task. `window.NiccData.loadBusinesses()` (Task 4) is the exact name/shape consumed nowhere else (only the boot sequence uses it). `window.NiccAuth.{signUp, logIn, logOut, getCurrentUser}` (Task 5) are the exact names called in Task 6/7/8. `window.NiccOwner.{loadMyBusinesses, createBusiness, claimBusiness, loadMyClaims, updateBusiness}` (Tasks 6-8) match between definition and every call site above.
