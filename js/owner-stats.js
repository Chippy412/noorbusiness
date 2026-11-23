// js/owner-stats.js
// "How your listings are doing" on the account page: views and website /
// phone / directions clicks for the signed-in owner's own live listings.
// Reads my_listing_stats() (owner or admin only, enforced in the database)
// and draws it the same way as the moderator Analytics tab.
(function () {
  "use strict";

  var SV = window.NiccStatsView;
  var RANGES = [7, 30, 90];

  function kindsList(t) {
    var clicks = t.website + t.phone + t.directions;
    var kinds = [["Website", t.website], ["Phone", t.phone], ["Directions", t.directions]];
    return '<ul class="mod-an-split">' + kinds.map(function (k) {
      return '<li><span class="mod-an-split-name">' + k[0] + '</span><span class="mod-an-track"><span class="mod-an-fill" style="width:' +
        (clicks ? Math.round((k[1] / clicks) * 100) : 0) + '%"></span></span>' +
        '<span class="mod-an-split-n">' + SV.num(k[1]) + '</span><span class="mod-an-split-pct">' + SV.pct(k[1], t.views) + " of views</span></li>";
    }).join("") + "</ul>";
  }

  // listings: [{ id, name, category }]; perListing: { id: summary } from SV.summarize.
  function panel(listings, perListing, all, days) {
    var esc = SV.esc, t = all.totals, prev = t.previous;
    var clicks = t.website + t.phone + t.directions, prevClicks = prev.website + prev.phone + prev.directions;
    var range = RANGES.map(function (n) {
      return '<button type="button" class="btn btn-sm ' + (days === n ? "btn-primary" : "btn-ghost") + '" data-stats-days="' + n + '" aria-pressed="' + (days === n) + '">' + n + " days</button>";
    }).join("");
    var head = '<div class="mod-an-bar-head"><p class="mod-intro">' +
      (listings.length > 1 ? "All " + listings.length + " of your live listings, last " : "Last ") + days +
      ' days. Only daily totals are counted: nothing about who visited is stored.</p><div class="mod-an-range" role="group" aria-label="Period">' + range + "</div></div>";
    var tiles = '<div class="mod-an-tiles">' +
      SV.tile("Views", SV.num(t.views), SV.change(t.views, prev.views)) +
      SV.tile("Clicks", SV.num(clicks), SV.change(clicks, prevClicks)) +
      SV.tile("Click rate", SV.pct(clicks, t.views), "Clicks per view") + "</div>";
    if (!t.views && !clicks) {
      return head + tiles + '<div class="mod-empty"><p class="mod-empty-title">No visits counted yet.</p>' +
        "<p>Counts start as people open your listing and tap its website, phone or directions. Share your listing link to get it seen.</p></div>";
    }
    var table = listings.length > 1
      ? '<section class="owner-stats-section"><h3>By listing</h3><div class="mod-an-tablewrap"><table class="mod-an-table"><thead><tr><th>Listing</th><th>Views</th><th>Website</th><th>Phone</th><th>Directions</th></tr></thead><tbody>' +
        listings.map(function (b) { return { b: b, t: perListing[b.id].totals }; })
          .sort(function (x, y) { return y.t.views - x.t.views; })
          .map(function (r) {
            return '<tr><th scope="row">' + esc(r.b.name) + '<span class="mod-an-cat">' + esc(r.b.category) + "</span></th><td>" + SV.num(r.t.views) + "</td><td>" +
              SV.num(r.t.website) + "</td><td>" + SV.num(r.t.phone) + "</td><td>" + SV.num(r.t.directions) + "</td></tr>";
          }).join("") + "</tbody></table></div></section>"
      : "";
    return head + tiles +
      '<section class="owner-stats-section"><h3>Views per day</h3>' + SV.viewsChart(all.daily) + "</section>" +
      '<section class="owner-stats-section"><h3>What people do next</h3><p class="mod-sub">Clicks on your website, phone number and directions, and how often per view.</p>' + kindsList(t) + "</section>" +
      table;
  }

  // card: the wrapper to show/hide; el: where the panel goes.
  // Returns a promise. Hides the card when the owner has no live listing.
  async function mount(card, el) {
    var listings;
    try {
      listings = (await window.NiccOwner.loadMyBusinesses()).filter(function (b) { return b.status === "approved"; });
    } catch (e) { card.hidden = true; return; }
    card.hidden = !listings.length;
    if (!listings.length) return;
    var days = 30, seq = 0;

    async function load() {
      var mine = ++seq;
      el.setAttribute("aria-busy", "true");
      try {
        var results = await Promise.all(listings.map(function (b) { return window.NiccOwner.loadListingStats(b.id, days * 2); }));
        if (mine !== seq) return;
        var perListing = {}, allRows = [];
        listings.forEach(function (b, i) {
          perListing[b.id] = SV.summarize(results[i], days);
          allRows = allRows.concat(results[i]);
        });
        el.innerHTML = panel(listings, perListing, SV.summarize(allRows, days), days);
      } catch (e) {
        if (mine !== seq) return;
        el.innerHTML = '<p style="color:var(--muted)">Could not load your stats right now. Please try again later.</p>';
      } finally {
        if (mine === seq) el.removeAttribute("aria-busy");
      }
    }
    if (!el._statsWired) {
      el._statsWired = true;
      el.addEventListener("click", function (e) {
        var b = e.target.closest("[data-stats-days]");
        if (!b || !el._statsSet) return;
        el._statsSet(Number(b.getAttribute("data-stats-days")));
      });
    }
    el._statsSet = function (n) { if (RANGES.indexOf(n) !== -1 && n !== days) { days = n; load(); } };
    await load();
  }

  window.NiccOwnerStats = { mount: mount, _panel: panel };
})();
