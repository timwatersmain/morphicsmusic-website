-- Rollback for 0004_handle_cooldown.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:handle-cooldown:local
-- Restores handle_locked (defaulting existing rows to 0 — there is no way to
-- recover which handles were "locked" under the old model once the column is
-- gone, and 0 is the safe/permissive default) and drops handle_changed_at.
ALTER TABLE fan_profiles ADD COLUMN handle_locked INTEGER NOT NULL DEFAULT 0
  CHECK (handle_locked IN (0, 1));
ALTER TABLE fan_profiles DROP COLUMN handle_changed_at;
DELETE FROM d1_migrations WHERE name = '0004_handle_cooldown.sql';
