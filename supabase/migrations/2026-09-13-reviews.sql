-- supabase/migrations/2026-09-13-reviews.sql
-- Run this once in the Supabase SQL editor. The site's copy (About, FAQ,
-- home page) has always promised a review system -- "leave a review",
-- "owners reply to reviews in public", "reviews moderated by volunteers"
-- -- but no table or UI for it ever existed. This adds the real thing,
-- moderated the same way businesses/claims already are.

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  author_id uuid not null references auth.users(id),
  author_name text not null,
  rating smallint not null check (rating between 1 and 5),
  body text not null,
  owner_reply text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

-- One review per person per business -- stops a visitor (or a script)
-- from stacking up multiple reviews on the same listing.
alter table reviews drop constraint if exists reviews_one_per_business_per_user;
alter table reviews add constraint reviews_one_per_business_per_user unique (business_id, author_id);

alter table reviews enable row level security;

-- Anyone can read approved reviews on a listing.
drop policy if exists "Public can read approved reviews" on reviews;
create policy "Public can read approved reviews"
  on reviews for select
  using (status = 'approved');

-- An author can read their own review regardless of status, so they can
-- see "pending" state rather than it just vanishing after submission.
drop policy if exists "Authors can read their own reviews" on reviews;
create policy "Authors can read their own reviews"
  on reviews for select
  using (author_id = auth.uid());

-- A business owner can read every review left on their own business,
-- including pending ones, so they can reply before it's even published.
drop policy if exists "Owners can read reviews on their own businesses" on reviews;
create policy "Owners can read reviews on their own businesses"
  on reviews for select
  using (business_id in (select id from businesses where owner_id = auth.uid()));

-- A logged in user can insert a review for themselves, only as pending --
-- no one can insert a pre-approved review.
drop policy if exists "Logged in users can insert their own pending review" on reviews;
create policy "Logged in users can insert their own pending review"
  on reviews for insert
  with check (author_id = auth.uid() and status = 'pending');

-- A business owner can update reviews left on their own business (this is
-- how the public "owner reply" gets attached). Column grant below locks
-- this down to owner_reply only -- an owner cannot edit the review body,
-- rating, or approve their own review.
drop policy if exists "Owners can reply to reviews on their own businesses" on reviews;
create policy "Owners can reply to reviews on their own businesses"
  on reviews for update
  using (business_id in (select id from businesses where owner_id = auth.uid()))
  with check (business_id in (select id from businesses where owner_id = auth.uid()));

revoke update on reviews from authenticated;
grant update (owner_reply) on reviews to authenticated;

-- No one but the Supabase dashboard (service role) can change a review's
-- status -- same volunteer-moderation-via-Table-Editor pattern as
-- businesses/claims.

-- At most 5 new reviews per person per rolling day.
create or replace function enforce_reviews_insert_rate_limit()
returns trigger as $$
begin
  if (
    select count(*) from reviews
    where author_id = new.author_id
      and created_at > now() - interval '1 day'
  ) >= 5 then
    raise exception 'Too many reviews submitted in a short time. Please try again later.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists reviews_insert_rate_limit on reviews;
create trigger reviews_insert_rate_limit
  before insert on reviews
  for each row execute function enforce_reviews_insert_rate_limit();
