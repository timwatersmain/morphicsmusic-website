-- Prestige: a completed creature line can be ascended into a new one.
--
-- Reaching Emergent used to be the end — XP kept counting and bought nothing.
-- These two columns are all the state a second line needs.
--
-- Both default to 0, so every existing fan is "on their first line, which
-- began at 0 EP" — which is exactly true, and needs no backfill.

-- Which line the fan is on. 0 = the starter line everyone begins with.
ALTER TABLE fan_profiles ADD COLUMN prestige INTEGER NOT NULL DEFAULT 0;

-- The fan's TOTAL EP at the moment the current line began. Stage progress is
-- measured as (ep - cycle_base_ep), which is what lets a new line start at
-- egg without the running total ever going down. The total is the site's
-- standing promise to fans; only progress within a line is relative.
ALTER TABLE fan_profiles ADD COLUMN cycle_base_ep INTEGER NOT NULL DEFAULT 0;

-- When they last ascended, for the profile to show. NULL = never.
ALTER TABLE fan_profiles ADD COLUMN ascended_at INTEGER;
