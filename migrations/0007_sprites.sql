-- 0007_sprites.sql
-- Adopts the owner's exported pixel-sprite creature system, replacing the
-- placeholder stage names and the species/hatch model from 0006.
--
-- STAGE RENAME: egg/larva/chrysalis/emergent -> egg/grub/pupa/adult, matching
-- the vendored sprite export exactly (see src/scripts/sprites/vendor/README.txt)
-- so there is no translation layer between what's stored and what the art is
-- authored against. SQLite cannot ALTER a CHECK constraint in place, so this
-- rebuilds fan_profiles: create the new shape, copy every row across
-- (translating `stage` with a CASE), drop the old table, rename the new one
-- into place. Rowids (and therefore `id`, and every FK that points at it —
-- fan_avatar_unlocks.fan_id) are preserved by copying `id` explicitly; the
-- RENAME TO at the end also carries the AUTOINCREMENT sequence entry in
-- sqlite_sequence across (SQLite renames it along with the table), so new
-- fans keep getting fresh, never-reused ids afterward.
--
-- SPECIES RETIRED: the 0006 model picked ONE species at the moment a fan's
-- stage first left 'egg' (creature_species + species.ts's assignSpecies).
-- That's replaced entirely by sprites.ts's assignSpriteRefs: four
-- independent sprite refs (one per stage) plus a colourway, all fixed
-- at PROFILE CREATION rather than at hatch — a fan's whole journey is
-- settled from the start and never re-rolls. creature_species is dropped;
-- nothing reads it after this migration (see the deleted functions/_lib/
-- community/species.ts). `species` and the old `creature_colourway` columns
-- are dropped; `creature_colourway` is replaced by `colourway`, which the
-- new CHECK constraint restricts to the 12 real ids (src/scripts/sprites/
-- vendor/colorways.js) — enforced at the DB layer, not just in application
-- code, unlike 0006's colourway column.
--
-- Existing rows (there are none yet in any real deployment — this ships
-- alongside its own feature — but the migration is written to be correct
-- for a populated table regardless) get NULL sprite_* / colourway: there is
-- no SQL-side SHA-256 to deterministically assign them here, so the
-- backfill happens lazily on the fan's own next profile read (see repo.ts's
-- ensureSpriteAssignment) — same NULL-is-a-valid-state precedent 0006 set
-- for a pre-migration `stage`.
--
-- FOREIGN KEYS: fan_avatar_unlocks.fan_id REFERENCES fan_profiles(id) ON
-- DELETE CASCADE. With foreign_keys=ON, SQLite fires that CASCADE not only
-- on an explicit DELETE but on DROP TABLE fan_profiles too — even though
-- this is a rebuild-and-copy, not a real delete, every fan's unlock ledger
-- would be wiped out from under them the instant the old table is dropped.
-- Toggling the pragma off for the duration of the rebuild (back on
-- immediately after) is what makes this actually additive instead of
-- silently destructive.
--
-- Rollback: see migrations/down/0007_sprites.down.sql

PRAGMA foreign_keys = OFF;

CREATE TABLE fan_profiles_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL,
  handle             TEXT    NOT NULL,
  display_name       TEXT    NOT NULL,
  equipped_avatar_id TEXT    REFERENCES avatar_catalogue (id) ON DELETE SET NULL,
  fan_since          INTEGER NOT NULL,
  rank_points        INTEGER NOT NULL DEFAULT 0,
  collection_count   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_seen_at       INTEGER,
  handle_changed_at  INTEGER,
  ep                 INTEGER NOT NULL DEFAULT 0,
  stage              TEXT
    CHECK (stage IS NULL OR stage IN ('egg', 'grub', 'pupa', 'adult')),
  hatched_at         INTEGER,
  -- One ref per stage into the vendored sprite set (e.g. "A147"), assigned
  -- once at profile creation (see sprites.ts) and permanent thereafter.
  sprite_egg         TEXT,
  sprite_grub        TEXT,
  sprite_pupa        TEXT,
  sprite_adult       TEXT,
  -- Named key into COLORWAYS (src/scripts/sprites/vendor/colorways.js) — the
  -- one part of the creature a fan can change, via /api/community/update.
  colourway          TEXT
    CHECK (colourway IS NULL OR colourway IN (
      'crimson', 'ember', 'amber', 'citron', 'leaf', 'jade',
      'cyan', 'azure', 'indigo', 'violet', 'magenta', 'rose'
    ))
);

INSERT INTO fan_profiles_new (
  id, email, handle, display_name, equipped_avatar_id, fan_since, rank_points,
  collection_count, created_at, updated_at, last_seen_at, handle_changed_at,
  ep, stage, hatched_at, sprite_egg, sprite_grub, sprite_pupa, sprite_adult, colourway
)
SELECT
  id, email, handle, display_name, equipped_avatar_id, fan_since, rank_points,
  collection_count, created_at, updated_at, last_seen_at, handle_changed_at,
  ep,
  CASE stage
    WHEN 'larva' THEN 'grub'
    WHEN 'chrysalis' THEN 'pupa'
    WHEN 'emergent' THEN 'adult'
    ELSE stage -- NULL or already 'egg'
  END,
  hatched_at,
  NULL, NULL, NULL, NULL, -- sprite_* backfilled lazily, see header comment
  NULL                    -- colourway backfilled lazily alongside sprite_*
FROM fan_profiles;

DROP TABLE fan_profiles;
ALTER TABLE fan_profiles_new RENAME TO fan_profiles;

CREATE UNIQUE INDEX idx_fan_profiles_email ON fan_profiles (email);
CREATE UNIQUE INDEX idx_fan_profiles_handle ON fan_profiles (handle);
CREATE INDEX idx_fan_profiles_board ON fan_profiles (rank_points, fan_since);

DROP TABLE creature_species;

PRAGMA foreign_keys = ON;
