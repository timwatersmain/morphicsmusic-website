-- Special avatars: the classes that release ownership cannot express.
-- Idempotent — safe to re-run.
--
-- available_from is pinned to 4102444800 (2100-01-01 UTC) rather than NULL.
-- The real artwork for these five ids is still a 348-byte flat-black
-- placeholder circle, so NULL here would let any customer older than the
-- relevant tenure/streak threshold earn and DISPLAY that placeholder today —
-- that is not the accepted "locked teaser" case, it is a shipped-looking
-- reward with no art behind it.
--
-- TO ENABLE: once real artwork exists for an avatar, clear its
-- available_from (set it back to NULL) and re-run this seed. Do it per-row
-- as art lands; there is no need to wait for all five.
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
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, art_path = excluded.art_path,
  unlock_rule = excluded.unlock_rule, hint = excluded.hint,
  available_from = excluded.available_from, sort_order = excluded.sort_order;
