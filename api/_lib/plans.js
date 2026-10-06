// api/_lib/plans.js
// The sponsorship plans: the one place names, prices and perks are defined.
// Prices here are what the site SHOWS; what Stripe CHARGES is the Stripe
// price each plan points at (env var), so change both together.
// Placeholder pricing until the masjid sets real numbers.
var PLANS = [
  {
    id: "spotlight",
    name: "Spotlight",
    price: 19,
    priceEnv: "STRIPE_PRICE_SPOTLIGHT",
    perks: ["A “Sponsored” label on your listing", "Shown first in matching search results"]
  },
  {
    id: "featured",
    name: "Featured",
    price: 39,
    priceEnv: "STRIPE_PRICE_FEATURED",
    perks: ["Everything in Spotlight", "A place in “Featured this month” on the home page"]
  }
];

function byId(id) { return PLANS.filter(function (p) { return p.id === id; })[0] || null; }
function priceId(plan, env) { return (env || process.env)[plan.priceEnv] || null; }
// Which plan a Stripe price belongs to (plans can change in the billing portal).
function byPrice(price, env) {
  return PLANS.filter(function (p) { return priceId(p, env) && priceId(p, env) === price; })[0] || null;
}
function configured(env) {
  env = env || process.env;
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && PLANS.every(function (p) { return priceId(p, env); }));
}
// What the browser gets: no env var names or price ids.
function publicPlans() {
  return PLANS.map(function (p) { return { id: p.id, name: p.name, price: p.price, perks: p.perks }; });
}

module.exports = { PLANS: PLANS, byId: byId, byPrice: byPrice, priceId: priceId, configured: configured, publicPlans: publicPlans };
