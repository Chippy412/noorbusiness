// api/_lib/stripe.js
// Minimal Stripe REST client (no SDK, so the project keeps zero npm
// dependencies), webhook signature checking, and the signed-in-user lookup
// the billing routes share. The API version is pinned so response shapes
// (e.g. subscription.current_period_end) don't move under us.
var crypto = require("crypto");
var supa = require("./supa");

var API_VERSION = "2024-06-20";

// {a: 1, b: {c: 2}, d: [{e: 3}]} -> "a=1&b[c]=2&d[0][e]=3", Stripe's form encoding.
function form(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (v === undefined || v === null) return;
    var key = prefix ? prefix + "[" + k + "]" : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  });
  return out.join("&");
}

async function call(method, path, params) {
  var res = await fetch("https://api.stripe.com/v1/" + path, {
    method: method,
    headers: {
      Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": API_VERSION
    },
    body: params ? form(params) : undefined
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var err = new Error((data.error && data.error.message) || "Stripe request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]. HMAC-SHA256 of "<t>.<raw body>".
function verifySignature(rawBody, header, secret, nowSeconds, tolerance) {
  if (!header || !secret) return false;
  var parts = String(header).split(",").map(function (p) { return p.split("="); });
  var t = (parts.filter(function (p) { return p[0] === "t"; })[0] || [])[1];
  var sigs = parts.filter(function (p) { return p[0] === "v1"; }).map(function (p) { return p[1]; });
  if (!t || !sigs.length) return false;
  var now = nowSeconds == null ? Math.floor(Date.now() / 1000) : nowSeconds;
  if (Math.abs(now - Number(t)) > (tolerance || 300)) return false;
  var expected = Buffer.from(crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest("hex"));
  return sigs.some(function (s) {
    var b = Buffer.from(String(s));
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}

// The signed-in site user, from the Supabase access token the page sends.
async function currentUser(req) {
  var auth = String(req.headers.authorization || "");
  var m = auth.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  try {
    var res = await fetch(supa.baseUrl() + "/auth/v1/user", {
      headers: { apikey: supa.anonKey(), Authorization: "Bearer " + m[1] }
    });
    if (!res.ok) return null;
    var u = await res.json();
    return u && u.id ? { id: u.id, email: u.email || null } : null;
  } catch (e) { return null; }
}

function siteUrl() {
  return (process.env.SITE_URL || "https://nicc-business.vercel.app").replace(/\/$/, "");
}

module.exports = { call: call, form: form, verifySignature: verifySignature, currentUser: currentUser, siteUrl: siteUrl, API_VERSION: API_VERSION };
