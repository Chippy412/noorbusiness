var test = require("node:test");
var assert = require("node:assert");
var P = require("../js/photo.js");

test("fitWithin scales landscape down", function () {
  assert.deepStrictEqual(P.fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
});
test("fitWithin scales portrait down", function () {
  assert.deepStrictEqual(P.fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 });
});
test("fitWithin never scales up", function () {
  assert.deepStrictEqual(P.fitWithin(800, 600, 1600), { width: 800, height: 600 });
  assert.deepStrictEqual(P.fitWithin(1600, 1600, 1600), { width: 1600, height: 1600 });
});
test("fitWithin handles squares", function () {
  assert.deepStrictEqual(P.fitWithin(3000, 3000, 1600), { width: 1600, height: 1600 });
});
test("fitWithin rounds to integers and keeps min 1", function () {
  assert.deepStrictEqual(P.fitWithin(4001, 3001, 1600), { width: 1600, height: 1200 });
  assert.deepStrictEqual(P.fitWithin(10000, 3, 1600), { width: 1600, height: 1 });
});
test("extFor", function () {
  assert.strictEqual(P.extFor("image/webp"), "webp");
  assert.strictEqual(P.extFor("image/jpeg"), "jpg");
  assert.strictEqual(P.extFor("image/png"), "png");
  assert.strictEqual(P.extFor("anything/else"), "jpg");
});
test("checkInput", function () {
  assert.strictEqual(P.checkInput({ type: "image/jpeg", size: 1000, name: "a.jpg" }), null);
  assert.strictEqual(P.checkInput({ type: "image/png", size: P.MAX_INPUT_BYTES, name: "a.png" }), null);
  assert.ok(P.checkInput({ type: "application/pdf", size: 10, name: "a.pdf" }));
  assert.ok(P.checkInput({ type: "image/gif", size: 10, name: "a.gif" }));
  assert.match(P.checkInput({ type: "image/heic", size: 10, name: "a.heic" }), /JPG/);
  assert.match(P.checkInput({ type: "", size: 10, name: "IMG_0042.HEIC" }), /HEIC/);
  assert.ok(P.checkInput({ type: "image/jpeg", size: P.MAX_INPUT_BYTES + 1, name: "big.jpg" }));
  assert.ok(P.checkInput(null));
});
