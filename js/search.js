// js/search.js
// Text search for the Explore page: normalizing, a small intent-word alias
// map, and a relevance score. Pure functions, no DOM. This is plain text
// matching only; it makes no claims about any business.
(function () {
  "use strict";

  // Lowercase, strip accents, turn punctuation/ampersands/apostrophes into
  // spaces (apostrophes vanish instead: "men's" -> "mens"), collapse spaces.
  function normalize(text) {
    var s = String(text == null ? "" : text).toLowerCase();
    if (s.normalize) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return s
      .replace(/[’‘'`´]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function words(text) {
    var n = normalize(text);
    return n ? n.split(" ") : [];
  }

  // intent word -> extra terms that also count as a match. Values are
  // normalized words that appear in category names ("grocery", "modest",
  // "health", "professional", "education", "auto", "home") or typical listings.
  var GROCERY = ["grocery"], MODEST = ["modest", "wear"], HEALTH = ["health", "wellness"],
      PRO = ["professional", "services"], EDU = ["education"], AUTO = ["auto", "repair"], HOME = ["home", "living"];
  var ALIASES = {
    meat: GROCERY, butcher: GROCERY, zabiha: GROCERY, market: GROCERY, produce: GROCERY,
    hijab: MODEST, abaya: MODEST, thobe: MODEST, thawb: MODEST, jilbab: MODEST, scarf: MODEST, scarves: MODEST, clothing: MODEST, clothes: MODEST,
    doctor: HEALTH, dentist: HEALTH, dental: HEALTH, clinic: HEALTH, pharmacy: HEALTH, therapy: HEALTH, therapist: HEALTH, counseling: HEALTH, counselor: HEALTH, counselling: HEALTH,
    lawyer: PRO, attorney: PRO, accountant: PRO, accounting: PRO, tax: PRO, taxes: PRO, insurance: PRO, realtor: PRO, real: PRO, estate: PRO, mortgage: PRO,
    quran: EDU, school: EDU, tutor: EDU, tutoring: EDU, arabic: EDU, madrasa: EDU, madrasah: EDU, weekend: EDU, class: EDU, classes: EDU,
    mechanic: AUTO, tires: AUTO, tire: AUTO, car: AUTO, cars: AUTO, repair: AUTO, oil: AUTO,
    furniture: HOME, decor: HOME, cleaning: HOME, plumber: HOME, plumbing: HOME, painting: HOME, contractor: HOME
  };

  // A word matches if it, or any alias of it, matches. Returns the list of
  // alternatives (the word itself first) for each query word.
  function expandQuery(queryWords) {
    return (queryWords || []).map(function (w) {
      var n = normalize(w);
      var alts = n ? [n] : [];
      var extra = Object.prototype.hasOwnProperty.call(ALIASES, n) ? ALIASES[n] : null;
      if (extra) extra.forEach(function (a) { if (alts.indexOf(a) === -1) alts.push(a); });
      return alts;
    }).filter(function (alts) { return alts.length; });
  }

  function hasWordStart(hay, term) {
    return (" " + hay).indexOf(" " + term) !== -1;
  }

  // fields: { name, category, keywords, description, address, area } (any may be missing).
  // queryWords: raw words typed by the user. Returns 0 when any word has no
  // match (AND), else a relevance number (higher is better).
  function score(fields, queryWords) {
    var groups = expandQuery(queryWords);
    if (!groups.length) return 0;
    var f = fields || {};
    var name = normalize(f.name), cat = normalize(f.category),
        kw = normalize(f.keywords), area = normalize(f.area),
        desc = normalize(f.description), addr = normalize(f.address);
    var all = [name, cat, kw, area, desc, addr].join(" ");
    var total = 0;
    for (var i = 0; i < groups.length; i++) {
      var best = 0;
      for (var j = 0; j < groups[i].length; j++) {
        var t = groups[i][j];
        var isAlias = j > 0;
        var s = 0;
        if (name === t) s = 100;
        else if (name.indexOf(t) === 0) s = 80;
        else if (hasWordStart(name, t)) s = 60;
        else if (name.indexOf(t) !== -1) s = 40;
        else if (hasWordStart(cat, t) || hasWordStart(kw, t)) s = 30;
        else if (hasWordStart(area, t)) s = 20;
        else if (hasWordStart(desc, t)) s = 12;
        else if (hasWordStart(addr, t)) s = 8;
        else if (all.indexOf(t) !== -1) s = 4;
        if (isAlias && s) s = Math.min(s, 30) * 0.7; // an alias hit never outranks a direct hit on the name
        if (s > best) best = s;
      }
      if (!best) return 0;
      total += best;
    }
    return total;
  }

  var api = { normalize: normalize, words: words, expandQuery: expandQuery, score: score, ALIASES: ALIASES };
  if (typeof window !== "undefined") window.NiccSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
