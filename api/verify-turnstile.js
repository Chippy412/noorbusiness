// api/verify-turnstile.js
// Verifies a Turnstile response token server-side. The client-side widget
// alone can't be trusted -- a bot can just skip loading it or replay an old
// token -- so anything gating a real write (account creation, a listing
// submission) must confirm the token with Cloudflare before proceeding.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  var secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    res.status(500).json({ success: false, error: "Turnstile is not configured on the server." });
    return;
  }

  var body = req.body || {};
  var token = typeof body === "string" ? JSON.parse(body).token : body.token;
  if (!token || typeof token !== "string") {
    res.status(400).json({ success: false, error: "Missing token." });
    return;
  }

  var params = new URLSearchParams();
  params.append("secret", secret);
  params.append("response", token);
  var ip = req.headers["x-forwarded-for"];
  if (ip) params.append("remoteip", String(ip).split(",")[0].trim());

  try {
    var verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });
    var data = await verifyRes.json();
    res.status(200).json({ success: !!data.success });
  } catch (e) {
    res.status(502).json({ success: false, error: "Could not reach Turnstile." });
  }
};
