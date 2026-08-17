-- Rollback for 0006_creatures.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:creatures:local
--
-- Drops the five fan_profiles columns and the creature_species table. Any
-- fan who had hatched loses that state — same trade-off 0004's and 0005's
-- down migrations make for their own columns.

ALTER TABLE fan_profiles DROP COLUMN ep;
ALTER TABLE fan_profiles DROP COLUMN stage;
ALTER TABLE fan_profiles DROP COLUMN species;
ALTER TABLE fan_profiles DROP COLUMN creature_colourway;
ALTER TABLE fan_profiles DROP COLUMN hatched_at;

DROP TABLE creature_species;

DELETE FROM d1_migrations WHERE name = '0006_creatures.sql';
