// api/notify.js
// Emails the volunteers when something needs moderating. Called by the
// notify_volunteers() database trigger (supabase/migrations/
// 2026-10-04-notify-triggers.sql) with  Authorization: Bearer <NOTIFY_SECRET>.
// Env vars (Vercel): NOTIFY_SECRET, RESEND_API_KEY, NOTIFY_EMAIL_TO,
// NOTIFY_EMAIL_FROM (a sender verified in Resend, or onboarding@resend.dev).
var html = require("./_lib/html");
var supa = require("./_lib/supa");

var LABELS = {
  businesses: "New business listing to review",
  claims: "New listing claim to review",
  reviews: "New review to review",
  contact_messages: "New contact message",
  business_edits: "Edited listing awaiting review (the live version is unchanged)"
};

// Who gets the alert: NOTIFY_EMAIL_TO, plus every moderator and volunteer on
// the team once the sender is on a verified domain. Resend's test sender
// (onboarding@resend.dev) can only deliver to the account owner and rejects
// the whole email if any other recipient is included, so the team is only
// added when a real sender is configured.
async function recipients(env, loadTeam) {
  var list = String(env.NOTIFY_EMAIL_TO || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  var testSender = /@resend\.dev>?\s*$/i.test(String(env.NOTIFY_EMAIL_FROM || ""));
  if (!testSender) {
    try { list = list.concat(await loadTeam()); } catch (e) { /* fall back to NOTIFY_EMAIL_TO */ }
  }
  var seen = {};
  return list.filter(function (e) {
    var k = String(e).toLowerCase();
    if (!e || seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

async function loadTeamEmails() {
  if (!supa.serviceKey()) return [];
  var r = await supa.rest("rpc/notify_recipients", { service: true, method: "POST", body: {} });
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.map(function (x) { return typeof x === "string" ? x : x && x.notify_recipients; }).filter(Boolean);
}

function summarize(table, r) {
  if (table === "businesses") return "Name: " + r.name + "\nCategory: " + r.category + "\nNeighborhood: " + r.neighborhood + "\nStatus: " + r.status;
  if (table === "claims") return "Business id: " + r.business_id + "\nNote: " + (r.note || "(none)");
  if (table === "reviews") return "By: " + r.author_name + "\nRating: " + r.rating + "/5\n\n" + r.body;
  if (table === "contact_messages") return "From: " + r.name + " <" + r.email + ">\nSubject: " + (r.subject || "(none)") + "\n\n" + r.message;
  if (table === "business_edits") return "Listing id: " + r.business_id + "\nChanged fields: " + Object.keys(r.changes || {}).join(", ");
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
  var okType = payload && (payload.type === "INSERT" || (payload.type === "UPDATE" && payload.table === "business_edits"));
  if (!payload || !payload.record || !LABELS[payload.table] || !okType) {
    res.status(200).json({ ok: true, skipped: true }); return;
  }

  var subject = LABELS[payload.table];
  var text = summarize(payload.table, payload.record) + "\n\nModerate it at https://nicc-business.vercel.app/#/admin";
  try {
    var r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: await recipients(process.env, loadTeamEmails), subject: "[NICC Business] " + subject, text: text })
    });
    if (!r.ok) console.error("notify: Resend rejected the email", r.status, await r.text());
    res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch (e) {
    console.error("notify: could not reach Resend", e && e.message);
    res.status(502).json({ ok: false });
  }
};
module.exports._test = { summarize: summarize, esc: html.esc, recipients: recipients };
