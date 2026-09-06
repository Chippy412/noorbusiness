-- supabase/migrations/2026-09-06-business-photos.sql
-- Run this once in the Supabase SQL editor. Adds a photo_url column to
-- businesses, lets owners write to it, and sets up a public storage
-- bucket + policies so owners can upload their own listing photo.

alter table businesses add column if not exists photo_url text;

-- Owners could already update their own row (Task 2's RLS policy), but
-- the column-level grant from that task only listed specific columns.
-- Add photo_url to what an owner is allowed to write.
grant update (photo_url) on businesses to authenticated;

-- Public bucket: photos need to be viewable by anonymous visitors browsing
-- the directory, same as the businesses table's own public read policy.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-photos', 'business-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects already has RLS enabled by default on every Supabase
-- project, and is owned by an internal role -- ALTER TABLE on it from
-- the SQL editor fails with "must be owner of table objects". No need
-- to enable it ourselves.

-- Anyone can view a business photo (matches the bucket's public flag,
-- explicit policy so it also covers listing/signed-URL style access).
drop policy if exists "Public can view business photos" on storage.objects;
create policy "Public can view business photos"
  on storage.objects for select
  using (bucket_id = 'business-photos');

-- Path convention: business-photos/<business_id>/<filename>. An owner
-- may only write into the folder named after a business they own.
drop policy if exists "Owners can upload their own business photos" on storage.objects;
create policy "Owners can upload their own business photos"
  on storage.objects for insert
  with check (
    bucket_id = 'business-photos'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can replace their own business photos" on storage.objects;
create policy "Owners can replace their own business photos"
  on storage.objects for update
  using (
    bucket_id = 'business-photos'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'business-photos'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_id = auth.uid()
    )
  );

drop policy if exists "Owners can delete their own business photos" on storage.objects;
create policy "Owners can delete their own business photos"
  on storage.objects for delete
  using (
    bucket_id = 'business-photos'
    and (storage.foldername(name))[1] in (
      select id::text from businesses where owner_id = auth.uid()
    )
  );
