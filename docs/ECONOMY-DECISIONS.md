# Economy decisions

Answers to the open questions in `artist-site-handoff-spec.md`, decided by the
owner on 18 Aug 2026. Recorded here so the spec's Phase 0 questions are closed
and nobody re-litigates them from the spec's defaults.

## 1. What behaviour should XP push hardest on?

**Ticket sales — specifically tickets bought through morphicsmusic.com.**

Encoded as `EP_WEIGHTS.PER_TICKET = 400` in `functions/_lib/community/ep.ts`:
one ticket outweighs eight releases, and a unit test asserts that ordering so
a later weight tune cannot quietly demote it.

**Blocked, and this is the important part: the site cannot sell tickets.**
There is no ticketing anywhere in the codebase — no shows, no inventory, no
fulfilment, no QR issuance. The spec does not cover it either; it assumes
tickets are sold elsewhere and only *scanned* at the door. So the top XP
priority currently has nothing that can emit it. The weight and the ledger are
in place so that building the sales path is the only remaining work.

## 2. One user table, or the KV/D1 split?

**D1 is the canonical identity.** `fan_profiles.id` is the `user_id` every
economy table references. The KV `customer:<email>` record stays the record of
truth for commerce (purchases, password, verification).

The owner's stated reason was that Discord uses D1. That isn't quite the case —
the Discord bot is a separate Python service — but the conclusion is right
anyway, and for a stronger reason: migrating live purchase history out of KV is
a large risk with no payoff before the first drop ships.

## 3. Five tiers, or four creature stages?

**Four stages, unchanged.** Egg / Larva / Chrysalis / Emergent at
0 / 50 / 200 / 600. The spec's five-tier curve is not adopted: stage keys are
bound to the sprite artwork (401 sprites, one per stage per fan) and to a CHECK
constraint, so a fifth tier means re-exporting the entire sprite set.

If a five-level *tier* concept is ever wanted for perks, it should be a
separate config-driven ladder that reads the same XP total — never a rename of
the creature stages.

## 4. Canonical site timezone

**Eastern.** Implement as IANA `America/New_York`, **not** a fixed `EST`
offset: a fixed offset is wrong for eight months of the year, which would shift
every drop window by an hour across a DST boundary and produce exactly the
"the drop closed early" tickets the spec warns about.

Not yet implemented — nothing renders a window today.

## 5. Season definition

**Undecided by the owner; deferred.** Seasons are step 8 of the spec's build
order and nothing depends on them yet. `xp_events.season_id` exists as a
nullable column so adding them later is a write, not a table rebuild.

Default if still undecided when it comes up: calendar quarters, because they
automate without anyone remembering to close a cycle.

## 6. Drop cadence

**Undecided; deferred with seasons.** Worth checking against the existing
release calendar (23 releases, 41 tracks) rather than adopting the spec's
first-Friday default unexamined.

## 7. Do claims survive profile deletion?

**No — unless the profile is restored.** This already falls out of the soft
delete shipped in migration 0012: deleting hides everything for 30 days and the
fan can restore it themselves, after which a purge is permanent. `xp_events`
follows the same rule (survives soft delete, cascades on purge), and a test
covers both halves.

Note this differs from the spec's recommendation, which was a flat "no". The
terms need to describe the 30-day window, and that purchases and library access
were never at risk from profile deletion at all.

## 8. Linking Bandcamp / other-platform purchases to accounts

**Wanted, deferred as too complex for now.** Recorded so it is not forgotten:
Bandcamp has no purchase webhook, so this would mean either sales-report import
or order-email parsing, plus an identity-matching step when the Bandcamp email
differs from the site account. Revisit after the drop ships.

## Not building: raffles and guest lists

The spec's guest-list raffle, token-priced entries and sweepstakes terms are
**out of scope** — the owner did not ask for them; they came from the spec.
That also removes the spec's legal-review flag, which existed only for raffles.
