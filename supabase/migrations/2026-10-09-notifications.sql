-- supabase/migrations/2026-10-09-notifications.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-08-review-fixes.sql.
-- Safe to re-run.
--
--  * admin_counts(): how many items are waiting in each moderation queue.
--    Cheap enough to poll; powers the badges on the site and the live
--    updates on the moderation page. Volunteers and moderators only.
--  * notify_recipients(): the email addresses of everyone on the team, so
--    /api/notify can alert all of them. Only the server (service role) can
--    call it.

create or replace function admin_counts()
returns jsonb as $$
declare
  n_new int; n_edits int; n_claims int; n_reviews int;
begin
  perform _require_admin();
  select count(*) into n_new from businesses where status = 'pending';
  select count(*) into n_edits from business_edits;
  select count(*) into n_claims from claims where status = 'pending';
  select count(*) into n_reviews from reviews where status = 'pending';
  return jsonb_build_object(
    'new_listings', n_new, 'edits', n_edits, 'claims', n_claims, 'reviews', n_reviews,
    'total', n_new + n_edits + n_claims + n_reviews);
end;
$$ language plpgsql stable security definer set search_path = public, auth;

create or replace function notify_recipients()
returns setof text as $$
  select u.email from admins a join auth.users u on u.id = a.user_id
   where u.email is not null order by a.created_at;
$$ language sql stable security definer set search_path = public, auth;

revoke execute on function admin_counts() from public, anon;
grant execute on function admin_counts() to authenticated;
revoke execute on function notify_recipients() from public, anon, authenticated;
grant execute on function notify_recipients() to service_role;
