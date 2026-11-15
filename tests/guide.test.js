// Tests for api/guide.js and the handbook fragments it serves.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function mockRes() {
  const res = { headers: {}, code: null, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const DIR = path.join(__dirname, "..", "api", "_lib", "guide");

test("guide: POST is 405", async () => {
  const res = mockRes();
  await require("../api/guide")({ method: "POST", headers: {} }, res);
  assert.strictEqual(res.code, 405);
  assert.strictEqual(res.headers["Cache-Control"], "no-store");
});

test("guide: no token is 403 team_only and makes no network call", async () => {
  const saved = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("no network expected"); };
  try {
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer " }]) {
      const res = mockRes();
      await require("../api/guide")({ method: "GET", headers }, res);
      assert.strictEqual(res.code, 403);
      assert.deepStrictEqual(res.body, { ok: false, error: "team_only" });
      assert.strictEqual(res.headers["Cache-Control"], "no-store");
    }
    assert.strictEqual(calls, 0);
  } finally { global.fetch = saved; }
});

function fakeFetch(admin, moderator) {
  return async (url) => {
    const v = /is_moderator/.test(url) ? moderator : admin;
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(v) };
  };
}

test("guide: volunteers get the handbook, moderators also get operations, others 403", async () => {
  const saved = global.fetch;
  const team = fs.readFileSync(path.join(DIR, "team.html"), "utf8");
  const ops = fs.readFileSync(path.join(DIR, "operations.html"), "utf8");
  try {
    global.fetch = fakeFetch(true, false);
    let res = mockRes();
    await require("../api/guide")({ method: "GET", headers: { authorization: "Bearer t" } }, res);
    assert.strictEqual(res.code, 200);
    assert.ok(res.body.html.includes(team));
    assert.ok(!res.body.html.includes(ops));

    global.fetch = fakeFetch(true, true);
    res = mockRes();
    await require("../api/guide")({ method: "GET", headers: { authorization: "Bearer t" } }, res);
    assert.strictEqual(res.code, 200);
    assert.ok(res.body.html.includes(team) && res.body.html.includes(ops));

    global.fetch = fakeFetch(false, false);
    res = mockRes();
    await require("../api/guide")({ method: "GET", headers: { authorization: "Bearer t" } }, res);
    assert.strictEqual(res.code, 403);
    assert.strictEqual(res.body.html, undefined);
  } finally { global.fetch = saved; }
});

test("guide: fragments exist, are non-empty and hold no secrets", () => {
  const bad = [/sb_secret/, /sb_publishable/, /BEGIN/, /eyJ/, /AKIA[0-9A-Z]{8}/, /\bre_[A-Za-z0-9]{10,}/, /whsec_/, /\bsk_(live|test)_/, /service_role key value/i, /password\s*[:=]\s*\S/i, /<script/i, /style="/i];
  for (const f of ["team.html", "operations.html"]) {
    const txt = fs.readFileSync(path.join(DIR, f), "utf8");
    assert.ok(txt.trim().length > 1000, f + " should have real content");
    for (const re of bad) assert.ok(!re.test(txt), f + " must not match " + re);
  }
});
