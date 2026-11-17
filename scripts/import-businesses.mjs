#!/usr/bin/env node
// scripts/import-businesses.mjs
// Loads researched listings from a CSV into the businesses table as
// PENDING, unclaimed rows (origin = 'imported', no owner), so a moderator
// approves each one before it shows on the site.
//
//   node scripts/import-businesses.mjs listings.csv --batch pilot-2026-11            # dry run (default)
//   node scripts/import-businesses.mjs listings.csv --batch pilot-2026-11 --apply    # really insert
//   node scripts/import-businesses.mjs --remove-batch pilot-2026-11 --apply          # delete a batch (unclaimed rows only)
//
// Only rows whose keep_or_drop column starts with "k" (keep) are imported.
// --apply needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (the server's env file). The key is never printed or put on the command line.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CATEGORIES = ["Restaurants", "Grocery", "Modest Wear", "Health & Wellness", "Professional Services", "Education", "Home & Living", "Auto & Repair"];

export function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  const [head, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || "").trim()])));
}

// "Mon-Sat 11am-9pm" -> [["Mon-Sat", "11am-9pm"]]; several ranges split on ";".
export function parseHours(text) {
  if (!text) return [];
  return text.split(";").map((part) => {
    const p = part.trim();
    const m = p.match(/^(\D*?)\s*(\d.*)$/);
    return m && m[1] ? [m[1].trim(), m[2].trim()] : [p, ""];
  }).filter((h) => h[0]);
}

export function normalize(s) { return String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim(); }

export function toRow(r, batch) {
  const errors = [];
  const need = (k) => { if (!r[k]) errors.push(`missing ${k}`); return r[k]; };
  const row = {
    name: need("name"), category: need("category"), neighborhood: need("neighborhood"),
    description: need("description"), long_description: need("long_description"),
    address: r.address || null, phone: r.phone || null, website: r.website || null,
    hours: parseHours(r.hours),
    source_urls: (r.source_urls || "").split(";").map((u) => u.trim()).filter(Boolean),
    status: "pending", origin: "imported", owner_id: null, import_batch: batch,
    last_verified_at: new Date().toISOString(),
  };
  if (row.category && !CATEGORIES.includes(row.category)) errors.push(`unknown category "${row.category}"`);
  if (row.name && row.name.length > 120) errors.push("name over 120 chars");
  if (row.neighborhood && row.neighborhood.length > 60) errors.push("neighborhood over 60 chars");
  if (row.description && row.description.length > 300) errors.push("description over 300 chars");
  if (row.long_description && row.long_description.length > 3000) errors.push("long_description over 3000 chars");
  if (row.address && row.address.length > 250) errors.push("address over 250 chars");
  if (row.phone && row.phone.length > 40) errors.push("phone over 40 chars");
  if (row.website && !/^https:\/\/\S+$/i.test(row.website)) errors.push("website must start with https://");
  return { row, errors };
}

async function api(method, path, body) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  const res = await fetch(url + "/rest/v1/" + path, {
    method,
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const batch = flag("--batch");
  const removeBatch = flag("--remove-batch");

  if (removeBatch) {
    const path = `businesses?import_batch=eq.${encodeURIComponent(removeBatch)}&owner_id=is.null`;
    if (!apply) {
      const rows = await api("GET", path + "&select=id,name");
      console.log(`DRY RUN: would delete ${rows.length} unclaimed listing(s) from batch ${removeBatch}:`);
      rows.forEach((r) => console.log("  -", r.name));
      console.log("Add --apply to delete them.");
      return;
    }
    const rows = await api("DELETE", path);
    console.log(`Deleted ${rows.length} unclaimed listing(s) from batch ${removeBatch}.`);
    return;
  }

  const file = args.find((a) => !a.startsWith("--") && a !== batch);
  if (!file || !batch) { console.error("Usage: import-businesses.mjs <file.csv> --batch <label> [--apply]"); process.exit(2); }

  const all = parseCsv(readFileSync(file, "utf8"));
  const kept = all.filter((r) => /^k/i.test(r.keep_or_drop || ""));
  console.log(`${all.length} rows in file, ${kept.length} marked keep.`);

  let existing = [];
  if (apply || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    existing = await api("GET", "businesses?select=name,address");
  } else console.log("(No Supabase credentials set: skipping the duplicate check against existing listings.)");
  const seen = new Set(existing.map((b) => normalize(b.name) + "|" + normalize(b.address)));
  const seenNames = new Set(existing.map((b) => normalize(b.name)));

  const good = [], bad = [], dup = [];
  for (const r of kept) {
    const { row, errors } = toRow(r, batch);
    const key = normalize(row.name) + "|" + normalize(row.address);
    if (errors.length) bad.push({ name: row.name || "(no name)", errors });
    else if (seen.has(key) || seenNames.has(normalize(row.name))) dup.push(row.name);
    else { good.push(row); seen.add(key); seenNames.add(normalize(row.name)); }
  }
  console.log(`\nWould insert ${good.length}:`);
  good.forEach((g) => console.log(`  + ${g.name} (${g.category}, ${g.neighborhood})`));
  if (dup.length) { console.log(`\nSkipped as duplicates of existing listings (${dup.length}):`); dup.forEach((n) => console.log("  =", n)); }
  if (bad.length) { console.log(`\nRejected (${bad.length}):`); bad.forEach((b) => console.log(`  ! ${b.name}: ${b.errors.join("; ")}`)); }

  if (!apply) { console.log("\nDRY RUN: nothing was saved. Add --apply to insert as pending."); return; }
  if (bad.length) { console.error("\nFix the rejected rows (or mark them drop) before using --apply."); process.exit(1); }
  if (!good.length) return;
  const inserted = await api("POST", "businesses", good);
  console.log(`\nInserted ${inserted.length} pending listing(s) in batch ${batch}. Approve them in the moderators' queue.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
