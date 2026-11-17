// tests/admin-add.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

test("migration defines admin_add_listing for team members", () => {
  const sql = fs.readFileSync("supabase/migrations/2026-11-17-imported-listings.sql", "utf8");
  assert.match(sql, /function admin_add_listing\(p_fields jsonb\)/);
  assert.match(sql, /perform _require_admin\(\)/);       // volunteers and moderators, not the public
  assert.match(sql, /'pending', 'imported', null/);       // waits for review, no owner
  assert.match(sql, /grant execute on function admin_add_listing\(jsonb\) to authenticated/);
});

test("admin page has an Add a listing tab wired to the RPC", () => {
  const js = fs.readFileSync("js/admin.js", "utf8");
  assert.match(js, /admin_add_listing/);
  assert.match(js, /id: "add", label: "Add a listing"/);
  assert.ok(!/id: "add"[^}]*modOnly/.test(js), "volunteers must see the tab");
});
