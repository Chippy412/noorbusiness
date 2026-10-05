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
