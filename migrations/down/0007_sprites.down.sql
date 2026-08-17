-- Rollback for 0007_sprites.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:sprites:local
--
-- Rebuilds fan_profiles back to its 0006 shape (stage values translated back
-- to the old names, sprite_*/colourway columns dropped, creature_colourway
-- and species columns restored as NULL — any sprite/colourway assignment
-- made under 0007 is lost, same trade-off every other down migration in this
-- chain makes for the columns it removes) and recreates creature_species
-- empty (0006's own down migration is what drops it again if you keep
-- rolling back further; that table has no seed file anymore — it was
-- retired along with functions/_lib/community/species.ts).
--
-- FOREIGN KEYS: same PRAGMA toggle as the up migration, and for the same
-- reason — DROP TABLE fan_profiles fires fan_avatar_unlocks' ON DELETE
-- CASCADE even though this is a rebuild, not a real delete.

PRAGMA foreign_keys = OFF;

CREATE TABLE creature_species (
  id            TEXT    PRIMARY KEY,
  name          TEXT,
  rarity_weight INTEGER NOT NULL DEFAULT 100,
  art_prefix    TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE fan_profiles_old (
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
    CHECK (stage IS NULL OR stage IN ('egg', 'larva', 'chrysalis', 'emergent')),
  species            TEXT,
  creature_colourway TEXT,
  hatched_at         INTEGER
);

INSERT INTO fan_profiles_old (
  id, email, handle, display_name, equipped_avatar_id, fan_since, rank_points,
  collection_count, created_at, updated_at, last_seen_at, handle_changed_at,
  ep, stage, species, creature_colourway, hatched_at
)
SELECT
  id, email, handle, display_name, equipped_avatar_id, fan_since, rank_points,
  collection_count, created_at, updated_at, last_seen_at, handle_changed_at,
  ep,
  CASE stage
    WHEN 'grub' THEN 'larva'
    WHEN 'pupa' THEN 'chrysalis'
    WHEN 'adult' THEN 'emergent'
    ELSE stage
  END,
  NULL, -- species: no way back from a sprite ref to a retired species id
  colourway,
  hatched_at
FROM fan_profiles;

DROP TABLE fan_profiles;
ALTER TABLE fan_profiles_old RENAME TO fan_profiles;

CREATE UNIQUE INDEX idx_fan_profiles_email ON fan_profiles (email);
CREATE UNIQUE INDEX idx_fan_profiles_handle ON fan_profiles (handle);
CREATE INDEX idx_fan_profiles_board ON fan_profiles (rank_points, fan_since);

PRAGMA foreign_keys = ON;

DELETE FROM d1_migrations WHERE name = '0007_sprites.sql';
