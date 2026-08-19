-- 0015_discord_award_events.sql
-- Makes POST /api/discord/award safely retryable.
--
-- WHY: addDiscordEp applies a RELATIVE increment (`discord_ep = discord_ep + ?`).
-- Replaying an award therefore adds the amount AGAIN — and because EP only ever
-- moves a fan forward (ep.ts's resolveStage never demotes), an inflated total
-- produces a rank that is permanent and cannot be corrected by the system that
-- created it. That made retrying a lost award unsafe, which in turn meant the
-- bot had to DROP any award the site did not accept: the member did the thing,
-- the bot recorded it as paid under its own permanent dedup key, and the EP
-- silently never arrived.
--
-- This table is the receiver-side half of the fix. The bot now sends a stable
-- `event_key` derived from what caused the award (kind + Discord message id +
-- Discord user id — the same triple its local ledger dedups on, so both sides
-- agree on what "the same award" means). A key already present here means the
-- award was applied before, and the endpoint reports current state instead of
-- adding again.
--
-- The PRIMARY KEY is what actually guarantees single-apply. Any read-then-write
-- check in application code is only deciding what to REPORT — two concurrent
-- retries both see "not applied", both attempt the insert, and exactly one
-- wins. That is by design, not a race left unhandled.
--
-- No foreign key to fan_profiles or discord_links on purpose: this records that
-- a REQUEST was applied, and it must stay true even if the fan later unlinks or
-- deletes their profile. A cascade here would silently make old awards
-- replayable again, which is the exact bug this prevents.
--
-- Rollback: see migrations/down/0015_discord_award_events.down.sql

CREATE TABLE discord_award_events (
  event_key  TEXT    PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Rows are only ever read by exact primary key, so no other index is needed.
-- Retention: unbounded for now. At the server's scale this grows by a handful
-- of rows per active member per day; if it ever matters, deleting rows older
-- than the bot's own retry horizon is safe, since the bot stops retrying after
-- MAX_ATTEMPTS anyway.
CREATE INDEX idx_discord_award_events_applied ON discord_award_events (applied_at);
