// api/billing/webhook.js
// Stripe calls this when a sponsorship is bought, renews, changes plan, or
// ends. The signature is checked against STRIPE_WEBHOOK_SECRET over the raw
// request body. The event only says WHICH subscription changed: its current
// state is always fetched fresh from Stripe, so retried or out-of-order
// events can't roll a listing back. The database side is
// billing_apply_subscription() in 2026-10-11-sponsorship.sql.
var html = require("../_lib/html");
var plans = require("../_lib/plans");
var stripe = require("../_lib/stripe");
var supa = require("../_lib/supa");

var HANDLED = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"];

// The signature covers the exact bytes Stripe sent, so read the stream
// ourselves instead of using a parsed (re-serialized) body.
function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody.toString("utf8"));
  if (typeof req.rawBody === "string") return Promise.resolve(req.rawBody);
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// The subscription's state, as billing_apply_subscription() wants it.
function toRow(sub) {
  var meta = sub.metadata || {};
  var item = sub.items && sub.items.data && sub.items.data[0];
  var plan = (item && item.price && plans.byPrice(item.price.id)) || plans.byId(meta.plan);
  var end = sub.current_period_end || (item && item.current_period_end);
  if (!plan || !html.UUID_RE.test(String(meta.business_id || "")) || !end) return null;
  return {
    p_business: meta.business_id,
    p_payer: html.UUID_RE.test(String(meta.payer_id || "")) ? meta.payer_id : null,
    p_tier: plan.id,
    p_customer: typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id,
    p_subscription: sub.id,
    p_status: sub.status,
    p_period_end: new Date(end * 1000).toISOString(),
    p_cancel_at_period_end: !!sub.cancel_at_period_end
  };
}

async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }
  if (!plans.configured() || !supa.serviceKey()) { res.status(503).json({ ok: false, error: "not_configured" }); return; }

  var raw = await rawBody(req);
  if (!stripe.verifySignature(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    res.status(400).json({ ok: false, error: "bad_signature" }); return;
  }
  var event;
  try { event = JSON.parse(raw); } catch (e) { res.status(400).json({ ok: false }); return; }
  if (HANDLED.indexOf(event.type) === -1) { res.status(200).json({ ok: true, skipped: true }); return; }

  var obj = event.data && event.data.object;
  var subId = event.type === "checkout.session.completed" ? obj && obj.subscription : obj && obj.id;
  if (!subId) { res.status(200).json({ ok: true, skipped: true }); return; }

  try {
    var sub = await stripe.call("GET", "subscriptions/" + encodeURIComponent(subId));
    var row = toRow(sub);
    if (!row) {
      // Not one of ours (no listing in its metadata): acknowledge so Stripe stops retrying.
      res.status(200).json({ ok: true, skipped: true }); return;
    }
    var r = await supa.rest("rpc/billing_apply_subscription", { service: true, method: "POST", body: row });
    if (!r.ok) {
      console.error("webhook: database refused", r.status, JSON.stringify(r.data));
      // A deleted listing (P0002) or an unknown plan (22023) will never be
      // accepted: acknowledge. Anything else (e.g. the function isn't there
      // yet, PostgREST's own 404) must make Stripe retry.
      var code = r.data && r.data.code;
      res.status(code === "P0002" || code === "22023" ? 200 : 500).json({ ok: false }); return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("webhook: failed", e.status, e.message);
    res.status(500).json({ ok: false });
  }
}

module.exports = handler;
// Vercel: don't parse the body, the signature needs the raw bytes.
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { toRow: toRow };
