# Visual Polish & Motion Pass — Design Spec

Date: 2026-09-06
Status: Approved, ready for implementation planning

## Problem

The site (`noor-business.html`) works and already passed an anti-slop
audit (one accent color, one shape system, restrained motion, real
photography where it exists), but it feels static and generic. Two
specific gaps, from the user directly:

1. Almost nothing responds to interaction beyond an instant color
   change — no hover feedback on nav links, no press feedback on
   buttons, cards blink into existence as a single block, the
   light/dark theme toggle snaps instead of transitioning, category
   pills and the search bar don't acknowledge focus/selection with any
   motion.
2. The site's visual identity leans entirely on a stock cityscape photo
   reused across several sections, with no distinctly Islamic visual
   character. Real photography of the actual businesses/community
   isn't available in this environment (no image generation or
   themed-stock-search tool), and generic "Islamic-themed" stock photos
   would be inauthentic filler, not real representation of this
   specific community. The site already has real ingredients for
   identity that don't depend on photography: an 8-point star/khatim
   geometric pattern (already the brand's visual system, per the CSS's
   own `Identity: the 8-point star (khatim)...` comment) and a
   `star-divider` motif, both currently used once, faintly.

## Goals

- Add tasteful, motivated micro-interactions throughout the site
  (nav, buttons, pills, search, cards, theme toggle) so the whole
  site feels alive and responsive, not just the pages touched in
  earlier sessions.
- Make the geometric pattern/khatim motif a bigger, more deliberate
  part of the site's visual identity, standing in for the "more
  Islamic" character the user wants, without introducing new
  photography this session can't source authentically.
- Do all of this within the existing constraints: single static HTML
  file, no build step, no framework, no new dependencies beyond what's
  already loaded (fonts, Supabase SDK).

## Non-goals

- No new photography, no stock-photo replacement for the existing 5
  extracted photos (`images/*.jpg`) — those stay as user-swappable
  files per the earlier photo-extraction work.
- No scroll-hijacking, parallax, or GSAP-style choreography. This
  stays in the "fluid CSS" motion band (transitions, keyframes,
  `:hover`/`:active`/`:focus-within`), consistent with a trust-first
  civic directory, not an agency portfolio.
- No new JS libraries or CDN scripts for animation. Everything is
  achievable with CSS transitions/keyframes plus the same vanilla JS
  patterns already in the file (the existing `reveal` +
  `IntersectionObserver` system, the boot sequence, per-item render
  functions).

## Design

### 1. Global micro-interactions

Applied wherever the relevant element/class already exists sitewide —
no new markup required for most of these, just new CSS rules (and one
small JS addition for the theme-toggle transition scoping):

- **Buttons** (`.btn`, `.save-btn`, filter pills, view-toggle buttons):
  add `:active { transform: scale(0.97) }` alongside the existing
  hover lift, with `transition` covering `transform` so the press
  reads as a deliberate squish, not a snap.
- **Category/filter pills**: `transition: background-color 0.2s ease,
  color 0.2s ease` so selecting a pill fades its fill in.
- **Search bar fields** (`.search-field`): on `:focus-within`,
  transition the existing highlight tint and grow a subtle
  `box-shadow`, via `transition: all 0.3s ease`. (Not doing the
  "icon slides aside" detail from the user's reference list — the
  icon is part of the label, not overlapping the caret, so that move
  wouldn't be functional here, just decorative for its own sake.)
- **Theme toggle**: scope a `transition: background-color 0.25s ease,
  border-color 0.25s ease, color 0.25s ease` to the elements that
  carry theme-driven colors (surfaces, text, borders, badges) so
  toggling `data-theme` cross-fades instead of snapping. Explicitly
  excludes `img`/`svg.icon` content so photos and icons don't
  visually "fade" as if they were theme-colored (they aren't).
- **Nav links** (desktop `.nav-links a`, mobile panel links): replace
  the current instant `color` change on hover/focus with an animated
  underline that grows in from the center, using a `::after`
  pseudo-element scaled via `transform: scaleX()` and `transition:
  transform 0.25s ease` — this is the effect the user described
  wanting under "Home / Explore / About."

### 2. Card & content reveal

- **Staggered grid reveal**: cards already fade up via the existing
  `.reveal` class driven by `IntersectionObserver` (see
  `revealInit()`). Extend `cardHtml()` to emit an inline `style="--i:
  N"` per card (N = its index in the rendered list), and add
  `transition-delay: calc(var(--i) * 0.05s)` to `.reveal` so a grid of
  cards cascades rather than fading in as one block. This is an
  extension of the existing reveal system, not a new one.
- **Skeleton loaders**: replace the current plain "Loading
  listings..." text (in `bootBusinessData()`) with a small number of
  placeholder card shapes — matching the real card's block layout
  (image area, title bar, two text lines) — filled with a CSS
  `@keyframes shimmer` sweep (a moving gradient) instead of a flat
  color. Swapped for real cards the moment Supabase data arrives, same
  as today.
- **Image zoom on hover**: `.listing:hover .listing-art img { transform:
  scale(1.05) }`. `.listing-art` already clips overflow, so this is a
  small addition, not a restructure.
- **Connective detail**: the skeleton shimmer uses the sage/olive
  brand tint rather than generic gray, so the loading state reads as
  this site's own rather than a stock component.

### 3. Geometric pattern expansion (identity, not photography)

- **Bolder hero presence**: the pattern (`--pattern` CSS var, already
  an inline SVG data URI of the khatim construction) currently sits
  behind the hero photo at low opacity as a background wash. Increase
  its scale and opacity in the hero specifically so it reads as a
  deliberate decorative layer, not a texture easy to miss.
- **Consistent section-transition device**: the `star-divider` element
  (a row of small star-mark icons) currently appears exactly once, on
  the home page between the category section and the steps section.
  Add it consistently as the site's "how we mark a section change"
  motif on the About, Explore, and Contact pages too, at equivalent
  structural transitions — turning a one-off flourish into a
  recognizable rhythm.
- **Card ornament for photo-less listings**: businesses without an
  uploaded photo show a plain icon in a circle on a flat tinted
  background (`.listing-art .art-badge`). Add a subtle instance of the
  same `--pattern` background (already used elsewhere at low opacity)
  behind the icon at card scale, so the "no photo yet" state carries
  the same visual language instead of feeling like a bare placeholder.

### 4. Testing approach

No automated suite exists for this project (established, accepted
constraint) — verification is manual, via a local static server and
real browser checks, covering:

- Light and dark mode for every new visual (theme-toggle transition
  itself, pattern opacity/scale in each mode, skeleton shimmer tint).
- Desktop and mobile widths (staggered-reveal timing feels right at
  both grid densities; touch targets for pills/buttons unaffected by
  the new `:active` transform).
- `prefers-reduced-motion`: every new animation (staggered delay,
  shimmer, hover/press transforms, underline growth) collapses to
  instant/static under this setting, consistent with how the existing
  reveal system already behaves.
- A final pass against the taste-skill anti-slop checklist from the
  earlier audit this session (one accent color, one shape system, no
  new AI-tell patterns introduced) so this pass doesn't undo that
  work.

## Open risk / judgment calls for implementation

- Exact easing curves, shimmer speed, and pattern opacity/scale values
  are implementation-time judgment calls, tuned by eye against the
  existing design tokens (the CSS already defines `--pattern-opacity`
  per light/dark mode) — not fixed numbers in this spec.
- "Equivalent structural transitions" for the star-divider on About/
  Explore/Contact means wherever those pages have a comparable
  section-to-section seam to Home's category-to-steps transition;
  the implementer should use judgment per page rather than force a
  divider onto a page that has no natural seam for it.
