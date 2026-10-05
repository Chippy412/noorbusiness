-- supabase/migrations/2026-10-05-admin.sql
-- Run this once in the Supabase SQL editor. Safe to re-run.
--
-- Adds the moderation interface's backend:
--
--  * `admins`: who may moderate. Managed only from the SQL editor (see the
--    bottom of this file). An admin must also have completed two-factor
--    login (aal2), enforced inside is_admin().
--  * Owner edits to an APPROVED listing no longer hide it. The live version
--    stays public and the edit waits in `business_edits` until an admin
--    applies or rejects it. Edits to listings that aren't public yet apply
--    directly. Owners write through owner_update_business(); direct UPDATE
--    on businesses is closed.
--  * admin_* functions for every moderation action, each re-checking
--    is_admin() on the server so the page can't be bypassed.
--
-- Replaces the earlier "send the whole listing back to pending" trigger.
-- Run AFTER 2026-10-04-hardening.sql and 2026-10-04-insert-column-grants.sql.

------------------------------------------------------------------ admins
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;

drop policy if exists "Admins can see their own row" on admins;
create policy "Admins can see their own row"
  on admins for select to authenticated
  using (user_id = auth.uid());

-- Same helper as 2026-09-13-require-mfa-for-owner-writes.sql, repeated here
-- so this file doesn't depend on that one having been run.
create or replace function has_verified_mfa_factor()
returns boolean as $$
  select exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  );
$$ language sql stable security definer set search_path = public, auth;

-- Is this person on the admin list AND signed in with their second factor?
create or replace function is_admin()
returns boolean as $$
  select exists (select 1 from admins where user_id = auth.uid())
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$ language sql stable security definer set search_path = public, auth;

create or replace function _require_admin()
returns void as $$
begin
  if not is_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
end;
$$ language plpgsql stable security definer set search_path = public, auth;

------------------------------------------------- pending edits (not public)
create table if not exists business_edits (
  business_id uuid primary key references businesses(id) on delete cascade,
  changes jsonb not null,
  submitted_at timestamptz not null default now()
);
alter table business_edits enable row level security;

drop policy if exists "Owners can read edits to their own listings" on business_edits;
create policy "Owners can read edits to their own listings"
  on business_edits for select to authenticated
  using (business_id in (select id from businesses where owner_id = auth.uid()));

-- No insert/update/delete policies: writes happen only through the functions below.

-------------------------------------------------- validation + apply helpers
-- Fields an owner may change on a listing (everything else is volunteer-only).
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
  end loop;
end;
$$ language plpgsql immutable set search_path = public;

-- Turn blank strings into null so "" and "no value" compare equal.
create or replace function _normalize_listing_fields(f jsonb)
returns jsonb as $$
  select coalesce(jsonb_object_agg(
           key,
           case when jsonb_typeof(value) = 'string' and btrim(value #>> '{}') = '' then 'null'::jsonb
                when jsonb_typeof(value) = 'string' then to_jsonb(btrim(value #>> '{}'))
                else value end), '{}'::jsonb)
    from jsonb_each(f);
$$ language sql immutable set search_path = public;

create or replace function _apply_listing_fields(p_id uuid, f jsonb)
returns void as $$
begin
  update businesses set
    name             = case when f ? 'name'             then f ->> 'name'             else name end,
    category         = case when f ? 'category'         then f ->> 'category'         else category end,
    neighborhood     = case when f ? 'neighborhood'     then f ->> 'neighborhood'     else neighborhood end,
    description      = case when f ? 'description'      then f ->> 'description'      else description end,
    long_description = case when f ? 'long_description' then f ->> 'long_description' else long_description end,
    address          = case when f ? 'address'          then f ->> 'address'          else address end,
    phone            = case when f ? 'phone'            then f ->> 'phone'            else phone end,
    website          = case when f ? 'website'          then f ->> 'website'          else website end,
    photo_url        = case when f ? 'photo_url'        then f ->> 'photo_url'        else photo_url end
  where id = p_id;
end;
$$ language plpgsql security definer set search_path = public;

---------------------------------------------------------- owner entry point
create or replace function owner_update_business(p_id uuid, p_fields jsonb)
returns jsonb as $$
declare
  b businesses%rowtype;
  allowed text[] := array['name','category','neighborhood','description','long_description','address','phone','website','photo_url'];
  incoming jsonb;
  hours_in jsonb;
  live jsonb;
  existing jsonb;
  merged jsonb;
  h jsonb;
begin
  if auth.uid() is null then
    raise exception 'Please log in first' using errcode = '28000';
  end if;
  select * into b from businesses where id = p_id and owner_id = auth.uid();
  if not found then
    raise exception 'Listing not found' using errcode = '42501';
  end if;
  if has_verified_mfa_factor() and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Please complete two-factor login first' using errcode = '42501';
  end if;

  incoming := _normalize_listing_fields(
    coalesce((select jsonb_object_agg(key, value) from jsonb_each(p_fields) where key = any(allowed)), '{}'::jsonb));
  perform _validate_listing_fields(incoming);

  -- Hours are low-risk and go live immediately.
  if p_fields ? 'hours' then
    hours_in := p_fields -> 'hours';
    if jsonb_typeof(hours_in) <> 'array' or jsonb_array_length(hours_in) > 14 then
      raise exception 'Hours must be a list of at most 14 rows' using errcode = '22023';
    end if;
    for h in select * from jsonb_array_elements(hours_in) loop
      if jsonb_typeof(h) <> 'array' or jsonb_array_length(h) <> 2
         or jsonb_typeof(h -> 0) <> 'string' or jsonb_typeof(h -> 1) <> 'string'
         or char_length(h ->> 0) > 40 or char_length(h ->> 1) > 40 then
        raise exception 'Each hours row needs a day and a time (40 characters max)' using errcode = '22023';
      end if;
    end loop;
    update businesses set hours = hours_in where id = p_id;
  end if;

  if b.status = 'approved' then
    -- Public listing: keep the live version, queue the change for review.
    live := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(b)) where key = any(allowed));
    existing := coalesce((select changes from business_edits where business_id = p_id), '{}'::jsonb);
    merged := coalesce((
      select jsonb_object_agg(key, value)
        from jsonb_each(existing || incoming)
       where value is distinct from (live -> key)
    ), '{}'::jsonb);
    perform _validate_listing_fields(merged);
    if merged = '{}'::jsonb then
      delete from business_edits where business_id = p_id;
    else
      insert into business_edits (business_id, changes, submitted_at)
        values (p_id, merged, now())
        on conflict (business_id) do update set changes = excluded.changes, submitted_at = now();
    end if;
  else
    -- Not public yet: nothing to protect, apply directly.
    perform _apply_listing_fields(p_id, incoming);
  end if;

  return jsonb_build_object(
    'status', (select status from businesses where id = p_id),
    'pending', exists (select 1 from business_edits where business_id = p_id));
end;
$$ language plpgsql security definer set search_path = public, auth;

-- The old design (edit => hide the listing) is replaced by the above.
drop trigger if exists businesses_requeue_on_edit on businesses;
drop function if exists requeue_business_on_edit();
drop trigger if exists notify_businesses_requeued on businesses;
-- Owners now write only through owner_update_business().
revoke update on businesses from authenticated;

--------------------------------------------------------- admin: read queue
create or replace function admin_queue()
returns jsonb as $$
begin
  perform _require_admin();
  return jsonb_build_object(
    'new_listings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
        from (select b.id, b.name, b.category, b.neighborhood, b.description, b.long_description,
                     b.address, b.phone, b.website, b.photo_url, b.hours, b.created_at, u.email as owner_email
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

create or replace function admin_all_businesses()
returns jsonb as $$
begin
  perform _require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.name)
      from (select b.id, b.name, b.category, b.neighborhood, b.status, b.badges, b.featured,
                   b.created_at, u.email as owner_email
              from businesses b left join auth.users u on u.id = b.owner_id
             order by b.name limit 1000) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

----------------------------------------------------------- admin: actions
create or replace function admin_set_listing_status(p_id uuid, p_status text)
returns void as $$
begin
  perform _require_admin();
  if p_status not in ('approved', 'pending', 'rejected') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  update businesses set status = p_status where id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_listing_flags(p_id uuid, p_badges text[], p_featured boolean)
returns void as $$
begin
  perform _require_admin();
  if not (p_badges <@ array['halal','prayer','women','family','community']) then
    raise exception 'Unknown badge' using errcode = '22023';
  end if;
  update businesses set badges = p_badges, featured = coalesce(p_featured, false) where id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_apply_edit(p_id uuid)
returns void as $$
declare
  c jsonb;
begin
  perform _require_admin();
  select changes into c from business_edits where business_id = p_id;
  if c is null then
    raise exception 'No pending edit for this listing' using errcode = 'P0002';
  end if;
  perform _validate_listing_fields(c);
  perform _apply_listing_fields(p_id, c);
  delete from business_edits where business_id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_reject_edit(p_id uuid)
returns void as $$
begin
  perform _require_admin();
  delete from business_edits where business_id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_resolve_claim(p_id uuid, p_approve boolean)
returns void as $$
declare
  c claims%rowtype;
begin
  perform _require_admin();
  select * into c from claims where id = p_id and status = 'pending';
  if not found then
    raise exception 'Claim not found or already handled' using errcode = 'P0002';
  end if;
  if p_approve then
    update businesses set owner_id = c.requester_id where id = c.business_id;
    update claims set status = 'approved' where id = p_id;
  else
    update claims set status = 'rejected' where id = p_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_review_status(p_id uuid, p_status text)
returns void as $$
begin
  perform _require_admin();
  if p_status not in ('approved', 'rejected') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  update reviews set status = p_status where id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------------ alerts
-- Tell volunteers when an owner queues an edit. This reuses the alert
-- function from 2026-10-04-notify-triggers.sql, upgraded here to report the
-- real operation (INSERT / UPDATE). It re-reads the Bearer secret out of the
-- existing function, so there is nothing to paste.
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
    create or replace function notify_volunteers()
    returns trigger as $body$
    begin
      begin
        perform net.http_post(
          url := 'https://nicc-business.vercel.app/api/notify',
          body := jsonb_build_object('type', TG_OP, 'table', TG_TABLE_NAME, 'record', to_jsonb(NEW)),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer %s'
          )
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

drop trigger if exists notify_business_edits on business_edits;
create trigger notify_business_edits
  after insert or update on business_edits
  for each row execute function notify_volunteers();

------------------------------------------------------------- permissions
-- Newer Supabase projects grant EXECUTE on new functions to everyone by
-- default. Internal helpers are not callable from the browser at all; the
-- public entry points check who is calling inside the function.
revoke execute on function _validate_listing_fields(jsonb), _normalize_listing_fields(jsonb),
  _apply_listing_fields(uuid, jsonb), _require_admin() from public, anon, authenticated;

revoke execute on function owner_update_business(uuid, jsonb), admin_queue(), admin_all_businesses(),
  admin_set_listing_status(uuid, text), admin_set_listing_flags(uuid, text[], boolean),
  admin_apply_edit(uuid), admin_reject_edit(uuid), admin_resolve_claim(uuid, boolean),
  admin_set_review_status(uuid, text), is_admin() from public, anon;
grant execute on function owner_update_business(uuid, jsonb), admin_queue(), admin_all_businesses(),
  admin_set_listing_status(uuid, text), admin_set_listing_flags(uuid, text[], boolean),
  admin_apply_edit(uuid), admin_reject_edit(uuid), admin_resolve_claim(uuid, boolean),
  admin_set_review_status(uuid, text), is_admin() to authenticated;

------------------------------------------------------------ first admin
-- Add a moderator (they must already have an account on the site and turn
-- on two-factor under My account). Replace the email, run, repeat per person:
--
--   insert into admins (user_id)
--   select id from auth.users where lower(email) = lower('someone@example.com')
--   on conflict do nothing;
--
-- Remove one:
--
--   delete from admins where user_id = (select id from auth.users where lower(email) = lower('someone@example.com'));
