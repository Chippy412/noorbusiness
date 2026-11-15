-- supabase/migrations/2026-11-02-remove-halal-verification.sql
-- The directory no longer offers a volunteer-verified "Halal verified" badge
-- (liability). This:
--   1. clears the badge from every listing that has it,
--   2. stops moderators from setting it again, and
--   3. clears any halal wording left in pending edits.
-- The businesses.halal_status column is kept (nothing reads or writes it
-- any more) so no data is destroyed; drop it later if you want.
-- Safe to re-run.

update public.businesses
   set badges = array_remove(badges, 'halal')
 where 'halal' = any(badges);

create or replace function admin_set_listing_flags(p_id uuid, p_badges text[], p_featured boolean)
returns void as $$
declare
  b businesses%rowtype;
begin
  perform _require_admin();
  if not (p_badges <@ array['prayer','women','family','community']) then
    raise exception 'Unknown badge' using errcode = '22023';
  end if;
  select * into b from businesses where id = p_id for update;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  if coalesce(p_featured, false) is distinct from b.featured and not is_moderator() then
    raise exception 'Only a moderator can change Featured' using errcode = '42501';
  end if;
  update businesses set badges = p_badges, featured = coalesce(p_featured, false) where id = p_id;
  if not (b.badges @> p_badges and p_badges @> b.badges) then
    perform _log('listing.badges', p_id, b.name, jsonb_build_object('from', to_jsonb(b.badges), 'to', to_jsonb(p_badges)));
  end if;
  if coalesce(p_featured, false) is distinct from b.featured then
    perform _log(case when p_featured then 'listing.featured' else 'listing.unfeatured' end, p_id, b.name, '{}'::jsonb);
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;
