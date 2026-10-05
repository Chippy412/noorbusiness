// api/submit.js
// Server-side entry point for the two public, no-login forms: the contact
// form and the footer newsletter signup. The old flow inserted from the
// browser with the public anon key, so a bot could skip Turnstile, the
// honeypot and every other client-side check by calling Supabase directly.
// Here the Turnstile token is verified on the server and writes use the
// service-role key, with per-sender (hashed IP) and per-email rate limits.
//
// If SUPABASE_SERVICE_ROLE_KEY isn't set yet this answers 503 with
// {error:"not_configured"}; the page then falls back to the old direct
// insert so the forms keep working until the key is added.
var crypto = require("crypto");
var supa = require("./_lib/supa");

// Deliberately stricter than the RFC: no characters that mean something in
// a mailto: link or HTML (? & = < > " ' etc.), since volunteers reply to
// these addresses from the moderation page.
var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function clientIp(req) {
  var fwd = req.headers["x-forwarded-for"];
  return fwd ? String(fwd).split(",")[0].trim() : (req.socket && req.socket.remoteAddress) || "";
}
function hashIp(ip) {
  var salt = process.env.IP_HASH_SALT || supa.serviceKey() || "nicc";
  return crypto.createHash("sha256").update(salt + "|" + ip).digest("hex").slice(0, 32);
}
function parseBody(req) {
  var b = req.body;
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return null; } }
  return b && typeof b === "object" ? b : null;
}
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }

// Resolves {ok, codes}. codes are Cloudflare's error-codes (or "missing-token"
// / "unreachable") so a rejected form can say why.
async function verifyTurnstile(token, ip) {
  var secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, codes: [] }; // Turnstile not configured on this deployment
  if (!token || typeof token !== "string") return { ok: false, codes: ["missing-token"] };
  var params = new URLSearchParams();
  params.append("secret", secret);
  params.append("response", token);
  if (ip) params.append("remoteip", ip);
  try {
    var r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: params });
    var data = await r.json();
    return { ok: !!data.success, codes: data["error-codes"] || [] };
  } catch (e) { return { ok: false, codes: ["unreachable"] }; }
}

async function recentCount(table, filter) {
  var since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  var r = await supa.rest(table + "?select=id&created_at=gte." + encodeURIComponent(since) + filter + "&limit=50", { service: true });
  return r.ok && Array.isArray(r.data) ? r.data.length : 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  if (!supa.serviceKey()) { res.status(503).json({ ok: false, error: "not_configured" }); return; }

  var body = parseBody(req);
  if (!body) { res.status(400).json({ ok: false, error: "bad_request" }); return; }

  // Honeypot: pretend success so bots learn nothing.
  if (str(body.company, 200) || str(body.website_alt, 200)) { res.status(200).json({ ok: true }); return; }

  var ip = clientIp(req);
  var ipHash = hashIp(ip);

  if (body.type === "contact") {
    var name = str(body.name, 120), email = str(body.email, 254), subject = str(body.subject, 200), message = str(body.message, 5000);
    if (!name || !EMAIL_RE.test(email) || !message) { res.status(400).json({ ok: false, error: "invalid" }); return; }
    var ts = await verifyTurnstile(body.token, ip);
    if (!ts.ok) { res.status(400).json({ ok: false, error: "captcha", codes: ts.codes }); return; }
    if ((await recentCount("contact_messages", "&ip_hash=eq." + ipHash)) >= 5 ||
        (await recentCount("contact_messages", "&email=eq." + encodeURIComponent(email))) >= 3) {
      res.status(429).json({ ok: false, error: "rate_limited" }); return;
    }
    var ins = await supa.rest("contact_messages", {
      service: true, method: "POST", headers: { Prefer: "return=minimal" },
      body: { name: name, email: email, subject: subject || null, message: message, ip_hash: ipHash }
    });
    if (!ins.ok) { res.status(ins.status === 400 && /rate|Too many/i.test(JSON.stringify(ins.data)) ? 429 : 502).json({ ok: false, error: "store_failed" }); return; }
    res.status(200).json({ ok: true }); return;
  }

  if (body.type === "subscribe") {
    var subEmail = str(body.email, 254);
    if (!EMAIL_RE.test(subEmail)) { res.status(400).json({ ok: false, error: "invalid" }); return; }
    if ((await recentCount("subscribers", "&ip_hash=eq." + ipHash)) >= 5) { res.status(429).json({ ok: false, error: "rate_limited" }); return; }
    var sub = await supa.rest("subscribers", {
      service: true, method: "POST", headers: { Prefer: "return=minimal" },
      body: { email: subEmail, ip_hash: ipHash }
    });
    // 409 = already subscribed (unique index). Treat as success; don't reveal who's on the list.
    if (!sub.ok && sub.status !== 409) { res.status(502).json({ ok: false, error: "store_failed" }); return; }
    res.status(200).json({ ok: true }); return;
  }

  res.status(400).json({ ok: false, error: "unknown_type" });
};
module.exports._test = { hashIp: hashIp, EMAIL_RE: EMAIL_RE };
