-- Rollback for 0015_discord_award_events.sql
--
-- Destructive in a specific way worth understanding: dropping this table makes
-- every award the bot has ever delivered replayable again. If the bot still has
-- rows queued in its outbox, the next drain will re-apply awards that were
-- already counted, inflating those fans' EP permanently (resolveStage never
-- demotes). Drain or clear the bot's discord_award_outbox before rolling back.

DROP TABLE IF EXISTS discord_award_events;
