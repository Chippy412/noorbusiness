// api/track.js  POST /api/track  { id: <listing uuid>, event: view|website|phone|directions }
// Privacy-friendly counters: only a daily total per listing is stored (see
// supabase/migrations/2026-11-22-listing-stats.sql). Nothing about the
// visitor is saved. To keep one person from inflating the numbers, the
// server remembers a one-way hash of (address, listing, event) in MEMORY
// ONLY for a short while; it is never written to disk or the database and
// disappears on restart.
var crypto = require("node:crypto");
var supa = require("./_lib/supa");
var h = require("./_lib/html");

var EVENTS = { view: 1, website: 1, phone: 1, directions: 1 };
var DEDUPE_MS = 30 * 60 * 1000;
var MAX_ENTRIES = 20000;
var seen = new Map(); // hash -> expiry ms
var SALT = crypto.randomBytes(16).toString("hex"); // new every process start

var BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python-requests|monitor|uptime/i;

function isBot(ua) { return !ua || BOT_RE.test(String(ua)); }

function clientAddr(req) {
  var xff = req.headers && req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "";
}

// true the first time this visitor does this in the window.
function firstTime(req, id, event) {
  var now = Date.now();
  if (seen.size > MAX_ENTRIES) {
    seen.forEach(function (exp, k) { if (exp < now) seen.delete(k); });
    if (seen.size > MAX_ENTRIES) seen.clear();
  }
  var key = crypto.createHash("sha256").update(SALT + "|" + clientAddr(req) + "|" + id + "|" + event).digest("hex");
  var exp = seen.get(key);
  if (exp && exp > now) return false;
  seen.set(key, now + DEDUPE_MS);
  return true;
}

// Shared with api/listing.js so a server-rendered page view counts the same way.
async function record(req, id, event) {
  if (!supa.serviceKey()) return false;
  if (!h.UUID_RE.test(String(id)) || !EVENTS[event]) return false;
  if (isBot(req.headers && req.headers["user-agent"])) return false;
  if (req.headers && String(req.headers.dnt) === "1") return false; // honour Do Not Track
  if (!firstTime(req, id, event)) return false;
  var r = await supa.rest("rpc/record_listing_event", { method: "POST", service: true, body: { p_business_id: id, p_event: event } });
  return r.ok;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.status(405).json({ ok: false }); return; }
  var body = req.body && typeof req.body === "object" ? req.body : {};
  try { await record(req, String(body.id || ""), String(body.event || "")); } catch (e) { /* counting never breaks a page */ }
  res.status(204).send("");
};
module.exports.record = record;
module.exports._test = { isBot: isBot, firstTime: firstTime };
