-- supabase/migrations/2026-10-10-moderation-tools.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-09-notifications.sql.
-- Safe to re-run.
--
--  * moderation_log: who did what, to which item, and when. Every admin_*
--    action below writes to it; internal notes on a listing are log entries
--    too. Readable only through admin_log() / admin_listing_history().
--  * owner_notices: decisions sent to the person they're about (a listing's
--    owner, a claim's requester, a review's author), with the volunteer's
--    reason. Private to that person; emailed by /api/notify.
--  * reports: "Report a problem" on a listing or review. Written only by
--    /api/submit (service role), worked from a new moderation queue.
--  * contact_messages.handled_at, so the team can see what's been answered.
--  * Reject/remove actions take an optional reason. Removing a review that's
--    already published is a moderator call, like taking down a listing.
--  * The new-listing queue flags possible duplicates (same name or phone).

------------------------------------------------------------ activity log
create table if not exists moderation_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  business_id uuid references businesses(id) on delete set null,
  summary text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists moderation_log_business on moderation_log (business_id, created_at desc);
create index if not exists moderation_log_created on moderation_log (created_at desc);
alter table moderation_log enable row level security;
-- No policies: read through admin_log() / admin_listing_history() only.

create or replace function _log(p_action text, p_business uuid, p_summary text, p_detail jsonb default '{}'::jsonb)
returns void as $$
  insert into moderation_log (actor_id, action, business_id, summary, detail)
  values (auth.uid(), p_action, p_business, p_summary, coalesce(p_detail, '{}'::jsonb));
$$ language sql security definer set search_path = public, auth;

-------------------------------------------------------- notices to people
create table if not exists owner_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references businesses(id) on delete cascade,
  kind text not null,
  title text not null,
  reason text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists owner_notices_user on owner_notices (user_id, created_at desc);
alter table owner_notices enable row level security;

drop policy if exists "People can read their own notices" on owner_notices;
create policy "People can read their own notices"
  on owner_notices for select to authenticated
  using (user_id = auth.uid());

create or replace function _notice(p_user uuid, p_business uuid, p_kind text, p_title text, p_reason text)
returns void as $$
begin
  if p_user is null then
    return;
  end if;
  insert into owner_notices (user_id, business_id, kind, title, reason)
  values (p_user, p_business, p_kind, p_title, nullif(btrim(coalesce(p_reason, '')), ''));
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function dismiss_notice(p_id uuid)
returns void as $$
  update owner_notices set read_at = coalesce(read_at, now()) where id = p_id and user_id = auth.uid();
$$ language sql security definer set search_path = public, auth;

-- Reasons are shown to the person and emailed; keep them a sane length.
create or replace function _check_reason(p_reason text)
returns void as $$
begin
  if char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'Please keep the reason under 1000 characters' using errcode = '22023';
  end if;
end;
$$ language plpgsql immutable set search_path = public;

------------------------------------------------------------------ reports
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  review_id uuid references reviews(id) on delete cascade,
  reason text not null check (reason in ('closed', 'wrong_info', 'inappropriate', 'spam', 'other')),
  details text check (char_length(details) <= 1000),
  reporter_email text check (char_length(reporter_email) <= 254),
  ip_hash text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reports_open on reports (created_at) where status = 'open';
alter table reports enable row level security;
-- No policies and no grants: only /api/submit (service role) inserts.
revoke all on reports from anon, authenticated;

-------------------------------------------------------- contact messages
alter table contact_messages add column if not exists handled_at timestamptz;
alter table contact_messages add column if not exists handled_by uuid references auth.users(id) on delete set null;

------------------------------------------------------ duplicate detection
create or replace function _name_key(n text)
returns text as $$
  select regexp_replace(lower(coalesce(n, '')), '[^a-z0-9]', '', 'g');
$$ language sql immutable set search_path = public;

create or replace function _phone_key(p text)
returns text as $$
  select case when char_length(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g')) >= 7
              then right(regexp_replace(p, '[^0-9]', '', 'g'), 10) end;
$$ language sql immutable set search_path = public;

---------------------------------------------------------------- the queue
create or replace function admin_queue()
returns jsonb as $$
begin
  perform _require_admin();
  return jsonb_build_object(
    'new_listings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
        from (select b.id, b.name, b.category, b.neighborhood, b.description, b.long_description,
                     b.address, b.phone, b.website, b.photo_url, b.hours, b.halal_status, b.created_at,
                     u.email as owner_email,
                     coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'status', d.status))
                                 from businesses d
                                where d.id <> b.id
                                  and (_name_key(d.name) = _name_key(b.name)
                                       or (_phone_key(b.phone) is not null and _phone_key(d.phone) = _phone_key(b.phone)))),
                              '[]'::jsonb) as possible_duplicates
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
        from (select r.id, r.business_id, r.author_name, r.rating, r.body, r.created_at, b.name as business_name
                from reviews r join businesses b on b.id = r.business_id
               where r.status = 'pending' order by r.created_at limit 200) x), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
        from (select p.id, p.business_id, p.review_id, p.reason, p.details, p.reporter_email, p.created_at,
                     b.name as business_name, b.status as business_status,
                     r.author_name as review_author, r.body as review_body, r.rating as review_rating,
                     r.status as review_status
                from reports p join businesses b on b.id = p.business_id
                left join reviews r on r.id = p.review_id
               where p.status = 'open' order by p.created_at limit 200) x), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
        from (select m.id, m.name, m.email, m.subject, m.message, m.created_at, m.handled_at,
                     h.email as handled_by_email
                from contact_messages m left join auth.users h on h.id = m.handled_by
               order by m.created_at desc limit 100) x), '[]'::jsonb)
  );
end;
$$ language plpgsql stable security definer set search_path = public, auth;

create or replace function admin_counts()
returns jsonb as $$
declare
  n_new int; n_edits int; n_claims int; n_reviews int; n_reports int;
begin
  perform _require_admin();
  select count(*) into n_new from businesses where status = 'pending';
  select count(*) into n_edits from business_edits;
  select count(*) into n_claims from claims where status = 'pending';
  select count(*) into n_reviews from reviews where status = 'pending';
  select count(*) into n_reports from reports where status = 'open';
  return jsonb_build_object(
    'new_listings', n_new, 'edits', n_edits, 'claims', n_claims, 'reviews', n_reviews, 'reports', n_reports,
    'total', n_new + n_edits + n_claims + n_reviews + n_reports);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

----------------------------------------------------- listings: decisions
drop function if exists admin_set_listing_status(uuid, text);
create or replace function admin_set_listing_status(p_id uuid, p_status text, p_reason text default null)
returns void as $$
declare
  b businesses%rowtype;
begin
  perform _require_admin();
  perform _check_reason(p_reason);
  if p_status not in ('approved', 'pending', 'rejected') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  select * into b from businesses where id = p_id for update;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  if b.status = p_status then
    return;
  end if;
  -- Volunteers decide new submissions. Changing a listing that has already
  -- been reviewed (e.g. taking a published one down) is a moderator call.
  if b.status <> 'pending' and not is_moderator() then
    raise exception 'Only a moderator can change a listing that has already been reviewed' using errcode = '42501';
  end if;
  update businesses set status = p_status where id = p_id;

  perform _log('listing.' || p_status, p_id, b.name,
               jsonb_build_object('from', b.status, 'to', p_status, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  if p_status = 'approved' then
    perform _notice(b.owner_id, p_id, 'listing_approved', b.name || ' is live in the directory', p_reason);
  elsif b.status = 'approved' then
    perform _notice(b.owner_id, p_id, 'listing_unpublished', b.name || ' was taken out of the directory', p_reason);
  else
    perform _notice(b.owner_id, p_id, 'listing_rejected', b.name || ' needs changes before it can be published', p_reason);
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_listing_flags(p_id uuid, p_badges text[], p_featured boolean)
returns void as $$
declare
  b businesses%rowtype;
begin
  perform _require_admin();
  if not (p_badges <@ array['halal','prayer','women','family','community']) then
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

-------------------------------------------------------------------- edits
create or replace function admin_apply_edit(p_id uuid)
returns void as $$
declare
  c jsonb;
  b businesses%rowtype;
begin
  perform _require_admin();
  select changes into c from business_edits where business_id = p_id for update;
  if c is null then
    raise exception 'No pending edit for this listing' using errcode = 'P0002';
  end if;
  perform _validate_listing_fields(c);
  perform _apply_listing_fields(p_id, c);
  delete from business_edits where business_id = p_id;
  select * into b from businesses where id = p_id;
  perform _log('edit.applied', p_id, b.name, jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(c) k)));
  perform _notice(b.owner_id, p_id, 'edit_applied', 'Your changes to ' || b.name || ' are live', null);
end;
$$ language plpgsql security definer set search_path = public, auth;

drop function if exists admin_reject_edit(uuid);
create or replace function admin_reject_edit(p_id uuid, p_reason text default null)
returns void as $$
declare
  c jsonb;
  b businesses%rowtype;
begin
  perform _require_admin();
  perform _check_reason(p_reason);
  delete from business_edits where business_id = p_id returning changes into c;
  if c is null then
    raise exception 'No pending edit for this listing' using errcode = 'P0002';
  end if;
  select * into b from businesses where id = p_id;
  perform _log('edit.rejected', p_id, b.name, jsonb_build_object(
    'fields', (select jsonb_agg(k) from jsonb_object_keys(c) k), 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  perform _notice(b.owner_id, p_id, 'edit_rejected', 'Your changes to ' || b.name || ' were not applied', p_reason);
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------------- claims
drop function if exists admin_resolve_claim(uuid, boolean);
create or replace function admin_resolve_claim(p_id uuid, p_approve boolean, p_reason text default null)
returns void as $$
declare
  c claims%rowtype;
  b businesses%rowtype;
begin
  perform _require_admin();
  perform _check_reason(p_reason);
  select * into c from claims where id = p_id and status = 'pending' for update;
  if not found then
    raise exception 'Claim not found or already handled' using errcode = 'P0002';
  end if;
  select * into b from businesses where id = c.business_id for update;
  if p_approve then
    update businesses set owner_id = c.requester_id where id = c.business_id;
    -- An edit the previous owner queued is theirs, not the new owner's: drop
    -- it so it isn't shown to (or applied on behalf of) the new owner.
    delete from business_edits where business_id = c.business_id;
    update claims set status = 'approved' where id = p_id;
    perform _log('claim.approved', c.business_id, b.name, jsonb_build_object('previous_owner', b.owner_id, 'new_owner', c.requester_id));
    perform _notice(c.requester_id, c.business_id, 'claim_approved', 'You now manage ' || b.name, p_reason);
    if b.owner_id is not null and b.owner_id <> c.requester_id then
      perform _notice(b.owner_id, null, 'listing_transferred', b.name || ' was transferred to another owner', p_reason);
    end if;
  else
    update claims set status = 'rejected' where id = p_id;
    perform _log('claim.rejected', c.business_id, b.name, jsonb_build_object(
      'requester', c.requester_id, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
    perform _notice(c.requester_id, null, 'claim_rejected', 'Your claim on ' || b.name || ' was not approved', p_reason);
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------------ reviews
drop function if exists admin_set_review_status(uuid, text);
create or replace function admin_set_review_status(p_id uuid, p_status text, p_reason text default null)
returns void as $$
declare
  r reviews%rowtype;
  bname text;
begin
  perform _require_admin();
  perform _check_reason(p_reason);
  if p_status not in ('approved', 'rejected') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  select * into r from reviews where id = p_id for update;
  if not found then
    raise exception 'Review not found' using errcode = 'P0002';
  end if;
  if r.status = p_status then
    return;
  end if;
  -- Volunteers decide new reviews; changing a decided one is a moderator call.
  if r.status <> 'pending' and not is_moderator() then
    raise exception 'Only a moderator can change a review that has already been decided' using errcode = '42501';
  end if;
  update reviews set status = p_status where id = p_id;
  select name into bname from businesses where id = r.business_id;
  if r.status = 'approved' then
    perform _log('review.removed', r.business_id, bname, jsonb_build_object(
      'review', p_id, 'author', r.author_name, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
    perform _notice(r.author_id, null, 'review_removed', 'Your review of ' || bname || ' was removed', p_reason);
  elsif p_status = 'approved' then
    perform _log('review.approved', r.business_id, bname, jsonb_build_object('review', p_id, 'author', r.author_name));
    perform _notice(r.author_id, null, 'review_published', 'Your review of ' || bname || ' is published', null);
  else
    perform _log('review.rejected', r.business_id, bname, jsonb_build_object(
      'review', p_id, 'author', r.author_name, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
    perform _notice(r.author_id, null, 'review_rejected', 'Your review of ' || bname || ' was not published', p_reason);
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_recent_reviews()
returns jsonb as $$
begin
  perform _require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (select r.id, r.business_id, r.author_name, r.rating, r.body, r.owner_reply, r.created_at,
                   b.name as business_name
              from reviews r join businesses b on b.id = r.business_id
             where r.status = 'approved' order by r.created_at desc limit 200) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

------------------------------------------------------------------ reports
-- p_action: 'dismiss' (nothing wrong), 'resolve' (fixed some other way),
-- 'hide_review' (unpublish the reported review), 'unpublish' (take the
-- listing out of the directory). The last two are moderator calls.
create or replace function admin_resolve_report(p_id uuid, p_action text, p_reason text default null)
returns void as $$
declare
  p reports%rowtype;
  bname text;
begin
  perform _require_admin();
  perform _check_reason(p_reason);
  if p_action not in ('dismiss', 'resolve', 'hide_review', 'unpublish') then
    raise exception 'Invalid action' using errcode = '22023';
  end if;
  select * into p from reports where id = p_id and status = 'open' for update;
  if not found then
    raise exception 'Report not found or already handled' using errcode = 'P0002';
  end if;
  if p_action = 'hide_review' then
    if p.review_id is null then
      raise exception 'This report is not about a review' using errcode = '22023';
    end if;
    perform admin_set_review_status(p.review_id, 'rejected', p_reason);
  elsif p_action = 'unpublish' then
    perform admin_set_listing_status(p.business_id, 'rejected', p_reason);
  end if;
  update reports set status = case when p_action = 'dismiss' then 'dismissed' else 'resolved' end,
                     resolved_by = auth.uid(), resolved_at = now()
   where id = p_id;
  select name into bname from businesses where id = p.business_id;
  perform _log('report.' || p_action, p.business_id, bname, jsonb_build_object(
    'report', p_id, 'reason', p.reason, 'note', nullif(btrim(coalesce(p_reason, '')), '')));
end;
$$ language plpgsql security definer set search_path = public, auth;

----------------------------------------------------------------- messages
create or replace function admin_set_message_handled(p_id uuid, p_handled boolean)
returns void as $$
begin
  perform _require_admin();
  update contact_messages
     set handled_at = case when p_handled then coalesce(handled_at, now()) end,
         handled_by = case when p_handled then coalesce(handled_by, auth.uid()) end
   where id = p_id;
  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  perform _log(case when p_handled then 'message.handled' else 'message.reopened' end, null, null, jsonb_build_object('message', p_id));
end;
$$ language plpgsql security definer set search_path = public, auth;

-------------------------------------------------------- notes + history
create or replace function admin_add_note(p_business uuid, p_note text)
returns void as $$
declare
  bname text;
begin
  perform _require_admin();
  if btrim(coalesce(p_note, '')) = '' then
    raise exception 'Write a note first' using errcode = '22023';
  end if;
  if char_length(p_note) > 2000 then
    raise exception 'Please keep notes under 2000 characters' using errcode = '22023';
  end if;
  select name into bname from businesses where id = p_business;
  if bname is null then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  perform _log('note', p_business, bname, jsonb_build_object('note', btrim(p_note)));
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_listing_history(p_business uuid)
returns jsonb as $$
begin
  perform _require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (select l.id, l.action, l.summary, l.detail, l.created_at, u.email as actor_email
              from moderation_log l left join auth.users u on u.id = l.actor_id
             where l.business_id = p_business order by l.created_at desc limit 100) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

create or replace function admin_log()
returns jsonb as $$
begin
  perform _require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (select l.id, l.action, l.business_id, l.summary, l.detail, l.created_at, u.email as actor_email
              from moderation_log l left join auth.users u on u.id = l.actor_id
             order by l.created_at desc limit 300) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

------------------------------------------------- team actions, now logged
create or replace function admin_add_member(p_email text, p_role text)
returns void as $$
declare
  uid uuid;
begin
  perform _require_moderator();
  if p_role not in ('moderator', 'volunteer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then
    raise exception 'No account found for that email. Ask them to create an account on the site first, and turn on two-factor.' using errcode = 'P0002';
  end if;
  if exists (select 1 from admins where user_id = uid) then
    raise exception 'They are already on the team. Change their role in the list below.' using errcode = '23505';
  end if;
  insert into admins (user_id, role, added_by) values (uid, p_role, auth.uid());
  perform _log('team.added', null, lower(btrim(p_email)), jsonb_build_object('role', p_role));
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_member_role(p_user uuid, p_role text)
returns void as $$
declare
  em text;
begin
  perform _require_moderator();
  perform 1 from admins where role = 'moderator' for update;
  if p_role not in ('moderator', 'volunteer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if p_role = 'volunteer'
     and not exists (select 1 from admins where role = 'moderator' and user_id <> p_user) then
    raise exception 'There must always be at least one moderator' using errcode = '23514';
  end if;
  update admins set role = p_role where user_id = p_user and role <> p_role;
  if found then
    select email into em from auth.users where id = p_user;
    perform _log('team.role', null, em, jsonb_build_object('role', p_role));
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_remove_member(p_user uuid)
returns void as $$
declare
  em text;
begin
  perform _require_moderator();
  perform 1 from admins where role = 'moderator' for update;
  if not exists (select 1 from admins where role = 'moderator' and user_id <> p_user) then
    raise exception 'There must always be at least one moderator' using errcode = '23514';
  end if;
  delete from admins where user_id = p_user;
  if found then
    select email into em from auth.users where id = p_user;
    perform _log('team.removed', null, em, '{}'::jsonb);
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------------ alerts
-- Volunteers hear about new reports; people hear about decisions on their
-- things (/api/notify looks up the recipient with notice_email()).
drop trigger if exists notify_reports on reports;
create trigger notify_reports
  after insert on reports
  for each row execute function notify_volunteers();

drop trigger if exists notify_owner_notices on owner_notices;
create trigger notify_owner_notices
  after insert on owner_notices
  for each row execute function notify_volunteers();

create or replace function notice_email(p_notice uuid)
returns text as $$
  select u.email from owner_notices n join auth.users u on u.id = n.user_id where n.id = p_notice;
$$ language sql stable security definer set search_path = public, auth;

------------------------------------------------------------- permissions
revoke execute on function _log(text, uuid, text, jsonb), _notice(uuid, uuid, text, text, text),
  _check_reason(text) from public, anon, authenticated;
revoke execute on function notice_email(uuid) from public, anon, authenticated;
grant execute on function notice_email(uuid) to service_role;

revoke execute on function admin_set_listing_status(uuid, text, text), admin_set_listing_flags(uuid, text[], boolean),
  admin_apply_edit(uuid), admin_reject_edit(uuid, text), admin_resolve_claim(uuid, boolean, text),
  admin_set_review_status(uuid, text, text), admin_recent_reviews(), admin_resolve_report(uuid, text, text),
  admin_set_message_handled(uuid, boolean), admin_add_note(uuid, text), admin_listing_history(uuid), admin_log(),
  admin_queue(), admin_counts(), admin_add_member(text, text), admin_set_member_role(uuid, text),
  admin_remove_member(uuid), dismiss_notice(uuid) from public, anon;
grant execute on function admin_set_listing_status(uuid, text, text), admin_set_listing_flags(uuid, text[], boolean),
  admin_apply_edit(uuid), admin_reject_edit(uuid, text), admin_resolve_claim(uuid, boolean, text),
  admin_set_review_status(uuid, text, text), admin_recent_reviews(), admin_resolve_report(uuid, text, text),
  admin_set_message_handled(uuid, boolean), admin_add_note(uuid, text), admin_listing_history(uuid), admin_log(),
  admin_queue(), admin_counts(), admin_add_member(text, text), admin_set_member_role(uuid, text),
  admin_remove_member(uuid), dismiss_notice(uuid) to authenticated;
