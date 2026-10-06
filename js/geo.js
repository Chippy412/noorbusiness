// Small distance helpers for the Explore "Distance from" feature.
// Plain script (exposed on window) and a CommonJS module so node:test can load it.
(function () {
  "use strict";

  var EARTH_RADIUS_MILES = 3958.8;

  function toRad(deg) { return deg * Math.PI / 180; }

  // Great-circle (haversine) distance in miles.
  function distanceMiles(lat1, lng1, lat2, lng2) {
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // "0.3 mi", "2.4 mi", "12 mi": one decimal under 10, whole numbers from 10 up.
  function formatMiles(mi) {
    if (typeof mi !== "number" || !isFinite(mi) || mi < 0) return "";
    if (mi < 9.95) return mi.toFixed(1) + " mi";
    return Math.round(mi) + " mi";
  }

  var api = { distanceMiles: distanceMiles, formatMiles: formatMiles };
  if (typeof window !== "undefined") window.NiccGeo = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
