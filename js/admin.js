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

  var TABS = [
    ["new", "New listings"], ["edits", "Edits"], ["claims", "Claims"],
    ["reviews", "Reviews"], ["messages", "Messages"], ["all", "All listings"], ["team", "Team", "moderator"]
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
    certified: "Certified halal, says they can name the certifier",
    supplier: "Halal supplier, not formally certified",
    some: "Some halal options",
    na: "Not applicable"
  };
  var dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  // root: container element. h: { escape, safeUrl, toast, role, userId } from the page.
  function mount(root, h) {
    var esc = h.escape;
    var isMod = h.role === "moderator";
    var state = { tab: "new", data: null, all: null, team: null };

    function when(iso) { try { return dateFmt.format(new Date(iso)); } catch (e) { return ""; } }
    function count(key) { return state.data && state.data[key] ? state.data[key].length : 0; }
    function tabCount(id) {
      return { "new": count("new_listings"), edits: count("edits"), claims: count("claims"), reviews: count("reviews") }[id];
    }
    function cell(v) { return v == null || v === "" ? '<span class="admin-none">(none)</span>' : esc(v); }
    function val(field, v) {
      if (field === "photo_url") {
        var u = h.safeUrl(v);
        return u ? '<img src="' + u + '" alt="" class="admin-thumb">' : '<span class="admin-none">(none)</span>';
      }
      return field === "description" || field === "long_description"
        ? '<span class="admin-long">' + cell(v) + "</span>" : cell(v);
    }

    function listingCard(l) {
      var photo = h.safeUrl(l.photo_url);
      var hours = (l.hours || []).map(function (r) { return esc(r[0]) + " " + esc(r[1]); }).join(" · ");
      return '<article class="admin-card" data-id="' + esc(l.id) + '">' +
        '<div class="admin-card-head"><h3>' + esc(l.name) + '</h3><span class="admin-meta">' + esc(l.category) + " · " + esc(l.neighborhood) + "</span></div>" +
        '<p class="admin-meta">Submitted ' + when(l.created_at) + " by " + cell(l.owner_email) + "</p>" +
        (photo ? '<img src="' + photo + '" alt="" class="admin-thumb">' : "") +
        "<p>" + esc(l.description) + '</p><p class="admin-long">' + esc(l.long_description) + "</p>" +
        '<dl class="admin-dl"><dt>Address</dt><dd>' + cell(l.address) + "</dd><dt>Phone</dt><dd>" + cell(l.phone) +
        "</dd><dt>Website</dt><dd>" + cell(l.website) + "</dd><dt>Hours</dt><dd>" + (hours || cell("")) +
        "</dd><dt>Halal (owner says)</dt><dd>" + cell(HALAL_LABELS[l.halal_status] || l.halal_status) + "</dd></dl>" +
        '<div class="admin-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="listing-status" data-id="' + esc(l.id) + '" data-status="approved">Approve</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="listing-status" data-id="' + esc(l.id) + '" data-status="rejected">Reject</button></div></article>';
    }

    function editCard(e) {
      var rows = Object.keys(e.changes).map(function (k) {
        return "<tr><th scope=\"row\">" + esc(FIELD_LABELS[k] || k) + "</th><td>" + val(k, e.live[k]) + "</td><td class=\"admin-new\">" + val(k, e.changes[k]) + "</td></tr>";
      }).join("");
      return '<article class="admin-card"><div class="admin-card-head"><h3>' + esc(e.business_name) + "</h3></div>" +
        '<p class="admin-meta">Edited ' + when(e.submitted_at) + " by " + cell(e.owner_email) + ". The live listing is unchanged until you apply this.</p>" +
        '<table class="admin-diff"><thead><tr><th></th><th scope="col">Live now</th><th scope="col">Proposed</th></tr></thead><tbody>' + rows + "</tbody></table>" +
        '<div class="admin-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="edit-apply" data-id="' + esc(e.business_id) + '">Apply changes</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="edit-reject" data-id="' + esc(e.business_id) + '">Reject</button></div></article>';
    }

    function claimCard(c) {
      return '<article class="admin-card"><div class="admin-card-head"><h3>' + esc(c.business_name) + "</h3></div>" +
        '<p class="admin-meta">Requested ' + when(c.created_at) + "</p>" +
        "<dl class=\"admin-dl\"><dt>Requested by</dt><dd>" + cell(c.requester_email) + "</dd><dt>Current owner</dt><dd>" +
        (c.current_owner_email ? esc(c.current_owner_email) : '<span class="admin-none">no one yet</span>') + "</dd><dt>Note</dt><dd>" + cell(c.note) + "</dd></dl>" +
        '<div class="admin-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="claim-approve" data-id="' + esc(c.id) + '" data-has-owner="' + (c.current_owner_email ? "1" : "") + '">Approve: make them the owner</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="claim-reject" data-id="' + esc(c.id) + '">Reject</button></div></article>';
    }

    function reviewCard(r) {
      var rating = Math.min(5, Math.max(0, Number(r.rating) | 0)); // always a plain 0-5 integer
      var stars = "★★★★★☆☆☆☆☆".slice(5 - rating, 10 - rating);
      return '<article class="admin-card"><div class="admin-card-head"><h3>' + esc(r.business_name) + '</h3><span class="admin-stars" aria-label="' + rating + ' out of 5">' + stars + "</span></div>" +
        '<p class="admin-meta">By ' + esc(r.author_name) + ", " + when(r.created_at) + '</p><p class="admin-long">' + esc(r.body) + "</p>" +
        '<div class="admin-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="review-status" data-id="' + esc(r.id) + '" data-status="approved">Approve</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="review-status" data-id="' + esc(r.id) + '" data-status="rejected">Reject</button></div></article>';
    }

    function messageCard(m) {
      var subject = "Re: " + (m.subject || "your message to NICC Business");
      return '<article class="admin-card"><div class="admin-card-head"><h3>' + esc(m.name) + '</h3><span class="admin-meta">' + esc(m.subject || "") + "</span></div>" +
        '<p class="admin-meta">' + when(m.created_at) + " · " + esc(m.email) + '</p><p class="admin-long">' + esc(m.message) + "</p>" +
        '<div class="admin-actions"><a class="btn btn-ghost btn-sm" href="mailto:' + esc(encodeURIComponent(m.email)) + "?subject=" + encodeURIComponent(subject) + '">Reply by email</a></div></article>';
    }

    function allTable(rows) {
      return '<div class="admin-scroll"><table class="admin-all"><thead><tr><th scope="col">Listing</th><th scope="col">Status</th><th scope="col">Badges</th><th scope="col">Featured</th><th></th></tr></thead><tbody>' +
        rows.map(function (b) {
          var id = esc(b.id);
          var statusSel = '<select data-field="status"' + (isMod ? "" : " disabled title=\"Only a moderator can change a published listing\"") + ' aria-label="Status for ' + esc(b.name) + '">' +
            ["approved", "pending", "rejected"].map(function (s) { return '<option value="' + s + '"' + (b.status === s ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select>";
          var badges = BADGES.map(function (p) {
            return '<label class="admin-check"><input type="checkbox" data-badge="' + p[0] + '"' + ((b.badges || []).indexOf(p[0]) !== -1 ? " checked" : "") + "> " + p[1] + "</label>";
          }).join("");
          return '<tr data-id="' + id + '" data-name="' + esc(b.name) + '" data-status="' + esc(b.status) + '"><th scope="row">' + esc(b.name) +
            '<div class="admin-meta">' + esc(b.category) + " · " + esc(b.neighborhood) + " · " + cell(b.owner_email) + "</div></th><td>" + statusSel +
            "</td><td>" + badges + '</td><td><label class="admin-check"><input type="checkbox" data-field="featured"' + (b.featured ? " checked" : "") + (isMod ? "" : " disabled") + '> Featured</label></td>' +
            '<td><button class="btn btn-ghost btn-sm" data-act="save-flags" data-id="' + id + '">Save</button></td></tr>';
        }).join("") + "</tbody></table></div>";
    }

    function teamPanel(members) {
      var rows = members.map(function (m) {
        var me = m.user_id === h.userId;
        var roleSel = '<select data-member-role aria-label="Role for ' + esc(m.email) + '">' +
          ["moderator", "volunteer"].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select>";
        return '<tr data-user="' + esc(m.user_id) + '" data-email="' + esc(m.email) + '" data-role="' + esc(m.role) + '"><th scope="row">' + esc(m.email) + (me ? ' <span class="admin-meta">(you)</span>' : "") +
          '</th><td>' + roleSel + '</td><td class="admin-meta">Added ' + when(m.created_at) + '</td><td class="admin-actions-cell">' +
          '<button class="btn btn-ghost btn-sm" data-act="member-role">Save role</button> ' +
          '<button class="btn btn-ghost btn-sm" data-act="member-remove">Remove</button></td></tr>';
      }).join("");
      return '<div class="admin-card"><h3>Add someone to the team</h3>' +
        '<p class="admin-meta">They need an account on the site first, with two-factor turned on (My account). Then add them by the email they signed up with.</p>' +
        '<form class="admin-add" id="adminAddForm"><div class="field"><label for="adminAddEmail">Their email</label><input type="email" id="adminAddEmail" autocomplete="off" spellcheck="false" required></div>' +
        '<div class="field"><label for="adminAddRole">Role</label><select id="adminAddRole"><option value="volunteer">Volunteer</option><option value="moderator">Moderator</option></select></div>' +
        '<button type="submit" class="btn btn-primary btn-sm">Add to team</button></form>' +
        '<ul class="admin-meta admin-rolehelp"><li><strong>Volunteer:</strong> ' + esc(ROLE_HELP.volunteer) + '</li><li><strong>Moderator:</strong> ' + esc(ROLE_HELP.moderator) + '</li></ul></div>' +
        '<div class="admin-scroll"><table class="admin-all"><thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Added</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function render() {
      var tabs = '<div class="admin-tabs" role="tablist" aria-label="Moderation queues">' + TABS.filter(function (t) { return !t[2] || isMod; }).map(function (t) {
        var n = tabCount(t[0]);
        return '<button role="tab" class="admin-tab" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + t[1] +
          (n ? ' <span class="admin-count">' + n + "</span>" : "") + "</button>";
      }).join("") + '<button class="btn btn-ghost btn-sm admin-refresh" data-act="refresh">Refresh</button></div>';

      var body = "";
      var d = state.data;
      var empty = function (msg) { return '<p class="admin-empty">' + msg + "</p>"; };
      if (state.tab === "new") body = d.new_listings.length ? d.new_listings.map(listingCard).join("") : empty("No new listings waiting. 🎉");
      else if (state.tab === "edits") body = d.edits.length ? d.edits.map(editCard).join("") : empty("No edits waiting.");
      else if (state.tab === "claims") body = d.claims.length ? d.claims.map(claimCard).join("") : empty("No claims waiting.");
      else if (state.tab === "reviews") body = d.reviews.length ? d.reviews.map(reviewCard).join("") : empty("No reviews waiting.");
      else if (state.tab === "messages") body = d.messages.length ? d.messages.map(messageCard).join("") : empty("No messages yet.");
      else if (state.tab === "team") body = state.team ? teamPanel(state.team) : empty("Loading…");
      else body = state.all ? allTable(state.all) : empty("Loading…");
      root.innerHTML = '<p class="admin-meta admin-header">You are signed in as a <strong>' + esc(h.role || "volunteer") + "</strong>. New items are checked for every minute. " +
        '<button class="btn-link" data-act="desktop-alerts">' + (desktopOn() ? "Turn off desktop alerts" : "Turn on desktop alerts") + "</button></p>" +
        tabs + '<div class="admin-body" role="tabpanel">' + body + "</div>";
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
        if (act === "refresh") { await refresh(); h.toast("Refreshed."); return; }
        else if (act === "listing-status") { await api.setListingStatus(id, s); msg = s === "approved" ? "Listing approved and now public." : "Listing rejected."; }
        else if (act === "edit-apply") { await api.applyEdit(id); msg = "Changes applied to the live listing."; }
        else if (act === "edit-reject") { await api.rejectEdit(id); msg = "Edit rejected. The live listing is unchanged."; }
        else if (act === "claim-approve") { await api.resolveClaim(id, true); msg = "Claim approved. They now own the listing."; }
        else if (act === "claim-reject") { await api.resolveClaim(id, false); msg = "Claim rejected."; }
        else if (act === "review-status") { await api.setReviewStatus(id, s); msg = s === "approved" ? "Review published." : "Review rejected."; }
        else if (act === "save-flags") {
          var row = btn.closest("tr");
          var badges = Array.prototype.slice.call(row.querySelectorAll("[data-badge]:checked")).map(function (c) { return c.getAttribute("data-badge"); });
          var featured = row.querySelector('[data-field="featured"]').checked;
          var newStatus = row.querySelector('[data-field="status"]').value;
          var statusChanged = newStatus !== row.getAttribute("data-status");
          if (statusChanged && newStatus !== "approved" && !window.confirm("Setting this to " + newStatus + " takes " + row.getAttribute("data-name") + " out of the public directory. Continue?")) { btn.disabled = false; return; }
          await api.setFlags(id, badges, featured);
          if (statusChanged) await api.setListingStatus(id, newStatus);
          msg = "Saved.";
        }
        else if (act === "member-role") {
          var mrow = btn.closest("tr");
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
          var rrow = btn.closest("tr");
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
        h.toast("Added as " + role + ".");
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
      var b = root.querySelector(".admin-banner");
      if (!b) {
        b = document.createElement("div");
        b.className = "admin-banner";
        b.setAttribute("role", "status");
        root.insertBefore(b, root.firstChild);
      }
      b.innerHTML = '<strong>' + n + (n === 1 ? " new item" : " new items") + "</strong> waiting. " +
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
      root.innerHTML = '<p class="admin-empty">Could not load the moderation queue: ' + esc((err && err.message) || "unknown error") + "</p>";
    });
    return function stop() { window.clearInterval(timer); };
  }

  window.NiccAdmin = Object.assign({ mount: mount }, api);
})();
