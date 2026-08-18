-- Rollback for 0011_profile_bio_privacy.sql
-- wrangler d1 migrations only runs forward; apply this by hand:
--   npm run d1:rollback:profile-bio:local
--
-- DROP COLUMN rather than a rebuild, mirroring the forward migration: neither
-- column is indexed and neither is referenced by a constraint or a view, which
-- are the cases where SQLite refuses the drop. Every bio written by a fan is
-- lost, and every fan hidden from the wall becomes listed again — both are
-- fan-authored settings, so this is an exceptional admin action, never routine.

ALTER TABLE fan_profiles DROP COLUMN bio;

ALTER TABLE fan_profiles DROP COLUMN hidden_from_wall;

DELETE FROM d1_migrations WHERE name = '0011_profile_bio_privacy.sql';
