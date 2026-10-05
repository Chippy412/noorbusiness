-- supabase/migrations/2026-10-04-insert-column-grants.sql
-- Run this once in the Supabase SQL editor. Safe to re-run.
--
-- The earlier hardening limited which columns an owner may UPDATE, but
-- INSERT privileges were still table-wide. A signed-in user could therefore
-- create a listing with featured = true or badges = '{halal}' already set,
-- or a review with an owner_reply pre-filled, and a volunteer approving it
-- at a glance would publish the forged value. Restrict INSERT to the
-- columns the site actually sends.

revoke insert on businesses from authenticated;
grant insert (owner_id, status, name, category, neighborhood, description,
              long_description, address, phone, website, hours, photo_url)
  on businesses to authenticated;

revoke insert on reviews from authenticated;
grant insert (business_id, author_id, author_name, rating, body, status)
  on reviews to authenticated;

revoke insert on claims from authenticated;
grant insert (business_id, requester_id, note, status)
  on claims to authenticated;
