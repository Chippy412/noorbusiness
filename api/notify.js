// api/notify.js
// Emails the volunteers when something needs moderating. Wire it up once
// in Supabase: Database > Webhooks > Create webhook, for INSERT on each of
// businesses, claims, reviews and contact_messages, method POST, URL
// https://<your-site>/api/notify, with the HTTP header
//   Authorization: Bearer <NOTIFY_SECRET>
// Env vars (Vercel): NOTIFY_SECRET, RESEND_API_KEY, NOTIFY_EMAIL_TO,
// NOTIFY_EMAIL_FROM (a sender verified in Resend).
var html = require("./_lib/html");

var LABELS = {
  businesses: "New business listing to review",
  claims: "New listing claim to review",
  reviews: "New review to review",
  contact_messages: "New contact message"
};

function summarize(table, r) {
  if (table === "businesses") return "Name: " + r.name + "\nCategory: " + r.category + "\nNeighborhood: " + r.neighborhood + "\nStatus: " + r.status;
  if (table === "claims") return "Business id: " + r.business_id + "\nNote: " + (r.note || "(none)");
  if (table === "reviews") return "By: " + r.author_name + "\nRating: " + r.rating + "/5\n\n" + r.body;
  if (table === "contact_messages") return "From: " + r.name + " <" + r.email + ">\nSubject: " + (r.subject || "(none)") + "\n\n" + r.message;
  return JSON.stringify(r);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }
  var secret = process.env.NOTIFY_SECRET;
  var auth = req.headers.authorization || "";
  if (!secret || auth !== "Bearer " + secret) { res.status(401).json({ ok: false }); return; }

  var key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL_TO, from = process.env.NOTIFY_EMAIL_FROM;
  if (!key || !to || !from) { res.status(503).json({ ok: false, error: "not_configured" }); return; }

  var payload = req.body;
  if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }
  var isInsert = payload && payload.type === "INSERT";
  // An UPDATE only matters for a listing that an owner edit just sent back to review.
  var isRequeue = payload && payload.type === "UPDATE" && payload.table === "businesses" && payload.record && payload.record.status === "pending";
  if (!payload || !payload.record || !LABELS[payload.table] || !(isInsert || isRequeue)) {
    res.status(200).json({ ok: true, skipped: true }); return;
  }

  var subject = isRequeue ? "Edited listing needs re-review (hidden until approved)" : LABELS[payload.table];
  var text = summarize(payload.table, payload.record) + "\n\nModerate it in the Supabase Table Editor (" + payload.table + ").";
  try {
    var r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: to.split(",").map(function (s) { return s.trim(); }), subject: "[NICC Business] " + subject, text: text })
    });
    if (!r.ok) console.error("notify: Resend rejected the email", r.status, await r.text());
    res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch (e) {
    console.error("notify: could not reach Resend", e && e.message);
    res.status(502).json({ ok: false });
  }
};
module.exports._test = { summarize: summarize, esc: html.esc };
