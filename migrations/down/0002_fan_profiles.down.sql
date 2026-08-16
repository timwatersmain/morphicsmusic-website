-- Rollback for 0002_fan_profiles.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:community:local
-- WARNING on remote: destroys every fan's handle, display name and unlock
-- ledger. Derived fields are regenerable; fan-owned ones are not.
DROP TABLE IF EXISTS fan_avatar_unlocks;
DROP TABLE IF EXISTS fan_profiles;
DROP TABLE IF EXISTS avatar_catalogue;
DELETE FROM d1_migrations WHERE name = '0002_fan_profiles.sql';
