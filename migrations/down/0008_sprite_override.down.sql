-- Rollback for 0008_sprite_override.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:sprite-override:local
--
-- Drops the override column. Any admin override in place is lost, same
-- trade-off every other down migration in this chain makes for the columns
-- it removes.

ALTER TABLE fan_profiles DROP COLUMN override_sprite;

DELETE FROM d1_migrations WHERE name = '0008_sprite_override.sql';
