-- supabase/migrations/2026-10-06-roles.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-05-admin.sql.
-- Safe to re-run.
--
-- Two roles on the moderation page:
--
--   moderator  full control. Everything a volunteer can do, plus: set
--              Featured, change a listing that is already published (take it
--              down, restore it), and manage the team.
--   volunteer  works the queues: approve/reject new listings, edits, claims
--              and reviews, read contact messages, set badges.
--
-- Everyone already in `admins` (you) becomes a moderator. Both roles still
-- need to be signed in with two-factor. Every rule below is enforced in the
-- database; the page only hides what a role can't do.

alter table admins add column if not exists role text not null default 'moderator';
alter table admins drop constraint if exists admins_role_check;
alter table admins add constraint admins_role_check check (role in ('moderator', 'volunteer'));
alter table admins add column if not exists added_by uuid references auth.users(id) on delete set null;

create or replace function is_moderator()
returns boolean as $$
  select exists (select 1 from admins where user_id = auth.uid() and role = 'moderator')
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$ language sql stable security definer set search_path = public, auth;

create or replace function _require_moderator()
returns void as $$
begin
  if not is_moderator() then
    raise exception 'Only a moderator can do that' using errcode = '42501';
  end if;
end;
$$ language plpgsql stable security definer set search_path = public, auth;

------------------------------------- tighten two existing actions by role
create or replace function admin_set_listing_status(p_id uuid, p_status text)
returns void as $$
declare
  cur text;
begin
  perform _require_admin();
  if p_status not in ('approved', 'pending', 'rejected') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  select status into cur from businesses where id = p_id;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  if cur = p_status then
    return;
  end if;
  -- Volunteers decide new submissions. Changing a listing that has already
  -- been reviewed (e.g. taking a published one down) is a moderator call.
  if cur <> 'pending' and not is_moderator() then
    raise exception 'Only a moderator can change a listing that has already been reviewed' using errcode = '42501';
  end if;
  update businesses set status = p_status where id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_listing_flags(p_id uuid, p_badges text[], p_featured boolean)
returns void as $$
declare
  cur_featured boolean;
begin
  perform _require_admin();
  if not (p_badges <@ array['halal','prayer','women','family','community']) then
    raise exception 'Unknown badge' using errcode = '22023';
  end if;
  select featured into cur_featured from businesses where id = p_id;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  if coalesce(p_featured, false) is distinct from cur_featured and not is_moderator() then
    raise exception 'Only a moderator can change Featured' using errcode = '42501';
  end if;
  update businesses set badges = p_badges, featured = coalesce(p_featured, false) where id = p_id;
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------ team management
create or replace function admin_team()
returns jsonb as $$
begin
  perform _require_moderator();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at)
      from (select a.user_id, u.email, a.role, a.created_at
              from admins a join auth.users u on u.id = a.user_id) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

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
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_set_member_role(p_user uuid, p_role text)
returns void as $$
begin
  perform _require_moderator();
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
  if not exists (select 1 from admins where role = 'moderator' and user_id <> p_user) then
    raise exception 'There must always be at least one moderator' using errcode = '23514';
  end if;
  delete from admins where user_id = p_user;
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------- permissions
revoke execute on function _require_moderator() from public, anon, authenticated;
revoke execute on function is_moderator(), admin_team(), admin_add_member(text, text),
  admin_set_member_role(uuid, text), admin_remove_member(uuid),
  admin_set_listing_status(uuid, text), admin_set_listing_flags(uuid, text[], boolean) from public, anon;
grant execute on function is_moderator(), admin_team(), admin_add_member(text, text),
  admin_set_member_role(uuid, text), admin_remove_member(uuid),
  admin_set_listing_status(uuid, text), admin_set_listing_flags(uuid, text[], boolean) to authenticated;
