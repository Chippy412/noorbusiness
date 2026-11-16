// api/_lib/ses.js
// Sends email through the Amazon SES v2 HTTP API. No dependencies: requests
// are signed with AWS Signature Version 4 using node:crypto.
// Env vars: AWS_SES_REGION (default us-east-1), AWS_SES_ACCESS_KEY_ID,
// AWS_SES_SECRET_ACCESS_KEY. The IAM user needs only ses:SendEmail.
var crypto = require("node:crypto");

function hmac(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256hex(data) { return crypto.createHash("sha256").update(data, "utf8").digest("hex"); }

function deriveSigningKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
}

// Signs a request. opts: method, host, path, query (already encoded, sorted),
// headers (extra headers to sign; host and x-amz-date are added), body,
// region, service, accessKeyId, secretAccessKey, amzDate (YYYYMMDDTHHMMSSZ).
// Returns { authorization, headers, signature, canonicalRequest, stringToSign }.
function signRequest(opts) {
  var amzDate = opts.amzDate, date = amzDate.slice(0, 8);
  var headers = { host: opts.host, "x-amz-date": amzDate };
  Object.keys(opts.headers || {}).forEach(function (k) { headers[k.toLowerCase()] = String(opts.headers[k]).trim(); });
  var names = Object.keys(headers).sort();
  var canonicalHeaders = names.map(function (n) { return n + ":" + headers[n] + "\n"; }).join("");
  var signedHeaders = names.join(";");
  var canonicalRequest = [opts.method, opts.path || "/", opts.query || "", canonicalHeaders, signedHeaders, sha256hex(opts.body || "")].join("\n");
  var scope = date + "/" + opts.region + "/" + opts.service + "/aws4_request";
  var stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  var signature = hmac(deriveSigningKey(opts.secretAccessKey, date, opts.region, opts.service), stringToSign).toString("hex");
  return {
    authorization: "AWS4-HMAC-SHA256 Credential=" + opts.accessKeyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
    headers: headers, signature: signature, canonicalRequest: canonicalRequest, stringToSign: stringToSign
  };
}

function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

// sendEmail({to, from, subject, text, html, replyTo}) -> { ok, id } | { ok:false, error }
async function sendEmail(m) {
  var env = process.env;
  var key = env.AWS_SES_ACCESS_KEY_ID, secret = env.AWS_SES_SECRET_ACCESS_KEY;
  var region = env.AWS_SES_REGION || "us-east-1";
  if (!key || !secret) return { ok: false, error: "not_configured" };
  m = m || {};
  var to = toList(m.to);
  if (!to.length || !m.from || !m.subject || (!m.text && !m.html)) return { ok: false, error: "invalid_message" };

  var content = { Subject: { Data: String(m.subject), Charset: "UTF-8" }, Body: {} };
  if (m.text) content.Body.Text = { Data: String(m.text), Charset: "UTF-8" };
  if (m.html) content.Body.Html = { Data: String(m.html), Charset: "UTF-8" };
  var payload = { FromEmailAddress: m.from, Destination: { ToAddresses: to }, Content: { Simple: content } };
  var reply = toList(m.replyTo);
  if (reply.length) payload.ReplyToAddresses = reply;
  var json = JSON.stringify(payload);

  var host = "email." + region + ".amazonaws.com", path = "/v2/email/outbound-emails";
  var amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  var signed = signRequest({
    method: "POST", host: host, path: path, query: "", body: json, region: region, service: "ses",
    accessKeyId: key, secretAccessKey: secret, amzDate: amzDate,
    headers: { "content-type": "application/json" }
  });
  try {
    var r = await fetch("https://" + host + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Amz-Date": amzDate, Authorization: signed.authorization },
      body: json
    });
    var text = await r.text();
    var data = null;
    try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!r.ok) return { ok: false, error: "ses_" + r.status + ": " + String((data && (data.message || data.Message)) || text).slice(0, 300) };
    return { ok: true, id: data && data.MessageId };
  } catch (e) {
    return { ok: false, error: "network: " + (e && e.message) };
  }
}

module.exports = { sendEmail: sendEmail, signRequest: signRequest, deriveSigningKey: deriveSigningKey };
