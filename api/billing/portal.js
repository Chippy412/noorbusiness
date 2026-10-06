// api/billing/portal.js
// POST {business_id} with  Authorization: Bearer <Supabase access token>.
// Opens Stripe's billing portal (change plan, update card, cancel) for the
// person paying for that listing's sponsorship. Answers {url}.
var html = require("../_lib/html");
var plans = require("../_lib/plans");
var stripe = require("../_lib/stripe");
var supa = require("../_lib/supa");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  if (!plans.configured() || !supa.serviceKey()) { res.status(503).json({ ok: false, error: "not_configured" }); return; }

  var body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  var businessId = String((body && body.business_id) || "");
  if (!html.UUID_RE.test(businessId)) { res.status(400).json({ ok: false, error: "invalid" }); return; }

  var user = await stripe.currentUser(req);
  if (!user) { res.status(401).json({ ok: false, error: "login_required" }); return; }

  var s = await supa.rest("sponsorships?select=stripe_customer_id,payer_id&business_id=eq." + businessId, { service: true });
  var row = s.ok && Array.isArray(s.data) ? s.data[0] : null;
  if (!row || row.payer_id !== user.id || !row.stripe_customer_id) { res.status(404).json({ ok: false, error: "not_found" }); return; }

  try {
    var portal = await stripe.call("POST", "billing_portal/sessions", {
      customer: row.stripe_customer_id,
      return_url: stripe.siteUrl() + "/#/account"
    });
    res.status(200).json({ ok: true, url: portal.url });
  } catch (e) {
    console.error("portal: Stripe refused", e.status, e.message);
    res.status(502).json({ ok: false, error: "stripe_failed" });
  }
};
