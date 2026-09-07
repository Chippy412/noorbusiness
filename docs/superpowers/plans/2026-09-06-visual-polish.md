# Visual Polish & Motion Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `noor-business.html` feel alive and responsive throughout, and give it a stronger geometric (khatim) visual identity, without any new dependencies or build tooling.

**Architecture:** Every change is either a CSS addition/edit inside the existing single `<style>` block, or a small edit to an existing JS function inside the existing inline `<script>` block, both in `noor-business.html`. No new files, no new libraries.

**Tech Stack:** Vanilla CSS (transitions, `@keyframes`, pseudo-classes) and vanilla JS, matching the file's existing patterns exactly. No build step.

**Spec:** `docs/superpowers/specs/2026-09-06-visual-polish-design.md`

## Global Constraints

- No new JS libraries or CDN scripts (spec Non-goals).
- No scroll-hijacking, parallax, or GSAP-style choreography — stay in the "fluid CSS" band (spec Non-goals).
- Every new animation must collapse to instant/static under `prefers-reduced-motion: reduce`, consistent with the existing `reveal` system and the existing `reduceMotion` JS variable (`noor-business.html:1724`).
- No automated test suite exists for this project. Every task's verification is a manual local-server + browser check (this matches every prior plan in this repo).

---

## Pre-existing state (read before starting)

A code audit during planning found several things the design spec's problem framing assumed were missing, but actually already exist from an earlier design pass. Do not re-add these — the tasks below only cover genuine gaps:

- `.btn:active { transform: scale(0.97); }` already exists (`noor-business.html:177`) — the "squish" press-feel is already done for every `.btn`-classed button.
- `.toggle` (the badge filter pills — Halal verified, Prayer space, etc.) already has `transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;` (`noor-business.html:556`) — smooth toggle fill already works.
- `.pill` (category quick-links) already transitions `border-color`, `color`, and lifts on hover (`noor-business.html:346`) — these aren't stateful toggles (they navigate away, they don't stay "selected"), so there's nothing further to add here.
- The staggered-reveal *mechanism* already exists: `revealInit()` (`noor-business.html:2072`) assigns each `.reveal` element a `transitionDelay` of `Math.min(i % 6, 5) * 60ms` before observing it with an `IntersectionObserver`. The gap (Task 4 below) is that it's never re-run after business cards are inserted asynchronously, so cards currently get **no** stagger or fade at all.
- `.listing-art::before` already paints the `--pattern` khatim texture behind every card's icon tile at `opacity: 0.5` (`noor-business.html:366`) — the "card ornament for photo-less listings" from the spec is already satisfied. No task for it below.

Genuine gaps this plan covers: nav-link hover animation, save-button press feedback, search-field focus transition, theme-toggle cross-fade, the dynamic-card stagger bug, skeleton loaders, image zoom-on-hover, a bolder hero pattern moment, and reusing the star-divider motif on About.

---

### Task 1: Animated nav-link hover underline

**Files:**
- Modify: `noor-business.html:218-220` (`.nav-links a` rule block)

**Interfaces:** None — pure CSS, no new classes or markup.

- [ ] **Step 1: Replace the nav-link hover rules**

Find:

```css
  .nav-links a { transition: color 0.2s ease; padding: 4px 0; border-bottom: 2px solid transparent; }
  .nav-links a:hover { color: var(--accent); }
  .nav-links a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
```

Replace with:

```css
  .nav-links a {
    position: relative; transition: color 0.2s ease; padding: 4px 0; border-bottom: 2px solid transparent;
  }
  .nav-links a::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -2px; height: 2px;
    background: var(--accent); transform: scaleX(0); transition: transform 0.25s ease;
  }
  .nav-links a:hover { color: var(--accent); }
  .nav-links a:hover::after, .nav-links a:focus-visible::after { transform: scaleX(1); }
  .nav-links a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
```

This keeps the existing `border-bottom` on `[aria-current="page"]` (the static "you are here" indicator) untouched, and adds a separate `::after` bar that animates in on hover/focus for every link. The two don't conflict visually since the current page's link is rarely also the one being hovered.

- [ ] **Step 2: Verify in the browser**

Serve the site locally (`python3 -m http.server 8000` from the repo root, open `http://localhost:8000/noor-business.html`). Hover over "Explore" in the top nav. Expected: a thin accent-colored line grows in from nothing to full width under the link, over about a quarter second — not an instant snap. Move the mouse away: the line shrinks back out the same way. Tab through the nav with the keyboard: the same animation should trigger on focus.

- [ ] **Step 3: Verify reduced motion**

In the browser devtools, emulate `prefers-reduced-motion: reduce` (Chrome DevTools → Rendering tab → "Emulate CSS media feature prefers-reduced-motion"). Hover a nav link again. Expected: the underline still appears/disappears (it's a small, non-distracting transition), which is acceptable — this plan only requires the *big* motions (staggered reveal, shimmer) to collapse under reduced motion, per the spec. No change needed here; this step is a sanity check, not a gate.

- [ ] **Step 4: Commit**

```bash
git add noor-business.html
git commit -m "feat: animate nav link hover with a growing underline"
```

---

### Task 2: Save-button press feedback and search-field focus transition

**Files:**
- Modify: `noor-business.html:381-389` (`.save-btn` rule block)
- Modify: `noor-business.html:298-309` (`.search-field` rule block)

**Interfaces:** None.

- [ ] **Step 1: Add press feedback to the save (bookmark) button**

Find (`noor-business.html:386`):

```css
    transition: color 0.2s ease, border-color 0.2s ease, transform 0.25s ease;
  }
  .save-btn svg { width: 17px; height: 17px; }
  .save-btn:hover { transform: scale(1.08); border-color: var(--accent); color: var(--accent); }
```

Replace with:

```css
    transition: color 0.2s ease, border-color 0.2s ease, transform 0.25s ease;
  }
  .save-btn svg { width: 17px; height: 17px; }
  .save-btn:hover { transform: scale(1.08); border-color: var(--accent); color: var(--accent); }
  .save-btn:active { transform: scale(0.92); }
```

- [ ] **Step 2: Add a smooth focus transition to search fields**

Find (`noor-business.html:298-309`):

```css
  .search-field { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px; min-width: 0; }
```

Replace with:

```css
  .search-field {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px; min-width: 0;
    transition: background-color 0.3s ease, box-shadow 0.3s ease;
  }
```

Then find (`noor-business.html:309`):

```css
  .search-field:focus-within { background: var(--accent-soft); }
```

Replace with:

```css
  .search-field:focus-within { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
```

- [ ] **Step 3: Verify in the browser**

Reload `#/explore` or `#/home`. Click the bookmark icon on any listing card: it should shrink slightly on the press itself (mouse-down), not just pop bigger on hover. Click into the hero search bar's "What are you looking for?" field: the field's background should smoothly tint over about a third of a second (not snap), and a thin accent-colored ring should fade in around it. Tab to the category/neighborhood selects and confirm the same.

- [ ] **Step 4: Commit**

```bash
git add noor-business.html
git commit -m "feat: add save-button press feedback and search-field focus transition"
```

---

### Task 3: Smooth light/dark theme cross-fade

**Files:**
- Modify: `noor-business.html` — add a new CSS rule (anywhere in the `<style>` block; put it near the `:root` theme blocks around line 90 for discoverability)
- Modify: `noor-business.html:2060-2065` (`toggleTheme` function)

**Interfaces:**
- Consumes: the existing `reduceMotion` variable (`noor-business.html:1724`).
- Produces: no new exports — `toggleTheme` keeps its existing signature (no arguments, called from the two toggle buttons' click handlers, unchanged).

- [ ] **Step 1: Add the transition-scoping CSS rule**

Add this new rule right after the closing `}` of the `:root[data-theme="dark"] { ... }` block (`noor-business.html:~112`):

```css
  html.theme-transitioning, html.theme-transitioning * {
    transition: background-color 0.25s ease, border-color 0.25s ease, color 0.25s ease, fill 0.25s ease, stroke 0.25s ease, box-shadow 0.25s ease !important;
  }
```

This only takes effect while the `theme-transitioning` class is present on `<html>`, so it never permanently changes any other component's own transition timing (buttons, pills, etc. keep their existing hover/press speeds the rest of the time).

- [ ] **Step 2: Toggle the class around the theme switch**

Find (`noor-business.html:2060-2065`):

```javascript
  function toggleTheme() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyThemeIcon();
  }
```

Replace with:

```javascript
  function toggleTheme() {
    var root = document.documentElement;
    if (!reduceMotion) root.classList.add("theme-transitioning");
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyThemeIcon();
    if (!reduceMotion) {
      window.setTimeout(function () { root.classList.remove("theme-transitioning"); }, 300);
    }
  }
```

- [ ] **Step 3: Verify in the browser**

Reload the site, click the theme toggle (sun/moon icon) in the nav. Expected: the whole page's colors cross-fade smoothly over about a quarter second — background, text, card borders, nav — rather than snapping instantly. Click it again to switch back; same smooth transition. Open the browser console and run `document.documentElement.classList.contains("theme-transitioning")` about 500ms after clicking: expected `false` (the class was removed after the transition finished, not left on permanently).

- [ ] **Step 4: Verify reduced motion**

Emulate `prefers-reduced-motion: reduce` in devtools, reload, and click the theme toggle. Expected: the theme still switches, but instantly (no cross-fade) — confirm by checking that `theme-transitioning` is never added (`reduceMotion` gates the whole block).

- [ ] **Step 5: Commit**

```bash
git add noor-business.html
git commit -m "feat: smooth light/dark theme cross-fade transition"
```

---

### Task 4: Fix — wire the staggered reveal to dynamically-loaded business cards

**Files:**
- Modify: `noor-business.html:1833-1842` (`renderListingCollections` function)

**Interfaces:**
- Consumes: `revealInit()` (`noor-business.html:2072`) — existing function, no signature change, called with no arguments.

This is a bug fix, not new machinery. `revealInit()` already implements exactly the "staggered grid reveal" the spec asks for (a capped, cycling `transitionDelay` per `.reveal` element, driven by `IntersectionObserver`), but it only ever runs once per route change, before `bootBusinessData()` has inserted any real business cards into `#results`/`#featuredGrid`. Cards therefore render with `.reveal`'s default `opacity: 1; transform: none` and are never given the `.pre` starting state — they just appear instantly, with no fade or stagger at all.

- [ ] **Step 1: Re-run revealInit() after cards are inserted**

Find (`noor-business.html:1833-1842`):

```javascript
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
```

Replace with:

```javascript
  function renderListingCollections() {
    if (featuredGrid) {
      featuredGrid.innerHTML = LISTINGS.filter(function (l) { return l.featured; }).map(cardHtml).join("");
    }
    if (results) {
      results.innerHTML = LISTINGS.map(cardHtml).join("");
      sortResults();
      applyFilters();
    }
    revealInit();
  }
```

`revealInit()` is safe to call repeatedly — it disconnects any existing `IntersectionObserver` before creating a new one (`noor-business.html:2074`), so this doesn't leak observers or double-animate cards on subsequent calls (e.g. if listings ever reload).

- [ ] **Step 2: Verify in the browser**

Hard-reload `#/explore` (so cards load fresh, not from a warm cache) with the browser window tall enough that not all cards are visible on load. Expected: cards already in the initial viewport fade/rise in with a slight stagger between them (not all at once); cards below the fold fade in as you scroll to them, same as other `.reveal` elements on the page already do. Compare against current (pre-fix) behavior by checking out the previous commit in a separate worktree if you want a side-by-side — pre-fix, cards appear with zero animation, fully opaque immediately.

- [ ] **Step 3: Verify the home page featured grid too**

Reload `#/home`. Expected: the 3 featured cards also fade/stagger in the same way.

- [ ] **Step 4: Commit**

```bash
git add noor-business.html
git commit -m "fix: re-run reveal stagger after business cards load from Supabase"
```

---

### Task 5: Shimmering skeleton loaders

**Files:**
- Modify: `noor-business.html` — add new CSS rules (near the existing `.listing`/`.listing-art` rules, around line 375, is a sensible spot)
- Modify: `noor-business.html:1844-1854` (`bootBusinessData` function) and add one new helper function next to `cardHtml` (around line 1799)

**Interfaces:**
- Produces: `skeletonCardsHtml(count)` — takes a number, returns an HTML string of that many placeholder cards. Used only within `bootBusinessData`.

- [ ] **Step 1: Add the skeleton CSS**

Add these rules after the `.listing-art img` rule (`noor-business.html:375`):

```css
  .skeleton-card { pointer-events: none; }
  .skeleton-body { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .skeleton-line { height: 12px; border-radius: 6px; }
  .skeleton-line.w-60 { width: 60%; }
  .skeleton-line.w-90 { width: 90%; }
  .skeleton-shimmer {
    background: linear-gradient(90deg, var(--accent-soft) 25%, var(--surface-2) 50%, var(--accent-soft) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s ease-in-out infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton-shimmer { animation: none; background: var(--surface-2); }
  }
```

- [ ] **Step 2: Add the skeleton markup helper**

Find `function cardHtml(item) {` (`noor-business.html:1799`) and add this new function immediately before it:

```javascript
  function skeletonCardsHtml(count) {
    var card = '' +
      '<div class="listing skeleton-card">' +
        '<div class="listing-art skeleton-shimmer"></div>' +
        '<div class="skeleton-body">' +
          '<div class="skeleton-line skeleton-shimmer w-60"></div>' +
          '<div class="skeleton-line skeleton-shimmer w-90"></div>' +
        '</div>' +
      '</div>';
    return new Array(count).fill(card).join("");
  }

  function cardHtml(item) {
```

- [ ] **Step 3: Use it in bootBusinessData**

Find (`noor-business.html:1844-1846`):

```javascript
  async function bootBusinessData() {
    if (featuredGrid) featuredGrid.innerHTML = '<p style="color:var(--muted)">Loading listings...</p>';
    if (results) results.innerHTML = '<p style="color:var(--muted)">Loading listings...</p>';
```

Replace with:

```javascript
  async function bootBusinessData() {
    if (featuredGrid) featuredGrid.innerHTML = skeletonCardsHtml(3);
    if (results) results.innerHTML = skeletonCardsHtml(6);
```

- [ ] **Step 4: Verify in the browser**

Reload `#/explore`. You'll likely need to throttle the network in devtools (Network tab → set throttling to "Slow 4G") to see the loading state clearly, since Supabase usually responds fast on localhost. Expected: 6 placeholder card shapes appear immediately in the results grid, each with a soft gradient sweeping across it on a loop, sized and spaced like real cards. When data arrives, they're replaced by the real cards (no flash of empty content in between). Repeat for `#/home` and confirm 3 skeleton cards in the featured grid.

- [ ] **Step 5: Verify reduced motion**

Emulate `prefers-reduced-motion: reduce`, throttle the network, reload. Expected: the placeholder shapes still show, but as a flat static tint with no moving sweep.

- [ ] **Step 6: Commit**

```bash
git add noor-business.html
git commit -m "feat: replace plain loading text with shimmering skeleton cards"
```

---

### Task 6: Image zoom on card hover

**Files:**
- Modify: `noor-business.html:358` (`.listing:hover` rule)
- Modify: `noor-business.html:375` (`.listing-art img` rule)

**Interfaces:** None.

- [ ] **Step 1: Make the image transform smoothly, then scale it on card hover**

Find (`noor-business.html:375`):

```css
  .listing-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
```

Replace with:

```css
  .listing-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; transition: transform 0.4s ease; }
```

Find (`noor-business.html:358`):

```css
  .listing:hover { transform: translateY(-4px); border-color: var(--sage); box-shadow: 0 22px 44px -26px rgba(var(--shadow-color) / 0.45); }
```

Replace with:

```css
  .listing:hover { transform: translateY(-4px); border-color: var(--sage); box-shadow: 0 22px 44px -26px rgba(var(--shadow-color) / 0.45); }
  .listing:hover .listing-art img { transform: scale(1.05); }
```

`.listing-art` already has `overflow: hidden` (`noor-business.html:357`, the shared card rule), so the scaled image can't spill past the card's rounded corners — no other change needed.

- [ ] **Step 2: Verify in the browser**

Reload `#/explore`, hover over "Test Bakery Two" (the listing with an uploaded photo). Expected: the whole card lifts slightly (existing behavior) *and* the photo inside slowly zooms in a touch, clipped cleanly at the card's rounded corners with no overflow. Move the mouse away: the photo eases back to its normal size.

- [ ] **Step 3: Commit**

```bash
git add noor-business.html
git commit -m "feat: zoom listing photo slightly on card hover"
```

---

### Task 7: Bolder hero pattern presence

**Files:**
- Modify: `noor-business.html:313` (`.hero-visual .pattern-bg` rule)

**Interfaces:** None.

- [ ] **Step 1: Add a hero-specific pattern override**

Find (`noor-business.html:313`):

```css
  .hero-visual .pattern-bg { position: absolute; inset: 0; border-radius: 24px; }
```

Replace with:

```css
  .hero-visual .pattern-bg { position: absolute; inset: 0; border-radius: 24px; }
  .hero-visual .pattern-bg::before { background-size: 140px 140px; opacity: calc(var(--pattern-opacity) * 1.6); }
```

This only overrides the hero's own `.pattern-bg::before` (via the more specific `.hero-visual` ancestor selector) — the shared rule at `noor-business.html:161-163` that every other `.pattern-bg` usage (About's "why we started" section, the Contact page photo, the home "built for this community" section) relies on is untouched, so their pattern stays at the current subtle scale.

- [ ] **Step 2: Verify in the browser, both themes**

Reload `#/home`. Expected: the geometric star pattern behind the hero photo is now clearly visible at a glance — larger tiles, more present — without overpowering the photo itself (the photo still reads as the focal point). Toggle to dark mode and confirm the pattern is still visibly present there too, just at the theme's existing lower `--pattern-opacity` baseline (0.22 dark vs 0.45 light) times the same 1.6 multiplier.

- [ ] **Step 3: Verify other pattern-bg usages are unaffected**

Visit `#/about` and `#/contact`. Expected: the pattern behind those sections' photos looks exactly as it did before this task — small, subtle tiling, not the bolder hero treatment.

- [ ] **Step 4: Commit**

```bash
git add noor-business.html
git commit -m "feat: give the hero's geometric pattern more visual presence"
```

---

### Task 8: Reuse the star-divider motif on the About page

**Files:**
- Modify: `noor-business.html:1170-1172` (insert between the "Why we started" and "What we hold ourselves to" sections)

**Interfaces:** None — reuses the existing `.star-divider` markup pattern verbatim (already styled by CSS at `noor-business.html:455-457`, already has an `#i-star-mark` SVG symbol defined in the icon sprite).

The spec explicitly allows skipping this on pages with no natural seam. Explore is a single continuous browsing section (filters + results) and Contact is a single form-plus-info section — neither has a real topic change to mark, so forcing a divider onto either would be arbitrary. About does have one: the transition from "Why we started" (the founding story, with a photo) to "What we hold ourselves to" (the values list) is a genuine shift in topic, structurally identical to Home's category-browse → three-steps transition where the divider already exists. This task adds it there only.

- [ ] **Step 1: Insert the divider**

Find (`noor-business.html:1170-1172`):

```html
      </div>
    </section>

    <section>
      <div class="wrap">
        <div class="section-head"><h2>What we hold ourselves to.</h2></div>
```

Replace with:

```html
      </div>
    </section>

    <div class="star-divider" aria-hidden="true">
      <svg viewBox="0 0 100 100"><use href="#i-star-mark"/></svg>
      <svg viewBox="0 0 100 100"><use href="#i-star-mark"/></svg>
      <svg viewBox="0 0 100 100"><use href="#i-star-mark"/></svg>
      <svg viewBox="0 0 100 100" class="mark"><use href="#i-star-mark"/></svg>
      <svg viewBox="0 0 100 100"><use href="#i-star-mark"/></svg>
      <svg viewBox="0 0 100 100"><use href="#i-star-mark"/></svg>
      <svg viewBox="0 0 100 100"><use href="#i-star-mark"/></svg>
    </div>

    <section>
      <div class="wrap">
        <div class="section-head"><h2>What we hold ourselves to.</h2></div>
```

- [ ] **Step 2: Verify in the browser**

Reload `#/about`. Expected: a row of small star-mark icons (matching the ones already on the home page, between "Explore by category" and "Finding the right place takes three steps") now appears between the founding-story section and the values-list section. Confirm it renders identically in both light and dark mode (the icons use `var(--sage)`/`var(--accent)`, which already have both-mode values defined).

- [ ] **Step 3: Commit**

```bash
git add noor-business.html
git commit -m "feat: reuse the star-divider motif on the About page"
```

---

### Task 9: Full sitewide verification pass

**Files:** None modified — this task is verification-only, covering the combined result of Tasks 1-8.

- [ ] **Step 1: Light/dark mode sweep**

Serve the site locally. In light mode, visit every page (`#/home`, `#/explore`, `#/about`, `#/faq`, `#/contact`, `#/list`, `#/account`) and confirm nothing looks broken (no missing patterns, no stray skeleton shimmer left on-screen after load, no layout shift from the new CSS). Toggle to dark mode and repeat the same sweep.

- [ ] **Step 2: Desktop and mobile widths**

Resize the browser to a mobile width (or use devtools device emulation at 375px). Re-check: nav-link underline doesn't apply to the mobile panel's stacked links (they don't need it — confirm the mobile panel still looks and behaves as before, since Task 1 only touched `.nav-links a`, not `.mobile-panel a`); staggered card reveal still looks reasonable in a single-column mobile grid; skeleton cards still match real card proportions at mobile width; save-button press feedback still works via touch (tap and hold briefly in devtools' touch emulation, or on an actual phone if available).

- [ ] **Step 3: `prefers-reduced-motion` sweep**

With reduced motion emulated, re-visit `#/home` and `#/explore` once more. Confirm: no staggered delay on card reveal (all appear together, or instantly — check the existing `.reveal, .reveal.pre { transition: none !important; }` rule at `noor-business.html:265` already forces this for the reveal system generally), no shimmer sweep on skeletons (flat tint instead, per Task 5 Step 5), theme toggle switches instantly with no cross-fade (per Task 3 Step 4).

- [ ] **Step 4: Re-run the anti-slop checklist from the earlier taste-skill audit**

Confirm this pass didn't introduce any of the patterns flagged earlier this project: still exactly one accent color used consistently (the new hover/focus states all use `var(--accent)` or `var(--accent-soft)`, no new colors introduced), still one consistent shape system (no new border-radius values introduced outside the existing pill/18px/12px scale), no new em-dashes, no decorative elements added that don't serve a real structural purpose.

- [ ] **Step 5: Final commit (if any fixups were needed)**

If Steps 1-4 surfaced anything, fix it and commit with a message describing what was fixed. If everything already passed, no commit is needed for this task — it's verification, not new code.

---

## Self-Review Notes

**Spec coverage:** Section 1 (global micro-interactions) → Tasks 1-3. Section 2 (card reveal/skeleton/zoom) → Tasks 4-6. Section 3 (pattern expansion) → Tasks 7-8 (card-ornament item already satisfied pre-session, documented in "Pre-existing state" rather than given a task — see that section for why). Section 4 (testing approach) → Task 9, plus a testing step folded into every individual task per this repo's established pattern.

**Placeholder scan:** No TBD/TODO/"add appropriate" phrasing. Every step shows the actual before/after code.

**Type/name consistency:** `revealInit()`, `renderListingCollections()`, `bootBusinessData()`, `cardHtml()`, `toggleTheme()`, `reduceMotion`, `THEME_KEY` are all pre-existing names used exactly as they already appear in the file — no renames. The one new function this plan introduces, `skeletonCardsHtml(count)`, is defined in Task 5 Step 2 and consumed only in Task 5 Step 3 — single definition, single call site, no naming drift.

**Deviation from spec, flagged explicitly:** The spec's Problem section states "almost nothing responds to interaction" — planning-time investigation found this overstated: button squish, toggle-pill transitions, and the reveal/stagger mechanism already existed before this session. The spec's *goals* (site-wide micro-interactions, pattern-driven identity) are unaffected and fully covered above; only the *severity of the starting gap* was smaller than described. Flagging this here rather than silently shrinking the plan, consistent with how this project's owner-accounts plan flagged its own mid-planning discovery.
