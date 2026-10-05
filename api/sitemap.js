// api/sitemap.js  (served at /sitemap.xml via a rewrite in vercel.json)
var supa = require("./_lib/supa");
var h = require("./_lib/html");
var SITE = "https://nicc-business.vercel.app";

module.exports = async function handler(req, res) {
  var r = await supa.rest("businesses?select=id,created_at&status=eq.approved&order=created_at.desc&limit=1000");
  var rows = r.ok && Array.isArray(r.data) ? r.data : [];
  var urls = [{ loc: SITE + "/", pri: "1.0" }].concat(rows.map(function (b) {
    return { loc: SITE + "/b/" + b.id, pri: "0.7", mod: String(b.created_at).slice(0, 10) };
  }));
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(function (u) {
      return "  <url><loc>" + h.esc(u.loc) + "</loc>" + (u.mod ? "<lastmod>" + u.mod + "</lastmod>" : "") +
        "<changefreq>weekly</changefreq><priority>" + u.pri + "</priority></url>";
    }).join("\n") + "\n</urlset>\n";
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).send(xml);
};
