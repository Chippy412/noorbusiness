-- supabase/migrations/2026-10-12-locations.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-11-sponsorship.sql
-- (and after 2026-10-04-notify-triggers.sql, whose secret it reuses). Safe to re-run.
--
-- Map coordinates for listings, so visitors can see how far away a business
-- is. businesses.lat / lng are public (the address already is). Only the
-- server writes them: when a listing's address is added or changed, a
-- trigger asks /api/geocode to look it up (US Census geocoder, falling back
-- to OpenStreetMap), and the answer comes back through set_business_location().
-- Changing the address clears the old coordinates straight away, so a moved
-- business never shows a stale distance.

alter table businesses add column if not exists lat double precision;
alter table businesses add column if not exists lng double precision;
alter table businesses add column if not exists located_at timestamptz;
alter table businesses drop constraint if exists businesses_latlng_check;
alter table businesses add constraint businesses_latlng_check
  check ((lat is null and lng is null) or (lat between -90 and 90 and lng between -180 and 180));

-- Server only (service role). p_address must still be the listing's address,
-- so a slow lookup can't overwrite the result for a newer address.
create or replace function set_business_location(p_id uuid, p_address text, p_lat double precision, p_lng double precision)
returns boolean as $$
begin
  update businesses set lat = p_lat, lng = p_lng, located_at = now()
   where id = p_id and address is not distinct from p_address;
  return found;
end;
$$ language plpgsql security definer set search_path = public;

-- Listings that still need coordinates (for the moderators' backfill button).
create or replace function unlocated_businesses(p_limit int)
returns table (id uuid, address text, neighborhood text) as $$
  select b.id, b.address, b.neighborhood from businesses b
   where b.address is not null and btrim(b.address) <> '' and b.lat is null
     and (b.located_at is null or b.located_at < now() - interval '1 day')
   order by b.created_at limit greatest(1, least(coalesce(p_limit, 10), 50));
$$ language sql stable security definer set search_path = public;

-- A lookup that found nothing is recorded too (located_at set, lat null), so
-- the backfill doesn't retry the same bad address over and over.
create or replace function mark_business_unlocatable(p_id uuid, p_address text)
returns void as $$
  update businesses set lat = null, lng = null, located_at = now()
   where id = p_id and address is not distinct from p_address;
$$ language sql security definer set search_path = public;

create or replace function clear_location_on_address_change()
returns trigger as $$
begin
  if new.address is distinct from old.address then
    new.lat := null;
    new.lng := null;
    new.located_at := null;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public;

drop trigger if exists businesses_clear_location on businesses;
create trigger businesses_clear_location
  before update of address on businesses
  for each row execute function clear_location_on_address_change();

-- Ask /api/geocode to look the address up. Same shared secret as the alert
-- emails; read out of notify_volunteers() so there's nothing to paste.
do $do$
declare
  secret text;
begin
  select substring(p.prosrc from 'Bearer ([A-Za-z0-9_-]+)')
    into secret
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'notify_volunteers' and n.nspname = 'public';

  if secret is null or secret = '__NOTIFY_SECRET__' then
    raise exception 'notify_volunteers() not found or has no secret. Run 2026-10-04-notify-triggers.sql first.';
  end if;

  execute format($f$
    create or replace function request_geocode()
    returns trigger as $body$
    begin
      if new.address is null or btrim(new.address) = '' then
        return new;
      end if;
      if tg_op = 'UPDATE' and new.address is not distinct from old.address then
        return new;
      end if;
      begin
        perform net.http_post(
          url := 'https://nicc-business.vercel.app/api/geocode',
          body := jsonb_build_object('id', new.id, 'address', new.address, 'neighborhood', new.neighborhood),
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer %s')
        );
      exception when others then
        null;
      end;
      return new;
    end;
    $body$ language plpgsql security definer set search_path = public, extensions;
  $f$, secret);
end
$do$;

drop trigger if exists businesses_request_geocode on businesses;
create trigger businesses_request_geocode
  after insert or update of address on businesses
  for each row execute function request_geocode();

revoke execute on function set_business_location(uuid, text, double precision, double precision),
  unlocated_businesses(int), mark_business_unlocatable(uuid, text), request_geocode(),
  clear_location_on_address_change() from public, anon, authenticated;
grant execute on function set_business_location(uuid, text, double precision, double precision),
  unlocated_businesses(int), mark_business_unlocatable(uuid, text) to service_role;
