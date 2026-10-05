-- supabase/migrations/2026-10-04-lock-public-inserts.sql
-- Run this ONLY AFTER the Vercel env var SUPABASE_SERVICE_ROLE_KEY is set
-- and /api/submit works (send a test message from the Contact page).
--
-- Until then the site falls back to inserting contact messages straight
-- from the browser, which is what lets a bot skip Turnstile entirely. Once
-- this runs, the only way to write to contact_messages is through
-- /api/submit, which verifies the Turnstile token on the server and
-- applies per-sender rate limits.

drop policy if exists "Anyone can submit a contact message" on contact_messages;
revoke insert on contact_messages from anon, authenticated;
