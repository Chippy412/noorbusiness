-- supabase/migrations/2026-10-07-fixes.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-06-roles.sql.
-- Safe to re-run. Fixes from a full-project review:
--
--  1. Edit alerts fired on every save of a pending edit, so an owner could
--     flood the volunteers' inbox. Now: one alert when an edit is first
--     queued (a new one after it's applied or rejected).
--  2. Claims: no duplicate pending claims for the same listing by the same
--     person, and no claiming a listing you already own.
--  3. photo_url must point at this project's own photo storage.
--  4. Listings record the halal status the owner chose on the sign-up form
--     (it used to be thrown away), shown to volunteers on the moderation page.

------------------------------------------------------------- 1. alerts
drop trigger if exists notify_business_edits on business_edits;
create trigger notify_business_edits
  after insert on business_edits
  for each row execute function notify_volunteers();

------------------------------------------------------------- 2. claims
-- Older duplicate pending claims (same person, same listing) are closed as
-- rejected so the unique index below can be created. The earliest one stays.
update claims c set status = 'rejected'
 where c.status = 'pending'
   and exists (select 1 from claims d
                where d.business_id = c.business_id and d.requester_id = c.requester_id
                  and d.status = 'pending' and d.created_at < c.created_at);

create unique index if not exists claims_one_pending_per_person
  on claims (business_id, requester_id) where status = 'pending';

drop policy if exists "Users can insert their own claims" on claims;
create policy "Users can insert their own claims"
  on claims for insert
  with check (
    requester_id = auth.uid()
    and status = 'pending'
    and business_id not in (select id from businesses where owner_id = auth.uid())
  );

------------------------------------------------------------- 3. photos
create or replace function _validate_listing_fields(f jsonb)
returns void as $$
declare
  k text;
  v jsonb;
  limits jsonb := '{"name":120,"category":60,"neighborhood":60,"description":300,"long_description":3000,"address":250,"phone":40,"website":300,"photo_url":500}';
begin
  for k, v in select * from jsonb_each(f) loop
    if not (limits ? k) then
      raise exception 'Unknown field: %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) not in ('string', 'null') then
      raise exception '% must be text', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'string' and char_length(f ->> k) > (limits ->> k)::int then
      raise exception '% is too long', k using errcode = '22023';
    end if;
    if k in ('name', 'category', 'neighborhood', 'description', 'long_description') and jsonb_typeof(v) = 'null' then
      raise exception '% is required', k using errcode = '22023';
    end if;
    if k in ('website', 'photo_url') and jsonb_typeof(v) = 'string' and (f ->> k) !~* '^https://[^[:space:]]+$' then
      raise exception '% must be a secure (https) web address', k using errcode = '22023';
    end if;
    -- Photos must be ones uploaded to this project's own photo storage; the
    -- site's Content-Security-Policy blocks images from anywhere else, so an
    -- outside URL would just show as a broken image after approval.
    if k = 'photo_url' and jsonb_typeof(v) = 'string'
       and (f ->> k) !~ '^https://[^/[:space:]]+/storage/v1/object/public/business-photos/[0-9a-f-]{36}/[^/[:space:]]+$' then
      raise exception 'photo_url must be a photo uploaded through the site' using errcode = '22023';
    end if;
  end loop;
end;
$$ language plpgsql immutable set search_path = public;

------------------------------------------------------------ 4. halal status
alter table businesses add column if not exists halal_status text;
alter table businesses drop constraint if exists businesses_halal_status_check;
alter table businesses add constraint businesses_halal_status_check
  check (halal_status is null or halal_status in ('certified', 'supplier', 'some', 'na'));
grant insert (halal_status) on businesses to authenticated;

create or replace function admin_queue()
returns jsonb as $$
begin
  perform _require_admin();
  return jsonb_build_object(
    'new_listings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
        from (select b.id, b.name, b.category, b.neighborhood, b.description, b.long_description,
                     b.address, b.phone, b.website, b.photo_url, b.hours, b.halal_status, b.created_at, u.email as owner_email
                from businesses b left join auth.users u on u.id = b.owner_id
               where b.status = 'pending' order by b.created_at limit 200) x), '[]'::jsonb),
    'edits', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.submitted_at)
        from (select e.business_id, e.changes, e.submitted_at, b.name as business_name,
                     to_jsonb(b) - 'owner_id' as live, u.email as owner_email
                from business_edits e join businesses b on b.id = e.business_id
                left join auth.users u on u.id = b.owner_id
               order by e.submitted_at limit 200) x), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
        from (select c.id, c.note, c.created_at, c.business_id, b.name as business_name,
                     cur.email as current_owner_email, req.email as requester_email
                from claims c join businesses b on b.id = c.business_id
                left join auth.users cur on cur.id = b.owner_id
                join auth.users req on req.id = c.requester_id
               where c.status = 'pending' order by c.created_at limit 200) x), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
        from (select r.id, r.author_name, r.rating, r.body, r.created_at, b.name as business_name
                from reviews r join businesses b on b.id = r.business_id
               where r.status = 'pending' order by r.created_at limit 200) x), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
        from (select id, name, email, subject, message, created_at
                from contact_messages order by created_at desc limit 50) x), '[]'::jsonb)
  );
end;
$$ language plpgsql stable security definer set search_path = public, auth;
