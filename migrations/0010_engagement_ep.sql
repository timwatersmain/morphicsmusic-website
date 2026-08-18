-- 0010_engagement_ep.sql
-- Adds engagement EP: 1 XP per unique interactive element clicked per day
-- (capped), 5 XP per 10 minutes of genuinely active visible-tab time
-- (capped), and listening XP (3 on genuine playback start, 3 more on
-- genuine completion, both per-track-per-day, aggregate capped) — see
-- functions/_lib/community/engagement.ts, the single source of truth for
-- every weight/cap, and POST /api/community/engagement, the only place that
-- ever writes these columns.
--
-- Seven columns, deliberately minimal — no per-click or per-listen EVENT
-- LOG (no timestamps, no history). The server's job is caps, day-rollover
-- and replay protection, not reconstructing what happened:
--   engagement_day                  -- UTC day (YYYY-MM-DD) the five
--                                       *_today fields below apply to; NULL
--                                       until the fan's first report.
--   engagement_clicks_today         -- unique elements counted today (also
--                                       the day's click XP, 1:1) — 0..25.
--   engagement_active_seconds_today -- seconds of visible+active time
--                                       accrued today; time XP is derived
--                                       from this (5 per 10 min, capped at
--                                       30), never stored separately.
--   engagement_listen_xp_today      -- listening XP accrued today (play +
--                                       complete awards, capped at 30).
--   engagement_listened_today       -- JSON object, track key -> which of
--                                       the two per-track listen awards it
--                                       already paid out today (e.g.
--                                       {"perception-01":{"played":true,
--                                       "completed":false}}). Bounded to at
--                                       most MAX_TRACKED_LISTEN_KEYS_PER_DAY
--                                       keys by application code — this is
--                                       the one column here that is a small
--                                       compact map rather than a scalar,
--                                       but it is still day-scoped and
--                                       reset on rollover, never a growing
--                                       log.
--   engagement_last_seq             -- last accepted client report id
--                                       (Date.now() at send time) — a
--                                       replayed/duplicate report has
--                                       seq <= this and is a no-op.
--   engagement_ep                   -- lifetime total engagement EP (clicks
--                                       + time + listening, combined), fed
--                                       into ep.ts's computeEp as
--                                       `engagementActions` (weight 1, see
--                                       EP_WEIGHTS.PER_ENGAGEMENT_ACTION).
--
-- SQLite cannot ADD COLUMN around the existing CHECK constraints on this
-- table (colourway, stage) without a rebuild — same limitation 0007/0008/
-- 0009 documented — so this follows their exact recipe: new shape, copy
-- every existing column across unchanged, drop, rename, recreate indexes.
-- PRAGMA foreign_keys OFF/ON brackets the rebuild so fan_avatar_unlocks rows
-- (FK'd to fan_profiles.id) are not cascade-deleted when the old table is
-- dropped — the guard every migration in this chain uses after a rebuild
-- once cascade-deleted live rows on this project before it was added
-- everywhere.
--
-- Rollback: see migrations/down/0010_engagement_ep.down.sql

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
  colourway          TEXT
    CHECK (colourway IS NULL OR colourway IN (
      'crimson', 'ember', 'amber', 'citron', 'leaf', 'jade',
      'cyan', 'azure', 'indigo', 'violet', 'magenta', 'rose', 'native'
    )),
  override_sprite    TEXT,
  -- New in this migration — see header comment for what each column means.
  engagement_day                  TEXT,
  engagement_clicks_today         INTEGER NOT NULL DEFAULT 0,
  engagement_active_seconds_today INTEGER NOT NULL DEFAULT 0,
  engagement_listen_xp_today      INTEGER NOT NULL DEFAULT 0,
  engagement_listened_today       TEXT    NOT NULL DEFAULT '{}',
  engagement_last_seq             INTEGER NOT NULL DEFAULT 0,
  engagement_ep                   INTEGER NOT NULL DEFAULT 0
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
