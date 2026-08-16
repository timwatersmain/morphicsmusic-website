-- Example gate for local testing.
--
--   npm run d1:seed:local
--
-- Deliberately NOT in migrations/ — it must never run against production.
-- Idempotent: re-running replaces the example gate and its actions rather
-- than erroring or duplicating.
--
-- Demonstrates the honest-labelling rule end to end: the four SoundCloud
-- actions and the email step are 'verified'; Spotify and Instagram are
-- 'attested'. Trying to flip either of the last two to 'verified' here will
-- be rejected by the CHECK constraint in 0001_download_gates.sql — which is
-- a useful thing to try once, to see that the guard is real.

DELETE FROM gates WHERE slug = 'example-pack';

INSERT INTO gates (
  slug, title, subtitle,
  artwork_path, preview_audio_path,
  file_storage_key, file_label, file_size_bytes,
  active, published_at, expires_at, theme_overrides,
  created_at, updated_at
) VALUES (
  'example-pack',
  'MORPHOGENESIS SAMPLE PACK',
  'Free · 42 one-shots and 12 loops · 24-bit WAV',
  '/images/digital/morphian-card.png',
  NULL,
  'gates/example-pack/morphogenesis-pack.zip',
  'Morphogenesis Pack (ZIP · 24-bit WAV)',
  NULL,
  1,
  strftime('%s', 'now'),
  NULL,
  NULL,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Plain VALUES rows rather than a UNION ALL chain: D1 caps the number of
-- terms in a compound SELECT far below stock SQLite's limit, and a seven-arm
-- UNION ALL is already over it ("too many terms in compound SELECT").
INSERT INTO gate_actions (
  gate_id, ordinal, type, target_url, target_resource_id,
  verification_mode, label, required, created_at
) VALUES
  ((SELECT id FROM gates WHERE slug = 'example-pack'), 1, 'email',
   NULL, NULL,
   'verified', 'Confirm your email', 1, strftime('%s', 'now')),

  ((SELECT id FROM gates WHERE slug = 'example-pack'), 2, 'soundcloud_follow',
   'https://soundcloud.com/morphics-music', NULL,
   'verified', 'Follow Morphics on SoundCloud', 1, strftime('%s', 'now')),

  ((SELECT id FROM gates WHERE slug = 'example-pack'), 3, 'soundcloud_like',
   'https://soundcloud.com/morphics-music/croaky-acid-2', NULL,
   'verified', 'Like "Croaky Acid"', 1, strftime('%s', 'now')),

  ((SELECT id FROM gates WHERE slug = 'example-pack'), 4, 'soundcloud_repost',
   'https://soundcloud.com/morphics-music/croaky-acid-2', NULL,
   'verified', 'Repost "Croaky Acid"', 0, strftime('%s', 'now')),

  ((SELECT id FROM gates WHERE slug = 'example-pack'), 5, 'soundcloud_comment',
   'https://soundcloud.com/morphics-music/croaky-acid-2', NULL,
   'verified', 'Leave a comment', 0, strftime('%s', 'now')),

  -- Attested from here down. No API can confirm these, and the schema will
  -- not let them claim otherwise.
  ((SELECT id FROM gates WHERE slug = 'example-pack'), 6, 'spotify_follow',
   'https://open.spotify.com/artist/morphics', NULL,
   'attested', 'Follow on Spotify', 1, strftime('%s', 'now')),

  ((SELECT id FROM gates WHERE slug = 'example-pack'), 7, 'instagram_follow',
   'https://www.instagram.com/morphicsmusic/', NULL,
   'attested', 'Follow on Instagram', 0, strftime('%s', 'now'));
