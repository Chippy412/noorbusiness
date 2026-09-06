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
      address: fields.address || null
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

  async function updateBusiness(id, fields) {
    var result = await window.NiccSupabase.from("businesses").update({
      name: fields.name,
      category: fields.category,
      neighborhood: fields.neighborhood,
      description: fields.description,
      long_description: fields.longDescription,
      address: fields.address || null
    }).eq("id", id);
    if (result.error) throw result.error;
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
    var updateResult = await window.NiccSupabase.from("businesses").update({ photo_url: publicUrl }).eq("id", businessId);
    if (updateResult.error) throw updateResult.error;
    return publicUrl;
  }

  window.NiccOwner = {
    loadMyBusinesses: loadMyBusinesses,
    createBusiness: createBusiness,
    claimBusiness: claimBusiness,
    loadMyClaims: loadMyClaims,
    updateBusiness: updateBusiness,
    uploadPhoto: uploadPhoto
  };
})();
