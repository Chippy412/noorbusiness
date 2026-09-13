-- supabase/migrations/2026-09-13-require-mfa-for-owner-writes.sql
-- Run this once in the Supabase SQL editor, AFTER the app-side TOTP 2FA
-- feature is deployed. Without this, enrolling in 2FA is cosmetic: a
-- stolen password alone would still be enough to write to the database
-- directly (create/edit a business, reply to reviews) even though the
-- *website's* login screen asks for a second factor, because Supabase
-- issues an "aal1" session on password login regardless, and RLS by
-- default doesn't care what AAL a session is.
--
-- These are RESTRICTIVE policies: Postgres ANDs them together with the
-- existing permissive policies, so they can only take privileges away,
-- never grant new ones. Each one reads "if this user has a verified MFA
-- factor enrolled, their session must have stepped up to aal2 (i.e.
-- completed the 2FA challenge) to do this write; if they never enrolled
-- in 2FA at all, this restriction does not apply to them." This is the
-- pattern Supabase's own docs recommend for optional-but-enforced MFA --
-- it protects owners who turn 2FA on without locking out everyone who
-- hasn't (which today is everyone, since this is a new feature).

create or replace function has_verified_mfa_factor()
returns boolean as $$
  select exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  );
$$ language sql stable security definer set search_path = public, auth;

drop policy if exists "Require aal2 to insert businesses when MFA is enrolled" on businesses;
create policy "Require aal2 to insert businesses when MFA is enrolled"
  on businesses as restrictive for insert
  to authenticated
  with check (
    (select auth.jwt() ->> 'aal') = 'aal2' or not has_verified_mfa_factor()
  );

drop policy if exists "Require aal2 to update businesses when MFA is enrolled" on businesses;
create policy "Require aal2 to update businesses when MFA is enrolled"
  on businesses as restrictive for update
  to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2' or not has_verified_mfa_factor()
  );

drop policy if exists "Require aal2 to insert claims when MFA is enrolled" on claims;
create policy "Require aal2 to insert claims when MFA is enrolled"
  on claims as restrictive for insert
  to authenticated
  with check (
    (select auth.jwt() ->> 'aal') = 'aal2' or not has_verified_mfa_factor()
  );

drop policy if exists "Require aal2 to reply to reviews when MFA is enrolled" on reviews;
create policy "Require aal2 to reply to reviews when MFA is enrolled"
  on reviews as restrictive for update
  to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2' or not has_verified_mfa_factor()
  );

drop policy if exists "Require aal2 to upload business photos when MFA is enrolled" on storage.objects;
create policy "Require aal2 to upload business photos when MFA is enrolled"
  on storage.objects as restrictive for insert
  to authenticated
  with check (
    bucket_id != 'business-photos'
    or (select auth.jwt() ->> 'aal') = 'aal2'
    or not has_verified_mfa_factor()
  );
