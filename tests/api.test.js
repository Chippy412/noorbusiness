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

test("digest rejects requests without the cron secret", async () => {
  process.env.CRON_SECRET = "s3cret";
  const handler = require("../api/digest");
  const res = mockRes();
  await handler({ headers: {} }, res);
  assert.strictEqual(res.code, 401);
  const res2 = mockRes();
  await handler({ headers: { authorization: "Bearer wrong" } }, res2);
  assert.strictEqual(res2.code, 401);
});

test("digest lists only the queues that have items", () => {
  const { digestText, total } = require("../api/digest")._test;
  const counts = { businesses: 2, business_edits: 0, claims: 1, reviews: 0 };
  const text = digestText(counts, 3);
  assert.match(text, /New listings: 2/);
  assert.match(text, /Claims: 1/);
  assert.match(text, /Contact messages in the last 24 hours: 3/);
  assert.doesNotMatch(text, /Reviews:/);
  assert.strictEqual(total(counts, 3), 6);
  assert.strictEqual(total({}, 0), 0);
});
