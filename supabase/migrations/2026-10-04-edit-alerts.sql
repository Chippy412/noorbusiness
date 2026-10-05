-- supabase/migrations/2026-10-04-edit-alerts.sql
-- Run this once in the Supabase SQL editor, AFTER 2026-10-04-notify-triggers.sql
-- has been run. Safe to re-run. No secret to paste: it reads the existing
-- Bearer secret out of the current notify_volunteers() function.
--
-- Editing an approved listing sends it back to "pending" (see the hardening
-- migration), but the alert triggers only fired on INSERT, so volunteers had
-- no way of knowing a listing had dropped out of the directory awaiting
-- re-approval. This alerts them when that happens, and makes the function
-- report the real operation (INSERT / UPDATE) to /api/notify.

do $do$
declare
  secret text;
begin
  select substring(p.prosrc from 'Bearer ([A-Za-z0-9_-]+)')
    into secret
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'notify_volunteers' and n.nspname = 'public';

  if secret is null or secret = '__NOTIFY_SECRET__' then
    raise exception 'notify_volunteers() not found or has no secret. Run 2026-10-04-notify-triggers.sql first.';
  end if;

  execute format($f$
    create or replace function notify_volunteers()
    returns trigger as $body$
    begin
      begin
        perform net.http_post(
          url := 'https://nicc-business.vercel.app/api/notify',
          body := jsonb_build_object('type', TG_OP, 'table', TG_TABLE_NAME, 'record', to_jsonb(NEW)),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer %s'
          )
        );
      exception when others then
        null;
      end;
      return new;
    end;
    $body$ language plpgsql security definer set search_path = public, extensions;
  $f$, secret);
end
$do$;

drop trigger if exists notify_businesses_requeued on businesses;
create trigger notify_businesses_requeued
  after update on businesses
  for each row
  when (old.status = 'approved' and new.status = 'pending')
  execute function notify_volunteers();
