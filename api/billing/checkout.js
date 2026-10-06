// api/billing/checkout.js
// POST {business_id, plan} with  Authorization: Bearer <Supabase access token>.
// Opens a Stripe Checkout session for a monthly sponsorship and answers {url}.
// Only the listing's owner can sponsor it, and only once it's approved.
var html = require("../_lib/html");
var plans = require("../_lib/plans");
var stripe = require("../_lib/stripe");
var supa = require("../_lib/supa");

var LIVE = ["active", "trialing", "past_due"];

function parseBody(req) {
  var b = req.body;
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return null; } }
  return b && typeof b === "object" ? b : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  if (!plans.configured() || !supa.serviceKey()) { res.status(503).json({ ok: false, error: "not_configured" }); return; }

  var body = parseBody(req) || {};
  var plan = plans.byId(body.plan);
  var businessId = String(body.business_id || "");
  if (!plan || !html.UUID_RE.test(businessId)) { res.status(400).json({ ok: false, error: "invalid" }); return; }

  var user = await stripe.currentUser(req);
  if (!user) { res.status(401).json({ ok: false, error: "login_required" }); return; }

  var b = await supa.rest("businesses?select=id,name,status,owner_id&id=eq." + businessId, { service: true });
  var biz = b.ok && Array.isArray(b.data) ? b.data[0] : null;
  if (!biz || biz.owner_id !== user.id) { res.status(404).json({ ok: false, error: "not_found" }); return; }
  if (biz.status !== "approved") { res.status(409).json({ ok: false, error: "not_approved" }); return; }

  var s = await supa.rest("sponsorships?select=stripe_customer_id,payer_id,paid_status,paid_until&business_id=eq." + businessId, { service: true });
  var current = s.ok && Array.isArray(s.data) ? s.data[0] : null;
  if (current && LIVE.indexOf(current.paid_status) !== -1 && new Date(current.paid_until) > new Date()) {
    res.status(409).json({ ok: false, error: "already_sponsored" }); return;
  }

  var meta = { business_id: businessId, payer_id: user.id, plan: plan.id };
  var site = stripe.siteUrl();
  try {
    var session = await stripe.call("POST", "checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: plans.priceId(plan), quantity: 1 }],
      client_reference_id: businessId,
      customer: current && current.payer_id === user.id && current.stripe_customer_id ? current.stripe_customer_id : undefined,
      customer_email: current && current.payer_id === user.id && current.stripe_customer_id ? undefined : user.email || undefined,
      metadata: meta,
      subscription_data: { metadata: meta, description: plan.name + " sponsorship: " + String(biz.name).slice(0, 200) },
      allow_promotion_codes: "true",
      success_url: site + "/#/account?billing=success",
      cancel_url: site + "/#/account?billing=cancelled"
    });
    res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    console.error("checkout: Stripe refused", e.status, e.message);
    res.status(502).json({ ok: false, error: "stripe_failed" });
  }
};
