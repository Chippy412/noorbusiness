// js/admin.js
// The moderation page (#/admin). Everything here is a convenience layer: every
// action calls an admin_* database function that re-checks, on the server,
// that the caller is on the `admins` list AND signed in with two-factor
// (see supabase/migrations/2026-10-05-admin.sql). Hiding this page's markup
// from non-admins is not what protects anything.
(function () {
  "use strict";

  async function rpc(name, args) {
    var result = await window.NiccSupabase.rpc(name, args || {});
    if (result.error) throw result.error;
    return result.data;
  }

  // "logged-out" | "not-admin" | "need-2fa" | "need-code" | "ok"
  async function status() {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) return { state: "logged-out" };
    var row = await window.NiccSupabase.from("admins").select("user_id, role").maybeSingle();
    if (row.error || !row.data) return { state: "not-admin" };
    var aal = await window.NiccSupabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.error) return { state: "need-code" };
    if (aal.data.currentLevel === "aal2") return { state: "ok", role: row.data.role, userId: user.id };
    return { state: aal.data.nextLevel === "aal2" ? "need-code" : "need-2fa" };
  }

  // Reasons are optional; an empty one is sent as null.
  function reason(r) { r = (r || "").trim(); return r || null; }

  var api = {
    status: status,
    queue: function () { return rpc("admin_queue"); },
    counts: function () { return rpc("admin_counts"); },
    addListing: function (fields) { return rpc("admin_add_listing", { p_fields: fields }); },
    allBusinesses: function () { return rpc("admin_all_businesses"); },
    recentReviews: function () { return rpc("admin_recent_reviews"); },
    log: function () { return rpc("admin_log"); },
    history: function (id) { return rpc("admin_listing_history", { p_business: id }); },
    addNote: function (id, note) { return rpc("admin_add_note", { p_business: id, p_note: note }); },
    team: function () { return rpc("admin_team"); },
    addMember: function (email, role) { return rpc("admin_add_member", { p_email: email, p_role: role }); },
    setMemberRole: function (userId, role) { return rpc("admin_set_member_role", { p_user: userId, p_role: role }); },
    removeMember: function (userId) { return rpc("admin_remove_member", { p_user: userId }); },
    setListingStatus: function (id, s, why) { return rpc("admin_set_listing_status", { p_id: id, p_status: s, p_reason: reason(why) }); },
    setFlags: function (id, badges, featured) { return rpc("admin_set_listing_flags", { p_id: id, p_badges: badges, p_featured: featured }); },
    applyEdit: function (id) { return rpc("admin_apply_edit", { p_id: id }); },
    rejectEdit: function (id, why) { return rpc("admin_reject_edit", { p_id: id, p_reason: reason(why) }); },
    resolveClaim: function (id, approve, why) { return rpc("admin_resolve_claim", { p_id: id, p_approve: approve, p_reason: reason(why) }); },
    setReviewStatus: function (id, s, why) { return rpc("admin_set_review_status", { p_id: id, p_status: s, p_reason: reason(why) }); },
    resolveReport: function (id, action, why) { return rpc("admin_resolve_report", { p_id: id, p_action: action, p_reason: reason(why) }); },
    setMessageHandled: function (id, handled) { return rpc("admin_set_message_handled", { p_id: id, p_handled: handled }); },
    sponsorships: function () { return rpc("admin_sponsorships"); },
    setComp: function (id, tier, until, note) { return rpc("admin_set_comp", { p_business: id, p_tier: tier, p_until: until, p_note: reason(note) }); },
    setFeaturedUntil: function (id, until) { return rpc("admin_set_featured_until", { p_id: id, p_until: until }); }
  };

  // Queues that need a decision come first; the rest is reference/management.
  var QUEUES = [
    { id: "new", label: "New listings", key: "new_listings", empty: "No new listings to review." },
    { id: "edits", label: "Edits", key: "edits", empty: "No edits waiting." },
    { id: "claims", label: "Claims", key: "claims", empty: "No claims waiting." },
    { id: "reviews", label: "Reviews", key: "reviews", empty: "No reviews waiting." },
    { id: "reports", label: "Reports", key: "reports", empty: "No open reports." }
  ];
  var SECTIONS = [
    { id: "messages", label: "Messages" },
    { id: "published", label: "Published reviews" },
    { id: "all", label: "All listings" },
    { id: "add", label: "Add a listing" },
    { id: "activity", label: "Activity" },
    { id: "guide", label: "Guide" },
    { id: "sponsors", label: "Sponsors", modOnly: true },
    { id: "team", label: "Team", modOnly: true }
  ];
  var ROLE_HELP = {
    moderator: "Full control, including Featured, taking listings or published reviews down, and managing the team.",
    volunteer: "Reviews new listings, edits, claims, reviews and reports, and sets badges."
  };
  var FIELD_LABELS = {
    name: "Name", category: "Category", neighborhood: "Neighborhood",
    description: "Short description", long_description: "Full description",
    address: "Address", phone: "Phone", website: "Website", photo_url: "Photo"
  };
  var BADGES = [
    ["prayer", "Prayer space"], ["women", "Women owned"],
    ["family", "Family run"], ["community", "Community service"]
  ];
  var REPORT_REASONS = {
    closed: "Closed or moved", wrong_info: "Wrong information", inappropriate: "Inappropriate",
    spam: "Spam or fake", other: "Something else"
  };
  var STATUS_LABELS = { approved: "Live", pending: "Waiting for review", rejected: "Not approved" };
  // Activity log wording: "<who> <verb> <summary>".
  var ACTIONS = {
    "listing.approved": "approved", "listing.rejected": "turned down", "listing.pending": "moved back to waiting:",
    "listing.badges": "changed badges on", "listing.featured": "featured", "listing.unfeatured": "un-featured",
    "edit.applied": "applied changes to", "edit.rejected": "rejected changes to",
    "claim.approved": "approved a claim on", "claim.rejected": "rejected a claim on",
    "review.approved": "published a review of", "review.rejected": "rejected a review of", "review.removed": "removed a published review of",
    "report.dismiss": "dismissed a report on", "report.resolve": "resolved a report on",
    "report.hide_review": "hid a reported review of", "report.unpublish": "unpublished after a report:",
    "message.handled": "marked a message handled", "message.reopened": "reopened a message",
    "note": "added a note on",
    "sponsor.billing": "billing update for", "sponsor.comped": "gave a free placement to", "sponsor.comp_ended": "ended the free placement on",
    "listing.added": "added a listing:",
    "listing.featured_until": "set when Featured ends on",
    "team.added": "added to the team:", "team.role": "changed the role of", "team.removed": "removed from the team:"
  };
  var PAGE_SIZE = 50;
  var dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // root: container element. h: { escape, safeUrl, toast, role, userId, onChange } from the page.
  function mount(root, h) {
    var esc = h.escape;
    var isMod = h.role === "moderator";
    var state = {
      tab: "new", guide: null, guideError: null, data: null, all: null, team: null, published: null, log: null, sponsors: null,
      allQuery: "", allStatus: "", allFlag: "", allPage: 0, openHistory: {}
    };

    function when(iso) { try { return dateFmt.format(new Date(iso)); } catch (e) { return ""; } }
    function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; } }
    function future(iso) { return !!iso && new Date(iso) > new Date(); }
    // <input type=date> value <-> end of that local day as an ISO timestamp.
    function dateValue(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    function endOfDay(v) { return v ? new Date(v + "T23:59:59").toISOString() : null; }
    // Items left waiting more than two days get a visible tag.
    function age(iso) {
      var days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
      return days >= 2 ? ' <span class="mod-age">Waiting ' + days + " days</span>" : "";
    }
    function queueItems(id) {
      var q = QUEUES.filter(function (x) { return x.id === id; })[0];
      return q && state.data ? state.data[q.key] || [] : [];
    }
    function none(text) { return '<span class="mod-none">' + (text || "Not given") + "</span>"; }
    function val(v) { return v == null || v === "" ? none() : esc(v); }
    function where(cat, hood) { return esc(cat) + " in " + esc(hood); }
    function star(filled) { return '<svg class="icon' + (filled ? " filled" : "") + '" aria-hidden="true"><use href="#i-star"/></svg>'; }
    function stars(n) {
      var rating = Math.min(5, Math.max(0, Number(n) | 0)), s = ""; // always a plain 0-5 integer
      for (var i = 1; i <= 5; i++) s += star(i <= rating);
      return '<span class="mod-stars" aria-label="' + rating + ' out of 5">' + s + "</span>";
    }
    function fieldVal(field, v) {
      if (field === "photo_url") {
        var u = h.safeUrl(v);
        return u ? '<img src="' + u + '" alt="" class="mod-thumb" width="120" height="90">' : none("No photo");
      }
      return v == null || v === "" ? none("Empty") : '<span class="mod-prose">' + esc(v) + "</span>";
    }
    function rows(pairs) {
      return '<dl class="mod-facts">' + pairs.map(function (p) { return "<dt>" + p[0] + "</dt><dd>" + p[1] + "</dd>"; }).join("") + "</dl>";
    }
    function decision(reject, approve) {
      return '<div class="mod-decide">' + reject + approve + "</div>";
    }
    function btn(kind, act, id, label, extra) {
      return '<button class="btn ' + (kind === "primary" ? "btn-primary" : "btn-ghost") + ' btn-sm" data-act="' + act + '" data-id="' + esc(id) + '"' + (extra || "") + ">" + label + "</button>";
    }
    // A button that first asks for a reason. prompt: what to tell the moderator;
    // confirm: label on the button that actually sends it.
    function askBtn(act, id, label, prompt, confirm, extra) {
      return btn("ghost", act, id, label, ' data-ask="' + esc(prompt) + '" data-confirm-label="' + esc(confirm) + '"' + (extra || ""));
    }

    /* ---------- one sheet per item ---------- */
    function listingSheet(l) {
      var photo = h.safeUrl(l.photo_url);
      var hours = (l.hours || []).map(function (r) { return esc(r[0]) + " " + esc(r[1]); }).join("<br>");
      var dupes = l.possible_duplicates || [];
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(l.name) + '</h3><p class="mod-sub">' + where(l.category, l.neighborhood) + "</p></div>" +
        '<p class="mod-when">Submitted ' + when(l.created_at) + age(l.created_at) + "<br>by " + val(l.owner_email) + "</p></header>" +
        (dupes.length ? '<div class="mod-warn" role="note"><strong>Possibly a duplicate.</strong> Same name or phone as: ' +
          dupes.map(function (d) { return esc(d.name) + " (" + esc(STATUS_LABELS[d.status] || d.status) + ")"; }).join(", ") + "</div>" : "") +
        (photo ? '<img src="' + photo + '" alt="" class="mod-photo">' : "") +
        '<p class="mod-lede">' + esc(l.description) + '</p><p class="mod-prose">' + esc(l.long_description) + "</p>" +
        rows([
          ["Address", val(l.address)], ["Phone", val(l.phone)], ["Website", val(l.website)],
          ["Hours", hours || none()]
        ]) +
        decision(askBtn("listing-status", l.id, "Send back for changes",
                        "What should the owner fix? They'll see this on their account page and by email. When they edit the listing it comes back here.",
                        "Send back", ' data-status="rejected"'),
                 btn("primary", "listing-status", l.id, "Approve and publish", ' data-status="approved"')) +
        "</article>";
    }

    function editSheet(e) {
      var changed = Object.keys(e.changes);
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(e.business_name) + '</h3><p class="mod-sub">' +
        changed.length + (changed.length === 1 ? " change" : " changes") + " proposed. The live listing stays as it is until you apply them.</p></div>" +
        '<p class="mod-when">Edited ' + when(e.submitted_at) + age(e.submitted_at) + "<br>by " + val(e.owner_email) + "</p></header>" +
        '<div class="mod-diff">' + changed.map(function (k) {
          return '<div class="mod-diff-row"><p class="mod-diff-field">' + esc(FIELD_LABELS[k] || k) + "</p>" +
            '<div class="mod-diff-old"><span class="mod-diff-tag">Now</span>' + fieldVal(k, e.live[k]) + "</div>" +
            '<div class="mod-diff-new"><span class="mod-diff-tag">Proposed</span>' + fieldVal(k, e.changes[k]) + "</div></div>";
        }).join("") + "</div>" +
        decision(askBtn("edit-reject", e.business_id, "Reject changes", "Why aren't these changes being applied? The owner will see this.", "Reject changes"),
                 btn("primary", "edit-apply", e.business_id, "Apply changes")) +
        "</article>";
    }

    function claimSheet(c) {
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(c.business_name) + '</h3><p class="mod-sub">' +
        (c.current_owner_email ? "Already has an owner. Approving moves the listing to the person claiming it." : "No owner yet.") + "</p></div>" +
        '<p class="mod-when">Requested ' + when(c.created_at) + age(c.created_at) + "</p></header>" +
        rows([["Claimed by", val(c.requester_email)], ["Current owner", c.current_owner_email ? esc(c.current_owner_email) : none("No one")], ["Their note", val(c.note)]]) +
        decision(askBtn("claim-reject", c.id, "Reject", "Why isn't this claim approved? The person claiming it will see this.", "Reject claim"),
                 btn("primary", "claim-approve", c.id, "Approve and transfer", ' data-has-owner="' + (c.current_owner_email ? "1" : "") + '"')) +
        "</article>";
    }

    function reviewSheet(r) {
      return '<article class="mod-sheet mod-selectable">' +
        '<label class="mod-select"><input type="checkbox" data-bulk value="' + esc(r.id) + '"><span class="sr-only">Select this review</span></label>' +
        '<header class="mod-sheet-head"><div><h3>' + esc(r.business_name) + '</h3><p class="mod-sub">' + stars(r.rating) + "</p></div>" +
        '<p class="mod-when">' + when(r.created_at) + age(r.created_at) + "<br>by " + esc(r.author_name) + "</p></header>" +
        '<blockquote class="mod-quote">' + esc(r.body) + "</blockquote>" +
        decision(askBtn("review-status", r.id, "Reject", "Why isn't this review being published? The author will see this.", "Reject review", ' data-status="rejected"'),
                 btn("primary", "review-status", r.id, "Publish review", ' data-status="approved"')) +
        "</article>";
    }

    function reportSheet(p) {
      var about = p.review_id
        ? '<p class="mod-sub">About a review by ' + esc(p.review_author || "someone") + (p.review_status && p.review_status !== "approved" ? " (already hidden)" : "") + "</p>"
        : '<p class="mod-sub">About the listing' + (p.business_status !== "approved" ? " (no longer public)" : "") + "</p>";
      var actions = btn("ghost", "report", p.id, "Dismiss", ' data-action="dismiss"') +
        btn("ghost", "report", p.id, "Mark fixed", ' data-action="resolve" title="You fixed it some other way, e.g. edited the listing or contacted the owner"');
      if (p.review_id && p.review_status === "approved") {
        actions += isMod
          ? askBtn("report", p.id, "Hide the review", "Why is the review being hidden? The author will see this.", "Hide review", ' data-action="hide_review"')
          : '<span class="mod-sub">A moderator can hide the review.</span>';
      } else if (!p.review_id && p.business_status === "approved") {
        actions += isMod
          ? askBtn("report", p.id, "Take the listing down", "Why is the listing being taken down? The owner will see this.", "Take down", ' data-action="unpublish"')
          : '<span class="mod-sub">A moderator can take the listing down.</span>';
      }
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(p.business_name) + '</h3>' + about + "</div>" +
        '<p class="mod-when">Reported ' + when(p.created_at) + age(p.created_at) + "<br>" + (p.reporter_email ? esc(p.reporter_email) : "anonymously") + "</p></header>" +
        (p.review_id ? '<div class="mod-review-ref">' + stars(p.review_rating) + '<blockquote class="mod-quote">' + esc(p.review_body || "") + "</blockquote></div>" : "") +
        rows([["Reason", esc(REPORT_REASONS[p.reason] || p.reason)], ["Details", val(p.details)]]) +
        '<div class="mod-decide mod-decide-wrap">' + actions + "</div>" +
        "</article>";
    }

    function messageSheet(m) {
      var subject = "Re: " + (m.subject || "your message to NICC Business");
      return '<article class="mod-sheet mod-sheet-quiet' + (m.handled_at ? " is-done" : "") + '">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(m.name) + '</h3><p class="mod-sub">' + esc(m.subject || "No subject") + "</p></div>" +
        '<p class="mod-when">' + when(m.created_at) + "<br>" + esc(m.email) + "</p></header>" +
        '<p class="mod-prose">' + esc(m.message) + "</p>" +
        '<div class="mod-decide">' +
          (m.handled_at
            ? '<span class="mod-sub">Handled ' + when(m.handled_at) + (m.handled_by_email ? " by " + esc(m.handled_by_email) : "") + ' · <button class="btn-link" data-act="message-handled" data-id="' + esc(m.id) + '" data-handled="0">Reopen</button></span>'
            : btn("ghost", "message-handled", m.id, "Mark handled", ' data-handled="1"')) +
          '<a class="btn btn-ghost btn-sm" href="mailto:' + esc(encodeURIComponent(m.email)) + "?subject=" + encodeURIComponent(subject) + '">Reply by email</a></div>' +
        "</article>";
    }

    function publishedReview(r) {
      return '<article class="mod-sheet mod-sheet-quiet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(r.business_name) + '</h3><p class="mod-sub">' + stars(r.rating) + "</p></div>" +
        '<p class="mod-when">' + when(r.created_at) + "<br>by " + esc(r.author_name) + "</p></header>" +
        '<blockquote class="mod-quote">' + esc(r.body) + "</blockquote>" +
        (r.owner_reply ? '<p class="mod-reply"><strong>Owner replied:</strong> ' + esc(r.owner_reply) + "</p>" : "") +
        (isMod ? '<div class="mod-decide"><span></span>' +
          askBtn("review-status", r.id, "Remove review", "Why is this review being removed? The author will see this.", "Remove review", ' data-status="rejected"') + "</div>" : "") +
        "</article>";
    }

    /* ---------- management views ---------- */
    function pill(attrs, label, on, disabled, title) {
      return '<label class="mod-pill' + (disabled ? " is-locked" : "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + '><input type="checkbox" ' + attrs + (on ? " checked" : "") + (disabled ? " disabled" : "") + "><span>" + label + "</span></label>";
    }
    function filteredListings() {
      var words = state.allQuery.toLowerCase().split(/\s+/).filter(Boolean);
      return (state.all || []).filter(function (b) {
        if (state.allStatus && b.status !== state.allStatus) return false;
        if (state.allFlag === "no-owner" && b.owner_email) return false;
        if (state.allFlag === "featured" && !b.featured) return false;
        if (state.allFlag === "sponsored" && !(b.sponsor_tier && future(b.sponsored_until))) return false;
        var hay = [b.name, b.category, b.neighborhood, b.owner_email || ""].join(" ").toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) !== -1; });
      });
    }
    function listingRow(b) {
      var statusSel = '<select data-field="status" aria-label="Status for ' + esc(b.name) + '"' + (isMod ? "" : " disabled") + ">" +
        ["approved", "pending", "rejected"].map(function (s) { return '<option value="' + s + '"' + (b.status === s ? " selected" : "") + ">" + STATUS_LABELS[s] + "</option>"; }).join("") + "</select>";
      var hist = state.openHistory[b.id];
      return '<li class="mod-row" data-id="' + esc(b.id) + '" data-name="' + esc(b.name) + '" data-status="' + esc(b.status) + '">' +
        '<div class="mod-row-main"><p class="mod-row-title">' + esc(b.name) + '</p><p class="mod-sub">' + where(b.category, b.neighborhood) +
        (b.owner_email ? ", owned by " + esc(b.owner_email) : ", no owner") +
        (b.sponsor_tier && future(b.sponsored_until) ? ' <span class="mod-you">Sponsored until ' + day(b.sponsored_until) + "</span>" : "") + "</p></div>" +
        '<div class="mod-row-status">' + statusSel + "</div>" +
        '<div class="mod-row-pills" role="group" aria-label="Badges for ' + esc(b.name) + '">' +
        BADGES.map(function (p) { return pill('data-badge="' + p[0] + '"', p[1], (b.badges || []).indexOf(p[0]) !== -1); }).join("") +
        pill('data-field="featured"', "Featured on home page", b.featured, !isMod, isMod ? "" : "Only moderators can change Featured").replace('class="mod-pill', 'class="mod-pill mod-pill-featured') +
        (isMod ? '<label class="mod-until">until <input type="date" data-field="featured-until" value="' + dateValue(b.featured_until) + '" aria-label="Featured until (leave empty for no end date)"></label>'
               : (b.featured_until ? '<span class="mod-sub">until ' + day(b.featured_until) + "</span>" : "")) + "</div>" +
        '<div class="mod-row-save"><button class="btn-link" data-act="history" data-id="' + esc(b.id) + '" aria-expanded="' + (hist ? "true" : "false") + '">Notes and history</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="save-flags" data-id="' + esc(b.id) + '">Save</button></div>' +
        (hist ? historyPanel(b.id, hist) : "") +
        "</li>";
    }
    function historyPanel(id, hist) {
      var body = hist === "loading" ? '<p class="mod-loading">Loading…</p>'
        : hist.length ? '<ol class="mod-log">' + hist.map(logItem).join("") + "</ol>"
        : '<p class="mod-sub">No notes or moderation history yet.</p>';
      return '<div class="mod-history">' +
        '<form class="mod-note-form" data-id="' + esc(id) + '"><label class="sr-only" for="note-' + esc(id) + '">Internal note</label>' +
        '<textarea id="note-' + esc(id) + '" rows="2" maxlength="2000" placeholder="Add an internal note (only the team sees this)"></textarea>' +
        '<button type="submit" class="btn btn-ghost btn-sm">Add note</button></form>' + body + "</div>";
    }
    function allListings() {
      var list = filteredListings();
      var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      if (state.allPage >= pages) state.allPage = pages - 1;
      var slice = list.slice(state.allPage * PAGE_SIZE, (state.allPage + 1) * PAGE_SIZE);
      var pager = pages > 1
        ? '<div class="mod-pager"><button class="btn btn-ghost btn-sm" data-act="page" data-dir="-1"' + (state.allPage === 0 ? " disabled" : "") + ">Previous</button>" +
          "<span>Page " + (state.allPage + 1) + " of " + pages + "</span>" +
          '<button class="btn btn-ghost btn-sm" data-act="page" data-dir="1"' + (state.allPage >= pages - 1 ? " disabled" : "") + ">Next</button></div>"
        : "";
      return '<p class="mod-count">' + list.length + (list.length === 1 ? " listing" : " listings") +
        (list.length !== state.all.length ? " of " + state.all.length : "") + "</p>" +
        (slice.length ? '<ul class="mod-list">' + slice.map(listingRow).join("") + "</ul>" : '<div class="mod-empty"><p>No listings match.</p></div>') + pager;
    }
    function allListingsView() {
      return '<p class="mod-intro">Every listing in the directory. Badges are set by volunteers and moderators' + (isMod ? "; status and Featured by moderators." : ". Status and Featured are set by moderators.") + "</p>" +
        (isMod ? '<p class="mod-intro">Listings are placed on the map automatically when their address changes. <button class="btn-link" data-act="locate">Find map locations for older listings</button></p>' : "") +
        '<div class="mod-tools" role="search">' +
          '<div class="field"><label for="modAllQ">Search</label><input type="search" id="modAllQ" value="' + esc(state.allQuery) + '" placeholder="Name, category, area or owner email" autocomplete="off" spellcheck="false"></div>' +
          '<div class="field"><label for="modAllStatus">Status</label><select id="modAllStatus">' +
            [["", "Any status"], ["approved", "Live"], ["pending", "Waiting for review"], ["rejected", "Not approved"]].map(function (o) {
              return '<option value="' + o[0] + '"' + (state.allStatus === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
            }).join("") + "</select></div>" +
          '<div class="field"><label for="modAllFlag">Show</label><select id="modAllFlag">' +
            [["", "Everything"], ["no-owner", "No owner"], ["featured", "Featured"], ["sponsored", "Sponsored"]].map(function (o) {
              return '<option value="' + o[0] + '"' + (state.allFlag === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
            }).join("") + "</select></div>" +
        "</div>" +
        '<div id="modAllList">' + allListings() + "</div>";
    }
    function renderAllList() {
      var box = root.querySelector("#modAllList");
      if (box) box.innerHTML = allListings();
    }

    function logItem(l) {
      var verb = ACTIONS[l.action] || l.action;
      var d = l.detail || {};
      var extra = d.note || d.reason || "";
      if (l.action === "listing.badges") extra = "Now: " + ((d.to || []).join(", ") || "no badges");
      if (l.action === "team.role") extra = "Now a " + d.role;
      if (l.action === "team.added") extra = "As a " + d.role;
      return '<li><p><strong>' + esc(l.actor_email || "Someone") + "</strong> " + esc(verb) + (l.summary ? " " + esc(l.summary) : "") + "</p>" +
        (extra ? '<p class="mod-log-note">' + esc(extra) + "</p>" : "") +
        '<p class="mod-sub">' + when(l.created_at) + "</p></li>";
    }

    var PLAN_NAMES = { spotlight: "Spotlight", featured: "Featured" };
    function sponsorsPanel(rows_) {
      var live = (state.all || []).filter(function (b) { return b.status === "approved"; });
      var form = '<section class="mod-sheet mod-sheet-quiet"><h3>Give a free placement</h3>' +
        '<p class="mod-sub">For a community partner, a prize, or a business you want to thank. It shows with the same \u201cSponsored\u201d label, and never replaces what someone pays for.</p>' +
        '<form class="mod-comp" id="modCompForm">' +
          '<div class="field"><label for="compListing">Listing</label><select id="compListing" required><option value="">Choose a live listing</option>' +
            live.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field"><label for="compTier">Plan</label><select id="compTier"><option value="featured">Featured</option><option value="spotlight">Spotlight</option></select></div>' +
          '<div class="field"><label for="compUntil">Until</label><input type="date" id="compUntil" required></div>' +
          '<div class="field mod-comp-note"><label for="compNote">Note for the team</label><input type="text" id="compNote" maxlength="500" placeholder="Why (optional)"></div>' +
          '<button type="submit" class="btn btn-primary btn-sm">Give placement</button>' +
        "</form></section>";
      if (!rows_.length) return form + '<div class="mod-empty"><p>No sponsorships yet. They appear here when you give one above.</p></div>';
      return form + '<ul class="mod-list">' + rows_.map(function (r) {
        var paidLive = r.paid_tier && future(r.paid_until) && ["active", "trialing", "past_due"].indexOf(r.paid_status) !== -1;
        var bits = [];
        if (r.paid_tier) bits.push("Paid " + esc(PLAN_NAMES[r.paid_tier]) + ": " + esc(r.paid_status || "unknown") +
          (paidLive ? (r.cancel_at_period_end ? ", ends " : ", renews ") + day(r.paid_period_end || r.paid_until) : "") + (r.payer_email ? " (" + esc(r.payer_email) + ")" : ""));
        if (paidLive && r.business_status !== "approved") bits.push('<strong class="mod-flag">Still billing while the listing isn\u2019t live. Check with the owner before it ends.</strong>');
        if (r.comp_tier && future(r.comp_until)) bits.push("Free " + esc(PLAN_NAMES[r.comp_tier]) + " until " + day(r.comp_until) + (r.comp_note ? ": " + esc(r.comp_note) : ""));
        var showing = r.sponsor_tier && future(r.sponsored_until)
          ? "Showing as " + esc(PLAN_NAMES[r.sponsor_tier]) + (r.business_status !== "approved" ? ", but the listing isn't live" : "")
          : "Not showing";
        return '<li class="mod-row mod-row-team" data-id="' + esc(r.business_id) + '" data-name="' + esc(r.business_name) + '">' +
          '<div class="mod-row-main"><p class="mod-row-title">' + esc(r.business_name) + '</p><p class="mod-sub">' + showing + "</p>" +
          bits.map(function (x) { return '<p class="mod-sub">' + x + "</p>"; }).join("") + "</div>" +
          '<div class="mod-row-status"></div>' +
          '<div class="mod-row-save">' + (r.comp_tier && future(r.comp_until) ? '<button class="btn-link mod-remove" data-act="comp-end" data-id="' + esc(r.business_id) + '">End free placement</button>' : "") + "</div>" +
          "</li>";
      }).join("") + "</ul>" +
      '<p class="mod-intro" style="margin-top:14px">Paid sponsorships will be handled through the masjid\u2019s own payment process. Until then, give a free placement above once the owner has arranged it with the team.</p>';
    }

    function teamPanel(members) {
      return '<section class="mod-sheet mod-sheet-quiet">' +
        '<h3>Add someone</h3>' +
        '<p class="mod-sub">They need an account on the site with two-factor turned on (My account). Add them by the email they signed up with.</p>' +
        '<form class="mod-add" id="adminAddForm"><div class="field"><label for="adminAddEmail">Email</label><input type="email" id="adminAddEmail" autocomplete="off" spellcheck="false" required></div>' +
        '<div class="field"><label for="adminAddRole">Role</label><select id="adminAddRole"><option value="volunteer">Volunteer</option><option value="moderator">Moderator</option></select></div>' +
        '<button type="submit" class="btn btn-primary btn-sm">Add to team</button></form>' +
        rows([["Volunteer", esc(ROLE_HELP.volunteer)], ["Moderator", esc(ROLE_HELP.moderator)]]) +
        "</section>" +
        '<ul class="mod-list">' + members.map(function (m) {
          var me = m.user_id === h.userId;
          return '<li class="mod-row mod-row-team" data-user="' + esc(m.user_id) + '" data-email="' + esc(m.email) + '" data-role="' + esc(m.role) + '">' +
            '<div class="mod-row-main"><p class="mod-row-title">' + esc(m.email) + (me ? ' <span class="mod-you">You</span>' : "") + '</p><p class="mod-sub">Added ' + when(m.created_at) + "</p></div>" +
            '<div class="mod-row-status"><select data-member-role aria-label="Role for ' + esc(m.email) + '">' +
            ["volunteer", "moderator"].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? " selected" : "") + ">" + (r === "moderator" ? "Moderator" : "Volunteer") + "</option>"; }).join("") + "</select></div>" +
            '<div class="mod-row-save"><button class="btn btn-ghost btn-sm" data-act="member-role">Save role</button><button class="btn-link mod-remove" data-act="member-remove">Remove</button></div>' +
            "</li>";
        }).join("") + "</ul>";
    }

    /* ---------- add a listing ---------- */
    var CATEGORY_LIST = ["Restaurants", "Grocery", "Modest Wear", "Health & Wellness", "Professional Services", "Education", "Home & Living", "Auto & Repair"];
    function addPanel() {
      function field(id, label, extra, tag) {
        return '<div class="field"><label for="' + id + '">' + label + "</label>" +
          (tag === "textarea" ? '<textarea id="' + id + '" rows="4"' + extra + "></textarea>" : '<input id="' + id + '" autocomplete="off"' + extra + ">") + "</div>";
      }
      return '<p class="mod-intro">Add a business you found, for example from a community directory. It is saved as a waiting listing with no owner, so it shows up under New listings to be published. The owner can claim it later.</p>' +
        '<form class="mod-add mod-form" id="adminListingForm">' +
        field("alName", "Business name", " required maxlength=\"120\"") +
        '<div class="field"><label for="alCat">Category</label><select id="alCat" required>' + CATEGORY_LIST.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("") + "</select></div>" +
        field("alHood", "Neighborhood or city", " required maxlength=\"60\" placeholder=\"Dublin\"") +
        field("alDesc", "Short description (shown on the card)", " required maxlength=\"300\"") +
        field("alLong", "Full description", " required maxlength=\"3000\"", "textarea") +
        field("alAddr", "Street address", " maxlength=\"250\"") +
        field("alPhone", "Phone", " maxlength=\"40\"") +
        field("alWeb", "Website (https://…)", " type=\"url\" maxlength=\"300\"") +
        field("alHours", "Hours, e.g. Mon-Sat 11am-9pm; Sun 12pm-6pm", "") +
        field("alSources", "Where you found it (links, one per line)", "", "textarea") +
        '<button type="submit" class="btn btn-primary btn-sm">Save listing</button></form>';
    }
    function parseHoursText(text) {
      return String(text || "").split(";").map(function (part) {
        var p = part.trim(), m = p.match(/^(\D*?)\s*(\d.*)$/);
        return m && m[1] ? [m[1].trim(), m[2].trim()] : [p, ""];
      }).filter(function (x) { return x[0]; });
    }

    /* ---------- layout ---------- */
    function navItem(id, label, n) {
      return '<button class="mod-nav-item" role="tab" data-tab="' + id + '" aria-selected="' + (state.tab === id) + '">' +
        "<span>" + label + "</span>" + (n ? '<span class="mod-nav-count">' + n + "</span>" : "") + "</button>";
    }
    function unhandledMessages() {
      return state.data ? state.data.messages.filter(function (m) { return !m.handled_at; }).length : 0;
    }
    function loading(what) { return '<p class="mod-loading">Loading ' + what + "…</p>"; }
    function render() {
      var d = state.data;
      var waiting = QUEUES.reduce(function (sum, q) { return sum + queueItems(q.id).length; }, 0);
      var nav = '<nav class="mod-rail" aria-label="Moderation">' +
        '<p class="mod-rail-sum">' + (waiting ? waiting + (waiting === 1 ? " item needs" : " items need") + " a decision" : "All caught up") + "</p>" +
        '<div role="tablist" aria-orientation="vertical">' +
        QUEUES.map(function (q) { return navItem(q.id, q.label, queueItems(q.id).length); }).join("") +
        '<hr class="mod-rail-rule">' +
        SECTIONS.filter(function (x) { return !x.modOnly || isMod; }).map(function (x) {
          return navItem(x.id, x.label, x.id === "messages" ? unhandledMessages() : 0);
        }).join("") +
        "</div>" +
        '<div class="mod-rail-foot"><p>Signed in as a ' + esc(h.role === "moderator" ? "moderator" : "volunteer") + ".</p>" +
        '<p>Checks for new items every minute.</p>' +
        '<button class="btn-link" data-act="desktop-alerts">' + (desktopOn() ? "Turn off desktop alerts" : "Turn on desktop alerts") + "</button>" +
        '<button class="btn-link" data-act="refresh">Refresh now</button></div>' +
        "</nav>";

      var body;
      var q = QUEUES.filter(function (x) { return x.id === state.tab; })[0];
      var title = q ? q.label : SECTIONS.filter(function (x) { return x.id === state.tab; })[0].label;
      if (q) {
        var items = queueItems(q.id);
        var sheet = { "new": listingSheet, edits: editSheet, claims: claimSheet, reviews: reviewSheet, reports: reportSheet }[q.id];
        var bulk = q.id === "reviews" && items.length > 1
          ? '<div class="mod-bulk"><label class="mod-select-all"><input type="checkbox" data-bulk-all> Select all</label>' +
            '<button class="btn btn-ghost btn-sm" data-act="bulk-review" data-status="rejected" disabled>Reject selected</button>' +
            '<button class="btn btn-primary btn-sm" data-act="bulk-review" data-status="approved" disabled>Publish selected</button></div>'
          : "";
        body = items.length ? bulk + items.map(sheet).join("") : '<div class="mod-empty"><p class="mod-empty-title">' + q.empty + "</p><p>New submissions show up here, and you'll see a count by My account.</p></div>";
      } else if (state.tab === "messages") {
        var msgs = d.messages.slice().sort(function (a, b) { return (a.handled_at ? 1 : 0) - (b.handled_at ? 1 : 0); });
        body = msgs.length ? msgs.map(messageSheet).join("") : '<div class="mod-empty"><p class="mod-empty-title">No messages yet.</p></div>';
      } else if (state.tab === "published") {
        body = !state.published ? loading("reviews")
          : '<p class="mod-intro">The latest 200 published reviews.' + (isMod ? "" : " A moderator can remove one; if you spot a problem, tell them.") + "</p>" +
            (state.published.length ? state.published.map(publishedReview).join("") : '<div class="mod-empty"><p>No published reviews yet.</p></div>');
      } else if (state.tab === "activity") {
        body = !state.log ? loading("activity")
          : state.log.length ? '<p class="mod-intro">The latest 300 decisions and notes by the team.</p><ol class="mod-log mod-sheet mod-sheet-quiet">' + state.log.map(logItem).join("") + "</ol>"
          : '<div class="mod-empty"><p>Nothing yet. Decisions show up here as the team makes them.</p></div>';
      } else if (state.tab === "guide") {
        body = state.guide ? '<article class="mod-guide-wrap">' + state.guide + "</article>"
          : state.guideError ? '<div class="mod-empty"><p class="mod-empty-title">' + esc(state.guideError) + '</p><p>Use <em>Refresh now</em> to try again.</p></div>'
          : loading("the guide");
      } else if (state.tab === "add") {
        body = addPanel();
      } else if (state.tab === "team") {
        body = state.team ? teamPanel(state.team) : loading("the team");
      } else if (state.tab === "sponsors") {
        body = state.sponsors && state.all ? sponsorsPanel(state.sponsors) : loading("sponsorships");
      } else {
        body = state.all ? allListingsView() : loading("listings");
      }
      root.innerHTML = '<div class="mod">' + nav +
        '<section class="mod-main" role="tabpanel" aria-label="' + esc(title) + '"><h2 class="mod-title">' + esc(title) + "</h2>" + body + "</section></div>";
    }

    // Loads what the current tab shows beyond the queue itself.
    // The guide comes from /api/guide with the session token (the server
    // re-checks team membership). It is our own trusted file, so it is
    // inserted as-is. Errors are shown in the panel instead of thrown.
    async function loadGuide() {
      try {
        var session = await window.NiccSupabase.auth.getSession();
        var token = session && session.data && session.data.session && session.data.session.access_token;
        var gr = await fetch("/api/guide", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
        var gd = await gr.json().catch(function () { return {}; });
        if (gr.ok && gd.ok && typeof gd.html === "string") { state.guide = gd.html; state.guideError = null; }
        else state.guideError = gd.error === "team_only" ? "The guide is only for signed-in team members." : "Couldn't load the guide.";
      } catch (e) {
        state.guideError = "Couldn't load the guide. Check your connection.";
      }
    }
    async function loadTab() {
      if (state.tab === "guide" && !state.guide) await loadGuide();
      if (state.tab === "all") state.all = await api.allBusinesses();
      if (state.tab === "published") state.published = await api.recentReviews();
      if (state.tab === "activity") state.log = await api.log();
      if (state.tab === "team" && isMod) state.team = await api.team();
      if (state.tab === "sponsors" && isMod) {
        var both = await Promise.all([api.sponsorships(), api.allBusinesses()]);
        state.sponsors = both[0]; state.all = both[1];
      }
    }
    async function refresh() {
      state.data = await api.queue();
      lastSeen = queueTotal();
      setTitle(lastSeen);
      await loadTab();
      render();
      if (h.onChange) h.onChange();
    }

    function closeReason(sheet) {
      var box = sheet && sheet.querySelector(".mod-reason");
      if (box) box.remove();
    }
    function openReason(btn_) {
      var sheet = btn_.closest(".mod-sheet") || btn_.closest(".mod-row");
      closeReason(sheet);
      var box = document.createElement("div");
      box.className = "mod-reason";
      var fid = "reason-" + Math.random().toString(36).slice(2, 9);
      var confirm = btn_.cloneNode(true);
      confirm.removeAttribute("data-ask");
      confirm.setAttribute("data-confirmed", "1");
      confirm.className = "btn btn-primary btn-sm";
      confirm.textContent = btn_.getAttribute("data-confirm-label") || "Confirm";
      confirm.disabled = false;
      box.innerHTML = '<label for="' + fid + '">' + esc(btn_.getAttribute("data-ask")) + ' <span class="mod-sub">(optional)</span></label>' +
        '<textarea id="' + fid + '" rows="3" maxlength="1000"></textarea>' +
        '<div class="mod-reason-actions"><button class="btn-link" data-act="reason-cancel">Cancel</button></div>';
      box.querySelector(".mod-reason-actions").appendChild(confirm);
      sheet.appendChild(box);
      box.querySelector("textarea").focus();
    }

    root.addEventListener("input", function (ev) {
      if (ev.target.id === "modAllQ") { state.allQuery = ev.target.value; state.allPage = 0; renderAllList(); }
    });
    root.addEventListener("change", function (ev) {
      var t = ev.target;
      if (t.id === "modAllStatus") { state.allStatus = t.value; state.allPage = 0; renderAllList(); return; }
      if (t.id === "modAllFlag") { state.allFlag = t.value; state.allPage = 0; renderAllList(); return; }
      if (t.hasAttribute("data-bulk-all")) {
        root.querySelectorAll("[data-bulk]").forEach(function (c) { c.checked = t.checked; });
      }
      if (t.hasAttribute("data-bulk") || t.hasAttribute("data-bulk-all")) {
        var n = root.querySelectorAll("[data-bulk]:checked").length;
        root.querySelectorAll('[data-act="bulk-review"]').forEach(function (b) {
          b.disabled = !n;
          b.textContent = (b.getAttribute("data-status") === "approved" ? "Publish " : "Reject ") + (n ? n + " selected" : "selected");
        });
      }
    });

    root.addEventListener("click", async function (ev) {
      var jump = ev.target.closest('.mod-guide-wrap a[href^="#g-"]');
      if (jump) { // in-guide links: scroll, don't change the page route
        ev.preventDefault();
        var dest = root.querySelector("#" + jump.getAttribute("href").slice(1));
        if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      var tab = ev.target.closest("[data-tab]");
      if (tab) {
        state.tab = tab.getAttribute("data-tab");
        render();
        var focusTarget = root.querySelector('[data-tab="' + state.tab + '"]');
        if (focusTarget) focusTarget.focus();
        var needs = (state.tab === "all" && !state.all) || state.tab === "published" || state.tab === "activity" ||
          (state.tab === "guide" && !state.guide) || (isMod && (state.tab === "team" || state.tab === "sponsors"));
        if (needs) {
          try { await loadTab(); render(); } catch (e) { h.toast(e.message || "Could not load that."); }
        }
        return;
      }
      var btn_ = ev.target.closest("[data-act]");
      if (!btn_) return;
      var act = btn_.getAttribute("data-act"), id = btn_.getAttribute("data-id"), s = btn_.getAttribute("data-status");
      if (act === "desktop-alerts") return; // handled by its own listener
      if (act === "reason-cancel") { closeReason(btn_.closest(".mod-sheet") || btn_.closest(".mod-row")); return; }
      if (btn_.hasAttribute("data-ask")) { openReason(btn_); return; }
      if (act === "page") {
        state.allPage += Number(btn_.getAttribute("data-dir"));
        renderAllList();
        var list = root.querySelector("#modAllList");
        if (list) list.scrollIntoView({ block: "start" });
        return;
      }
      if (act === "history") {
        if (state.openHistory[id]) { delete state.openHistory[id]; renderAllList(); return; }
        state.openHistory[id] = "loading"; renderAllList();
        try { state.openHistory[id] = await api.history(id); } catch (e) { delete state.openHistory[id]; h.toast(e.message || "Could not load the history."); }
        renderAllList();
        return;
      }
      if (act === "claim-approve" && btn_.getAttribute("data-has-owner") &&
          !window.confirm("This listing already has an owner. Approving moves it to the person who claimed it. Continue?")) return;
      var box = btn_.closest(".mod-reason");
      var why = box ? box.querySelector("textarea").value : null;
      btn_.disabled = true;
      try {
        var msg = "Done.";
        if (act === "refresh") { await refresh(); h.toast("Up to date."); return; }
        else if (act === "locate") {
          var session = await window.NiccSupabase.auth.getSession();
          var token = session && session.data && session.data.session && session.data.session.access_token;
          var lr = await fetch("/api/geocode", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ backfill: true }) });
          var ld = await lr.json().catch(function () { return {}; });
          btn_.disabled = false;
          if (!lr.ok) { h.toast(ld.error === "moderators_only" ? "Only moderators can do that." : "Couldn't reach the map lookup. Please try again."); return; }
          h.toast(ld.located + " placed on the map" + (ld.not_found ? ", " + ld.not_found + " addresses not found (check them)" : "") + (ld.more ? ". More left: click again." : ". All done."));
          return;
        }
        else if (act === "listing-status") { await api.setListingStatus(id, s, why); msg = s === "approved" ? "Published. It's now in the directory." : "Sent back to the owner."; }
        else if (act === "edit-apply") { await api.applyEdit(id); msg = "Changes applied to the live listing."; }
        else if (act === "edit-reject") { await api.rejectEdit(id, why); msg = "Changes rejected. The live listing is unchanged."; }
        else if (act === "claim-approve") { await api.resolveClaim(id, true); msg = "Claim approved. They now own the listing."; }
        else if (act === "claim-reject") { await api.resolveClaim(id, false, why); msg = "Claim rejected."; }
        else if (act === "review-status") { await api.setReviewStatus(id, s, why); msg = s === "approved" ? "Review published." : "Review removed."; }
        else if (act === "report") {
          var action = btn_.getAttribute("data-action");
          await api.resolveReport(id, action, why);
          msg = { dismiss: "Report dismissed.", resolve: "Report marked fixed.", hide_review: "Review hidden.", unpublish: "Listing taken down." }[action];
        }
        else if (act === "bulk-review") {
          var ids = Array.prototype.map.call(root.querySelectorAll("[data-bulk]:checked"), function (c) { return c.value; });
          var failed = 0;
          for (var i = 0; i < ids.length; i++) {
            try { await api.setReviewStatus(ids[i], s, null); } catch (e) { failed++; }
          }
          msg = (ids.length - failed) + (s === "approved" ? " published." : " rejected.") + (failed ? " " + failed + " could not be changed." : "");
        }
        else if (act === "comp-end") {
          if (!window.confirm("End the free placement for " + btn_.closest("[data-name]").getAttribute("data-name") + "? A paid sponsorship, if any, is not affected.")) { btn_.disabled = false; return; }
          await api.setComp(id, null, null, null);
          msg = "Free placement ended.";
        }
        else if (act === "message-handled") {
          await api.setMessageHandled(id, btn_.getAttribute("data-handled") === "1");
          msg = btn_.getAttribute("data-handled") === "1" ? "Marked handled." : "Reopened.";
        }
        else if (act === "save-flags") {
          var row = btn_.closest(".mod-row"); // not [data-id]: the button itself carries one
          var badges = Array.prototype.slice.call(row.querySelectorAll("[data-badge]:checked")).map(function (c) { return c.getAttribute("data-badge"); });
          var featured = row.querySelector('[data-field="featured"]').checked;
          var newStatus = row.querySelector('[data-field="status"]').value;
          var statusChanged = newStatus !== row.getAttribute("data-status");
          if (statusChanged && newStatus !== "approved" && !window.confirm("This takes " + row.getAttribute("data-name") + " out of the public directory. Continue?")) { btn_.disabled = false; return; }
          await api.setFlags(id, badges, featured);
          var untilEl = row.querySelector('[data-field="featured-until"]');
          if (untilEl) {
            var before = (state.all || []).filter(function (x) { return x.id === id; })[0];
            if (untilEl.value !== dateValue(before && before.featured_until)) await api.setFeaturedUntil(id, endOfDay(untilEl.value));
          }
          if (statusChanged) await api.setListingStatus(id, newStatus, null);
          msg = "Saved.";
        }
        else if (act === "member-role") {
          var mrow = btn_.closest("[data-user]");
          await api.setMemberRole(mrow.getAttribute("data-user"), mrow.querySelector("[data-member-role]").value);
          if (mrow.getAttribute("data-user") === h.userId) {
            // Your own role changed: reload so the page shows what you can do now.
            h.toast("Your role was updated.");
            window.setTimeout(function () { window.location.reload(); }, 600);
            return;
          }
          msg = "Role updated.";
        }
        else if (act === "member-remove") {
          var rrow = btn_.closest("[data-user]");
          if (!window.confirm("Remove " + rrow.getAttribute("data-email") + " from the team? They keep their account but lose moderation access.")) { btn_.disabled = false; return; }
          await api.removeMember(rrow.getAttribute("data-user"));
          msg = "Removed from the team.";
        }
        await refresh();
        h.toast(msg);
      } catch (err) {
        h.toast((err && err.message) || "That didn't work. Please try again.");
        btn_.disabled = false;
      }
    });

    root.addEventListener("submit", async function (ev) {
      var noteForm = ev.target.closest(".mod-note-form");
      if (noteForm) {
        ev.preventDefault();
        var nid = noteForm.getAttribute("data-id");
        var text = noteForm.querySelector("textarea").value.trim();
        if (!text) return;
        var nb = noteForm.querySelector("button");
        nb.disabled = true;
        try {
          await api.addNote(nid, text);
          state.openHistory[nid] = await api.history(nid);
          renderAllList();
          h.toast("Note added.");
        } catch (err) {
          h.toast((err && err.message) || "Could not add the note.");
          nb.disabled = false;
        }
        return;
      }
      var compForm = ev.target.closest("#modCompForm");
      if (compForm) {
        ev.preventDefault();
        var cb = compForm.querySelector('button[type="submit"]');
        var listing = document.getElementById("compListing").value, until = document.getElementById("compUntil").value;
        if (!listing || !until) { h.toast("Choose a listing and an end date."); return; }
        cb.disabled = true;
        try {
          await api.setComp(listing, document.getElementById("compTier").value, endOfDay(until), document.getElementById("compNote").value);
          await refresh();
          h.toast("Placement added.");
        } catch (err) {
          h.toast((err && err.message) || "Could not add it.");
          cb.disabled = false;
        }
        return;
      }
      var listingForm = ev.target.closest("#adminListingForm");
      if (listingForm) {
        ev.preventDefault();
        var lb = listingForm.querySelector('button[type="submit"]');
        var gv = function (id) { return document.getElementById(id).value.trim(); };
        lb.disabled = true;
        try {
          await api.addListing({
            name: gv("alName"), category: gv("alCat"), neighborhood: gv("alHood"),
            description: gv("alDesc"), long_description: gv("alLong"),
            address: gv("alAddr"), phone: gv("alPhone"), website: gv("alWeb"),
            hours: parseHoursText(gv("alHours")),
            source_urls: gv("alSources").split(/\s+/).filter(function (u) { return /^https?:\/\//.test(u); })
          });
          state.tab = "new";
          await refresh();
          h.toast("Listing saved. It is waiting under New listings.");
        } catch (err) {
          h.toast((err && err.message) || "Could not save the listing.");
          lb.disabled = false;
        }
        return;
      }
      var form = ev.target.closest("#adminAddForm");
      if (!form) return;
      ev.preventDefault();
      var email = document.getElementById("adminAddEmail").value.trim();
      var role = document.getElementById("adminAddRole").value;
      var btn_ = form.querySelector('button[type="submit"]');
      if (!email) return;
      btn_.disabled = true;
      try {
        await api.addMember(email, role);
        state.team = await api.team();
        render();
        h.toast("Added as a " + role + ".");
      } catch (err) {
        h.toast((err && err.message) || "Could not add them. Please try again.");
        btn_.disabled = false;
      }
    });

    /* ---- Live updates: check for new items every minute ---- */
    var DESKTOP_KEY = "nicc-admin-desktop-alerts";
    function desktopOn() {
      try { return localStorage.getItem(DESKTOP_KEY) === "1" && window.Notification && Notification.permission === "granted"; } catch (e) { return false; }
    }
    function queueTotal() {
      return QUEUES.reduce(function (sum, q) { return sum + queueItems(q.id).length; }, 0);
    }
    function setTitle(n) {
      document.title = (n ? "(" + n + ") " : "") + "Moderation — NICC Business";
    }
    function showBanner(n) {
      var main = root.querySelector(".mod-main");
      if (!main) return;
      var b = root.querySelector(".mod-banner");
      if (!b) {
        b = document.createElement("div");
        b.className = "mod-banner";
        b.setAttribute("role", "status");
        main.insertBefore(b, main.firstChild);
      }
      b.innerHTML = "<p><strong>" + n + (n === 1 ? " new item" : " new items") + "</strong> came in.</p>" +
        '<button class="btn btn-primary btn-sm" data-act="refresh">Show them</button>';
    }
    var lastSeen = null;
    async function poll() {
      if (document.getElementById("page-admin") && document.getElementById("page-admin").hidden) return;
      var c;
      try { c = await api.counts(); } catch (e) { return; }
      setTitle(c.total);
      if (lastSeen != null && c.total > lastSeen) {
        var added = c.total - lastSeen;
        // Don't re-render under the moderator (they may be mid-edit); offer it.
        showBanner(added);
        h.toast(added === 1 ? "A new item needs review." : added + " new items need review.");
        if (desktopOn() && document.hidden) {
          try { new Notification("NICC Business moderation", { body: (added === 1 ? "1 new item" : added + " new items") + " waiting for review.", tag: "nicc-moderation" }); } catch (e) { /* unsupported */ }
        }
      }
      lastSeen = c.total;
    }
    var timer = window.setInterval(poll, 60000);

    root.addEventListener("click", async function (ev) {
      var t = ev.target.closest("[data-act='desktop-alerts']");
      if (!t) return;
      if (!window.Notification) { h.toast("This browser doesn't support desktop alerts."); return; }
      if (desktopOn()) {
        try { localStorage.removeItem(DESKTOP_KEY); } catch (e) { /* ignore */ }
        h.toast("Desktop alerts turned off.");
      } else {
        var perm = await Notification.requestPermission();
        if (perm !== "granted") { h.toast("Desktop alerts are blocked in your browser settings."); return; }
        try { localStorage.setItem(DESKTOP_KEY, "1"); } catch (e) { /* ignore */ }
        h.toast("Desktop alerts on. You'll get one when something new arrives while this page is open.");
      }
      render();
    });

    refresh().then(function () { lastSeen = queueTotal(); setTitle(lastSeen); }).catch(function (err) {
      root.innerHTML = '<div class="mod-empty"><p class="mod-empty-title">Could not load the moderation queue.</p><p>' + esc((err && err.message) || "Unknown error") + "</p></div>";
    });
    return function stop() { window.clearInterval(timer); };
  }

  window.NiccAdmin = Object.assign({ mount: mount }, api);
})();
