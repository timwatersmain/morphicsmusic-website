-- Seeds 8 placeholder species into creature_species. Idempotent upserts —
-- safe to re-run; ids are stable so re-running can never change an
-- already-hatched fan's species (species.ts reads fan_profiles.species
-- directly and never re-derives it — this table only feeds NEW
-- assignments). Plain VALUES rows rather than a compound SELECT — D1 caps
-- the number of terms in a compound SELECT very low (see the same note in
-- seed-avatar-tiers.sql).
--
-- Names and rarity_weight are placeholders the owner will replace with real
-- designs; the point of seeding now is to make the weighted distribution
-- testable and to unblock the hatch flow end to end. art_prefix is the
-- filename stem art resolves against: /images/creatures/<art_prefix>-<stage>.webp
-- for stage in {larva, chrysalis, emergent} (never for 'egg' — that stage
-- always renders the fan's existing glyph avatar, see creature.ts).

INSERT INTO creature_species (id, name, rarity_weight, art_prefix, active)
VALUES
  ('creature:driftlarva',   'Driftlarva',   220, 'driftlarva',   1),
  ('creature:hushcocoon',   'Hushcocoon',   180, 'hushcocoon',   1),
  ('creature:glassmoth',    'Glassmoth',    140, 'glassmoth',    1),
  ('creature:signalwyrm',   'Signalwyrm',   110, 'signalwyrm',   1),
  ('creature:pupalume',     'Pupalume',      90, 'pupalume',     1),
  ('creature:emberchrysid', 'Emberchrysid',  60, 'emberchrysid', 1),
  ('creature:nightimago',   'Nightimago',    35, 'nightimago',   1),
  ('creature:auroraimago',  'Auroraimago',   15, 'auroraimago',  1)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  rarity_weight = excluded.rarity_weight,
  art_prefix = excluded.art_prefix,
  active = excluded.active;
