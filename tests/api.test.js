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

// ------------------------------------------------------------- sponsorship
const crypto = require("crypto");
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_SPOTLIGHT: "price_s", STRIPE_PRICE_FEATURED: "price_f", SUPABASE_SERVICE_ROLE_KEY: "svc" };
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}
function sign(body, secret, t) {
  return "t=" + t + ",v1=" + crypto.createHmac("sha256", secret).update(t + "." + body).digest("hex");
}

test("stripe: webhook signatures are checked against the raw body and the clock", () => {
  const { verifySignature } = require("../api/_lib/stripe");
  const body = '{"id":"evt_1"}', now = 1700000000;
  assert.ok(verifySignature(body, sign(body, "whsec_x", now), "whsec_x", now));
  assert.ok(verifySignature(body, "t=" + now + ",v1=deadbeef," + sign(body, "whsec_x", now).split(",")[1], "whsec_x", now), "any v1 may match");
  assert.ok(!verifySignature(body, sign(body, "wrong", now), "whsec_x", now));
  assert.ok(!verifySignature(body + " ", sign(body, "whsec_x", now), "whsec_x", now), "a re-serialized body must not pass");
  assert.ok(!verifySignature(body, sign(body, "whsec_x", now - 3600), "whsec_x", now), "replays outside the tolerance fail");
  assert.ok(!verifySignature(body, "", "whsec_x", now));
  assert.ok(!verifySignature(body, "garbage", "whsec_x", now));
});

test("stripe: form encoding matches Stripe's nested format", () => {
  const { form } = require("../api/_lib/stripe");
  assert.strictEqual(form({ a: 1, b: { c: "x y" }, d: [{ e: 3 }], skip: undefined }), "a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=3");
});

test("billing: plans are public, and paying is off until Stripe is configured", async () => {
  const handler = require("../api/billing/plans");
  let res = mockRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.strictEqual(res.body.configured, false);
  assert.deepStrictEqual(res.body.plans.map((p) => p.id), ["spotlight", "featured"]);
  assert.ok(!JSON.stringify(res.body).includes("STRIPE"), "no env var names leak");
  await withEnv(STRIPE_ENV, async () => {
    res = mockRes();
    await handler({ method: "GET", headers: {} }, res);
    assert.strictEqual(res.body.configured, true);
  });
  const checkout = require("../api/billing/checkout");
  res = mockRes();
  await checkout({ method: "POST", headers: {}, body: { business_id: "x", plan: "featured" } }, res);
  assert.strictEqual(res.code, 503);
});

test("billing: checkout and portal need a valid listing, a plan and a login", async () => {
  await withEnv(STRIPE_ENV, async () => {
    const checkout = require("../api/billing/checkout");
    const portal = require("../api/billing/portal");
    const id = "11111111-1111-1111-1111-111111111111";
    let res = mockRes();
    await checkout({ method: "POST", headers: {}, body: { business_id: id, plan: "gold" } }, res);
    assert.strictEqual(res.code, 400);
    res = mockRes();
    await checkout({ method: "POST", headers: {}, body: { business_id: "nope", plan: "featured" } }, res);
    assert.strictEqual(res.code, 400);
    res = mockRes();
    await checkout({ method: "POST", headers: {}, body: { business_id: id, plan: "featured" } }, res);
    assert.strictEqual(res.code, 401);
    res = mockRes();
    await portal({ method: "POST", headers: {}, body: { business_id: id } }, res);
    assert.strictEqual(res.code, 401);
  });
});

test("billing: webhook refuses unsigned events", async () => {
  await withEnv(STRIPE_ENV, async () => {
    const handler = require("../api/billing/webhook");
    const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
    let res = mockRes();
    await handler({ method: "POST", headers: { "stripe-signature": sign(body, "wrong", Math.floor(Date.now() / 1000)) }, rawBody: body }, res);
    assert.strictEqual(res.code, 400);
    res = mockRes();
    const other = JSON.stringify({ type: "invoice.created", data: { object: {} } });
    await handler({ method: "POST", headers: { "stripe-signature": sign(other, "whsec_x", Math.floor(Date.now() / 1000)) }, rawBody: other }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.skipped, true);
  });
});

test("billing: subscriptions map to the plan by price, not just metadata", async () => {
  await withEnv(STRIPE_ENV, async () => {
    const { toRow } = require("../api/billing/webhook")._test;
    const id = "11111111-1111-1111-1111-111111111111";
    const sub = { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1700000000, cancel_at_period_end: false,
      metadata: { business_id: id, payer_id: id, plan: "spotlight" }, items: { data: [{ price: { id: "price_f" } }] } };
    const row = toRow(sub);
    assert.strictEqual(row.p_tier, "featured", "upgraded in the portal: price wins over stale metadata");
    assert.strictEqual(row.p_period_end, new Date(1700000000 * 1000).toISOString());
    assert.strictEqual(toRow(Object.assign({}, sub, { metadata: { business_id: "../x" } })), null);
    const newer = Object.assign({}, sub, { current_period_end: undefined, items: { data: [{ price: { id: "price_s" }, current_period_end: 1700000500 }] } });
    assert.strictEqual(toRow(newer).p_tier, "spotlight");
    assert.ok(toRow(newer).p_period_end);
  });
});

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

test("stripe: token claims are read from the JWT payload", () => {
  const { tokenClaims } = require("../api/_lib/stripe");
  const payload = Buffer.from(JSON.stringify({ sub: "u1", aal: "aal2" })).toString("base64url");
  assert.strictEqual(tokenClaims("x." + payload + ".sig").aal, "aal2");
  assert.deepStrictEqual(tokenClaims("garbage"), {});
});
