-- 0012_profile_soft_delete.sql
-- Turns profile deletion into a 30-day grace period instead of an
-- irreversible drop.
--
--   deleted_at  -- NULL (default, and the state of every existing row) means
--                  a live profile. A unix timestamp means the fan asked for
--                  deletion at that moment: the profile is gone from every
--                  fan-facing surface immediately — the wall, public profile
--                  links, engagement earning, their own profile page — but
--                  the row survives so they can restore it. After the grace
--                  window it is hard-deleted for real.
--
-- Why a column and not a "deleted_profiles" archive table: everything that
-- makes a profile worth restoring (bio, engagement_ep, colourway, sprite
-- override, hatched_at, handle) is already on this row, and an archive table
-- would have to be kept in lockstep with every future column added here —
-- a schema-drift bug waiting to happen, where the restore silently returns a
-- profile missing whatever was added since. One nullable column cannot drift
-- from itself.
--
-- The handle stays reserved for the whole window ON PURPOSE. The unique
-- index on handle still covers deleted rows, so nobody can take the name of
-- a fan who is still inside their restore window and make the restore fail
-- (or worse, succeed while pointing an old link at a stranger). See
-- isHandleTaken in functions/_lib/community/repo.ts, which deliberately does
-- NOT filter deleted rows, unlike every other read in that file.
--
-- Plain ADD COLUMN, following 0011 rather than the 0007/0009/0010 rebuilds:
-- those rebuilt only because they had to alter a CHECK constraint, which
-- SQLite cannot do in place. One nullable INTEGER touches no constraint, so
-- copying every live fan row would be pure risk for no gain.
--
-- Rollback: see migrations/down/0012_profile_soft_delete.down.sql

ALTER TABLE fan_profiles ADD COLUMN deleted_at INTEGER;

-- Partial index: the only query that ever reads this column looks for rows
-- where it is NOT NULL (the purge sweep). Indexing the NULLs too would mean
-- indexing every live fan — the overwhelming majority of the table — to
-- answer a question that is never asked about them.
CREATE INDEX idx_fan_profiles_deleted_at
  ON fan_profiles (deleted_at)
  WHERE deleted_at IS NOT NULL;
