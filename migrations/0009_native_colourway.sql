-- 0009_native_colourway.sql
-- Adds the NATIVE_COLOURWAY sentinel ('native') as a value a fan can opt
-- into for `colourway`, meaning "render this creature in its own authored
-- palette (sprite.palette — see src/scripts/sprites/vendor/README.txt's
-- SPRITE FORMAT) instead of any of the 12 named colourways". Not the same
-- state as NULL: NULL means "this fan has never chosen a colourway" (falls
-- back to their deterministically assigned one — see sprites.ts's
-- assignColourway); 'native' is an explicit opt-in choice. See
-- src/scripts/sprites/native-palette.js, the single source of truth for
-- this literal, shared by both the client and functions/_lib/community/
-- sprites.ts's isValidColourway (the actual write-time gate).
--
-- A GENUINE BLOCKER makes this a migration rather than a free write: 0007
-- added a DB-level CHECK constraint enforcing colourway to exactly the 12
-- real ids or NULL ("enforced at the DB layer, not just in application
-- code" — see that migration's header). A plain nullable-column write
-- would violate that CHECK the instant a fan opts into 'native'. SQLite
-- cannot ALTER a CHECK constraint in place (same limitation 0007 documents),
-- so this rebuilds fan_profiles again: create the new shape with the widened
-- CHECK, copy every row and column across unchanged (including
-- override_sprite, added by 0008, which this migration does not touch),
-- drop the old table, rename the new one into place. Same id-preservation,
-- index-recreation and FK-cascade guard as 0007/0008 — see those files'
-- header comments for why each of those steps exists.
--
-- Rollback: see migrations/down/0009_native_colourway.down.sql

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
  sprite_egg         TEXT,
  sprite_grub        TEXT,
  sprite_pupa        TEXT,
  sprite_adult       TEXT,
  -- Widened from 0007's 12-id CHECK to also allow 'native' — the sentinel
  -- meaning "use the sprite's own authored palette" (see this file's header
  -- comment). Still a closed allow-list, never a free-form TEXT column.
  colourway          TEXT
    CHECK (colourway IS NULL OR colourway IN (
      'crimson', 'ember', 'amber', 'citron', 'leaf', 'jade',
      'cyan', 'azure', 'indigo', 'violet', 'magenta', 'rose', 'native'
    )),
  -- Added by 0008; carried through this rebuild unchanged.
  override_sprite    TEXT
);

INSERT INTO fan_profiles_new (
  id, email, handle, display_name, equipped_avatar_id, fan_since, rank_points,
  collection_count, created_at, updated_at, last_seen_at, handle_changed_at,
  ep, stage, hatched_at, sprite_egg, sprite_grub, sprite_pupa, sprite_adult,
  colourway, override_sprite
)
SELECT
  id, email, handle, display_name, equipped_avatar_id, fan_since, rank_points,
  collection_count, created_at, updated_at, last_seen_at, handle_changed_at,
  ep, stage, hatched_at, sprite_egg, sprite_grub, sprite_pupa, sprite_adult,
  colourway, override_sprite
FROM fan_profiles;

DROP TABLE fan_profiles;
ALTER TABLE fan_profiles_new RENAME TO fan_profiles;

CREATE UNIQUE INDEX idx_fan_profiles_email ON fan_profiles (email);
CREATE UNIQUE INDEX idx_fan_profiles_handle ON fan_profiles (handle);
CREATE INDEX idx_fan_profiles_board ON fan_profiles (rank_points, fan_since);

PRAGMA foreign_keys = ON;
