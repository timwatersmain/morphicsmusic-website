-- Rollback for 0010_engagement_ep.sql
-- wrangler d1 migrations only runs forward; apply this by hand:
--   npm run d1:rollback:engagement-ep:local
--
-- Rebuilds fan_profiles back to 0009's shape, dropping the seven
-- engagement_* columns. Any accrued engagement EP (clicks/time/listening)
-- is lost — acceptable: it is a supplementary signal into computeEp (see
-- ep.ts's PER_ENGAGEMENT_ACTION), never a fan's purchases or tenure, and
-- rolling this migration back is itself an exceptional admin action, not a
-- routine one. Same id-preservation / index-recreation / FK-cascade-guard
-- pattern as every other migration in this chain.

PRAGMA foreign_keys = OFF;

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
    CHECK (stage IS NULL OR stage IN ('egg', 'grub', 'pupa', 'adult')),
  hatched_at         INTEGER,
  sprite_egg         TEXT,
  sprite_grub        TEXT,
  sprite_pupa        TEXT,
  sprite_adult       TEXT,
  colourway          TEXT
    CHECK (colourway IS NULL OR colourway IN (
      'crimson', 'ember', 'amber', 'citron', 'leaf', 'jade',
      'cyan', 'azure', 'indigo', 'violet', 'magenta', 'rose', 'native'
    )),
  override_sprite    TEXT
);

INSERT INTO fan_profiles_old (
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
ALTER TABLE fan_profiles_old RENAME TO fan_profiles;

CREATE UNIQUE INDEX idx_fan_profiles_email ON fan_profiles (email);
CREATE UNIQUE INDEX idx_fan_profiles_handle ON fan_profiles (handle);
CREATE INDEX idx_fan_profiles_board ON fan_profiles (rank_points, fan_since);

PRAGMA foreign_keys = ON;

DELETE FROM d1_migrations WHERE name = '0010_engagement_ep.sql';
