const test = require("node:test");
const assert = require("node:assert");
const S = require("../js/search.js");

test("normalize lowercases, strips accents and punctuation", () => {
  assert.strictEqual(S.normalize("  Café  Zaïd's & Sons! "), "cafe zaids and sons");
  assert.strictEqual(S.normalize("Men’s Wear"), "mens wear");
  assert.strictEqual(S.normalize("Health & Wellness"), "health and wellness");
  assert.strictEqual(S.normalize(null), "");
});

test("expandQuery adds aliases and keeps the word itself first", () => {
  assert.deepStrictEqual(S.expandQuery(["pizza"]), [["pizza"]]);
  assert.strictEqual(S.expandQuery(["butcher"])[0][0], "butcher");
  assert.ok(S.expandQuery(["meat"])[0].includes("grocery"));
  assert.ok(S.expandQuery(["Hijab"])[0].includes("modest"));
  assert.ok(S.expandQuery(["dentist"])[0].includes("health"));
  assert.ok(S.expandQuery(["attorney"])[0].includes("professional"));
  assert.ok(S.expandQuery(["tutor"])[0].includes("education"));
  assert.ok(S.expandQuery(["tires"])[0].includes("auto"));
  assert.ok(S.expandQuery(["plumber"])[0].includes("home"));
  assert.ok(!S.expandQuery(["toString"])[0].includes("grocery"));
});

test("alias words match by category", () => {
  const f = { name: "Al Noor Foods", category: "Grocery", description: "Fresh goods" };
  assert.ok(S.score(f, ["butcher"]) > 0);
  assert.strictEqual(S.score({ name: "Cafe", category: "Restaurants" }, ["butcher"]), 0);
});

test("name prefix outranks description match", () => {
  const byName = S.score({ name: "Bakery Bliss", category: "Restaurants", description: "sweets" }, ["bak"]);
  const byDesc = S.score({ name: "Corner Shop", category: "Grocery", description: "we sell bakery items" }, ["bak"]);
  assert.ok(byName > byDesc && byDesc > 0);
  const exact = S.score({ name: "Bakery", category: "x" }, ["bakery"]);
  assert.ok(exact > byName);
});

test("direct name hit outranks alias hit", () => {
  const direct = S.score({ name: "Meat House", category: "Restaurants" }, ["meat"]);
  const alias = S.score({ name: "Corner Shop", category: "Grocery" }, ["meat"]);
  assert.ok(direct > alias && alias > 0);
});

test("every word must match (AND)", () => {
  const f = { name: "Noor Bakery", category: "Restaurants", description: "fresh bread" };
  assert.ok(S.score(f, ["noor", "bread"]) > 0);
  assert.strictEqual(S.score(f, ["noor", "sushi"]), 0);
  assert.strictEqual(S.score(f, []), 0);
});

test("accent-insensitive in both directions", () => {
  const f = { name: "Café Zaïd", category: "Restaurants" };
  assert.ok(S.score(f, ["cafe"]) > 0);
  assert.ok(S.score(f, ["zaid"]) > 0);
  assert.ok(S.score({ name: "Cafe Zaid" }, ["café"]) > 0);
});

test("halal is ordinary text matching", () => {
  assert.strictEqual(S.score({ name: "Corner Shop", category: "Grocery", description: "sells snacks" }, ["halal"]), 0);
  assert.ok(S.score({ name: "Halal Corner", category: "Grocery" }, ["halal"]) > 0);
});
