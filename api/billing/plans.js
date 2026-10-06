// api/billing/plans.js
// GET: the sponsorship plans for the owner dashboard, and whether paying
// works yet on this deployment (Stripe keys and prices set).
var plans = require("../_lib/plans");
var supa = require("../_lib/supa");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ configured: plans.configured() && !!supa.serviceKey(), plans: plans.publicPlans() });
};
