-- supabase/migrations/2026-10-08-review-fixes.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-07-fixes.sql.
-- Safe to re-run. Found by running every migration against a real Postgres
-- (tests/db/run.py):
--
--  1. A rejected listing was a dead end: the owner could edit it but it never
--     reached a volunteer again. Editing it now resubmits it (pending).
--  2. An edit queued while a listing was public stayed queued after the
--     listing was unpublished; approving it later could overwrite the owner's
--     newer changes. It's now dropped when edits start applying directly.
--  3. Reviews and claims could be filed against listings that aren't public
--     (by guessing an id). Both now require an approved listing.
--  4. Approving a claim left the previous owner's unreviewed edit queued, so
--     the new owner saw (and could get applied) someone else's draft.
--  5. Two moderators removing/demoting each other at the same moment could
--     leave the team with no moderator. Those checks now lock first.

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
    -- Not public: nothing to protect, apply directly. Any edit queued while
    -- it WAS public is dropped -- the owner's form already shows those values
    -- and sends them again, and applying the stale copy later would undo
    -- newer changes.
    perform _apply_listing_fields(p_id, incoming);
    delete from business_edits where business_id = p_id;
    -- A rejected listing the owner has fixed goes back in the review queue.
    if b.status = 'rejected' and (incoming <> '{}'::jsonb or p_fields ? 'hours') then
      update businesses set status = 'pending' where id = p_id;
    end if;
  end if;

  return jsonb_build_object(
    'status', (select status from businesses where id = p_id),
    'pending', exists (select 1 from business_edits where business_id = p_id));
end;
$$ language plpgsql security definer set search_path = public, auth;

drop policy if exists "Logged in users can insert their own pending review" on reviews;
create policy "Logged in users can insert their own pending review"
  on reviews for insert
  with check (
    author_id = auth.uid()
    and status = 'pending'
    and business_id in (select id from businesses where status = 'approved')
    and business_id not in (select id from businesses where owner_id = auth.uid())
  );

drop policy if exists "Users can insert their own claims" on claims;
create policy "Users can insert their own claims"
  on claims for insert
  with check (
    requester_id = auth.uid()
    and status = 'pending'
    and business_id in (select id from businesses where status = 'approved')
    and business_id not in (select id from businesses where owner_id = auth.uid())
  );

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
    -- An edit the previous owner queued is theirs, not the new owner's: drop
    -- it so it isn't shown to (or applied on behalf of) the new owner.
    delete from business_edits where business_id = c.business_id;
    update claims set status = 'approved' where id = p_id;
  else
    update claims set status = 'rejected' where id = p_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_member_role(p_user uuid, p_role text)
returns void as $$
begin
  perform _require_moderator();
  -- Lock the moderator rows first so two moderators changing each other at
  -- the same moment can't both pass the "someone else is still a moderator"
  -- check and leave the team with none.
  perform 1 from admins where role = 'moderator' for update;
  if p_role not in ('moderator', 'volunteer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if p_role = 'volunteer'
     and not exists (select 1 from admins where role = 'moderator' and user_id <> p_user) then
    raise exception 'There must always be at least one moderator' using errcode = '23514';
  end if;
  update admins set role = p_role where user_id = p_user;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_remove_member(p_user uuid)
returns void as $$
begin
  perform _require_moderator();
  -- Lock the moderator rows first so two moderators changing each other at
  -- the same moment can't both pass the "someone else is still a moderator"
  -- check and leave the team with none.
  perform 1 from admins where role = 'moderator' for update;
  if not exists (select 1 from admins where role = 'moderator' and user_id <> p_user) then
    raise exception 'There must always be at least one moderator' using errcode = '23514';
  end if;
  delete from admins where user_id = p_user;
end;
$$ language plpgsql security definer set search_path = public, auth;
