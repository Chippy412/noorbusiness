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
      verify: null,
      hours: row.hours || [],
      reviews: []
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

  window.NiccData = {
    loadBusinesses: loadBusinesses
  };
})();
