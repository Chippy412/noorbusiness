// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");

function mockRes() {
  const res = { headers: {}, code: null, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

test("html.esc escapes markup and quotes", () => {
  const { esc } = require("../api/_lib/html");
  assert.strictEqual(esc(`<img src=x onerror="a('b')">`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;");
});

test("html.safeHttps only allows https", () => {
  const { safeHttps } = require("../api/_lib/html");
  assert.ok(safeHttps("https://example.com/a"));
  assert.strictEqual(safeHttps("http://example.com"), null);
  assert.strictEqual(safeHttps("javascript:alert(1)"), null);
  assert.strictEqual(safeHttps("not a url"), null);
});

test("listing page escapes owner-controlled fields and drops unsafe urls", () => {
  const { render } = require("../api/listing")._test;
  const out = render({
    id: "11111111-1111-1111-1111-111111111111",
    name: `Evil </title><script>alert(1)</script>`,
    category: "Restaurants", neighborhood: "Dublin",
    description: `"><img src=x onerror=alert(1)>`, long_description: "<b>hi</b>",
    address: "1 Main St", phone: "614", website: "javascript:alert(1)", photo_url: "http://insecure.example/x.jpg"
  }, [{ rating: 5 }, { rating: 4 }]);
  assert.ok(!out.html.includes("<script>alert(1)"));
  assert.ok(!out.html.includes("<img src=x"));
  assert.ok(!out.html.includes("javascript:alert"));
  assert.ok(!out.html.includes("insecure.example"));
  assert.ok(out.html.includes("4.5"));
  assert.ok(out.html.includes('"ratingValue":"4.5"'));
});

test("listing route 404s on a malformed id without hitting the database", async () => {
  const handler = require("../api/listing");
  const res = mockRes();
  await handler({ query: { id: "../etc/passwd" } }, res);
  assert.strictEqual(res.code, 404);
});

test("submit: wrong method, missing service key, bad input", async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const handler = require("../api/submit");
  let res = mockRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.strictEqual(res.code, 405);

  res = mockRes();
  await handler({ method: "POST", headers: {}, body: { type: "contact" } }, res);
  assert.strictEqual(res.code, 503); // not configured -> the page falls back

  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  res = mockRes();
  await handler({ method: "POST", headers: {}, body: { type: "contact", name: "A", email: "nope", message: "hi" } }, res);
  assert.strictEqual(res.code, 400);

  res = mockRes();
  await handler({ method: "POST", headers: {}, body: { type: "subscribe", email: "a@b.co", company: "bot" } }, res);
  assert.strictEqual(res.code, 200); // honeypot: silent success, nothing stored
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test("submit: contact is rejected without a Turnstile token when Turnstile is configured", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.TURNSTILE_SECRET_KEY = "secret";
  const handler = require("../api/submit");
  const res = mockRes();
  await handler({ method: "POST", headers: {}, body: { type: "contact", name: "A", email: "a@b.co", message: "hi" } }, res);
  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.body.error, "captcha");
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

test("notify rejects requests without the shared secret", async () => {
  process.env.NOTIFY_SECRET = "s3cret";
  const handler = require("../api/notify");
  let res = mockRes();
  await handler({ method: "POST", headers: {}, body: {} }, res);
  assert.strictEqual(res.code, 401);
  res = mockRes();
  await handler({ method: "POST", headers: { authorization: "Bearer wrong" }, body: {} }, res);
  assert.strictEqual(res.code, 401);
  delete process.env.NOTIFY_SECRET;
});

test("verify-turnstile survives a malformed JSON body", async () => {
  process.env.TURNSTILE_SECRET_KEY = "secret";
  const handler = require("../api/verify-turnstile");
  const res = mockRes();
  await handler({ method: "POST", headers: {}, body: "{not json" }, res);
  assert.strictEqual(res.code, 400);
  delete process.env.TURNSTILE_SECRET_KEY;
});

test("notify skips updates except for queued listing edits", async () => {
  process.env.NOTIFY_SECRET = "s3cret";
  process.env.RESEND_API_KEY = "k"; process.env.NOTIFY_EMAIL_TO = "a@b.co"; process.env.NOTIFY_EMAIL_FROM = "x <x@y.co>";
  const handler = require("../api/notify");
  const res = mockRes();
  await handler({ method: "POST", headers: { authorization: "Bearer s3cret" },
    body: { type: "UPDATE", table: "reviews", record: { status: "pending" } } }, res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, true);
  for (const k of ["NOTIFY_SECRET", "RESEND_API_KEY", "NOTIFY_EMAIL_TO", "NOTIFY_EMAIL_FROM"]) delete process.env[k];
});

test("notify summarises a queued listing edit", () => {
  const { summarize } = require("../api/notify")._test;
  const text = summarize("business_edits", { business_id: "abc", changes: { description: "x", phone: "y" } });
  assert.ok(text.includes("abc"));
  assert.ok(text.includes("description, phone"));
});

test("submit rejects contact emails that could inject into a mailto: link", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  const handler = require("../api/submit");
  for (const email of ["x?bcc=evil@evil.com@example.com", "a&b@example.com", "a@b.co?subject=x", "<a@b.co>", "a b@c.co"]) {
    const res = mockRes();
    await handler({ method: "POST", headers: {}, body: { type: "contact", name: "A", email, message: "hi" } }, res);
    assert.strictEqual(res.code, 400, email);
  }
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test("alerts go to the whole team only once a real sender is set up", async () => {
  const { recipients } = require("../api/notify")._test;
  const team = async () => ["mod@noor.org", "Me@Gmail.com", "vol@noor.org"];
  assert.deepStrictEqual(
    await recipients({ NOTIFY_EMAIL_TO: "me@gmail.com", NOTIFY_EMAIL_FROM: "NICC Business <onboarding@resend.dev>" }, team),
    ["me@gmail.com"], "Resend's test sender must not get extra recipients");
  assert.deepStrictEqual(
    await recipients({ NOTIFY_EMAIL_TO: "me@gmail.com", NOTIFY_EMAIL_FROM: "NICC Business <alerts@updates.noorohio.org>" }, team),
    ["me@gmail.com", "mod@noor.org", "vol@noor.org"]);
  assert.deepStrictEqual(
    await recipients({ NOTIFY_EMAIL_TO: "me@gmail.com", NOTIFY_EMAIL_FROM: "alerts@updates.noorohio.org" }, async () => { throw new Error("db down"); }),
    ["me@gmail.com"], "a team lookup failure falls back to NOTIFY_EMAIL_TO");
});

test("submit: reports need a real listing id, a known reason, and details for 'other'", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  const handler = require("../api/submit");
  const id = "11111111-1111-1111-1111-111111111111";
  for (const body of [
    { type: "report", business_id: "../x", reason: "closed" },
    { type: "report", business_id: id, reason: "made-up" },
    { type: "report", business_id: id, reason: "other" },
    { type: "report", business_id: id, review_id: "nope", reason: "spam" },
    { type: "report", business_id: id, reason: "spam", email: "a@b.co?bcc=x" }
  ]) {
    const res = mockRes();
    await handler({ method: "POST", headers: {}, body }, res);
    assert.strictEqual(res.code, 400, JSON.stringify(body));
  }
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test("notify: decisions are never sent from Resend's test sender", async () => {
  process.env.NOTIFY_SECRET = "s3cret";
  process.env.RESEND_API_KEY = "k"; process.env.NOTIFY_EMAIL_TO = "a@b.co"; process.env.NOTIFY_EMAIL_FROM = "NICC <onboarding@resend.dev>";
  const handler = require("../api/notify");
  const res = mockRes();
  await handler({ method: "POST", headers: { authorization: "Bearer s3cret" },
    body: { type: "INSERT", table: "owner_notices", record: { id: "11111111-1111-1111-1111-111111111111", title: "x" } } }, res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.skipped, true);
  for (const k of ["NOTIFY_SECRET", "RESEND_API_KEY", "NOTIFY_EMAIL_TO", "NOTIFY_EMAIL_FROM"]) delete process.env[k];
});

test("notify: decision and report emails carry the useful details", () => {
  const { noticeText, summarize } = require("../api/notify")._test;
  const t = noticeText({ title: "Your claim on Shop was not approved", reason: "We could not verify you" });
  assert.ok(t.startsWith("Your claim on Shop was not approved."));
  assert.ok(t.includes("We could not verify you"));
  assert.ok(!noticeText({ title: "Live", reason: null }).includes("Note from"));
  const r = summarize("reports", { business_id: "abc", reason: "closed", details: "Shut last month" });
  assert.ok(r.includes("Closed or moved") && r.includes("Shut last month"));
});

// ------------------------------------------------------------- helpers
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

// --------------------------------------------------------------- locations
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return { ok: true, json: async () => (hit ? routes[hit] : {}) };
  };
  fn.calls = calls;
  return fn;
}

test("geocode: listing addresses get a city and state when they lack one", () => {
  const { withContext } = require("../api/_lib/geocode");
  assert.strictEqual(withContext("1 Main St", "Dublin"), "1 Main St, Dublin, OH");
  assert.strictEqual(withContext("1 Main St", "Short North"), "1 Main St, Columbus, OH");
  assert.strictEqual(withContext("1 Main St, Columbus, OH 43215", "Dublin"), "1 Main St, Columbus, OH 43215");
  assert.strictEqual(withContext("1 Main St 43017", "Dublin"), "1 Main St 43017");
  assert.strictEqual(withContext("  ", "Dublin"), "");
});

test("geocode: Census first, OpenStreetMap as fallback, ZIPs straight to OpenStreetMap", async () => {
  const { geocode } = require("../api/_lib/geocode");
  const census = { result: { addressMatches: [{ matchedAddress: "90 W BROAD ST, COLUMBUS, OH, 43215", coordinates: { x: -83.0, y: 39.96 } }] } };
  const osm = [{ lat: "40.0886", lon: "-83.1034", display_name: "43017, Columbus, Franklin County, Ohio, United States" }];
  let f = fakeFetch({ "geocoding.geo.census.gov": census, "nominatim": osm });
  assert.deepStrictEqual(await geocode("90 W Broad St, Columbus, OH", f), { lat: 39.96, lng: -83.0, label: "90 W BROAD ST, COLUMBUS, OH, 43215" });
  assert.strictEqual(f.calls.length, 1);
  f = fakeFetch({ "geocoding.geo.census.gov": { result: { addressMatches: [] } }, "nominatim": osm });
  assert.strictEqual((await geocode("somewhere vague", f)).label, "43017, Columbus, Franklin County, Ohio");
  f = fakeFetch({ "nominatim": osm });
  await geocode("43017", f);
  assert.ok(f.calls.every((u) => u.includes("nominatim")), "a bare ZIP skips Census");
  f = fakeFetch({ "nominatim": [{ lat: "999", lon: "0" }] });
  assert.strictEqual(await geocode("43017", f), null, "nonsense coordinates are rejected");
});

test("geocode route: validates input and keeps the backfill for moderators", async () => {
  const handler = require("../api/geocode");
  let res = mockRes();
  await handler({ method: "GET", headers: {}, query: { q: "ab" } }, res);
  assert.strictEqual(res.code, 400);
  res = mockRes();
  await handler({ method: "GET", headers: {}, query: { q: "x".repeat(201) } }, res);
  assert.strictEqual(res.code, 400);
  await withEnv({ SUPABASE_SERVICE_ROLE_KEY: "svc", NOTIFY_SECRET: "s3cret" }, async () => {
    res = mockRes();
    await handler({ method: "POST", headers: {}, body: { backfill: true } }, res);
    assert.strictEqual(res.code, 403);
    res = mockRes();
    await handler({ method: "POST", headers: { authorization: "Bearer s3cret" }, body: { id: "../x", address: "1 Main" } }, res);
    assert.strictEqual(res.code, 400);
    res = mockRes();
    await handler({ method: "POST", headers: { authorization: "Bearer wrong" }, body: { id: "11111111-1111-1111-1111-111111111111", address: "1 Main" } }, res);
    assert.strictEqual(res.code, 400, "a wrong secret is treated as a (bad) backfill request, never as the trigger");
  });
});


test("listing page: typed JSON-LD with geo, opening hours and breadcrumbs, plus related links", () => {
  const { render } = require("../api/listing")._test;
  const out = render({
    id: "22222222-2222-2222-2222-222222222222", name: "Noor Grill", category: "Restaurants", neighborhood: "Dublin",
    description: "Halal grill. " + "x".repeat(200), long_description: "Long", address: "1 Main St", phone: "(614) 555-0100",
    website: "https://noor.example", lat: 40.1, lng: -83.1,
    hours: [["Mon–Fri", "9am–5pm"], ["Sat", "10am–2pm"], ["Sun", "Closed"], ["Whenever", "maybe"]]
  }, [], [{ id: "33333333-3333-3333-3333-333333333333", name: "Other <b>", category: "Grocery", neighborhood: "Dublin" }]);
  const blocks = [...out.html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.strictEqual(blocks.length, 2);
  const biz = blocks[0];
  assert.strictEqual(biz["@type"], "Restaurant");
  assert.deepStrictEqual(biz.geo, { "@type": "GeoCoordinates", latitude: 40.1, longitude: -83.1 });
  assert.strictEqual(biz.openingHoursSpecification.length, 2, "closed and unreadable rows are dropped");
  assert.deepStrictEqual(biz.openingHoursSpecification[0].dayOfWeek, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  assert.strictEqual(biz.openingHoursSpecification[0].opens, "09:00");
  assert.strictEqual(biz.openingHoursSpecification[0].closes, "17:00");
  assert.strictEqual(blocks[1]["@type"], "BreadcrumbList");
  assert.match(out.html, /<meta name="description" content="[^"]{1,160}">/);
  assert.ok(out.html.includes('href="/b/33333333-3333-3333-3333-333333333333"'));
  assert.ok(!out.html.includes("<b>"), "related names are escaped");
  assert.ok(out.html.includes('data-ev="phone"') && out.html.includes('data-ev="website"') && out.html.includes('data-ev="directions"'));
  assert.ok(out.html.includes('send("view")'), "views are counted from the browser, not on page load by the server");
  assert.ok(out.html.includes("navigator.webdriver") && out.html.includes('"nb_team"'), "automated browsers and the team are skipped");
});

test("track: only POST, ignores bots / bad input / missing service key, answers 204", async () => {
  const handler = require("../api/track");
  const id = "11111111-1111-1111-1111-111111111111";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let res = mockRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.strictEqual(res.code, 405);
  res = mockRes();
  await handler({ method: "POST", headers: { "user-agent": "Mozilla/5.0" }, body: { id, event: "view" } }, res);
  assert.strictEqual(res.code, 204);

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => "true", headers: new Map() }; };
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  try {
    const human = { headers: { "user-agent": "Mozilla/5.0 (iPhone)", "x-forwarded-for": "9.9.9.9" } };
    assert.strictEqual(await handler.record(human, id, "view"), true);
    assert.strictEqual(await handler.record(human, id, "view"), false, "same visitor, same event: counted once");
    assert.strictEqual(await handler.record(human, id, "phone"), true);
    assert.strictEqual(await handler.record({ headers: { "user-agent": "Googlebot/2.1" } }, id, "view"), false);
    assert.strictEqual(await handler.record({ headers: { "user-agent": "Mozilla/5.0", dnt: "1", "x-forwarded-for": "1.1.1.1" } }, id, "view"), false);
    assert.strictEqual(await handler.record(human, "not-a-uuid", "view"), false);
    assert.strictEqual(await handler.record({ headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "2.2.2.2" } }, id, "pwn"), false);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].body, { p_business_id: id, p_event: "view" });
    assert.ok(!JSON.stringify(calls).includes("9.9.9.9"), "the visitor's address is never sent to the database");
  } finally { global.fetch = realFetch; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test("robots.txt and the sitemap point at the real domain", () => {
  const robots = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "robots.txt"), "utf8");
  assert.match(robots, /Sitemap: https:\/\/noorbusiness\.org\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/api\//);
  assert.ok(!robots.includes("vercel.app"));
});

test("listing page share card: listing photo when there is one, else the 1200x630 site card", () => {
  const { render } = require("../api/listing")._test;
  const base = { id: "22222222-2222-2222-2222-222222222222", name: "Cafe & Co", category: "Restaurants", neighborhood: "Dublin",
    description: "Coffee.", long_description: "Coffee." };
  const plain = render(base, [], []).html;
  assert.match(plain, /<meta property="og:image" content="https:\/\/noorbusiness\.org\/images\/og-image\.jpg">/);
  assert.match(plain, /<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">/);
  assert.match(plain, /<meta property="og:title" content="Cafe &amp; Co · Restaurants in Dublin, Columbus">/);
  assert.match(plain, /<meta name="twitter:image" content="https:\/\/noorbusiness\.org\/images\/og-image\.jpg">/);
  assert.match(plain, /<title>Cafe &amp; Co — Restaurants in Dublin, Columbus \| NICC Business<\/title>/);
  const withPhoto = render(Object.assign({}, base, { photo_url: "https://cdn.example/p.jpg" }), [], []).html;
  assert.match(withPhoto, /<meta property="og:image" content="https:\/\/cdn\.example\/p\.jpg">/);
  assert.match(withPhoto, /<meta property="og:image:alt" content="Photo of Cafe &amp; Co">/);
  assert.ok(!/og:image:width/.test(withPhoto), "no made-up size for owner photos");
});

test("listing page doesn't say Columbus twice when the neighborhood already names it", () => {
  const { render } = require("../api/listing")._test;
  const html = render({ id: "33333333-3333-3333-3333-333333333333", name: "Afra Grill", category: "Restaurants",
    neighborhood: "Columbus (Northland)", description: "Food.", long_description: "Food." }, [], []).html;
  assert.match(html, /<title>Afra Grill — Restaurants in Columbus \(Northland\) \| NICC Business<\/title>/);
  assert.match(html, /Restaurants in Columbus \(Northland\), Ohio/);
  assert.ok(!/Columbus \(Northland\), Columbus/.test(html));
});
