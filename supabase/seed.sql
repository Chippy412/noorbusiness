-- supabase/seed.sql
-- One-time seed: inserts the 6 real, already-researched businesses.
-- Run this once, after schema.sql, in the Supabase SQL editor.
-- This uses the service role (the SQL editor bypasses RLS), which is
-- correct here -- these rows start pre-approved because they were already
-- vetted by research, not submitted through the public form.

insert into businesses
  (name, category, neighborhood, description, long_description, address, hours, badges, featured, status)
values
  (
    'Meat Moot', 'Restaurants', 'Hilliard',
    'Zabihah-listed Mediterranean smoked meats on Fishinger Boulevard.',
    'A Mediterranean smoked meat restaurant on Fishinger Boulevard in Hilliard, listed as halal on Zabihah. New to this directory, this listing has not yet been confirmed directly with the owner.',
    '3708 Fishinger Blvd, Hilliard, OH 43026',
    '[]'::jsonb, '{}'::text[], true, 'approved'
  ),
  (
    'Supreme Fresh Halal Meat & Grocery', 'Grocery', 'Northland',
    'Fresh halal meat and Indian grocery staples near Polaris.',
    'A halal meat and grocery shop on Sancus Boulevard carrying goat, chicken, and fish alongside a curated selection of Indian pantry staples and spices.',
    '8635 Sancus Blvd, Columbus, OH 43240',
    '[]'::jsonb, '{}'::text[], true, 'approved'
  ),
  (
    'We-Got-Meat', 'Grocery', 'Dublin',
    'Halal meat market and delivery service on Sawmill Road.',
    'Part of a regional halal meat delivery service, with a Dublin location on Sawmill Road for in-person shopping alongside online ordering.',
    '5833 Sawmill Rd, Dublin, OH 43017',
    '[]'::jsonb, '{}'::text[], false, 'approved'
  ),
  (
    'Naska Beauty', 'Modest Wear', 'Citywide (online)',
    'Mother and daughter modest wear brand, hijabs and abayas shipped worldwide.',
    'An online modest wear brand run by a mother and daughter, designing hijabs, abayas, and prayer wear in house and shipping worldwide from Columbus. No walk-in storefront yet.',
    null,
    '[]'::jsonb, '{women}'::text[], false, 'approved'
  ),
  (
    'Al-Tahoor Quran Institute', 'Education', 'Citywide (online)',
    'Live one-on-one Quran classes for families across central Ohio.',
    'Live, one-on-one Quran instruction from Ijazah-certified teachers, serving families across Columbus, Dublin, and Hilliard through online sessions.',
    null,
    '[]'::jsonb, '{}'::text[], false, 'approved'
  ),
  (
    'Noor Free Clinic', 'Health & Wellness', 'Short North',
    'NICC''s own free clinic, run by volunteer Muslim physicians since 2010.',
    'Run by Noor Islamic Cultural Center in partnership with OSU Wexner Medical Center, this free clinic serves uninsured and underserved patients of any faith background. Call ahead to schedule.',
    '2231 North High St, Columbus, OH 43201 · (614) 516-3075',
    '[["Clinic hours", "Wednesdays, 17:00 - 21:00"], ["To schedule", "Call Mon 10:00-15:00 or Tue 10:00-12:00"]]'::jsonb,
    '{community}'::text[], true, 'approved'
  );
