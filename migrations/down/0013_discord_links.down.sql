-- Rollback for 0013_discord_links.sql
--
-- Destructive: every fan's Discord link and the EP earned through it are
-- lost, and re-applying 0013 does not bring them back — the bot's local
-- event log holds the events but nothing replays them into D1. Take a D1
-- export first if the links matter.
--
-- Indexes are dropped with their tables; naming them explicitly would fail
-- on a partially-applied migration.

DROP TABLE IF EXISTS discord_link_codes;
DROP TABLE IF EXISTS discord_links;
