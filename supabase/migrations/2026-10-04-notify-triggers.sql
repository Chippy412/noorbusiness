-- supabase/migrations/2026-10-04-notify-triggers.sql
-- Replaces the four dashboard webhooks: when a listing, claim, review or
-- contact message is inserted, POST it to /api/notify (which emails the
-- volunteers). Replace __NOTIFY_SECRET__ with the NOTIFY_SECRET env var
-- from Vercel before running (scripts/finish-setup.sh does this for you and
-- puts the finished SQL on your clipboard). Safe to re-run.
--
-- A failure here never blocks the insert: errors are swallowed.

create extension if not exists pg_net with schema extensions;

create or replace function notify_volunteers()
returns trigger as $$
begin
  begin
    perform net.http_post(
      url := 'https://nicc-business.vercel.app/api/notify',
      body := jsonb_build_object('type', 'INSERT', 'table', TG_TABLE_NAME, 'record', to_jsonb(NEW)),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer __NOTIFY_SECRET__'
      )
    );
  exception when others then
    null;
  end;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists notify_businesses on businesses;
create trigger notify_businesses after insert on businesses
  for each row execute function notify_volunteers();

drop trigger if exists notify_claims on claims;
create trigger notify_claims after insert on claims
  for each row execute function notify_volunteers();

drop trigger if exists notify_reviews on reviews;
create trigger notify_reviews after insert on reviews
  for each row execute function notify_volunteers();

drop trigger if exists notify_contact_messages on contact_messages;
create trigger notify_contact_messages after insert on contact_messages
  for each row execute function notify_volunteers();
