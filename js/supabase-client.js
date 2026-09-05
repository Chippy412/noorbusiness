// js/supabase-client.js
// Loaded after the Supabase CDN script (see noor-business.html), which
// exposes a global `supabase` object with `.createClient()`.
(function () {
  "use strict";

  var SUPABASE_URL = "https://jmqljbqvyhwdrxugbwun.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_oeB4TfM31dlO6eEQmfMqJw_jEHTKmfn";

  window.NiccSupabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
