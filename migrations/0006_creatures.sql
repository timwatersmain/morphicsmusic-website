-- 0006_creatures.sql
-- The creature evolution system. A fan's avatar becomes a creature that
-- visibly transforms with engagement: egg -> larva -> chrysalis -> emergent.
-- The egg IS the existing Morphian glyph avatar (already built) — nobody
-- starts blank. Purely additive, same shape as 0005: every new column on
-- fan_profiles is nullable (or has a safe default), so every existing row
-- stays valid with no backfill. A NULL `stage` is read as 'egg' by the
-- application layer (see functions/_lib/community/repo.ts's toPublicProfile),
-- not by a default here, so existing rows never need a write to be correct.
--
-- Rollback: see migrations/down/0006_creatures.down.sql

-- Species catalogue first — fan_profiles.species is a plain TEXT key into
-- it (no FK: species assignment must survive even if the catalogue row is
-- ever pruned, same reasoning as avatar_catalogue's colourway/style columns
-- being plain TEXT keys into colourways.ts rather than FK'd rows). Art for
-- a species at a stage resolves to /images/creatures/<art_prefix>-<stage>.webp,
-- so the owner drops in real illustrations by filename with no code change.
CREATE TABLE creature_species (
  id            TEXT    PRIMARY KEY,
  name          TEXT,
  -- Higher weight = more common. Used to build a cumulative-weight table for
  -- assignment (see functions/_lib/community/species.ts) — never a raw
  -- probability, so weights don't need to sum to 100.
  rarity_weight INTEGER NOT NULL DEFAULT 100,
  art_prefix    TEXT    NOT NULL,
  -- 0/1. An inactive species is no longer eligible for NEW assignments but
  -- must never affect fans who already carry it (species.ts always reads
  -- fan_profiles.species directly, never re-derives it) — this column only
  -- controls the roster the assignment draw is taken from.
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

ALTER TABLE fan_profiles ADD COLUMN ep INTEGER NOT NULL DEFAULT 0;

-- NULL means "egg", exactly like a fan who predates this migration — see the
-- header comment. Once a fan hatches, this only ever moves forward through
-- the ladder (see resolveStage in ep.ts); nothing here enforces that at the
-- schema level; it is an application invariant.
ALTER TABLE fan_profiles ADD COLUMN stage TEXT
  CHECK (stage IS NULL OR stage IN ('egg', 'larva', 'chrysalis', 'emergent'));

-- Assigned once, at hatch, from a hash of the fan's email + a fixed
-- server-side salt (see species.ts) — never Math.random(), so it is
-- reproducible and never lost to a failed write. Permanent once set.
ALTER TABLE fan_profiles ADD COLUMN species TEXT;

-- The one part of the creature the fan actually chooses (see colourways.ts —
-- same named-key convention as the avatar-tier colourway column, never a
-- raw hex value).
ALTER TABLE fan_profiles ADD COLUMN creature_colourway TEXT;

-- Unix seconds of the hatch moment, or NULL pre-hatch. Kept purely for
-- display/audit; nothing re-derives it.
ALTER TABLE fan_profiles ADD COLUMN hatched_at INTEGER;
