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

  function isSponsored(row) {
    return !!row.sponsor_tier && !!row.sponsored_until && new Date(row.sponsored_until) > new Date();
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
      // Editorial Featured, which a moderator can give an end date.
      featured: !!row.featured && (!row.featured_until || new Date(row.featured_until) > new Date()),
      rating: null,
      reviewCount: 0,
      ownerId: row.owner_id || null,
      phone: row.phone || null,
      website: row.website || null,
      desc: row.description,
      long: row.long_description,
      address: row.address,
      photo: row.photo_url || null,
      verify: null,
      hours: row.hours || [],
      created: row.created_at || null,
      // Paid (or comped) placement, see 2026-10-11-sponsorship.sql. Recommended
      // sort puts these first; the "featured" plan also joins the home page row.
      sponsored: isSponsored(row),
      sponsorTier: isSponsored(row) ? row.sponsor_tier : null
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
    var items = result.data.map(mapRow);

    // Average rating per business from approved reviews. A failure here
    // just means cards say "New to the directory" -- never block the list.
    var ratings = await window.NiccSupabase
      .from("reviews")
      .select("business_id, rating")
      .eq("status", "approved");
    if (!ratings.error && ratings.data) {
      var sums = {};
      ratings.data.forEach(function (r) {
        var t = sums[r.business_id] || (sums[r.business_id] = { sum: 0, n: 0 });
        t.sum += r.rating; t.n += 1;
      });
      items.forEach(function (it) {
        var t = sums[it.id];
        if (t) { it.rating = t.sum / t.n; it.reviewCount = t.n; }
      });
    }
    return items;
  }

  async function loadReviews(businessId) {
    var result = await window.NiccSupabase
      .from("reviews")
      .select("id, author_name, rating, body, owner_reply, created_at")
      .eq("business_id", businessId)
      .eq("status", "approved")
      .order("created_at", { ascending: false });
    if (result.error) throw result.error;
    return result.data.map(function (r) {
      return { id: r.id, name: r.author_name, stars: r.rating, text: r.body, reply: r.owner_reply || null };
    });
  }

  // Saved listings follow a logged-in user across devices. Anonymous
  // visitors keep using localStorage only (handled in the page script).
  async function loadSavedIds() {
    var result = await window.NiccSupabase.from("saved_listings").select("business_id");
    if (result.error) throw result.error;
    return result.data.map(function (r) { return r.business_id; });
  }
  async function saveListing(userId, businessId) {
    var result = await window.NiccSupabase.from("saved_listings")
      .upsert({ user_id: userId, business_id: businessId }, { onConflict: "user_id,business_id", ignoreDuplicates: true });
    if (result.error) throw result.error;
  }
  async function unsaveListing(userId, businessId) {
    var result = await window.NiccSupabase.from("saved_listings")
      .delete().eq("user_id", userId).eq("business_id", businessId);
    if (result.error) throw result.error;
  }

  window.NiccData = {
    loadBusinesses: loadBusinesses,
    loadReviews: loadReviews,
    loadSavedIds: loadSavedIds,
    saveListing: saveListing,
    unsaveListing: unsaveListing,
    categoryIcons: CATEGORY_ICONS
  };
})();
