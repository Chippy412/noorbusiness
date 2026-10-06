const test = require("node:test");
const assert = require("node:assert/strict");
const { distanceMiles, formatMiles } = require("../js/geo.js");

test("downtown Columbus to Dublin OH is about 11 miles", () => {
  const d = distanceMiles(39.9612, -82.9988, 40.0992, -83.1141);
  assert.ok(Math.abs(d - 11) < 1, "got " + d);
});

test("zero distance for the same point", () => {
  assert.equal(distanceMiles(40.1, -83.0, 40.1, -83.0), 0);
});

test("distance is symmetric", () => {
  const a = distanceMiles(39.9612, -82.9988, 40.0992, -83.1141);
  const b = distanceMiles(40.0992, -83.1141, 39.9612, -82.9988);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test("formatMiles: one decimal under 10, whole above", () => {
  assert.equal(formatMiles(0.3), "0.3 mi");
  assert.equal(formatMiles(0), "0.0 mi");
  assert.equal(formatMiles(2.44), "2.4 mi");
  assert.equal(formatMiles(9.94), "9.9 mi");
  assert.equal(formatMiles(9.96), "10 mi");
  assert.equal(formatMiles(10.4), "10 mi");
  assert.equal(formatMiles(11.6), "12 mi");
});

test("formatMiles ignores bad input", () => {
  assert.equal(formatMiles(NaN), "");
  assert.equal(formatMiles(null), "");
  assert.equal(formatMiles(-1), "");
});
