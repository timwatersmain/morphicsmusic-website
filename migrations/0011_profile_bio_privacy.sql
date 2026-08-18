-- 0011_profile_bio_privacy.sql
-- Turns the fan profile into a profile rather than a trophy case: a bio the
-- fan writes, and a switch to keep that profile off the public fan wall.
--
--   bio               -- free text the fan writes about themselves, or NULL
--                        if they never wrote one. Length and character
--                        sanitising live in functions/_lib/community/bio.ts
--                        (MAX_BIO_LENGTH), NOT in a CHECK constraint: the
--                        limit is a product/copy decision that will be tuned,
--                        and every tune of a CHECK on this table costs a full
--                        rebuild (see 0007/0009/0010). The DB's job here is
--                        to store text; the write path's job is to bound it.
--   hidden_from_wall  -- 0 (default) = listed in the directory; 1 = the fan
--                        keeps their profile and their rank but does not
--                        appear on /community. Direct links to their profile
--                        still work — this is "unlisted", not "private", and
--                        the copy on /community/me says exactly that.
--
-- Deliberately a plain ADD COLUMN, NOT the table rebuild that 0007/0008/0009/
-- 0010 used. Those rebuilt because each of them had to ALTER an existing
-- CHECK constraint (colourway's allow-list, stage's allow-list), which SQLite
-- cannot do in place. Nothing here touches a constraint: one nullable TEXT
-- column and one INTEGER with a non-NULL default, both of which ADD COLUMN
-- supports directly. A rebuild would mean copying every live fan row for no
-- reason, so this takes the cheaper and far less destructive path.
--
-- Rollback: see migrations/down/0011_profile_bio_privacy.down.sql

ALTER TABLE fan_profiles ADD COLUMN bio TEXT;

ALTER TABLE fan_profiles ADD COLUMN hidden_from_wall INTEGER NOT NULL DEFAULT 0;
