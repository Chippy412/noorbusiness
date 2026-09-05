-- supabase/schema.sql
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).

create table businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id),
  name text not null,
  category text not null,
  neighborhood text not null,
  description text not null,
  long_description text not null,
  address text,
  phone text,
  hours jsonb not null default '[]'::jsonb,
  badges text[] not null default '{}'::text[],
  featured boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  requester_id uuid not null references auth.users(id),
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

alter table businesses enable row level security;
alter table claims enable row level security;

-- businesses: anyone can read approved listings
create policy "Public can read approved businesses"
  on businesses for select
  using (status = 'approved');

-- businesses: an owner can read their own listing regardless of status
create policy "Owners can read their own businesses"
  on businesses for select
  using (owner_id = auth.uid());

-- businesses: a logged-in user can insert a new listing, but only as
-- pending and only owned by themselves -- no one can insert a pre-approved row
create policy "Logged in users can insert their own pending business"
  on businesses for insert
  with check (owner_id = auth.uid() and status = 'pending');

-- businesses: an owner can update their own listing
create policy "Owners can update their own businesses"
  on businesses for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Column-level lock: even though the policy above allows an owner to run
-- UPDATE on their own row, Postgres privileges restrict WHICH columns that
-- UPDATE is allowed to touch. Without this, an owner could set their own
-- status to 'approved' or hand the listing to a different owner_id.
revoke update on businesses from authenticated;
grant update (name, category, neighborhood, description, long_description, address, phone, hours, badges)
  on businesses to authenticated;

-- claims: a logged-in user can create a claim for themselves, only pending
create policy "Users can insert their own claims"
  on claims for insert
  with check (requester_id = auth.uid() and status = 'pending');

-- claims: a user can see their own claims (to show "claim pending" in their dashboard)
create policy "Users can read their own claims"
  on claims for select
  using (requester_id = auth.uid());

-- No one but the Supabase dashboard (service role) can update a claim's
-- status or a business's status/owner_id. The dashboard's Table Editor
-- uses the service role, which bypasses RLS and column grants entirely,
-- so a volunteer can still approve things there.
revoke update on claims from authenticated;
