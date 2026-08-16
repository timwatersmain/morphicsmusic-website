-- Rollback for 0005_avatar_tiers.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:avatar-tiers:local
--
-- Restores the five special:* placeholder rows exactly as
-- tools/d1/seed-special-avatars.sql defines them (same ids, art_path,
-- unlock_rule, hint, available_from/sort_order), then drops the four
-- tier-ladder columns. Re-running the up migration afterwards is expected
-- to re-delete these rows, matching 0005's own behaviour.
INSERT INTO avatar_catalogue
  (id, kind, release_slug, name, art_path, unlock_rule, hint, available_from, available_until, sort_order)
VALUES
  ('special:tenure-90', 'special', NULL, 'Early Signal', '/images/avatars/tenure-90.webp',
   '{"type":"tenure_days","days":90}', 'Be a fan for 3 months', 4102444800, NULL, 1000),
  ('special:tenure-365', 'special', NULL, 'Year One', '/images/avatars/tenure-365.webp',
   '{"type":"tenure_days","days":365}', 'Be a fan for 1 year', 4102444800, NULL, 1001),
  ('special:tenure-730', 'special', NULL, 'Longform', '/images/avatars/tenure-730.webp',
   '{"type":"tenure_days","days":730}', 'Be a fan for 2 years', 4102444800, NULL, 1002),
  ('special:streak-4', 'special', NULL, 'Four Weeks', '/images/avatars/streak-4.webp',
   '{"type":"free_song_streak","weeks":4}', 'Claim the free song 4 weeks running', 4102444800, NULL, 1010),
  ('special:streak-12', 'special', NULL, 'Twelve Weeks', '/images/avatars/streak-12.webp',
   '{"type":"free_song_streak","weeks":12}', 'Claim the free song 12 weeks running', 4102444800, NULL, 1011)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE avatar_catalogue DROP COLUMN style;
ALTER TABLE avatar_catalogue DROP COLUMN colourway;
ALTER TABLE avatar_catalogue DROP COLUMN artwork_key;
ALTER TABLE avatar_catalogue DROP COLUMN tier;

DELETE FROM d1_migrations WHERE name = '0005_avatar_tiers.sql';
