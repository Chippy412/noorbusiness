// api/_lib/supa.js
// Tiny PostgREST helper for the serverless routes. The URL and anon key are
// the same public values js/supabase-client.js ships to every browser; the
// service-role key (secret) is only ever read from the environment.
var URL_FALLBACK = "https://jmqljbqvyhwdrxugbwun.supabase.co";
var ANON_FALLBACK = "sb_publishable_oeB4TfM31dlO6eEQmfMqJw_jEHTKmfn";

function baseUrl() { return (process.env.SUPABASE_URL || URL_FALLBACK).replace(/\/$/, ""); }
function anonKey() { return process.env.SUPABASE_ANON_KEY || ANON_FALLBACK; }
function serviceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY || null; }

async function rest(path, opts) {
  opts = opts || {};
  var key = opts.service ? serviceKey() : anonKey();
  var headers = Object.assign({
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json"
  }, opts.headers || {});
  var res = await fetch(baseUrl() + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  var text = await res.text();
  var data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data: data, headers: res.headers };
}

module.exports = { rest: rest, serviceKey: serviceKey, baseUrl: baseUrl };
