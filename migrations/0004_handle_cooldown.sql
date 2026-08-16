-- 0004_handle_cooldown.sql
-- Replaces the permanent handle_locked flag (0003) with a 30-day cooldown:
-- fans may change their handle, just not more than once every 30 days. That
-- keeps profile links reasonably stable and makes name-squatting expensive
-- without freezing anyone out of their own name forever.
--
-- handle_changed_at is nullable: NULL means "never changed", which is what
-- lets the very first change through with no waiting period.
--
-- handle_locked is dropped outright rather than left dead alongside the new
-- column. Nothing built on this branch has been deployed yet, so there is no
-- live data or running code depending on it — leaving it would just be a
-- confusing, superseded column. D1's SQLite (like the node:sqlite build these
-- tests run against) supports DROP COLUMN, so this can be a straight ALTER
-- rather than a rebuild-and-copy.
--
-- Rollback: see migrations/down/0004_handle_cooldown.down.sql
ALTER TABLE fan_profiles ADD COLUMN handle_changed_at INTEGER;
ALTER TABLE fan_profiles DROP COLUMN handle_locked;
