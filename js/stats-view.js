// js/stats-view.js
// Shared pieces for showing listing stats: number formatting, the "up 12% on
// the period before" line and the views-per-day bar chart. Used by the
// moderator Analytics tab (js/admin.js) and the owner's "How your listings
// are doing" card on the account page (js/owner-stats.js), so both look the
// same. Styles are the .mod-an-* rules in noor-business.html.
(function (root) {
  "use strict";

  var TZ = "America/New_York"; // listing_daily_stats counts days in New York time

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 + "%" : "–"; }
  function shortDay(iso) { return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  function change(now, before) {
    if (!before) return now ? "New this period" : "No change";
    var d = Math.round(((now - before) / before) * 100);
    return d === 0 ? "Same as before" : (d > 0 ? "Up " : "Down ") + Math.abs(d) + "% on the period before";
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    var mag = Math.pow(10, Math.floor(Math.log10(v))), f = v / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  }

  // Today's date (YYYY-MM-DD) in New York, and n days before an ISO date.
  function today(now) {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now || new Date());
    var get = function (t) { return p.filter(function (x) { return x.type === t; })[0].value; };
    return get("year") + "-" + get("month") + "-" + get("day");
  }
  function addDays(iso, n) {
    var d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Turns my_listing_stats() rows (only days with activity, any order) for
  // one or more listings into the same shape admin_listing_stats() returns:
  // { days, totals: {views, website, phone, directions, previous: {...}},
  //   daily: [{day, views, website, phone, directions}] oldest first, one per day }.
  // Rows should cover 2 * days so the previous period can be compared.
  function summarize(rows, days, now) {
    var end = today(now), from = addDays(end, -(days - 1)), prevFrom = addDays(end, -(2 * days - 1));
    var zero = function () { return { views: 0, website: 0, phone: 0, directions: 0 }; };
    var cur = zero(), prev = zero(), byDay = {};
    (rows || []).forEach(function (r) {
      var day = String(r.day).slice(0, 10);
      if (day > end || day < prevFrom) return;
      var v = { views: r.views || 0, website: r.website_clicks || 0, phone: r.phone_clicks || 0, directions: r.directions_clicks || 0 };
      var bucket = day >= from ? cur : prev;
      Object.keys(v).forEach(function (k) { bucket[k] += v[k]; });
      if (day >= from) {
        var d = byDay[day] || (byDay[day] = zero());
        Object.keys(v).forEach(function (k) { d[k] += v[k]; });
      }
    });
    var daily = [];
    for (var i = 0; i < days; i++) {
      var day = addDays(from, i), d = byDay[day] || zero();
      daily.push({ day: day, views: d.views, website: d.website, phone: d.phone, directions: d.directions });
    }
    cur.previous = prev;
    return { days: days, totals: cur, daily: daily };
  }

  function viewsChart(daily) {
    var W = 720, H = 220, L = 38, B = 26, T = 8, R = 4;
    var max = niceMax(Math.max.apply(null, daily.map(function (d) { return d.views; }).concat([1])));
    var slot = (W - L - R) / daily.length, bw = Math.max(2, slot * 0.7);
    var grid = [0, 0.5, 1].map(function (f) {
      var y = T + (H - T - B) * (1 - f);
      return '<line class="mod-an-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/>' +
        '<text class="mod-an-axis" x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + num(max * f) + "</text>";
    }).join("");
    var bars = daily.map(function (d, i) {
      var hgt = (H - T - B) * (d.views / max);
      return '<rect class="mod-an-bar" x="' + (L + i * slot + (slot - bw) / 2).toFixed(1) + '" y="' + (H - B - hgt).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + Math.max(hgt, d.views ? 2 : 0).toFixed(1) + '" rx="2"><title>' +
        esc(shortDay(d.day) + ": " + num(d.views) + (d.views === 1 ? " view" : " views")) + "</title></rect>";
    }).join("");
    var ticks = [0, Math.floor((daily.length - 1) / 2), daily.length - 1].filter(function (v, i, a) { return a.indexOf(v) === i; });
    var labels = ticks.map(function (i, k) {
      return '<text class="mod-an-axis" x="' + (L + i * slot + slot / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' +
        (k === 0 && ticks.length > 1 ? "start" : k === ticks.length - 1 && ticks.length > 1 ? "end" : "middle") + '">' + esc(shortDay(daily[i].day)) + "</text>";
    }).join("");
    return '<svg class="mod-an-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Views per day, ' +
      esc(shortDay(daily[0].day)) + " to " + esc(shortDay(daily[daily.length - 1].day)) + '">' + grid + bars + labels + "</svg>";
  }

  function tile(label, value, sub) {
    return '<div class="mod-an-tile"><p class="mod-an-label">' + label + '</p><p class="mod-an-value">' + value + '</p><p class="mod-an-sub">' + sub + "</p></div>";
  }

  var api = { esc: esc, num: num, pct: pct, shortDay: shortDay, change: change, niceMax: niceMax, today: today, addDays: addDays, summarize: summarize, viewsChart: viewsChart, tile: tile };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NiccStatsView = api;
})(typeof window !== "undefined" ? window : this);
