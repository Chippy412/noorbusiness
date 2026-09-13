-- supabase/migrations/2026-09-12-write-rate-limits.sql
-- Run this once in the Supabase SQL editor. Adds server-side rate limits
-- on the writes RLS alone doesn't throttle: a logged-in owner could
-- otherwise script unlimited business submissions or claim requests.
-- Editing an existing listing (name/description/etc.) is left unthrottled
-- on purpose -- it's already scoped to the owner's own row by RLS and
-- column grants, and throttling it would just make normal editing
-- annoying without meaningfully reducing abuse.

-- businesses: at most 3 new submissions per owner per rolling hour.
create or replace function enforce_business_insert_rate_limit()
returns trigger as $$
begin
  if (
    select count(*) from businesses
    where owner_id = new.owner_id
      and created_at > now() - interval '1 hour'
  ) >= 3 then
    raise exception 'Too many business submissions in a short time. Please wait a while and try again.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists businesses_insert_rate_limit on businesses;
create trigger businesses_insert_rate_limit
  before insert on businesses
  for each row execute function enforce_business_insert_rate_limit();

-- claims: at most 5 claim requests per user per rolling hour.
create or replace function enforce_claims_insert_rate_limit()
returns trigger as $$
begin
  if (
    select count(*) from claims
    where requester_id = new.requester_id
      and created_at > now() - interval '1 hour'
  ) >= 5 then
    raise exception 'Too many claim requests in a short time. Please wait a while and try again.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists claims_insert_rate_limit on claims;
create trigger claims_insert_rate_limit
  before insert on claims
  for each row execute function enforce_claims_insert_rate_limit();

-- business-photos storage: at most 10 uploads per owner per rolling hour.
-- Folded into the existing insert policy (a trigger can't be attached to
-- storage.objects from the SQL editor -- see the note in the previous
-- migration -- but a policy's WITH CHECK can still read the table).
drop policy if exists "Owners can upload their own business photos" on storage.objects;
create policy "Owners can upload their own business photos"
  on storage.objects for insert
  with check (
    bucket_id = 'business-photos'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_id = auth.uid()
    )
    and (
      select count(*) from storage.objects
      where bucket_id = 'business-photos'
        and owner = auth.uid()
        and created_at > now() - interval '1 hour'
    ) < 10
  );
