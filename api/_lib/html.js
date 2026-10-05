// api/_lib/html.js
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Only plain https URLs are ever echoed into href/src attributes.
function safeHttps(url) {
  if (!url) return null;
  try {
    var u = new URL(String(url));
    return u.protocol === "https:" ? u.href : null;
  } catch (e) { return null; }
}

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = { esc: esc, safeHttps: safeHttps, UUID_RE: UUID_RE };
