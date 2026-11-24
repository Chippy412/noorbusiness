// api/notify.js
// Emails the volunteers when something needs moderating. Called by the
// notify_volunteers() database trigger (supabase/migrations/
// 2026-10-04-notify-triggers.sql) with  Authorization: Bearer <NOTIFY_SECRET>.
// Env vars: NOTIFY_SECRET, AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY,
// AWS_SES_REGION (default us-east-1), NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM (an
// address on a verified SES identity, e.g. noorbusiness.org).
var ses = require("./_lib/ses");
var html = require("./_lib/html");
var supa = require("./_lib/supa");
var SITE = (process.env.SITE_URL || "https://noorbusiness.org").replace(/\/$/, "");

var LABELS = {
  businesses: "New business listing to review",
  claims: "New listing claim to review",
  reviews: "New review to review",
  contact_messages: "New contact message",
  business_edits: "Edited listing awaiting review (the live version is unchanged)",
  reports: "A visitor reported a problem"
};
var REPORT_REASONS = { closed: "Closed or moved", wrong_info: "Wrong information", inappropriate: "Inappropriate", spam: "Spam or fake", other: "Something else" };

// Who gets the alert: NOTIFY_EMAIL_TO, plus every moderator and volunteer on
// the team.
async function recipients(env, loadTeam) {
  var list = String(env.NOTIFY_EMAIL_TO || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  try { list = list.concat(await loadTeam()); } catch (e) { /* fall back to NOTIFY_EMAIL_TO */ }
  var seen = {};
  return list.filter(function (e) {
    var k = String(e).toLowerCase();
    if (!e || seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

// A decision for one person (owner_notices, see 2026-10-10-moderation-tools.sql).
async function loadNoticeEmail(id) {
  if (!supa.serviceKey() || !html.UUID_RE.test(String(id || ""))) return null;
  var r = await supa.rest("rpc/notice_email", { service: true, method: "POST", body: { p_notice: id } });
  return r.ok && typeof r.data === "string" && r.data ? r.data : null;
}
function noticeText(r) {
  return r.title + "." + (r.reason ? "\n\nNote from the volunteer team:\n" + r.reason : "") +
    "\n\nSee your listings and reviews at " + SITE + "/#/account" +
    "\n\nYou're getting this because you have an account on NICC Business.";
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
  if (table === "reports") return "Listing id: " + r.business_id + (r.review_id ? "\nAbout a review: " + r.review_id : "") +
    "\nReason: " + (REPORT_REASONS[r.reason] || r.reason) + "\n\n" + (r.details || "(no details)");
  return JSON.stringify(r);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }
  var secret = process.env.NOTIFY_SECRET;
  var auth = req.headers.authorization || "";
  if (!secret || auth !== "Bearer " + secret) { res.status(401).json({ ok: false }); return; }

  var key = process.env.AWS_SES_ACCESS_KEY_ID && process.env.AWS_SES_SECRET_ACCESS_KEY, to = process.env.NOTIFY_EMAIL_TO, from = process.env.NOTIFY_EMAIL_FROM;
  if (!key || !to || !from) { res.status(503).json({ ok: false, error: "not_configured" }); return; }

  var payload = req.body;
  if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }

  if (payload && payload.table === "owner_notices" && payload.type === "INSERT" && payload.record) {
    var person = await loadNoticeEmail(payload.record.id);
    if (!person) { res.status(200).json({ ok: true, skipped: true }); return; }
    var sent = await send({ from: from, to: [person], subject: "[NICC Business] " + String(payload.record.title || "An update on your account").slice(0, 150), text: noticeText(payload.record) });
    res.status(sent ? 200 : 502).json({ ok: sent }); return;
  }
  var okType = payload && (payload.type === "INSERT" || (payload.type === "UPDATE" && payload.table === "business_edits"));
  if (!payload || !payload.record || !LABELS[payload.table] || !okType) {
    res.status(200).json({ ok: true, skipped: true }); return;
  }

  var subject = LABELS[payload.table];
  var text = summarize(payload.table, payload.record) + "\n\nModerate it at " + SITE + "/#/admin";
  var ok = await send({ from: from, to: await recipients(process.env, loadTeamEmails), subject: "[NICC Business] " + subject, text: text });
  res.status(ok ? 200 : 502).json({ ok: ok });
};

async function send(email) {
  var r = await ses.sendEmail(email);
  if (!r.ok) console.error("notify: SES did not send the email:", r.error);
  return r.ok;
}
module.exports._test = { summarize: summarize, esc: html.esc, recipients: recipients, noticeText: noticeText };
