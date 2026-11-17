-- supabase/migrations/2026-11-17-imported-listings.sql
-- Run once in the SQL editor / psql. Safe to re-run.
--
-- Community-researched listings that volunteers add in bulk from public
-- information (see scripts/import-businesses.mjs). They have no owner until
-- the real owner claims them, and show an "Unclaimed" note on the site.
--   origin        'owner'    submitted by the owner (default, all existing rows)
--                 'imported' added by volunteers from public sources
--   source_urls   public pages the details came from
--   import_batch  label of the import run, so a whole batch can be removed
--   last_verified_at  when a person last checked the details
alter table businesses add column if not exists origin text not null default 'owner';
alter table businesses drop constraint if exists businesses_origin_check;
alter table businesses add constraint businesses_origin_check check (origin in ('owner', 'imported'));
alter table businesses add column if not exists source_urls text[] not null default '{}'::text[];
alter table businesses add column if not exists import_batch text;
alter table businesses add column if not exists last_verified_at timestamptz;
create index if not exists businesses_import_batch on businesses (import_batch) where import_batch is not null;
-- Owners can't touch these: the column grants on businesses only list the
-- editable fields, and inserts by owners keep the defaults.

-- Team members (moderators and volunteers) can add a business from the
-- moderation page. It is saved as a waiting, ownerless listing, so it goes
-- through the same "New listings" review as everything else.
create or replace function admin_add_listing(p_fields jsonb)
returns uuid as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
  new_id uuid;
  v_name text := btrim(coalesce(f ->> 'name', ''));
  v_cat text := btrim(coalesce(f ->> 'category', ''));
  v_hood text := btrim(coalesce(f ->> 'neighborhood', ''));
  v_desc text := btrim(coalesce(f ->> 'description', ''));
  v_long text := btrim(coalesce(f ->> 'long_description', ''));
  v_web text := nullif(btrim(coalesce(f ->> 'website', '')), '');
  v_urls text[] := '{}'::text[];
begin
  perform _require_admin();
  if v_name = '' or v_cat = '' or v_hood = '' or v_desc = '' or v_long = '' then
    raise exception 'Name, category, neighborhood and both descriptions are required' using errcode = '22023';
  end if;
  if v_cat not in ('Restaurants','Grocery','Modest Wear','Health & Wellness','Professional Services','Education','Home & Living','Auto & Repair') then
    raise exception 'Unknown category' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 or char_length(v_hood) > 60 or char_length(v_desc) > 300 or char_length(v_long) > 3000 then
    raise exception 'A field is too long' using errcode = '22023';
  end if;
  if v_web is not null and v_web !~* '^https://[^\s]+$' then
    raise exception 'The website must start with https://' using errcode = '22023';
  end if;
  if jsonb_typeof(f -> 'source_urls') = 'array' then
    select coalesce(array_agg(x), '{}'::text[]) into v_urls from jsonb_array_elements_text(f -> 'source_urls') x;
  end if;
  insert into businesses (name, category, neighborhood, description, long_description, address, phone, website,
                          hours, status, origin, owner_id, source_urls, import_batch, last_verified_at)
  values (v_name, v_cat, v_hood, v_desc, v_long,
          nullif(btrim(coalesce(f ->> 'address', '')), ''), nullif(btrim(coalesce(f ->> 'phone', '')), ''), v_web,
          case when jsonb_typeof(f -> 'hours') = 'array' then f -> 'hours' else '[]'::jsonb end,
          'pending', 'imported', null, v_urls, 'added-by-team', now())
  returning id into new_id;
  perform _log('listing.added', new_id, v_name, '{}'::jsonb);
  return new_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

revoke execute on function admin_add_listing(jsonb) from public, anon;
grant execute on function admin_add_listing(jsonb) to authenticated;
