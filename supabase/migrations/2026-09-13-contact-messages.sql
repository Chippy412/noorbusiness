-- supabase/migrations/2026-09-13-contact-messages.sql
-- Run this once in the Supabase SQL editor. The contact form on the site
-- validated and showed a "message sent" toast without ever sending
-- anything anywhere -- there was no table and no email integration behind
-- it. This gives it somewhere real to land: a table any visitor (logged
-- in or not) can insert into, that only a volunteer with dashboard access
-- can read, moderated the same way businesses/claims already are (via
-- Supabase's own Table Editor, no custom admin panel).

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  subject text,
  message text not null,
  created_at timestamptz not null default now()
);

alter table contact_messages enable row level security;

-- Anyone can send a message -- this form has no login step, by design.
drop policy if exists "Anyone can submit a contact message" on contact_messages;
create policy "Anyone can submit a contact message"
  on contact_messages for insert
  to anon, authenticated
  with check (true);

-- No select policy for anon/authenticated: submitted messages are only
-- readable from the Supabase dashboard (service role), which bypasses RLS.
-- This keeps other visitors' messages private, matching the privacy policy.

-- A blunt cap on pure volume, since this table has no auth.uid() to key a
-- per-user limit off of the way businesses/claims do. The existing
-- honeypot + submit-timing + challenge layers on the client are the first
-- line of defense; this just stops a script from flooding the table.
create or replace function enforce_contact_message_rate_limit()
returns trigger as $$
begin
  if (
    select count(*) from contact_messages
    where created_at > now() - interval '1 minute'
  ) >= 20 then
    raise exception 'Too many messages received in a short time. Please try again shortly.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists contact_messages_rate_limit on contact_messages;
create trigger contact_messages_rate_limit
  before insert on contact_messages
  for each row execute function enforce_contact_message_rate_limit();
