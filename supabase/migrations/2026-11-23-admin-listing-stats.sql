-- supabase/migrations/2026-11-23-admin-listing-stats.sql
-- Run once in the SQL editor / psql. Safe to re-run. Purely additive.
--
-- Moderator-only roll-up of the anonymous daily counts in listing_daily_stats
-- (see 2026-11-22-listing-stats.sql) for the Analytics tab of the moderation
-- page. Reads only aggregate daily totals, so it cannot reveal anything about
-- individual visitors: none of that is ever stored.
--
-- Returns one JSON object for the last p_days days (1 to 366, default 30):
--   days     the window length actually used
--   totals   sums for this window, and "previous" for the window before it
--   daily    one row per day, oldest first, zero-filled
--   top      the 15 most viewed listings, with their clicks
--   coverage how many live listings got any views, and how many are live
create or replace function admin_listing_stats(p_days integer default 30)
returns jsonb as $$
declare
  n integer := greatest(1, least(coalesce(p_days, 30), 366));
  today date := (now() at time zone 'America/New_York')::date;
  from_day date := today - (n - 1);
  prev_from date := today - (2 * n - 1);
  result jsonb;
begin
  perform _require_moderator();
  select jsonb_build_object(
    'days', n,
    'totals', (select jsonb_build_object(
        'views', coalesce(sum(views) filter (where day >= from_day), 0),
        'website', coalesce(sum(website_clicks) filter (where day >= from_day), 0),
        'phone', coalesce(sum(phone_clicks) filter (where day >= from_day), 0),
        'directions', coalesce(sum(directions_clicks) filter (where day >= from_day), 0),
        'previous', jsonb_build_object(
          'views', coalesce(sum(views) filter (where day < from_day), 0),
          'website', coalesce(sum(website_clicks) filter (where day < from_day), 0),
          'phone', coalesce(sum(phone_clicks) filter (where day < from_day), 0),
          'directions', coalesce(sum(directions_clicks) filter (where day < from_day), 0)))
      from listing_daily_stats where day >= prev_from and day <= today),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
        'day', g.d::date, 'views', coalesce(s.v, 0), 'website', coalesce(s.w, 0),
        'phone', coalesce(s.p, 0), 'directions', coalesce(s.r, 0)) order by g.d), '[]'::jsonb)
      from generate_series(from_day, today, interval '1 day') as g(d)
      left join (select day, sum(views) v, sum(website_clicks) w, sum(phone_clicks) p, sum(directions_clicks) r
                   from listing_daily_stats where day >= from_day group by day) s on s.day = g.d::date),
    'top', (select coalesce(jsonb_agg(to_jsonb(t) order by t.views desc, t.name), '[]'::jsonb)
      from (select b.id, b.name, b.category,
                   sum(s.views)::int as views, sum(s.website_clicks)::int as website,
                   sum(s.phone_clicks)::int as phone, sum(s.directions_clicks)::int as directions
              from listing_daily_stats s join businesses b on b.id = s.business_id
             where s.day >= from_day and b.status = 'approved'
             group by b.id, b.name, b.category
            having sum(s.views) > 0
             order by sum(s.views) desc, b.name limit 15) t),
    'coverage', jsonb_build_object(
      'live', (select count(*) from businesses where status = 'approved'),
      'with_views', (select count(distinct s.business_id) from listing_daily_stats s
                       join businesses b on b.id = s.business_id
                      where s.day >= from_day and s.views > 0 and b.status = 'approved'))
  ) into result;
  return result;
end;
$$ language plpgsql stable security definer set search_path = public;
revoke all on function admin_listing_stats(integer) from public, anon;
grant execute on function admin_listing_stats(integer) to authenticated;
