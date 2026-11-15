// Tests for server/index.js, the self-hosted wrapper around api/*.js.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { createServer, resolveRoute, parseBody } = require("../server/index");

const API = path.resolve(__dirname, "..", "api");

test("resolveRoute maps the vercel.json rewrites", () => {
  const b = resolveRoute("/b/11111111-1111-1111-1111-111111111111");
  assert.strictEqual(b.file, path.join(API, "listing.js"));
  assert.deepStrictEqual(b.params, { id: "11111111-1111-1111-1111-111111111111" });
  assert.strictEqual(resolveRoute("/sitemap.xml").file, path.join(API, "sitemap.js"));
});

test("resolveRoute finds handlers and refuses private or missing ones", () => {
  assert.strictEqual(resolveRoute("/api/billing/plans"), null, "the Stripe billing routes are gone");
  assert.strictEqual(resolveRoute("/api/turnstile-config").file, path.join(API, "turnstile-config.js"));
  assert.strictEqual(resolveRoute("/api/_lib/supa"), null);
  assert.strictEqual(resolveRoute("/api/../server/index"), null);
  assert.strictEqual(resolveRoute("/api/nope"), null);
  assert.strictEqual(resolveRoute("/noor-business.html"), null);
});

test("parseBody handles json, urlencoded, bad json and empty", () => {
  assert.deepStrictEqual(parseBody(Buffer.from('{"a":1}'), "application/json"), { a: 1 });
  assert.deepStrictEqual(parseBody(Buffer.from("a=1&b=x"), "application/x-www-form-urlencoded"), { a: "1", b: "x" });
  assert.strictEqual(parseBody(Buffer.from("{oops"), "application/json"), "{oops");
  assert.strictEqual(parseBody(Buffer.alloc(0), "application/json"), undefined);
});

async function withServer(fn) {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  try { await fn(base); } finally { await new Promise((r) => srv.close(r)); }
}

test("server answers health, 404s and runs a real handler with a parsed body", async () => {
  const saved = process.env.TURNSTILE_SECRET_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  try {
    await withServer(async (base) => {
      let r = await fetch(base + "/healthz");
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(base + "/api/_lib/supa");
      assert.strictEqual(r.status, 404);

      // verify-turnstile answers 500 "not configured" without a secret, which
      // proves the handler ran and res.status().json() works end to end.
      r = await fetch(base + "/api/verify-turnstile", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x" })
      });
      assert.strictEqual(r.status, 500);
      assert.strictEqual((await r.json()).success, false);
    });
  } finally {
    if (saved !== undefined) process.env.TURNSTILE_SECRET_KEY = saved;
  }
});

test("listing rewrite returns the not-found page for a bad id without calling the database", async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/b/not-a-uuid");
    assert.strictEqual(r.status, 404);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(await r.text(), /Listing not found/);
  });
});

test("oversized bodies are refused", async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/api/verify-turnstile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1024 * 1024 + 10)
    }).catch((e) => e);
    // Either a 413 or the socket being closed mid-upload is acceptable.
    if (r instanceof Error) return;
    assert.strictEqual(r.status, 413);
  });
});
