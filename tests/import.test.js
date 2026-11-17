// tests/import.test.js
const test = require("node:test");
const assert = require("node:assert");

test("import script parsing and validation", async () => {
  const m = await import("../scripts/import-businesses.mjs");
  const rows = m.parseCsv('keep_or_drop,name,note\nkeep,"A, B","say ""hi""\nthere"\n');
  assert.deepStrictEqual(rows, [{ keep_or_drop: "keep", name: "A, B", note: 'say "hi"\nthere' }]);
  assert.deepStrictEqual(m.parseHours("Mon-Sat 11am-9pm; Sun 12pm-6pm"), [["Mon-Sat", "11am-9pm"], ["Sun", "12pm-6pm"]]);
  assert.deepStrictEqual(m.parseHours(""), []);
  const ok = m.toRow({ name: "X", category: "Grocery", neighborhood: "Dublin", description: "d", long_description: "l", website: "https://x.com", source_urls: "https://a.com; https://b.com" }, "b1");
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.row.status, "pending");
  assert.strictEqual(ok.row.owner_id, null);
  assert.strictEqual(ok.row.origin, "imported");
  assert.deepStrictEqual(ok.row.source_urls, ["https://a.com", "https://b.com"]);
  const bad = m.toRow({ name: "X", category: "Nope", neighborhood: "D", description: "d", long_description: "l", website: "http://x.com" }, "b1");
  assert.strictEqual(bad.errors.length, 2);
});
