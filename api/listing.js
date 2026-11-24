// api/listing.js  (served at /b/<id> via a rewrite in vercel.json)
// A real, crawlable page for each approved listing. The main app is a
// hash-routed single page, so individual businesses had no URL Google could
// index or a person could share. This renders the essentials as plain HTML
// (with title, description, Open Graph and schema.org JSON-LD) and links
// into the full app.
var supa = require("./_lib/supa");
var h = require("./_lib/html");
var hoursLib = require("../js/hours");

var SITE = (process.env.SITE_URL || "https://noorbusiness.org").replace(/\/$/, "");

// The site-wide share card, sized for link previews (1200x630).
var DEFAULT_CARD = { url: SITE + "/images/og-image.jpg", width: 1200, height: 630, alt: "NICC Business: Muslim-owned businesses in Columbus, Ohio" };

// card: { title, url, width?, height?, alt } for the link preview that
// WhatsApp, iMessage, Facebook, X and Slack show when the page is shared.
function page(title, desc, canonical, card, jsonLd, body, status) {
  card = card || {};
  var image = card.url || DEFAULT_CARD.url;
  var shareTitle = card.title || title;
  return { status: status || 200, html: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + h.esc(title) + "</title>" +
    '<meta name="description" content="' + h.esc(desc) + '">' +
    '<link rel="canonical" href="' + h.esc(canonical) + '">' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="NICC Business"><meta property="og:locale" content="en_US">' +
    '<meta property="og:title" content="' + h.esc(shareTitle) + '"><meta property="og:description" content="' + h.esc(desc) + '">' +
    '<meta property="og:url" content="' + h.esc(canonical) + '"><meta property="og:image" content="' + h.esc(image) + '">' +
    (card.width && card.height ? '<meta property="og:image:width" content="' + card.width + '"><meta property="og:image:height" content="' + card.height + '">' : "") +
    '<meta property="og:image:alt" content="' + h.esc(card.alt || DEFAULT_CARD.alt) + '">' +
    '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + h.esc(shareTitle) + '">' +
    '<meta name="twitter:description" content="' + h.esc(desc) + '"><meta name="twitter:image" content="' + h.esc(image) + '">' +
    '<meta name="twitter:image:alt" content="' + h.esc(card.alt || DEFAULT_CARD.alt) + '">' +
    [].concat(jsonLd || []).map(function (ld) { return '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, "\\u003c") + "</script>"; }).join("") +
    "<style>:root{color-scheme:light;--bg:#fbfaf5;--ink:#1d2410;--muted:#5d6650;--accent:#4c5f26;--card:#fff;--line:#dfe3d0}" +
    "body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}" +
    "main{max-width:720px;margin:0 auto;padding:32px 16px 64px}a{color:var(--accent)}" +
    "h1{font-size:2rem;line-height:1.15;margin:.2em 0 .1em;text-wrap:balance}.meta{color:var(--muted);margin:0 0 20px}" +
    ".card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin:16px 0}" +
    ".cta{display:inline-block;background:var(--accent);color:var(--bg);padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700}" +
    "img{max-width:100%;border-radius:14px}ul{padding-left:1.1em}h2{font-size:1.15rem;margin:1.4em 0 .4em}</style></head><body><main>" +
    '<p><a href="/">&larr; NICC Business</a></p>' + body + "</main></body></html>" };
}

var SCHEMA_TYPE = {
  "Restaurants": "Restaurant", "Grocery": "GroceryStore", "Modest Wear": "ClothingStore",
  "Health & Wellness": "HealthAndBeautyBusiness", "Professional Services": "ProfessionalService",
  "Education": "EducationalOrganization", "Home & Living": "HomeGoodsStore", "Auto & Repair": "AutoRepair"
};
var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(min) {
  min = min % 1440;
  var hh = Math.floor(min / 60), mm = min % 60;
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
}

// The free-text hours owners type, as schema.org OpeningHoursSpecification.
// Rows that can't be read are left out rather than guessed at.
function openingHours(hours) {
  var out = [];
  (Array.isArray(hours) ? hours : []).forEach(function (row) {
    if (!Array.isArray(row)) return;
    var days = hoursLib.parseDays(row[0]), t = hoursLib.parseTimes(row[1]);
    if (!days || !t || t.closed) return;
    t.ranges.forEach(function (r) {
      out.push({ "@type": "OpeningHoursSpecification",
        dayOfWeek: days.map(function (d) { return DAY_NAMES[d]; }),
        opens: clock(r[0]), closes: r[1] >= 1440 && r[1] % 1440 === 0 ? "23:59" : clock(r[1]) });
    });
  });
  return out;
}

function related(b, others) {
  var list = (others || []).filter(function (o) { return o.id !== b.id; });
  var same = list.filter(function (o) { return o.neighborhood === b.neighborhood; });
  var rest = list.filter(function (o) { return o.neighborhood !== b.neighborhood; });
  return same.concat(rest).slice(0, 5);
}

function render(b, reviews, others) {
  var url = SITE + "/b/" + b.id;
  var photo = h.safeHttps(b.photo_url);
  var site = h.safeHttps(b.website);
  var ratings = reviews.map(function (r) { return r.rating; });
  var avg = ratings.length ? ratings.reduce(function (a, c) { return a + c; }, 0) / ratings.length : null;
  var jsonLd = { "@context": "https://schema.org", "@type": SCHEMA_TYPE[b.category] || "LocalBusiness", "@id": url + "#business",
    name: b.name, description: b.description, url: url, areaServed: { "@type": "City", name: "Columbus, Ohio" } };
  if (photo) jsonLd.image = photo;
  if (b.phone) jsonLd.telephone = b.phone;
  if (site) jsonLd.sameAs = [site];
  if (b.address) jsonLd.address = { "@type": "PostalAddress", streetAddress: b.address, addressLocality: "Columbus", addressRegion: "OH", addressCountry: "US" };
  if (typeof b.lat === "number" && typeof b.lng === "number") jsonLd.geo = { "@type": "GeoCoordinates", latitude: b.lat, longitude: b.lng };
  var spec = openingHours(b.hours);
  if (spec.length) jsonLd.openingHoursSpecification = spec;
  if (avg != null) jsonLd.aggregateRating = { "@type": "AggregateRating", ratingValue: avg.toFixed(1), reviewCount: ratings.length };
  var crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "NICC Business", item: SITE + "/" },
    { "@type": "ListItem", position: 2, name: b.category, item: SITE + "/#/explore" },
    { "@type": "ListItem", position: 3, name: b.name, item: url }] };

  var mapsUrl = typeof b.lat === "number" && typeof b.lng === "number"
    ? "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(b.lat + "," + b.lng)
    : b.address ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(b.name + " " + b.address) : null;
  var phoneDigits = b.phone ? String(b.phone).replace(/[^\d+]/g, "") : "";
  var hoursRows = (Array.isArray(b.hours) ? b.hours : []).filter(function (r) { return Array.isArray(r) && r[0] && r[1]; });
  var more = related(b, others);
  // "Columbus (Northland)" already names the city; suburbs like "Dublin" get ", Columbus".
  var place = /\bcolumbus\b/i.test(String(b.neighborhood || "")) ? String(b.neighborhood) : b.neighborhood + ", Columbus";

  var body = (photo ? '<img src="' + h.esc(photo) + '" alt="' + h.esc(b.name) + '" width="720" height="405">' : "") +
    "<h1>" + h.esc(b.name) + '</h1><p class="meta">' + h.esc(b.category) + " in " + h.esc(place) + ", Ohio" +
    (avg != null ? " &middot; " + avg.toFixed(1) + " &#9733; (" + ratings.length + ")" : "") + "</p>" +
    '<div class="card"><p>' + h.esc(b.long_description) + "</p></div>" +
    '<div class="card"><ul>' +
    (b.address ? "<li>Address: " + h.esc(b.address) + (mapsUrl ? ' (<a href="' + h.esc(mapsUrl) + '" data-ev="directions" rel="noopener nofollow">Directions</a>)' : "") + "</li>" : "") +
    (b.phone ? "<li>Phone: " + (phoneDigits ? '<a href="tel:' + h.esc(phoneDigits) + '" data-ev="phone">' + h.esc(b.phone) + "</a>" : h.esc(b.phone)) + "</li>" : "") +
    (site ? '<li>Website: <a href="' + h.esc(site) + '" data-ev="website" rel="noopener nofollow">' + h.esc(site) + "</a></li>" : "") +
    "</ul></div>" +
    (hoursRows.length ? '<div class="card"><h2>Hours</h2><ul>' + hoursRows.map(function (r) { return "<li>" + h.esc(r[0]) + ": " + h.esc(r[1]) + "</li>"; }).join("") + "</ul></div>" : "") +
    '<p><a class="cta" href="/#/explore?open=' + h.esc(b.id) + '">See reviews &amp; more</a></p>' +
    '<div class="card"><strong>Is this your business?</strong> <a href="/#/explore?open=' + h.esc(b.id) + '">Claim it</a> to keep the details up to date. ' +
    'Spot something wrong? <a href="/#/explore?open=' + h.esc(b.id) + '">Report wrong info</a> and a volunteer will check it.</div>' +
    (more.length ? '<h2>More Muslim-owned businesses in Columbus</h2><ul>' + more.map(function (o) {
      return '<li><a href="/b/' + h.esc(o.id) + '">' + h.esc(o.name) + "</a> &middot; " + h.esc(o.category) + ", " + h.esc(o.neighborhood) + "</li>";
    }).join("") + "</ul>" : "") +
    // Counts a view and clicks on the links above, from the browser only, so
    // crawlers that load the page without running it aren't counted. Skipped
    // for Do Not Track, automated browsers and the site's own team (flag set
    // when they open the moderation page). Same-origin, no cookies, nothing
    // about the visitor is sent (see api/track.js).
    '<script>(function(){var id="' + h.esc(b.id) + '";function ok(){try{if(navigator.doNotTrack==="1"||navigator.webdriver||!navigator.sendBeacon)return false;' +
    'if(localStorage.getItem("nb_team")==="1")return false;}catch(e){}return true;}' +
    'function send(ev){if(ok())navigator.sendBeacon("/api/track",new Blob([JSON.stringify({id:id,event:ev})],{type:"application/json"}));}' +
    'send("view");document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-ev]");if(a)send(a.getAttribute("data-ev"));});})();</script>';
  var title = b.name + " \u2014 " + b.category + " in " + place + " | NICC Business";
  var desc = String(b.description || "");
  if (desc.length > 155) desc = desc.slice(0, 152).replace(/\s+\S*$/, "") + "\u2026";
  // Share card: the listing's own photo when it has one, else the site card.
  var card = photo
    ? { url: photo, alt: "Photo of " + b.name }
    : { url: DEFAULT_CARD.url, width: DEFAULT_CARD.width, height: DEFAULT_CARD.height, alt: DEFAULT_CARD.alt };
  card.title = b.name + " \u00b7 " + b.category + " in " + place;
  return page(title, desc, url, card, [jsonLd, crumbs], body);
}

module.exports = async function handler(req, res) {
  var id = String((req.query && req.query.id) || "");
  var out;
  if (!h.UUID_RE.test(id)) {
    out = page("Listing not found | NICC Business", "This listing could not be found.", SITE + "/", null, null,
      '<h1>Listing not found</h1><p><a href="/noor-business.html#/explore">Browse the directory</a></p>', 404);
  } else {
    var b = await supa.rest("businesses?select=*&status=eq.approved&id=eq." + id);
    if (!b.ok || !Array.isArray(b.data) || !b.data[0]) {
      out = page("Listing not found | NICC Business", "This listing could not be found.", SITE + "/", null, null,
        '<h1>Listing not found</h1><p><a href="/noor-business.html#/explore">Browse the directory</a></p>', 404);
    } else {
      var rv = await supa.rest("reviews?select=rating&status=eq.approved&business_id=eq." + id);
      var ot = await supa.rest("businesses?select=id,name,category,neighborhood&status=eq.approved&order=name.asc&limit=200");
      out = render(b.data[0], rv.ok && Array.isArray(rv.data) ? rv.data : [], ot.ok && Array.isArray(ot.data) ? ot.data : []);
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  res.status(out.status).send(out.html);
};
module.exports._test = { render: render };
