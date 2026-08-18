-- 0013_discord_links.sql
-- Links a Discord account to a fan profile, and stores the EP that Discord
-- activity has earned that fan.
--
-- WHY A SEPARATE TABLE, not columns on fan_profiles: every migration in the
-- 0007..0010 chain had to REBUILD fan_profiles (copy, drop, rename) because
-- SQLite cannot ADD COLUMN around its CHECK constraints, and 0007's header
-- records that such a rebuild once cascade-deleted live fan_avatar_unlocks
-- rows before the foreign_keys guard was added everywhere. That rebuild is
-- a real risk against paying customers' rows, and it buys nothing here: a
-- fan's Discord link is genuinely a separate 1:0-or-1 fact, not an
-- attribute of the profile. Nothing in this file touches fan_profiles.
--
-- TWO TABLES, deliberately:
--
--   discord_links      the durable link, one row per linked fan.
--     discord_ep       lifetime EP earned from Discord activity, summed
--                      alongside fan_profiles.engagement_ep into ep.ts's
--                      `engagementActions`. NOT a second ladder: the bot
--                      keeps its own event log (discord_xp_events, in the
--                      brain's SQLite) purely for dedup and rate caps, and
--                      pushes only net deltas here. This column is the
--                      total, and ep.ts remains the only thing that turns
--                      a total into a rank.
--
--   discord_link_codes short-lived codes for the linking handshake.
--     The bot can reach the site; the site cannot reach the bot (the bot
--     runs in a container on a home machine, the site runs on Cloudflare).
--     So the handshake is one-directional: /link in Discord makes the bot
--     POST a code here, the fan pastes that code on /account, and the site
--     resolves it locally. No OAuth app, no redirect URI, no inbound
--     connection to a home network.
--
-- ON DELETE CASCADE on fan_id: a fan who deletes their profile must not
-- leave a dangling link that would silently re-attach their Discord account
-- to whoever next takes that row id.
--
-- Rollback: see migrations/down/0013_discord_links.down.sql

CREATE TABLE discord_links (
  fan_id          INTEGER NOT NULL
                    REFERENCES fan_profiles (id) ON DELETE CASCADE,
  discord_user_id TEXT    NOT NULL,
  linked_at       INTEGER NOT NULL,
  discord_ep      INTEGER NOT NULL DEFAULT 0
);

-- One Discord account links to exactly one fan, and one fan to exactly one
-- Discord account. Both directions are enforced here rather than in
-- application code: without the fan_id index, two Discord accounts could
-- farm EP into a single profile, and without the discord_user_id index one
-- Discord account could be linked to several profiles and be awarded by
-- each of them.
CREATE UNIQUE INDEX idx_discord_links_fan ON discord_links (fan_id);
CREATE UNIQUE INDEX idx_discord_links_user ON discord_links (discord_user_id);

CREATE TABLE discord_link_codes (
  code            TEXT    PRIMARY KEY,
  discord_user_id TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- Codes are consumed by expiry sweep as well as by use, so this index is
-- what keeps the sweep from scanning the table.
CREATE INDEX idx_discord_link_codes_expiry ON discord_link_codes (expires_at);
