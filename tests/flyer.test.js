const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

test("flyer: page, vendored QR lib and short links are wired up", () => {
  assert.ok(fs.existsSync("flyer.html") && fs.existsSync("js/vendor/qrcode.js"));
  assert.match(fs.readFileSync("flyer.html", "utf8"), /\/js\/vendor\/qrcode\.js/);
  const v = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  const srcs = v.redirects.map((r) => r.source);
  assert.ok(srcs.includes("/join") && srcs.includes("/claim"));
  assert.match(fs.readFileSync("deploy/nginx/noorbusiness.conf", "utf8"), /location = \/join/);
  assert.match(fs.readFileSync("deploy/deploy.sh", "utf8"), /flyer\.html/);
});

test("listing page offers claim and report links", () => {
  const out = require("../api/listing")._test.render(
    { id: "11111111-1111-1111-1111-111111111111", name: "X", category: "Food", neighborhood: "N", description: "d", long_description: "l" }, []);
  assert.match(out.html, /Claim it/);
  assert.match(out.html, /Report wrong info/);
});
