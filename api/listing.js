// api/listing.js  (served at /b/<id> via a rewrite in vercel.json)
// A real, crawlable page for each approved listing. The main app is a
// hash-routed single page, so individual businesses had no URL Google could
// index or a person could share. This renders the essentials as plain HTML
// (with title, description, Open Graph and schema.org JSON-LD) and links
// into the full app.
var supa = require("./_lib/supa");
var h = require("./_lib/html");

var SITE = (process.env.SITE_URL || "https://nicc-business.vercel.app").replace(/\/$/, "");

function page(title, desc, canonical, image, jsonLd, body, status) {
  return { status: status || 200, html: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + h.esc(title) + "</title>" +
    '<meta name="description" content="' + h.esc(desc) + '">' +
    '<link rel="canonical" href="' + h.esc(canonical) + '">' +
    '<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="NICC Business">' +
    '<meta property="og:title" content="' + h.esc(title) + '"><meta property="og:description" content="' + h.esc(desc) + '">' +
    '<meta property="og:url" content="' + h.esc(canonical) + '"><meta property="og:image" content="' + h.esc(image) + '">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    (jsonLd ? '<script type="application/ld+json">' + JSON.stringify(jsonLd).replace(/</g, "\\u003c") + "</script>" : "") +
    "<style>:root{color-scheme:light;--bg:#fbfaf5;--ink:#1d2410;--muted:#5d6650;--accent:#4c5f26;--card:#fff;--line:#dfe3d0}" +
    "body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}" +
    "main{max-width:720px;margin:0 auto;padding:32px 16px 64px}a{color:var(--accent)}" +
    "h1{font-size:2rem;line-height:1.15;margin:.2em 0 .1em;text-wrap:balance}.meta{color:var(--muted);margin:0 0 20px}" +
    ".card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin:16px 0}" +
    ".cta{display:inline-block;background:var(--accent);color:var(--bg);padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700}" +
    "img{max-width:100%;border-radius:14px}ul{padding-left:1.1em}</style></head><body><main>" +
    '<p><a href="/">&larr; NICC Business</a></p>' + body + "</main></body></html>" };
}

function render(b, reviews) {
  var url = SITE + "/b/" + b.id;
  var photo = h.safeHttps(b.photo_url);
  var site = h.safeHttps(b.website);
  var ratings = reviews.map(function (r) { return r.rating; });
  var avg = ratings.length ? ratings.reduce(function (a, c) { return a + c; }, 0) / ratings.length : null;
  var jsonLd = { "@context": "https://schema.org", "@type": "LocalBusiness", name: b.name, description: b.description, url: url };
  if (photo) jsonLd.image = photo;
  if (b.phone) jsonLd.telephone = b.phone;
  if (b.address) jsonLd.address = { "@type": "PostalAddress", streetAddress: b.address, addressLocality: "Columbus", addressRegion: "OH" };
  if (avg != null) jsonLd.aggregateRating = { "@type": "AggregateRating", ratingValue: avg.toFixed(1), reviewCount: ratings.length };

  var body = (photo ? '<img src="' + h.esc(photo) + '" alt="' + h.esc(b.name) + '" width="720" height="405">' : "") +
    "<h1>" + h.esc(b.name) + '</h1><p class="meta">' + h.esc(b.category) + " in " + h.esc(b.neighborhood) + ", Columbus, Ohio" +
    (avg != null ? " &middot; " + avg.toFixed(1) + " &#9733; (" + ratings.length + ")" : "") + "</p>" +
    '<div class="card"><p>' + h.esc(b.long_description) + "</p></div>" +
    '<div class="card"><ul>' +
    (b.address ? "<li>Address: " + h.esc(b.address) + "</li>" : "") +
    (b.phone ? "<li>Phone: " + h.esc(b.phone) + "</li>" : "") +
    (site ? '<li>Website: <a href="' + h.esc(site) + '" rel="noopener nofollow">' + h.esc(site) + "</a></li>" : "") +
    "</ul></div>" +
    '<p><a class="cta" href="/#/explore?open=' + h.esc(b.id) + '">See hours &amp; reviews</a></p>';
  return page(b.name + " — " + b.category + " in " + b.neighborhood + " | NICC Business", b.description, url, photo || SITE + "/images/hero.jpg", jsonLd, body);
}

module.exports = async function handler(req, res) {
  var id = String((req.query && req.query.id) || "");
  var out;
  if (!h.UUID_RE.test(id)) {
    out = page("Listing not found | NICC Business", "This listing could not be found.", SITE + "/", SITE + "/images/hero.jpg", null,
      '<h1>Listing not found</h1><p><a href="/noor-business.html#/explore">Browse the directory</a></p>', 404);
  } else {
    var b = await supa.rest("businesses?select=*&status=eq.approved&id=eq." + id);
    if (!b.ok || !Array.isArray(b.data) || !b.data[0]) {
      out = page("Listing not found | NICC Business", "This listing could not be found.", SITE + "/", SITE + "/images/hero.jpg", null,
        '<h1>Listing not found</h1><p><a href="/noor-business.html#/explore">Browse the directory</a></p>', 404);
    } else {
      var rv = await supa.rest("reviews?select=rating&status=eq.approved&business_id=eq." + id);
      out = render(b.data[0], rv.ok && Array.isArray(rv.data) ? rv.data : []);
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  res.status(out.status).send(out.html);
};
module.exports._test = { render: render };
