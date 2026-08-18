-- Rollback for 0014_xp_events.sql
-- wrangler d1 migrations only runs forward; apply this by hand:
--   npm run d1:rollback:xp-events:local
--
-- DESTRUCTIVE, and asymmetrically so: dropping this table throws away every
-- discrete XP grant ever recorded — admin corrections, and anything the earn
-- table pays out — with no way to reconstruct them. The derived portion of a
-- fan's XP (purchases, tenure, engagement) recomputes itself and is fine;
-- the granted portion simply vanishes, and every affected fan silently loses
-- XP on their next profile load.
--
-- Only run this to unwind the migration on a database where no real grants
-- have happened yet.

DROP INDEX IF EXISTS idx_xp_events_fan;
DROP INDEX IF EXISTS idx_xp_events_key;
DROP TABLE IF EXISTS xp_events;

DELETE FROM d1_migrations WHERE name = '0014_xp_events.sql';
