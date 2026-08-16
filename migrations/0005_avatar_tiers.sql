-- 0005_avatar_tiers.sql
-- Adds the four-tier avatar ladder (glyph_solid -> glyph_inverted -> duotone
-- -> glyph_overlay) as a second, additive axis alongside the existing
-- release/special avatar_catalogue rows. `art_path` is untouched: the 21
-- release avatars (earned by owning a record) keep working exactly as they
-- do today, on their own axis.
--
-- Every new column is nullable so every existing row (release + special)
-- stays valid with no backfill. A row with style/tier set is a "recipe"
-- (style + colourway + optional artwork_key) rather than a picture — the
-- glyph itself is derived from the fan's own username at render time, not
-- stored here. See functions/_lib/community/glyph.ts.
--
-- Rollback: see migrations/down/0005_avatar_tiers.down.sql

ALTER TABLE avatar_catalogue ADD COLUMN style TEXT
  CHECK (style IS NULL OR style IN ('glyph_solid', 'glyph_inverted', 'duotone', 'glyph_overlay'));

-- Named key (e.g. 'cyan'), not a hex value — the hex lives in exactly one
-- place, functions/_lib/community/colourways.ts, mirroring the live
-- @theme tokens in src/styles/global.css. Storing a name here means that
-- module can change its hexes without a migration.
ALTER TABLE avatar_catalogue ADD COLUMN colourway TEXT;

-- Filename stem under public/images/visuals/, for tiers 3-4 (duotone /
-- glyph_overlay) only. NULL for tiers 1-2, which need no artwork file.
ALTER TABLE avatar_catalogue ADD COLUMN artwork_key TEXT;

-- 1-4, NULL for release/special rows (this ladder does not apply to them).
ALTER TABLE avatar_catalogue ADD COLUMN tier INTEGER
  CHECK (tier IS NULL OR tier BETWEEN 1 AND 4);

-- The five special:* placeholder rows (tenure/streak badges, see
-- tools/d1/seed-special-avatars.sql) were flat-black placeholder art gated
-- to the year 2100 because no real artwork existed for them. This ladder
-- replaces that reward slot entirely, so they come out. The down migration
-- restores them verbatim.
DELETE FROM avatar_catalogue WHERE id IN (
  'special:tenure-90', 'special:tenure-365', 'special:tenure-730',
  'special:streak-4', 'special:streak-12'
);
