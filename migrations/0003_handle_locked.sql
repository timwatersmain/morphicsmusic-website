-- 0003_handle_locked.sql
-- Adds fan_profiles.handle_locked: a permanent flag set the first time a
-- fan's handle is regenerated off a chosen display name.
--
-- Purely additive, following 0002's convention. Rollback: see
-- migrations/down/0003_handle_locked.down.sql
--
-- Why this column exists: the old gate compared the CURRENT display_name
-- against the literal 'Fan' to decide whether to regenerate the handle. But
-- 'Fan' is itself a legal display name a fan can rename themselves to, which
-- re-arms the gate and lets a fan move their handle indefinitely (breaking
-- every link shared to their profile in the meantime). handle_locked is
-- state that only ever moves 0 -> 1, once, regardless of what the fan later
-- renames themselves to.
ALTER TABLE fan_profiles ADD COLUMN handle_locked INTEGER NOT NULL DEFAULT 0
  CHECK (handle_locked IN (0, 1));
