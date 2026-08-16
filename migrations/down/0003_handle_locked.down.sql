-- Rollback for 0003_handle_locked.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:handle-locked:local
-- This is the one place this branch relies on SQLite's DROP COLUMN support
-- (unavailable in older SQLite generally, but present in D1's SQLite and in
-- the node:sqlite build these tests run against).
ALTER TABLE fan_profiles DROP COLUMN handle_locked;
DELETE FROM d1_migrations WHERE name = '0003_handle_locked.sql';
