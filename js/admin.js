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

  var api = {
    status: status,
    queue: function () { return rpc("admin_queue"); },
    counts: function () { return rpc("admin_counts"); },
    allBusinesses: function () { return rpc("admin_all_businesses"); },
    team: function () { return rpc("admin_team"); },
    addMember: function (email, role) { return rpc("admin_add_member", { p_email: email, p_role: role }); },
    setMemberRole: function (userId, role) { return rpc("admin_set_member_role", { p_user: userId, p_role: role }); },
    removeMember: function (userId) { return rpc("admin_remove_member", { p_user: userId }); },
    setListingStatus: function (id, s) { return rpc("admin_set_listing_status", { p_id: id, p_status: s }); },
    setFlags: function (id, badges, featured) { return rpc("admin_set_listing_flags", { p_id: id, p_badges: badges, p_featured: featured }); },
    applyEdit: function (id) { return rpc("admin_apply_edit", { p_id: id }); },
    rejectEdit: function (id) { return rpc("admin_reject_edit", { p_id: id }); },
    resolveClaim: function (id, approve) { return rpc("admin_resolve_claim", { p_id: id, p_approve: approve }); },
    setReviewStatus: function (id, s) { return rpc("admin_set_review_status", { p_id: id, p_status: s }); }
  };

  // Queues that need a decision come first; the rest is reference/management.
  var QUEUES = [
    { id: "new", label: "New listings", key: "new_listings", empty: "No new listings to review." },
    { id: "edits", label: "Edits", key: "edits", empty: "No edits waiting." },
    { id: "claims", label: "Claims", key: "claims", empty: "No claims waiting." },
    { id: "reviews", label: "Reviews", key: "reviews", empty: "No reviews waiting." }
  ];
  var SECTIONS = [
    { id: "messages", label: "Messages" },
    { id: "all", label: "All listings" },
    { id: "team", label: "Team", modOnly: true }
  ];
  var ROLE_HELP = {
    moderator: "Full control, including Featured, taking listings down, and managing the team.",
    volunteer: "Reviews new listings, edits, claims and reviews, and sets badges."
  };
  var FIELD_LABELS = {
    name: "Name", category: "Category", neighborhood: "Neighborhood",
    description: "Short description", long_description: "Full description",
    address: "Address", phone: "Phone", website: "Website", photo_url: "Photo"
  };
  var BADGES = [
    ["halal", "Halal verified"], ["prayer", "Prayer space"], ["women", "Women owned"],
    ["family", "Family run"], ["community", "Community service"]
  ];
  var HALAL_LABELS = {
    certified: "Certified halal (says they can name the certifier)",
    supplier: "Halal supplier, not formally certified",
    some: "Some halal options",
    na: "Not applicable"
  };
  var STATUS_LABELS = { approved: "Live", pending: "Waiting for review", rejected: "Not approved" };
  var dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // root: container element. h: { escape, safeUrl, toast, role, userId, onChange } from the page.
  function mount(root, h) {
    var esc = h.escape;
    var isMod = h.role === "moderator";
    var state = { tab: "new", data: null, all: null, team: null };

    function when(iso) { try { return dateFmt.format(new Date(iso)); } catch (e) { return ""; } }
    function queueItems(id) {
      var q = QUEUES.filter(function (x) { return x.id === id; })[0];
      return q && state.data ? state.data[q.key] || [] : [];
    }
    function none(text) { return '<span class="mod-none">' + (text || "Not given") + "</span>"; }
    function val(v) { return v == null || v === "" ? none() : esc(v); }
    function where(cat, hood) { return esc(cat) + " in " + esc(hood); }
    function star(filled) { return '<svg class="icon' + (filled ? " filled" : "") + '" aria-hidden="true"><use href="#i-star"/></svg>'; }
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

    /* ---------- one sheet per item ---------- */
    function listingSheet(l) {
      var photo = h.safeUrl(l.photo_url);
      var hours = (l.hours || []).map(function (r) { return esc(r[0]) + " " + esc(r[1]); }).join("<br>");
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(l.name) + '</h3><p class="mod-sub">' + where(l.category, l.neighborhood) + "</p></div>" +
        '<p class="mod-when">Submitted ' + when(l.created_at) + "<br>by " + val(l.owner_email) + "</p></header>" +
        (photo ? '<img src="' + photo + '" alt="" class="mod-photo">' : "") +
        '<p class="mod-lede">' + esc(l.description) + '</p><p class="mod-prose">' + esc(l.long_description) + "</p>" +
        rows([
          ["Halal (owner says)", l.halal_status ? esc(HALAL_LABELS[l.halal_status] || l.halal_status) : none()],
          ["Address", val(l.address)], ["Phone", val(l.phone)], ["Website", val(l.website)],
          ["Hours", hours || none()]
        ]) +
        decision(btn("ghost", "listing-status", l.id, "Reject", ' data-status="rejected"'),
                 btn("primary", "listing-status", l.id, "Approve and publish", ' data-status="approved"')) +
        "</article>";
    }

    function editSheet(e) {
      var changed = Object.keys(e.changes);
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(e.business_name) + '</h3><p class="mod-sub">' +
        changed.length + (changed.length === 1 ? " change" : " changes") + " proposed. The live listing stays as it is until you apply them.</p></div>" +
        '<p class="mod-when">Edited ' + when(e.submitted_at) + "<br>by " + val(e.owner_email) + "</p></header>" +
        '<div class="mod-diff">' + changed.map(function (k) {
          return '<div class="mod-diff-row"><p class="mod-diff-field">' + esc(FIELD_LABELS[k] || k) + "</p>" +
            '<div class="mod-diff-old"><span class="mod-diff-tag">Now</span>' + fieldVal(k, e.live[k]) + "</div>" +
            '<div class="mod-diff-new"><span class="mod-diff-tag">Proposed</span>' + fieldVal(k, e.changes[k]) + "</div></div>";
        }).join("") + "</div>" +
        decision(btn("ghost", "edit-reject", e.business_id, "Reject changes"), btn("primary", "edit-apply", e.business_id, "Apply changes")) +
        "</article>";
    }

    function claimSheet(c) {
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(c.business_name) + '</h3><p class="mod-sub">' +
        (c.current_owner_email ? "Already has an owner. Approving moves the listing to the person claiming it." : "No owner yet.") + "</p></div>" +
        '<p class="mod-when">Requested ' + when(c.created_at) + "</p></header>" +
        rows([["Claimed by", val(c.requester_email)], ["Current owner", c.current_owner_email ? esc(c.current_owner_email) : none("No one")], ["Their note", val(c.note)]]) +
        decision(btn("ghost", "claim-reject", c.id, "Reject"),
                 btn("primary", "claim-approve", c.id, "Approve and transfer", ' data-has-owner="' + (c.current_owner_email ? "1" : "") + '"')) +
        "</article>";
    }

    function reviewSheet(r) {
      var rating = Math.min(5, Math.max(0, Number(r.rating) | 0)); // always a plain 0-5 integer
      var stars = "";
      for (var i = 1; i <= 5; i++) stars += star(i <= rating);
      return '<article class="mod-sheet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(r.business_name) + '</h3><p class="mod-sub mod-stars" aria-label="' + rating + ' out of 5">' + stars + "</p></div>" +
        '<p class="mod-when">' + when(r.created_at) + "<br>by " + esc(r.author_name) + "</p></header>" +
        '<blockquote class="mod-quote">' + esc(r.body) + "</blockquote>" +
        decision(btn("ghost", "review-status", r.id, "Reject", ' data-status="rejected"'), btn("primary", "review-status", r.id, "Publish review", ' data-status="approved"')) +
        "</article>";
    }

    function messageSheet(m) {
      var subject = "Re: " + (m.subject || "your message to NICC Business");
      return '<article class="mod-sheet mod-sheet-quiet">' +
        '<header class="mod-sheet-head"><div><h3>' + esc(m.name) + '</h3><p class="mod-sub">' + esc(m.subject || "No subject") + "</p></div>" +
        '<p class="mod-when">' + when(m.created_at) + "<br>" + esc(m.email) + "</p></header>" +
        '<p class="mod-prose">' + esc(m.message) + "</p>" +
        '<div class="mod-decide"><span></span><a class="btn btn-ghost btn-sm" href="mailto:' + esc(encodeURIComponent(m.email)) + "?subject=" + encodeURIComponent(subject) + '">Reply by email</a></div>' +
        "</article>";
    }

    /* ---------- management views ---------- */
    function pill(attrs, label, on, disabled, title) {
      return '<label class="mod-pill' + (disabled ? " is-locked" : "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + '><input type="checkbox" ' + attrs + (on ? " checked" : "") + (disabled ? " disabled" : "") + "><span>" + label + "</span></label>";
    }
    function allListings(rows_) {
      return '<p class="mod-intro">Every listing in the directory. Badges are set by volunteers and moderators' + (isMod ? "; status and Featured by moderators." : ". Status and Featured are set by moderators.") + "</p>" +
        '<ul class="mod-list">' + rows_.map(function (b) {
          var statusSel = '<select data-field="status" aria-label="Status for ' + esc(b.name) + '"' + (isMod ? "" : " disabled") + ">" +
            ["approved", "pending", "rejected"].map(function (s) { return '<option value="' + s + '"' + (b.status === s ? " selected" : "") + ">" + STATUS_LABELS[s] + "</option>"; }).join("") + "</select>";
          return '<li class="mod-row" data-id="' + esc(b.id) + '" data-name="' + esc(b.name) + '" data-status="' + esc(b.status) + '">' +
            '<div class="mod-row-main"><p class="mod-row-title">' + esc(b.name) + '</p><p class="mod-sub">' + where(b.category, b.neighborhood) +
            (b.owner_email ? ", owned by " + esc(b.owner_email) : ", no owner") + "</p></div>" +
            '<div class="mod-row-status">' + statusSel + "</div>" +
            '<div class="mod-row-pills" role="group" aria-label="Badges for ' + esc(b.name) + '">' +
            BADGES.map(function (p) { return pill('data-badge="' + p[0] + '"', p[1], (b.badges || []).indexOf(p[0]) !== -1); }).join("") +
            pill('data-field="featured"', "Featured on home page", b.featured, !isMod, isMod ? "" : "Only moderators can change Featured").replace('class="mod-pill', 'class="mod-pill mod-pill-featured') + "</div>" +
            '<div class="mod-row-save"><button class="btn btn-ghost btn-sm" data-act="save-flags" data-id="' + esc(b.id) + '">Save</button></div>' +
            "</li>";
        }).join("") + "</ul>";
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

    /* ---------- layout ---------- */
    function navItem(id, label, n) {
      return '<button class="mod-nav-item" role="tab" data-tab="' + id + '" aria-selected="' + (state.tab === id) + '">' +
        "<span>" + label + "</span>" + (n ? '<span class="mod-nav-count">' + n + "</span>" : "") + "</button>";
    }
    function render() {
      var d = state.data;
      var waiting = QUEUES.reduce(function (sum, q) { return sum + queueItems(q.id).length; }, 0);
      var nav = '<nav class="mod-rail" aria-label="Moderation">' +
        '<p class="mod-rail-sum">' + (waiting ? waiting + (waiting === 1 ? " item needs" : " items need") + " a decision" : "All caught up") + "</p>" +
        '<div role="tablist" aria-orientation="vertical">' +
        QUEUES.map(function (q) { return navItem(q.id, q.label, queueItems(q.id).length); }).join("") +
        '<hr class="mod-rail-rule">' +
        SECTIONS.filter(function (x) { return !x.modOnly || isMod; }).map(function (x) { return navItem(x.id, x.label, 0); }).join("") +
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
        var sheet = { "new": listingSheet, edits: editSheet, claims: claimSheet, reviews: reviewSheet }[q.id];
        body = items.length ? items.map(sheet).join("") : '<div class="mod-empty"><p class="mod-empty-title">' + q.empty + "</p><p>New submissions show up here, and you'll see a count by My account.</p></div>";
      } else if (state.tab === "messages") {
        body = d.messages.length ? d.messages.map(messageSheet).join("") : '<div class="mod-empty"><p class="mod-empty-title">No messages yet.</p></div>';
      } else if (state.tab === "team") {
        body = state.team ? teamPanel(state.team) : '<p class="mod-loading">Loading the team…</p>';
      } else {
        body = state.all ? allListings(state.all) : '<p class="mod-loading">Loading listings…</p>';
      }
      root.innerHTML = '<div class="mod">' + nav +
        '<section class="mod-main" role="tabpanel" aria-label="' + esc(title) + '"><h2 class="mod-title">' + esc(title) + "</h2>" + body + "</section></div>";
    }

    async function refresh() {
      state.data = await api.queue();
      lastSeen = queueTotal();
      setTitle(lastSeen);
      if (state.tab === "all") state.all = await api.allBusinesses();
      if (state.tab === "team" && isMod) state.team = await api.team();
      render();
      if (h.onChange) h.onChange();
    }

    root.addEventListener("click", async function (ev) {
      var tab = ev.target.closest("[data-tab]");
      if (tab) {
        state.tab = tab.getAttribute("data-tab");
        render();
        var focusTarget = root.querySelector('[data-tab="' + state.tab + '"]');
        if (focusTarget) focusTarget.focus();
        if (state.tab === "all" && !state.all) {
          try { state.all = await api.allBusinesses(); render(); } catch (e) { h.toast(e.message || "Could not load listings."); }
        }
        if (state.tab === "team" && isMod) {
          try { state.team = await api.team(); render(); } catch (e) { h.toast(e.message || "Could not load the team."); }
        }
        return;
      }
      var btn = ev.target.closest("[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act"), id = btn.getAttribute("data-id"), s = btn.getAttribute("data-status");
      if (act === "desktop-alerts") return; // handled by its own listener
      if (act === "claim-approve" && btn.getAttribute("data-has-owner") &&
          !window.confirm("This listing already has an owner. Approving moves it to the person who claimed it. Continue?")) return;
      btn.disabled = true;
      try {
        var msg = "Done.";
        if (act === "refresh") { await refresh(); h.toast("Up to date."); return; }
        else if (act === "listing-status") { await api.setListingStatus(id, s); msg = s === "approved" ? "Published. It's now in the directory." : "Listing rejected."; }
        else if (act === "edit-apply") { await api.applyEdit(id); msg = "Changes applied to the live listing."; }
        else if (act === "edit-reject") { await api.rejectEdit(id); msg = "Changes rejected. The live listing is unchanged."; }
        else if (act === "claim-approve") { await api.resolveClaim(id, true); msg = "Claim approved. They now own the listing."; }
        else if (act === "claim-reject") { await api.resolveClaim(id, false); msg = "Claim rejected."; }
        else if (act === "review-status") { await api.setReviewStatus(id, s); msg = s === "approved" ? "Review published." : "Review rejected."; }
        else if (act === "save-flags") {
          var row = btn.closest(".mod-row"); // not [data-id]: the button itself carries one
          var badges = Array.prototype.slice.call(row.querySelectorAll("[data-badge]:checked")).map(function (c) { return c.getAttribute("data-badge"); });
          var featured = row.querySelector('[data-field="featured"]').checked;
          var newStatus = row.querySelector('[data-field="status"]').value;
          var statusChanged = newStatus !== row.getAttribute("data-status");
          if (statusChanged && newStatus !== "approved" && !window.confirm("This takes " + row.getAttribute("data-name") + " out of the public directory. Continue?")) { btn.disabled = false; return; }
          await api.setFlags(id, badges, featured);
          if (statusChanged) await api.setListingStatus(id, newStatus);
          msg = "Saved.";
        }
        else if (act === "member-role") {
          var mrow = btn.closest("[data-user]");
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
          var rrow = btn.closest("[data-user]");
          if (!window.confirm("Remove " + rrow.getAttribute("data-email") + " from the team? They keep their account but lose moderation access.")) { btn.disabled = false; return; }
          await api.removeMember(rrow.getAttribute("data-user"));
          msg = "Removed from the team.";
        }
        await refresh();
        h.toast(msg);
      } catch (err) {
        h.toast((err && err.message) || "That didn't work. Please try again.");
        btn.disabled = false;
      }
    });

    root.addEventListener("submit", async function (ev) {
      var form = ev.target.closest("#adminAddForm");
      if (!form) return;
      ev.preventDefault();
      var email = document.getElementById("adminAddEmail").value.trim();
      var role = document.getElementById("adminAddRole").value;
      var btn = form.querySelector('button[type="submit"]');
      if (!email) return;
      btn.disabled = true;
      try {
        await api.addMember(email, role);
        state.team = await api.team();
        render();
        h.toast("Added as a " + role + ".");
      } catch (err) {
        h.toast((err && err.message) || "Could not add them. Please try again.");
        btn.disabled = false;
      }
    });

    /* ---- Live updates: check for new items every minute ---- */
    var DESKTOP_KEY = "nicc-admin-desktop-alerts";
    function desktopOn() {
      try { return localStorage.getItem(DESKTOP_KEY) === "1" && window.Notification && Notification.permission === "granted"; } catch (e) { return false; }
    }
    function queueTotal() {
      var d = state.data;
      return d ? d.new_listings.length + d.edits.length + d.claims.length + d.reviews.length : 0;
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
