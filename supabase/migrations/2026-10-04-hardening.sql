-- supabase/migrations/2026-10-04-hardening.sql
-- Run this once in the Supabase SQL editor. Safe to re-run.
--
-- 1. Owners can no longer write `badges` (they could award themselves
--    "Halal verified" straight through the API). Badges are now set by a
--    volunteer in the Table Editor, like `status` and `featured`.
-- 2. Editing an approved listing sends it back to `pending` so a volunteer
--    re-checks it (name/description/photo/phone/etc. used to go live
--    instantly). Hours-only edits stay instant.
-- 3. Adds `website` to listings (owner-editable, https only).
-- 4. Owners can't review their own business.
-- 5. Newsletter + saved-listings tables, and IP-hash columns the
--    /api/submit route uses for per-sender rate limits.
-- 6. Length limits on user-supplied text.

------------------------------------------------------------------ 1. badges
revoke update (badges) on businesses from authenticated;

------------------------------------------------------------------ 3. website
alter table businesses add column if not exists website text;
alter table businesses drop constraint if exists businesses_website_https;
alter table businesses add constraint businesses_website_https
  check (website is null or website ~* '^https://[^\s]+$');
grant update (website) on businesses to authenticated;

------------------------------------------------------- 2. re-moderate edits
create or replace function requeue_business_on_edit()
returns trigger as $$
begin
  -- Only act on writes made by a signed-in owner. The Supabase dashboard /
  -- SQL editor / service role have no end-user uid, so volunteers editing a
  -- listing never knock it back to pending.
  if auth.uid() is null or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if old.status = 'approved' and (
       new.name             is distinct from old.name
    or new.category         is distinct from old.category
    or new.neighborhood     is distinct from old.neighborhood
    or new.description      is distinct from old.description
    or new.long_description is distinct from old.long_description
    or new.address          is distinct from old.address
    or new.phone            is distinct from old.phone
    or new.website          is distinct from old.website
    or new.photo_url        is distinct from old.photo_url
  ) then
    new.status := 'pending';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists businesses_requeue_on_edit on businesses;
create trigger businesses_requeue_on_edit
  before update on businesses
  for each row execute function requeue_business_on_edit();

------------------------------------------------------- 4. no self-reviews
drop policy if exists "Logged in users can insert their own pending review" on reviews;
create policy "Logged in users can insert their own pending review"
  on reviews for insert
  with check (
    author_id = auth.uid()
    and status = 'pending'
    and business_id not in (select id from businesses where owner_id = auth.uid())
  );

---------------------------------------------- 5. newsletter, saved, ip hash
alter table contact_messages add column if not exists ip_hash text;

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create unique index if not exists subscribers_email_unique on subscribers (lower(email));
alter table subscribers enable row level security;
-- No policies on purpose: only /api/submit (service role) writes here and
-- only the dashboard reads it.

create table if not exists saved_listings (
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, business_id)
);
alter table saved_listings enable row level security;

drop policy if exists "Users read their own saved listings" on saved_listings;
create policy "Users read their own saved listings"
  on saved_listings for select using (user_id = auth.uid());
drop policy if exists "Users save listings for themselves" on saved_listings;
create policy "Users save listings for themselves"
  on saved_listings for insert with check (user_id = auth.uid());
drop policy if exists "Users unsave their own listings" on saved_listings;
create policy "Users unsave their own listings"
  on saved_listings for delete using (user_id = auth.uid());

-------------------------------------------------------------- 6. lengths
alter table contact_messages drop constraint if exists contact_messages_lengths;
alter table contact_messages add constraint contact_messages_lengths
  check (char_length(name) <= 120 and char_length(email) <= 254
         and char_length(coalesce(subject, '')) <= 200 and char_length(message) <= 5000) not valid;

alter table reviews drop constraint if exists reviews_lengths;
alter table reviews add constraint reviews_lengths
  check (char_length(author_name) <= 80 and char_length(body) <= 2000
         and char_length(coalesce(owner_reply, '')) <= 2000) not valid;

alter table businesses drop constraint if exists businesses_lengths;
alter table businesses add constraint businesses_lengths
  check (char_length(name) <= 120 and char_length(description) <= 300
         and char_length(long_description) <= 3000
         and char_length(coalesce(address, '')) <= 250
         and char_length(coalesce(phone, '')) <= 40) not valid;
