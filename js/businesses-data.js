// js/businesses-data.js
(function () {
  "use strict";

  // Same category -> icon mapping used by the category browse section
  // already in noor-business.html. Kept here so a business's card icon
  // follows its category without storing a redundant column in the DB.
  var CATEGORY_ICONS = {
    "Restaurants": "i-heart",
    "Grocery & Halal Meat": "i-basket",
    "Modest Wear": "i-shirt",
    "Education": "i-book",
    "Health & Wellness": "i-heart",
    "Professional Services": "i-briefcase",
    "Home & Living": "i-sofa",
    "Auto & Repair": "i-car"
  };

  function toneFor(index) {
    return (index % 4) + 1;
  }

  function mapRow(row, index) {
    return {
      id: row.id,
      name: row.name,
      cat: row.category,
      hood: row.neighborhood,
      icon: CATEGORY_ICONS[row.category] || "i-storefront",
      tone: toneFor(index),
      badges: row.badges || [],
      featured: !!row.featured,
      rating: null,
      desc: row.description,
      long: row.long_description,
      address: row.address,
      photo: row.photo_url || null,
      verify: null,
      hours: row.hours || []
    };
  }

  async function loadBusinesses() {
    var result = await window.NiccSupabase
      .from("businesses")
      .select("*")
      .eq("status", "approved")
      .order("name", { ascending: true });

    if (result.error) {
      throw result.error;
    }
    return result.data.map(mapRow);
  }

  async function loadReviews(businessId) {
    var result = await window.NiccSupabase
      .from("reviews")
      .select("author_name, rating, body, owner_reply, created_at")
      .eq("business_id", businessId)
      .eq("status", "approved")
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data.map(function (r) {
      return { name: r.author_name, stars: r.rating, text: r.body, reply: r.owner_reply || null };
    });
  }

  window.NiccData = {
    loadBusinesses: loadBusinesses,
    loadReviews: loadReviews
  };
})();
