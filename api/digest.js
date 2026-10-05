// api/digest.js
// Daily summary for the volunteers: how much is waiting on the moderation
// page. Run by a Vercel cron (see "crons" in vercel.json). Vercel sends
// Authorization: Bearer <CRON_SECRET> on cron calls, so set CRON_SECRET in the
// project's environment variables. Sends nothing when the queue is empty.
// Also needs RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM and
// SUPABASE_SERVICE_ROLE_KEY (the same ones api/notify.js uses).
var supa = require("./_lib/supa");
var mail = require("./_lib/mail");

var QUEUES = [
  { key: "businesses", label: "New listings", path: "businesses?select=id&status=eq.pending&limit=1000" },
  { key: "business_edits", label: "Edits to live listings", path: "business_edits?select=business_id&limit=1000" },
  { key: "claims", label: "Claims", path: "claims?select=id&status=eq.pending&limit=1000" },
  { key: "reviews", label: "Reviews", path: "reviews?select=id&status=eq.pending&limit=1000" }
];

function digestText(counts, newMessages) {
  var lines = [];
  QUEUES.forEach(function (q) { if (counts[q.key]) lines.push(q.label + ": " + counts[q.key]); });
  if (newMessages) lines.push("Contact messages in the last 24 hours: " + newMessages);
  return lines.join("\n") + "\n\nReview them at https://nicc-business.vercel.app/#/admin";
}
function total(counts, newMessages) {
  return QUEUES.reduce(function (n, q) { return n + (counts[q.key] || 0); }, 0) + (newMessages || 0);
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.authorization || "") !== "Bearer " + secret) { res.status(401).json({ ok: false }); return; }
  if (!supa.serviceKey() || !process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL_TO || !process.env.NOTIFY_EMAIL_FROM) {
    res.status(503).json({ ok: false, error: "not_configured" }); return;
  }
  try {
    var counts = {};
    for (var i = 0; i < QUEUES.length; i++) {
      var r = await supa.rest(QUEUES[i].path, { service: true });
      counts[QUEUES[i].key] = r.ok && Array.isArray(r.data) ? r.data.length : 0;
    }
    var since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    var m = await supa.rest("contact_messages?select=id&created_at=gte." + encodeURIComponent(since) + "&limit=1000", { service: true });
    var newMessages = m.ok && Array.isArray(m.data) ? m.data.length : 0;

    var n = total(counts, newMessages);
    if (!n) { res.status(200).json({ ok: true, sent: false }); return; }
    var sent = await mail.send(n + (n === 1 ? " item" : " items") + " waiting for review", digestText(counts, newMessages));
    res.status(sent.ok ? 200 : 502).json({ ok: sent.ok, sent: sent.ok, items: n });
  } catch (e) {
    console.error("digest failed", e && e.message);
    res.status(502).json({ ok: false });
  }
};
module.exports._test = { digestText: digestText, total: total };
