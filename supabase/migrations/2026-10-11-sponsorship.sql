-- supabase/migrations/2026-10-11-sponsorship.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-10-moderation-tools.sql.
-- Safe to re-run.
--
-- Paid sponsorship. Two plans (names and prices live in api/_lib/plans.js):
--   spotlight  "Sponsored" label, shown first in matching search results
--   featured   the same, plus a place in "Featured this month" on the home page
--
--  * businesses.sponsor_tier / sponsored_until: public, so the site can show
--    the label. A listing is sponsored while sponsored_until is in the future.
--    Only the server writes them (owners have no grant on these columns).
--  * sponsorships: one row per listing, private to its owner and the team.
--    Paid placement comes from Stripe (written by /api/billing/webhook with
--    the service-role key through billing_apply_subscription()). A moderator
--    can also comp a placement (admin_set_comp), kept separately so a billing
--    event never wipes it out. The listing shows whichever is better.
--  * businesses.featured_until: editorial Featured can now expire.
--
-- Badges can't be bought: nothing here touches them. A listing that isn't
-- approved is never shown publicly, paid or not.

alter table businesses add column if not exists sponsor_tier text;
alter table businesses drop constraint if exists businesses_sponsor_tier_check;
alter table businesses add constraint businesses_sponsor_tier_check
  check (sponsor_tier is null or sponsor_tier in ('spotlight', 'featured'));
alter table businesses add column if not exists sponsored_until timestamptz;
alter table businesses add column if not exists featured_until timestamptz;

create table if not exists sponsorships (
  business_id uuid primary key references businesses(id) on delete cascade,
  payer_id uuid references auth.users(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  paid_tier text check (paid_tier is null or paid_tier in ('spotlight', 'featured')),
  paid_status text,
  paid_until timestamptz,
  cancel_at_period_end boolean not null default false,
  comp_tier text check (comp_tier is null or comp_tier in ('spotlight', 'featured')),
  comp_until timestamptz,
  comp_note text check (char_length(comp_note) <= 500),
  updated_at timestamptz not null default now()
);
-- paid_until includes the grace period; paid_period_end is Stripe's own date
-- (what owners see as "renews on").
alter table sponsorships add column if not exists paid_period_end timestamptz;
alter table sponsorships enable row level security;

-- The listing's owner sees its sponsorship (so they know it's sponsored and
-- by which plan); the person paying sees theirs even after a transfer.
-- Column-level: owners never see Stripe ids or the team's comp note.
revoke select on sponsorships from anon, authenticated;
grant select (business_id, payer_id, paid_tier, paid_status, paid_until, paid_period_end, cancel_at_period_end,
              comp_tier, comp_until) on sponsorships to authenticated;
drop policy if exists "Owners and payers can read their sponsorships" on sponsorships;
create policy "Owners and payers can read their sponsorships"
  on sponsorships for select to authenticated
  using (payer_id = auth.uid() or business_id in (select id from businesses where owner_id = auth.uid()));
revoke insert, update, delete on sponsorships from anon, authenticated;

-- Grace period after a paid period ends, so a slow renewal doesn't flicker.
create or replace function _sync_sponsorship(p_business uuid)
returns void as $$
declare
  s sponsorships%rowtype;
  paid_ok boolean;
  comp_ok boolean;
  rank_paid int;
  rank_comp int;
begin
  select * into s from sponsorships where business_id = p_business;
  paid_ok := found and s.paid_tier is not null and s.paid_until > now();
  comp_ok := found and s.comp_tier is not null and s.comp_until > now();
  rank_paid := case when paid_ok then (case s.paid_tier when 'featured' then 2 else 1 end) else 0 end;
  rank_comp := case when comp_ok then (case s.comp_tier when 'featured' then 2 else 1 end) else 0 end;
  if rank_paid = 0 and rank_comp = 0 then
    update businesses set sponsor_tier = null, sponsored_until = null where id = p_business;
  elsif rank_paid > rank_comp or (rank_paid = rank_comp and s.paid_until >= s.comp_until) then
    update businesses set sponsor_tier = s.paid_tier, sponsored_until = s.paid_until where id = p_business;
  else
    update businesses set sponsor_tier = s.comp_tier, sponsored_until = s.comp_until where id = p_business;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- Called only by /api/billing/webhook (service role) with the subscription's
-- current state, fetched fresh from Stripe. Re-applying the same state is a
-- no-op, so retried or out-of-order webhooks are harmless.
create or replace function billing_apply_subscription(
  p_business uuid, p_payer uuid, p_tier text, p_customer text, p_subscription text,
  p_status text, p_period_end timestamptz, p_cancel_at_period_end boolean)
returns void as $$
declare
  paid boolean := p_status in ('active', 'trialing');
  cur sponsorships%rowtype;
  new_until timestamptz;
  bname text;
begin
  if p_tier not in ('spotlight', 'featured') then
    raise exception 'Unknown plan' using errcode = '22023';
  end if;
  select name into bname from businesses where id = p_business;
  if bname is null then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  select * into cur from sponsorships where business_id = p_business for update;
  -- One listing, one paid sponsorship. An event about a DIFFERENT
  -- subscription that isn't paying (a retried event for an old, cancelled
  -- one; the second of two checkouts being cancelled) must not end the one
  -- that is.
  if found and cur.stripe_subscription_id is not null and cur.stripe_subscription_id <> p_subscription
     and cur.paid_status in ('active', 'trialing', 'past_due') and cur.paid_until > now()
     and not paid then
    return;
  end if;
  -- Paid up: through the period plus 3 days' grace. A failed renewal
  -- (past_due) keeps what was already paid for but never extends it.
  new_until := case
    when paid then p_period_end + interval '3 days'
    when p_status = 'past_due' then least(coalesce(case when cur.stripe_subscription_id = p_subscription then cur.paid_until end, now()),
                                          p_period_end + interval '3 days')
    else least(p_period_end, now()) end;
  insert into sponsorships (business_id, payer_id, stripe_customer_id, stripe_subscription_id, paid_tier,
                            paid_status, paid_until, paid_period_end, cancel_at_period_end, updated_at)
  values (p_business, p_payer, p_customer, p_subscription, p_tier, p_status,
          new_until, p_period_end, coalesce(p_cancel_at_period_end, false), now())
  on conflict (business_id) do update set
    payer_id = coalesce(excluded.payer_id, sponsorships.payer_id),
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    paid_tier = excluded.paid_tier,
    paid_status = excluded.paid_status,
    paid_until = excluded.paid_until,
    paid_period_end = excluded.paid_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    updated_at = now();
  perform _sync_sponsorship(p_business);
  if cur.paid_status is distinct from p_status or cur.stripe_subscription_id is distinct from p_subscription then
    insert into moderation_log (actor_id, action, business_id, summary, detail)
    values (null, 'sponsor.billing', p_business, bname, jsonb_build_object('plan', p_tier, 'status', p_status));
  end if;
end;
$$ language plpgsql security definer set search_path = public, auth;

------------------------------------------------------------- moderators
create or replace function admin_set_comp(p_business uuid, p_tier text, p_until timestamptz, p_note text)
returns void as $$
declare
  bname text;
begin
  perform _require_moderator();
  if p_tier is not null and p_tier not in ('spotlight', 'featured') then
    raise exception 'Unknown plan' using errcode = '22023';
  end if;
  if p_tier is not null and (p_until is null or p_until <= now()) then
    raise exception 'Pick an end date in the future' using errcode = '22023';
  end if;
  if char_length(coalesce(p_note, '')) > 500 then
    raise exception 'Please keep the note under 500 characters' using errcode = '22023';
  end if;
  select name into bname from businesses where id = p_business;
  if bname is null then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  insert into sponsorships (business_id, comp_tier, comp_until, comp_note, updated_at)
  values (p_business, p_tier, case when p_tier is null then null else p_until end, nullif(btrim(coalesce(p_note, '')), ''), now())
  on conflict (business_id) do update set
    comp_tier = excluded.comp_tier, comp_until = excluded.comp_until, comp_note = excluded.comp_note, updated_at = now();
  perform _sync_sponsorship(p_business);
  perform _log(case when p_tier is null then 'sponsor.comp_ended' else 'sponsor.comped' end, p_business, bname,
               jsonb_build_object('plan', p_tier, 'until', p_until, 'note', nullif(btrim(coalesce(p_note, '')), '')));
end;
$$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_sponsorships()
returns jsonb as $$
begin
  perform _require_moderator();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.business_name)
      from (select s.business_id, b.name as business_name, b.status as business_status,
                   b.sponsor_tier, b.sponsored_until, s.paid_tier, s.paid_status, s.paid_until, s.paid_period_end,
                   s.cancel_at_period_end, s.comp_tier, s.comp_until, s.comp_note, s.updated_at,
                   payer.email as payer_email, owner.email as owner_email,
                   s.stripe_subscription_id is not null as has_subscription
              from sponsorships s join businesses b on b.id = s.business_id
              left join auth.users payer on payer.id = s.payer_id
              left join auth.users owner on owner.id = b.owner_id) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

create or replace function admin_set_featured_until(p_id uuid, p_until timestamptz)
returns void as $$
declare
  bname text;
begin
  perform _require_moderator();
  update businesses set featured_until = p_until where id = p_id returning name into bname;
  if bname is null then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  perform _log('listing.featured_until', p_id, bname, jsonb_build_object('until', p_until));
end;
$$ language plpgsql security definer set search_path = public, auth;

-- The All listings tab also shows sponsorship and Featured end dates.
create or replace function admin_all_businesses()
returns jsonb as $$
begin
  perform _require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.name)
      from (select b.id, b.name, b.category, b.neighborhood, b.status, b.badges, b.featured, b.featured_until,
                   b.sponsor_tier, b.sponsored_until, b.created_at, u.email as owner_email
              from businesses b left join auth.users u on u.id = b.owner_id
             order by b.name limit 1000) x), '[]'::jsonb);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

------------------------------------------------------------- permissions
revoke execute on function _sync_sponsorship(uuid) from public, anon, authenticated;
revoke execute on function billing_apply_subscription(uuid, uuid, text, text, text, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function billing_apply_subscription(uuid, uuid, text, text, text, text, timestamptz, boolean) to service_role;
revoke execute on function admin_set_comp(uuid, text, timestamptz, text), admin_sponsorships(),
  admin_set_featured_until(uuid, timestamptz), admin_all_businesses() from public, anon;
grant execute on function admin_set_comp(uuid, text, timestamptz, text), admin_sponsorships(),
  admin_set_featured_until(uuid, timestamptz), admin_all_businesses() to authenticated;
