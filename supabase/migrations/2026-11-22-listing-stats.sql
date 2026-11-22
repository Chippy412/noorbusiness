-- supabase/migrations/2026-11-22-listing-stats.sql
-- Run once in the SQL editor / psql. Safe to re-run. Purely additive.
--
-- Privacy-friendly page and click counts for each listing, so owners can
-- later see how many people looked at their business. Only DAILY TOTALS are
-- stored: no IP address, no user agent, no cookie, no visitor or session id,
-- nothing that could single a person out. The server counts an event by
-- calling record_listing_event() (service role only, via /api/track).
--
--   views             listing page or dialog opened
--   website_clicks    "Website" link clicked
--   phone_clicks      phone number tapped
--   directions_clicks "Directions" link clicked
create table if not exists listing_daily_stats (
  business_id uuid not null references businesses(id) on delete cascade,
  day date not null,
  views integer not null default 0,
  website_clicks integer not null default 0,
  phone_clicks integer not null default 0,
  directions_clicks integer not null default 0,
  primary key (business_id, day)
);
alter table listing_daily_stats enable row level security;
-- No policies and no grants: nobody reads or writes the table directly.
revoke all on listing_daily_stats from anon, authenticated;

-- Server only (service role). Unknown events and listings that aren't
-- public are ignored, so counts can't be created for hidden listings.
create or replace function record_listing_event(p_business_id uuid, p_event text)
returns boolean as $$
declare
  v_day date := (now() at time zone 'America/New_York')::date;
begin
  if p_event not in ('view', 'website', 'phone', 'directions') then return false; end if;
  if not exists (select 1 from businesses where id = p_business_id and status = 'approved') then return false; end if;
  insert into listing_daily_stats (business_id, day, views, website_clicks, phone_clicks, directions_clicks)
  values (p_business_id, v_day,
          (p_event = 'view')::int, (p_event = 'website')::int, (p_event = 'phone')::int, (p_event = 'directions')::int)
  on conflict (business_id, day) do update set
    views = listing_daily_stats.views + (p_event = 'view')::int,
    website_clicks = listing_daily_stats.website_clicks + (p_event = 'website')::int,
    phone_clicks = listing_daily_stats.phone_clicks + (p_event = 'phone')::int,
    directions_clicks = listing_daily_stats.directions_clicks + (p_event = 'directions')::int;
  return true;
end;
$$ language plpgsql security definer set search_path = public;
revoke all on function record_listing_event(uuid, text) from public, anon, authenticated;
grant execute on function record_listing_event(uuid, text) to service_role;

-- For the owner dashboard (to be built): daily counts for one listing the
-- caller owns (or any listing, for an admin). Last p_days days, newest first.
create or replace function my_listing_stats(p_business_id uuid, p_days integer default 30)
returns table (day date, views integer, website_clicks integer, phone_clicks integer, directions_clicks integer) as $$
begin
  if not (is_admin() or exists (select 1 from businesses where id = p_business_id and owner_id = auth.uid())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select s.day, s.views, s.website_clicks, s.phone_clicks, s.directions_clicks
      from listing_daily_stats s
     where s.business_id = p_business_id
       and s.day > (now() at time zone 'America/New_York')::date - greatest(1, least(coalesce(p_days, 30), 366))
     order by s.day desc;
end;
$$ language plpgsql stable security definer set search_path = public;
revoke all on function my_listing_stats(uuid, integer) from public, anon;
grant execute on function my_listing_stats(uuid, integer) to authenticated;
