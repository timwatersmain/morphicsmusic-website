-- 0002_fan_profiles.sql
-- Fan profiles, the avatar catalogue, and the unlock ledger.
--
-- Purely additive. The store's purchase data lives in KV and is untouched.
-- Rollback: migrations/down/0002_fan_profiles.down.sql
--
-- Two kinds of column live here, and the difference matters:
--   derived    — regenerable from KV (fan_since, collection_count) and from
--                the ledger. A rebuild script can recompute all of it.
--   fan-owned  — exists only here (handle, display_name, equipped_avatar_id).
--                Never derived, never overwritten by a rebuild.
-- Times are unix epoch seconds, matching the KV records.

CREATE TABLE fan_profiles (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The link to the KV customer record (`customer:<email>`). Never exposed
  -- to any client; `handle` is the only fan-facing identifier.
  email              TEXT    NOT NULL,
  handle             TEXT    NOT NULL,
  display_name       TEXT    NOT NULL,
  equipped_avatar_id TEXT    REFERENCES avatar_catalogue (id) ON DELETE SET NULL,
  fan_since          INTEGER NOT NULL,
  rank_points        INTEGER NOT NULL DEFAULT 0,
  collection_count   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_seen_at       INTEGER
);

CREATE UNIQUE INDEX idx_fan_profiles_email ON fan_profiles (email);
CREATE UNIQUE INDEX idx_fan_profiles_handle ON fan_profiles (handle);
CREATE INDEX idx_fan_profiles_board ON fan_profiles (rank_points, fan_since);

-- Avatar ids are stable TEXT keys, not autoincrement integers: `release:<slug>`
-- and `special:<name>`. The sync script is re-runnable, and a stable id means
-- re-running it can never re-issue or orphan somebody's unlock.
CREATE TABLE avatar_catalogue (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('release', 'special')),
  release_slug   TEXT,
  name           TEXT    NOT NULL,
  art_path       TEXT    NOT NULL,
  -- JSON: {"type":"own_release","slug":"..."} | {"type":"tenure_days","days":N}
  --     | {"type":"free_song_streak","weeks":N} | {"type":"show_attended","showId":"..."}
  --     | {"type":"gate_completed","gateSlug":"..."}
  unlock_rule    TEXT    NOT NULL,
  -- Shown to fans who do not have it yet. This is the teaser, so it must
  -- always be populated.
  hint           TEXT    NOT NULL,
  available_from  INTEGER,
  available_until INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_avatar_catalogue_kind ON avatar_catalogue (kind, sort_order);

CREATE TABLE fan_avatar_unlocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id      INTEGER NOT NULL REFERENCES fan_profiles (id) ON DELETE CASCADE,
  avatar_id   TEXT    NOT NULL REFERENCES avatar_catalogue (id) ON DELETE CASCADE,
  unlocked_at INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  source_ref  TEXT,
  UNIQUE (fan_id, avatar_id)
);

-- Rarity: COUNT(*) GROUP BY avatar_id, so avatar_id leads.
CREATE INDEX idx_unlocks_avatar ON fan_avatar_unlocks (avatar_id);
CREATE INDEX idx_unlocks_fan ON fan_avatar_unlocks (fan_id);
