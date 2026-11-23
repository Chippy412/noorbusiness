// tests/owner-stats.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");
const SV = require("../js/stats-view");

const NOW = new Date("2026-11-23T15:00:00Z"); // Nov 23 in New York

test("today() uses New York dates", () => {
  assert.strictEqual(SV.today(NOW), "2026-11-23");
  assert.strictEqual(SV.today(new Date("2026-11-24T03:00:00Z")), "2026-11-23"); // still the 23rd in NY
});

test("summarize fills every day and splits this period from the one before", () => {
  const rows = [
    { day: "2026-11-23", views: 5, website_clicks: 1, phone_clicks: 2, directions_clicks: 0 },
    { day: "2026-11-17", views: 3, website_clicks: 0, phone_clicks: 0, directions_clicks: 1 },
    { day: "2026-11-23", views: 2, website_clicks: 0, phone_clicks: 0, directions_clicks: 0 }, // a second listing, same day
    { day: "2026-11-16", views: 4, website_clicks: 1, phone_clicks: 0, directions_clicks: 0 }, // previous week
    { day: "2026-11-09", views: 99, website_clicks: 9, phone_clicks: 9, directions_clicks: 9 } // too old
  ];
  const s = SV.summarize(rows, 7, NOW);
  assert.strictEqual(s.daily.length, 7);
  assert.strictEqual(s.daily[0].day, "2026-11-17");
  assert.strictEqual(s.daily[6].day, "2026-11-23");
  assert.strictEqual(s.daily[6].views, 7);
  assert.deepStrictEqual(s.totals.previous, { views: 4, website: 1, phone: 0, directions: 0 });
  assert.strictEqual(s.totals.views, 10);
  assert.strictEqual(s.totals.phone, 2);
  assert.strictEqual(s.totals.directions, 1);
});

test("change() and pct() read naturally", () => {
  assert.strictEqual(SV.change(12, 10), "Up 20% on the period before");
  assert.strictEqual(SV.change(0, 0), "No change");
  assert.strictEqual(SV.change(3, 0), "New this period");
  assert.strictEqual(SV.pct(1, 0), "–");
});

function loadOwnerStats() {
  const window = { NiccStatsView: SV };
  vm.runInNewContext(fs.readFileSync("js/owner-stats.js", "utf8"), { window });
  return window.NiccOwnerStats;
}

test("owner panel escapes listing names and shows a per-listing table for several listings", () => {
  const { _panel } = loadOwnerStats();
  const listings = [{ id: "a", name: "<b>Bad</b>", category: "Grocery" }, { id: "b", name: "Cafe", category: "Restaurants" }];
  const a = SV.summarize([{ day: "2026-11-23", views: 4, website_clicks: 1, phone_clicks: 0, directions_clicks: 0 }], 30, NOW);
  const b = SV.summarize([{ day: "2026-11-22", views: 6, website_clicks: 0, phone_clicks: 2, directions_clicks: 1 }], 30, NOW);
  const all = SV.summarize([
    { day: "2026-11-23", views: 4, website_clicks: 1, phone_clicks: 0, directions_clicks: 0 },
    { day: "2026-11-22", views: 6, website_clicks: 0, phone_clicks: 2, directions_clicks: 1 }], 30, NOW);
  const html = _panel(listings, { a, b }, all, 30);
  assert.ok(!html.includes("<b>Bad</b>"));
  assert.ok(html.includes("&lt;b&gt;Bad&lt;/b&gt;"));
  assert.match(html, /By listing/);
  assert.ok(html.indexOf("Cafe") < html.indexOf("&lt;b&gt;Bad"), "most viewed first");
  assert.match(html, /<svg class="mod-an-chart"/);
  assert.match(html, /data-stats-days="30" aria-pressed="true"/);
});

test("owner panel has an empty state and no table for a single quiet listing", () => {
  const { _panel } = loadOwnerStats();
  const s = SV.summarize([], 7, NOW);
  const html = _panel([{ id: "a", name: "Cafe", category: "Restaurants" }], { a: s }, s, 7);
  assert.match(html, /No visits counted yet/);
  assert.ok(!/By listing/.test(html));
});

test("account page loads the stats scripts before admin.js and has the card", () => {
  const page = fs.readFileSync("noor-business.html", "utf8");
  const i = (s) => page.indexOf('<script src="js/' + s + '"></script>');
  assert.ok(i("stats-view.js") > 0 && i("stats-view.js") < i("owner-stats.js") && i("owner-stats.js") < i("admin.js"));
  assert.match(page, /id="ownerStatsCard"[^>]*hidden/);
  assert.match(fs.readFileSync("js/owner-dashboard.js", "utf8"), /rpc\("my_listing_stats"/);
});
