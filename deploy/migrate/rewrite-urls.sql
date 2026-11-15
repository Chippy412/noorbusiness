-- Rewrite stored photo URLs from the hosted Supabase host to the new origin.
-- Run once after import-selfhosted.sh:
--
--   docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 \
--     -v NEW_BASE="'https://noorbusiness.org'" < rewrite-urls.sql
--
-- NEW_BASE is the public site origin WITHOUT a trailing slash, quoted for psql
-- (note the inner single quotes). Photo URLs look like
--   <base>/storage/v1/object/public/business-photos/<owner-uuid>/<file>
-- and the validator in 2026-10-07-fixes.sql only accepts that shape.
--
-- Columns that can hold the old host (from schema.sql + migrations):
--   businesses.photo_url        text
--   business_edits.changes      jsonb (a pending edit may carry photo_url)
--   moderation_log.detail       jsonb (edit history, display only)
-- businesses.website holds owners' own sites, never the Supabase host: untouched.
-- Safe to re-run (a second run matches nothing).

begin;
-- Skip triggers (the photo_url column guard, alert and geocode triggers).
set local session_replication_role = replica;

update public.businesses
   set photo_url = replace(photo_url, 'https://jmqljbqvyhwdrxugbwun.supabase.co', :NEW_BASE)
 where photo_url like 'https://jmqljbqvyhwdrxugbwun.supabase.co%';

update public.business_edits
   set changes = replace(changes::text, 'https://jmqljbqvyhwdrxugbwun.supabase.co', :NEW_BASE)::jsonb
 where changes::text like '%https://jmqljbqvyhwdrxugbwun.supabase.co%';

update public.moderation_log
   set detail = replace(detail::text, 'https://jmqljbqvyhwdrxugbwun.supabase.co', :NEW_BASE)::jsonb
 where detail::text like '%https://jmqljbqvyhwdrxugbwun.supabase.co%';

-- Every row should show 0; anything else still points at the old host.
select 'businesses' as tbl, count(*) as leftover from public.businesses where photo_url like '%supabase.co%'
union all select 'business_edits', count(*) from public.business_edits where changes::text like '%supabase.co%'
union all select 'moderation_log', count(*) from public.moderation_log where detail::text like '%supabase.co%';
commit;
