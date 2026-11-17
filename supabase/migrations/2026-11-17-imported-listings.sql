-- supabase/migrations/2026-11-17-imported-listings.sql
-- Run once in the SQL editor / psql. Safe to re-run.
--
-- Community-researched listings that volunteers add in bulk from public
-- information (see scripts/import-businesses.mjs). They have no owner until
-- the real owner claims them, and show an "Unclaimed" note on the site.
--   origin        'owner'    submitted by the owner (default, all existing rows)
--                 'imported' added by volunteers from public sources
--   source_urls   public pages the details came from
--   import_batch  label of the import run, so a whole batch can be removed
--   last_verified_at  when a person last checked the details
alter table businesses add column if not exists origin text not null default 'owner';
alter table businesses drop constraint if exists businesses_origin_check;
alter table businesses add constraint businesses_origin_check check (origin in ('owner', 'imported'));
alter table businesses add column if not exists source_urls text[] not null default '{}'::text[];
alter table businesses add column if not exists import_batch text;
alter table businesses add column if not exists last_verified_at timestamptz;
create index if not exists businesses_import_batch on businesses (import_batch) where import_batch is not null;
-- Owners can't touch these: the column grants on businesses only list the
-- editable fields, and inserts by owners keep the defaults.
