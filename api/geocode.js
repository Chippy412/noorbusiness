// api/geocode.js
// Three callers:
//  * GET ?q=<address or ZIP>: a visitor's "distance from" point on Explore.
//    Answers {ok, lat, lng, label}; nothing is stored. Identical queries are
//    cached at Vercel's edge for a day, which also keeps us within the free
//    geocoders' fair-use limits.
//  * POST {id, address, neighborhood} with  Authorization: Bearer <NOTIFY_SECRET>:
//    the request_geocode() database trigger (2026-10-12-locations.sql) when a
//    listing's address is added or changed.
//  * POST {backfill: true} with a moderator's Supabase access token: the
//    "Find map locations" button. Locates a few listings per call (the
//    geocoders ask for ~1 request a second) and says how many are left.
var geo = require("./_lib/geocode");
var html = require("./_lib/html");
var supa = require("./_lib/supa");

var crypto = require("crypto");

var BATCH = 6;
var PER_HOUR = 30; // fresh visitor lookups per IP; cached repeats don't count

function ipHash(req) {
  var fwd = req.headers["x-forwarded-for"];
  var ip = fwd ? String(fwd).split(",")[0].trim() : (req.socket && req.socket.remoteAddress) || "";
  var salt = process.env.IP_HASH_SALT || supa.serviceKey() || "nicc";
  return crypto.createHash("sha256").update(salt + "|" + ip).digest("hex").slice(0, 32);
}

function parseBody(req) {
  var b = req.body;
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return null; } }
  return b && typeof b === "object" ? b : null;
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function locateListing(id, address, neighborhood) {
  var hit = await geo.geocode(geo.withContext(address, neighborhood));
  if (hit) {
    await supa.rest("rpc/set_business_location", { service: true, method: "POST", body: { p_id: id, p_address: address, p_lat: hit.lat, p_lng: hit.lng } });
  } else {
    await supa.rest("rpc/mark_business_unlocatable", { service: true, method: "POST", body: { p_id: id, p_address: address } });
  }
  return !!hit;
}

async function isModerator(req) {
  var m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/);
  if (!m) return false;
  var r = await supa.rest("rpc/is_moderator", { method: "POST", body: {}, headers: { Authorization: "Bearer " + m[1] } });
  return r.ok && r.data === true;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    var q = String((req.query && req.query.q) || "").trim();
    if (q.length < 3 || q.length > 200) { res.status(400).json({ ok: false, error: "invalid" }); return; }
    if (supa.serviceKey()) {
      var allowed = await supa.rest("rpc/geocode_allowed", { service: true, method: "POST", body: { p_ip_hash: ipHash(req), p_per_hour: PER_HOUR } });
      if (allowed.ok && allowed.data === false) { res.status(429).json({ ok: false, error: "rate_limited" }); return; }
    }
    try {
      var hit = await geo.geocode(q);
      if (!hit) {
        res.setHeader("Cache-Control", "public, s-maxage=3600");
        res.status(404).json({ ok: false, error: "not_found" }); return;
      }
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      res.status(200).json({ ok: true, lat: hit.lat, lng: hit.lng, label: hit.label });
    } catch (e) {
      res.status(502).json({ ok: false, error: "lookup_failed" });
    }
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }
  if (!supa.serviceKey()) { res.status(503).json({ ok: false, error: "not_configured" }); return; }
  var body = parseBody(req) || {};

  // From the database trigger.
  var secret = process.env.NOTIFY_SECRET;
  if (secret && req.headers.authorization === "Bearer " + secret) {
    if (!html.UUID_RE.test(String(body.id || "")) || typeof body.address !== "string") { res.status(400).json({ ok: false }); return; }
    try {
      var found = await locateListing(body.id, body.address, body.neighborhood);
      res.status(200).json({ ok: true, located: found });
    } catch (e) {
      res.status(502).json({ ok: false });
    }
    return;
  }

  // A moderator's backfill.
  if (body.backfill !== true) { res.status(400).json({ ok: false, error: "invalid" }); return; }
  if (!(await isModerator(req))) { res.status(403).json({ ok: false, error: "moderators_only" }); return; }
  var list = await supa.rest("rpc/unlocated_businesses", { service: true, method: "POST", body: { p_limit: BATCH + 1 } });
  if (!list.ok || !Array.isArray(list.data)) { res.status(502).json({ ok: false }); return; }
  var located = 0, missed = 0;
  var batch = list.data.slice(0, BATCH);
  for (var i = 0; i < batch.length; i++) {
    try { if (await locateListing(batch[i].id, batch[i].address, batch[i].neighborhood)) located++; else missed++; }
    catch (e) { missed++; }
    if (i < batch.length - 1) await wait(1100);
  }
  res.status(200).json({ ok: true, located: located, not_found: missed, more: list.data.length > BATCH });
};

module.exports.config = { maxDuration: 30 };
