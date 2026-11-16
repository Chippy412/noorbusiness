// server/index.js
// Runs the Vercel-style handlers in api/ as one small Node service, for the
// self-hosted setup on the masjid's Lightsail server. Nginx serves the static
// site and proxies /api/*, /b/<id> and /sitemap.xml here (see
// deploy/nginx/noorbusiness.conf). No dependencies: plain node:http, Node 18+.
//
// It reproduces the parts of Vercel the handlers rely on:
//   req.query            parsed query string (plus params from a rewrite)
//   req.body             JSON / urlencoded body, parsed unless the handler
//                        exports config.api.bodyParser = false
//   res.status/json/send Express-like helpers
// and the rewrites from vercel.json: /b/:id -> /api/listing?id=:id,
// /sitemap.xml -> /api/sitemap.
"use strict";

var http = require("node:http");
var path = require("node:path");
var fs = require("node:fs");

var API_DIR = path.resolve(__dirname, "..", "api");
var MAX_BODY = 1024 * 1024; // 1 MB, plenty for forms and webhooks

// Map a request path to { file, params } or null. Only real handler files
// under api/ are reachable; _lib and anything with dots or traversal is not.
function resolveRoute(pathname) {
  var m = pathname.match(/^\/b\/([^/]+)\/?$/);
  if (m) return { file: path.join(API_DIR, "listing.js"), params: { id: decodeURIComponent(m[1]) } };
  if (pathname === "/sitemap.xml") return { file: path.join(API_DIR, "sitemap.js"), params: {} };
  m = pathname.match(/^\/api\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\/?$/i);
  if (!m) return null;
  var rel = m[1];
  if (rel.split("/").some(function (p) { return p.charAt(0) === "_"; })) return null;
  var file = path.join(API_DIR, rel + ".js");
  if (file.indexOf(API_DIR + path.sep) !== 0) return null;
  if (!fs.existsSync(file)) return null;
  return { file: file, params: {} };
}

function loadHandler(file) {
  var mod = require(file);
  var fn = typeof mod === "function" ? mod : mod && mod.default;
  return { fn: fn, config: (mod && mod.config) || {} };
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("too_large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function parseBody(buf, contentType) {
  if (!buf.length) return undefined;
  var text = buf.toString("utf8");
  var ct = String(contentType || "").toLowerCase();
  if (ct.indexOf("application/json") !== -1) {
    try { return JSON.parse(text); } catch (e) { return text; }
  }
  if (ct.indexOf("application/x-www-form-urlencoded") !== -1) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

function decorate(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = function (body) {
    if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) return res.json(body);
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body == null ? "" : body);
    return res;
  };
  res.redirect = function (a, b) {
    var code = typeof a === "number" ? a : 307, loc = typeof a === "number" ? b : a;
    res.statusCode = code; res.setHeader("Location", loc); res.end();
    return res;
  };
  return res;
}

function sendError(res, code, error) {
  if (res.headersSent) { res.end(); return; }
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: error }));
}

async function handle(req, res) {
  decorate(res);
  var url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") { res.status(200).json({ ok: true }); return; }

  var route = resolveRoute(url.pathname);
  if (!route) { sendError(res, 404, "not_found"); return; }

  var h;
  try { h = loadHandler(route.file); } catch (e) {
    console.error("[server] failed to load", route.file, e);
    sendError(res, 500, "handler_load_failed"); return;
  }
  if (typeof h.fn !== "function") { sendError(res, 404, "not_found"); return; }

  req.query = Object.assign(Object.fromEntries(url.searchParams), route.params);
  var parse = !(h.config.api && h.config.api.bodyParser === false);
  if (parse && req.method !== "GET" && req.method !== "HEAD") {
    try {
      var buf = await readBody(req);
      req.rawBody = buf;
      req.body = parseBody(buf, req.headers["content-type"]);
    } catch (e) { sendError(res, e.code === 413 ? 413 : 400, e.code === 413 ? "too_large" : "bad_body"); return; }
  }

  try {
    await h.fn(req, res);
    if (!res.writableEnded) res.end();
  } catch (e) {
    console.error("[server] handler error", url.pathname, e);
    sendError(res, 500, "server_error");
  }
}

function createServer() {
  return http.createServer(function (req, res) {
    handle(req, res).catch(function (e) {
      console.error("[server] unexpected", e);
      sendError(res, 500, "server_error");
    });
  });
}

if (require.main === module) {
  var port = Number(process.env.PORT || 3001);
  var host = process.env.HOST || "127.0.0.1";
  createServer().listen(port, host, function () {
    console.log("[server] NICC Business API on http://" + host + ":" + port);
  });
}

module.exports = { createServer: createServer, resolveRoute: resolveRoute, parseBody: parseBody };
