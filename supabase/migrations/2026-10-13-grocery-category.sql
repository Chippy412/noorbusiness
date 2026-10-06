-- supabase/migrations/2026-10-13-grocery-category.sql
-- Run this once in the Supabase SQL editor. Safe to re-run.
--
-- The "Grocery & Halal Meat" category is now just "Grocery"; halal status is
-- shown by the Halal verified badge instead.
update public.businesses set category = 'Grocery' where category = 'Grocery & Halal Meat';
