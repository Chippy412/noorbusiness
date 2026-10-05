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
      website: fields.website || null
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
    if (result.error) throw result.error;
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

  // Returns the listing's status after the save. An approved listing whose
  // public details changed is sent back to "pending" by a database trigger
  // (see 2026-10-04-hardening.sql), so callers can tell the owner.
  async function updateBusiness(id, fields) {
    var result = await window.NiccSupabase.from("businesses").update({
      name: fields.name,
      category: fields.category,
      neighborhood: fields.neighborhood,
      description: fields.description,
      long_description: fields.longDescription,
      address: fields.address || null,
      phone: fields.phone || null,
      website: fields.website || null,
      hours: fields.hours || []
    }).eq("id", id).select("status").single();
    if (result.error) throw result.error;
    return result.data.status;
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
    var updateResult = await window.NiccSupabase.from("businesses").update({ photo_url: publicUrl }).eq("id", businessId).select("status").single();
    if (updateResult.error) throw updateResult.error;
    // status can come back "pending": changing a public listing's photo
    // sends it back to a volunteer for a re-check (database trigger).
    return { url: publicUrl, status: updateResult.data.status };
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

  window.NiccOwner = {
    loadMyBusinesses: loadMyBusinesses,
    createBusiness: createBusiness,
    claimBusiness: claimBusiness,
    loadMyClaims: loadMyClaims,
    updateBusiness: updateBusiness,
    uploadPhoto: uploadPhoto,
    submitReview: submitReview,
    loadReviewsForMyBusinesses: loadReviewsForMyBusinesses,
    replyToReview: replyToReview
  };
})();
