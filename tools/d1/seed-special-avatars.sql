-- Special avatars: the classes that release ownership cannot express.
-- Idempotent — safe to re-run.
INSERT INTO avatar_catalogue
  (id, kind, release_slug, name, art_path, unlock_rule, hint, available_from, available_until, sort_order)
VALUES
  ('special:tenure-90', 'special', NULL, 'Early Signal', '/images/avatars/tenure-90.webp',
   '{"type":"tenure_days","days":90}', 'Be a fan for 3 months', NULL, NULL, 1000),
  ('special:tenure-365', 'special', NULL, 'Year One', '/images/avatars/tenure-365.webp',
   '{"type":"tenure_days","days":365}', 'Be a fan for 1 year', NULL, NULL, 1001),
  ('special:tenure-730', 'special', NULL, 'Longform', '/images/avatars/tenure-730.webp',
   '{"type":"tenure_days","days":730}', 'Be a fan for 2 years', NULL, NULL, 1002),
  ('special:streak-4', 'special', NULL, 'Four Weeks', '/images/avatars/streak-4.webp',
   '{"type":"free_song_streak","weeks":4}', 'Claim the free song 4 weeks running', NULL, NULL, 1010),
  ('special:streak-12', 'special', NULL, 'Twelve Weeks', '/images/avatars/streak-12.webp',
   '{"type":"free_song_streak","weeks":12}', 'Claim the free song 12 weeks running', NULL, NULL, 1011)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, art_path = excluded.art_path,
  unlock_rule = excluded.unlock_rule, hint = excluded.hint, sort_order = excluded.sort_order;
