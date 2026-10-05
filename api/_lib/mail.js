// api/_lib/mail.js
// Shared by api/notify.js (per-event alerts) and api/digest.js (daily summary):
// who to email, and how to send through Resend.
var supa = require("./supa");

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

// Sends one plain-text email to the whole recipient list. Resolves {ok, status}.
async function send(subject, text) {
  var key = process.env.RESEND_API_KEY, from = process.env.NOTIFY_EMAIL_FROM;
  var r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: from, to: await recipients(process.env, loadTeamEmails), subject: "[NICC Business] " + subject, text: text })
  });
  if (!r.ok) console.error("mail: Resend rejected the email", r.status, await r.text());
  return { ok: r.ok, status: r.status };
}

module.exports = { recipients: recipients, loadTeamEmails: loadTeamEmails, send: send };
