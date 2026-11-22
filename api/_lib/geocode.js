// api/_lib/geocode.js
// Address or ZIP -> {lat, lng, label}. Tries the US Census Bureau geocoder
// first (free, no key, good at full US street addresses), then OpenStreetMap
// Nominatim (handles ZIP codes and looser text; its usage policy asks for an
// identifying User-Agent and light use, which the callers keep to).

// Neighborhoods that are their own cities; the rest of the directory's
// neighborhoods are inside Columbus.
var CITIES = { "Dublin": "Dublin", "Westerville": "Westerville", "Hilliard": "Hilliard" };
var UA = "NICC-Business-directory/1.0 (+https://noorbusiness.org)";

// A listing's address often leaves out the city and state ("1 Main St").
function withContext(address, neighborhood) {
  var a = String(address || "").trim();
  if (!a) return "";
  if (/\b(OH|Ohio)\b/i.test(a) || /\b\d{5}(-\d{4})?\s*$/.test(a)) return a;
  return a + ", " + (CITIES[neighborhood] || "Columbus") + ", OH";
}

function inRange(lat, lng) {
  return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

async function census(text, fetchFn) {
  var url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(text);
  var r = await fetchFn(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  var d = await r.json();
  var m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
  if (!m || !m.coordinates) return null;
  var lat = Number(m.coordinates.y), lng = Number(m.coordinates.x);
  return inRange(lat, lng) ? { lat: lat, lng: lng, label: String(m.matchedAddress || text) } : null;
}

async function nominatim(text, fetchFn) {
  // viewbox nudges results toward central Ohio without excluding elsewhere.
  var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&viewbox=-83.45,40.35,-82.55,39.75&q=" + encodeURIComponent(text);
  var r = await fetchFn(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!r.ok) return null;
  var d = await r.json();
  var m = Array.isArray(d) && d[0];
  if (!m) return null;
  var lat = Number(m.lat), lng = Number(m.lon);
  return inRange(lat, lng) ? { lat: lat, lng: lng, label: String(m.display_name || text).replace(/, United States$/, "") } : null;
}

// Resolves {lat, lng, label} or null. Never throws for "not found"; network
// errors propagate so callers can tell "no such place" from "try again".
async function geocode(text, fetchFn) {
  fetchFn = fetchFn || fetch;
  var q = String(text || "").trim().slice(0, 200);
  if (!q) return null;
  if (!/^\d{5}$/.test(q)) {
    var hit = await census(q, fetchFn);
    if (hit) return hit;
  }
  return nominatim(q, fetchFn);
}

module.exports = { geocode: geocode, withContext: withContext };
