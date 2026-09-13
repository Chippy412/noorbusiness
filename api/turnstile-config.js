// api/turnstile-config.js
// Hands the client the Turnstile site key at runtime, so it never has to be
// committed to the repo or baked into the static HTML. The site key isn't
// secret (Cloudflare expects it to be visible to the browser), but keeping
// it in Vercel's env vars means both keys live in one place and can rotate
// without a code change.
module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({ siteKey: process.env.TURNSTILE_SITE_KEY || null });
};
