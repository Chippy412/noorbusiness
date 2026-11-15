// api/guide.js
// GET with  Authorization: Bearer <a team member's Supabase access token>.
// Answers the team handbook (api/_lib/guide/team.html); moderators also get the
// operations section (operations.html). Anyone else gets 403. The handbook is
// kept out of the public site so the server layout isn't advertised, but it
// holds no secrets: never put a password, key or key file in these fragments.
var fs = require("fs");
var path = require("path");
var supa = require("./_lib/supa");

var DIR = path.join(__dirname, "_lib", "guide");

function read(name) { return fs.readFileSync(path.join(DIR, name), "utf8"); }

function token(req) {
  var m = String((req.headers && req.headers.authorization) || "").match(/^Bearer\s+(\S+)$/);
  return m ? m[1] : null;
}

async function check(fn, jwt) {
  var r = await supa.rest("rpc/" + fn, { method: "POST", body: {}, headers: { Authorization: "Bearer " + jwt } });
  return r.ok && r.data === true;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ ok: false }); return; }
  var jwt = token(req);
  if (!jwt) { res.status(403).json({ ok: false, error: "team_only" }); return; }
  try {
    var results = await Promise.all([check("is_admin", jwt), check("is_moderator", jwt)]);
    var admin = results[0], moderator = results[1];
    if (!admin && !moderator) { res.status(403).json({ ok: false, error: "team_only" }); return; }
    var out = read("team.html");
    if (moderator) out += "\n" + read("operations.html");
    res.status(200).json({ ok: true, html: out });
  } catch (e) {
    res.status(502).json({ ok: false, error: "unavailable" });
  }
};
