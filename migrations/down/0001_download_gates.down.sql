-- Rollback for 0001_download_gates.sql
--
-- `wrangler d1 migrations` only ever runs forward — it has no `down` command —
-- so this file is applied manually:
--
--   npm run d1:rollback:local        (local)
--   npm run d1:rollback              (remote — destroys real leads, see below)
--
-- Dropped children-first so the foreign keys never dangle mid-rollback.
--
-- WARNING: on remote this destroys every captured email, consent record and
-- completion event. Export contacts to CSV from /admin/gates first. Nothing
-- outside the gate system is touched — the store's data lives in KV and R2.

DROP TABLE IF EXISTS gate_events;
DROP TABLE IF EXISTS gate_action_completions;
DROP TABLE IF EXISTS gate_unlocks;
DROP TABLE IF EXISTS gate_actions;
DROP TABLE IF EXISTS gates;

-- Let wrangler's migration bookkeeping forget 0001, so a subsequent
-- `d1:migrate` re-applies it cleanly instead of reporting "no migrations to
-- apply" against tables that no longer exist.
DELETE FROM d1_migrations WHERE name = '0001_download_gates.sql';
