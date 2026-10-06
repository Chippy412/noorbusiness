// js/owner-dashboard.js
(function () {
  "use strict";

  async function loadMyBusinesses() {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) return [];
    var result = await window.NiccSupabase
      .from("businesses")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data;
  }

  async function createBusiness(fields) {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) throw new Error("You must be logged in to add a business.");
    var result = await window.NiccSupabase.from("businesses").insert({
      owner_id: user.id,
      status: "pending",
      name: fields.name,
      category: fields.category,
      neighborhood: fields.neighborhood,
      description: fields.description,
      long_description: fields.longDescription,
      address: fields.address || null,
      phone: fields.phone || null,
      website: fields.website || null,
      halal_status: fields.halalStatus || null
    }).select().single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function claimBusiness(businessId, note) {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) throw new Error("You must be logged in to claim a business.");
    var result = await window.NiccSupabase.from("claims").insert({
      business_id: businessId,
      requester_id: user.id,
      note: note || null
    });
    if (result.error) {
      if (result.error.code === "23505") throw new Error("You already have a claim waiting on this listing. A volunteer will get to it soon.");
      if (result.error.code === "42501") throw new Error("You can't claim a listing you already own.");
      throw new Error(result.error.message || "Could not submit your claim. Please try again.");
    }
  }

  async function loadMyClaims() {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) return [];
    var result = await window.NiccSupabase
      .from("claims")
      .select("*, businesses(name)")
      .eq("requester_id", user.id)
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data;
  }

  // Saves through owner_update_business() (see 2026-10-05-admin.sql).
  // For an approved listing the live version stays public and the change
  // waits for a volunteer; hours go live immediately. Resolves
  // {status, pending}. pending = there is an edit awaiting review.
  async function updateBusiness(id, fields) {
    var result = await window.NiccSupabase.rpc("owner_update_business", {
      p_id: id,
      p_fields: {
        name: fields.name,
        category: fields.category,
        neighborhood: fields.neighborhood,
        description: fields.description,
        long_description: fields.longDescription,
        address: fields.address || null,
        phone: fields.phone || null,
        website: fields.website || null,
        hours: fields.hours || []
      }
    });
    if (result.error) throw result.error;
    return result.data;
  }

  // Hours on their own: they go live straight away, so a brand-new listing
  // can carry them from the moment a volunteer approves it.
  async function setHours(id, hours) {
    var result = await window.NiccSupabase.rpc("owner_update_business", { p_id: id, p_fields: { hours: hours } });
    if (result.error) throw result.error;
    return result.data;
  }

  // Edits awaiting review for the owner's listings, keyed by business id.
  async function loadMyPendingEdits() {
    var result = await window.NiccSupabase.from("business_edits").select("business_id, changes, submitted_at");
    if (result.error) throw result.error;
    var byId = {};
    result.data.forEach(function (e) { byId[e.business_id] = e; });
    return byId;
  }

  async function uploadPhoto(businessId, file) {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) throw new Error("You must be logged in to upload a photo.");
    var ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    var path = businessId + "/" + Date.now() + "." + ext;
    var uploadResult = await window.NiccSupabase.storage
      .from("business-photos")
      .upload(path, file, { cacheControl: "3600", upsert: false });
    if (uploadResult.error) throw uploadResult.error;
    var publicUrl = window.NiccSupabase.storage.from("business-photos").getPublicUrl(path).data.publicUrl;
    var updateResult = await window.NiccSupabase.rpc("owner_update_business", { p_id: businessId, p_fields: { photo_url: publicUrl } });
    if (updateResult.error) throw updateResult.error;
    // On a public listing the new photo waits for a volunteer (pending = true).
    return { url: publicUrl, status: updateResult.data.status, pending: updateResult.data.pending };
  }

  async function submitReview(businessId, authorName, rating, body) {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) throw new Error("You must be logged in to leave a review.");
    var result = await window.NiccSupabase.from("reviews").insert({
      business_id: businessId,
      author_id: user.id,
      author_name: authorName,
      rating: rating,
      body: body,
      status: "pending"
    });
    if (result.error) {
      if (result.error.code === "23505") throw new Error("You've already reviewed this business.");
      throw new Error(result.error.message || "Could not submit your review. Please try again.");
    }
  }

  // Every review left on any business this owner owns, including
  // pending ones -- lets an owner reply before a volunteer even
  // publishes it. RLS scopes this to the caller's own businesses.
  async function loadReviewsForMyBusinesses() {
    var user = await window.NiccAuth.getCurrentUser();
    if (!user) return [];
    // RLS also lets people read reviews they wrote themselves, so scope this
    // to businesses the caller owns -- otherwise their own reviews of other
    // places show up here with a reply form that can't work.
    var mine = await window.NiccSupabase.from("businesses").select("id").eq("owner_id", user.id);
    if (mine.error) throw mine.error;
    var ids = mine.data.map(function (b) { return b.id; });
    if (!ids.length) return [];
    var result = await window.NiccSupabase
      .from("reviews")
      .select("*")
      .in("business_id", ids)
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data;
  }

  async function replyToReview(reviewId, reply) {
    var result = await window.NiccSupabase.from("reviews").update({ owner_reply: reply }).eq("id", reviewId);
    if (result.error) throw result.error;
  }

  // Unread decisions about this person's listings, claims and reviews.
  async function loadMyNotices() {
    var result = await window.NiccSupabase
      .from("owner_notices")
      .select("id, kind, title, reason, created_at")
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (result.error) throw result.error;
    return result.data;
  }
  async function dismissNotice(id) {
    var result = await window.NiccSupabase.rpc("dismiss_notice", { p_id: id });
    if (result.error) throw result.error;
  }

  // Sponsorship state for the caller's listings (and any they pay for), keyed
  // by business id. has_customer = there's a Stripe customer to manage.
  async function loadMySponsorships() {
    var result = await window.NiccSupabase
      .from("sponsorships")
      .select("business_id, payer_id, paid_tier, paid_status, paid_until, paid_period_end, cancel_at_period_end, comp_tier, comp_until, stripe_customer_id");
    if (result.error) throw result.error;
    var byId = {};
    result.data.forEach(function (r) {
      byId[r.business_id] = Object.assign({}, r, { has_customer: !!r.stripe_customer_id });
      delete byId[r.business_id].stripe_customer_id;
    });
    return byId;
  }

  window.NiccOwner = {
    loadMyBusinesses: loadMyBusinesses,
    createBusiness: createBusiness,
    claimBusiness: claimBusiness,
    loadMyClaims: loadMyClaims,
    updateBusiness: updateBusiness,
    loadMyPendingEdits: loadMyPendingEdits,
    uploadPhoto: uploadPhoto,
    setHours: setHours,
    submitReview: submitReview,
    loadReviewsForMyBusinesses: loadReviewsForMyBusinesses,
    replyToReview: replyToReview,
    loadMyNotices: loadMyNotices,
    dismissNotice: dismissNotice,
    loadMySponsorships: loadMySponsorships
  };
})();
