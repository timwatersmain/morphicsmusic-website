-- Rollback for 0012_profile_soft_delete.sql
-- wrangler d1 migrations only runs forward; apply this by hand:
--   npm run d1:rollback:soft-delete:local
--
-- DANGER, and it is not symmetrical with the forward migration: dropping the
-- column does NOT restore the old behaviour, it strands every soft-deleted
-- profile as a LIVE one. A fan who asked to be deleted and is sitting inside
-- their grace window would silently reappear on the fan wall.
--
-- So purge first, then drop. The DELETE below hard-deletes exactly the rows
-- that were pending deletion anyway — which is what would have happened to
-- them at the end of their window — and the unlock ledger rows with them,
-- since nothing cascades from a plain column drop.

DELETE FROM fan_avatar_unlocks
  WHERE fan_id IN (SELECT id FROM fan_profiles WHERE deleted_at IS NOT NULL);

DELETE FROM fan_profiles WHERE deleted_at IS NOT NULL;

DROP INDEX IF EXISTS idx_fan_profiles_deleted_at;

ALTER TABLE fan_profiles DROP COLUMN deleted_at;

DELETE FROM d1_migrations WHERE name = '0012_profile_soft_delete.sql';
