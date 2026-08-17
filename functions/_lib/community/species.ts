// Deterministic species assignment for creature hatching.
//
// The same (email, roster) pair must always produce the same species — a
// random draw at hatch time would be unreproducible, and unrecoverable if
// the D1 write that persists it failed partway through and had to retry.
// So this derives the pick from a hash of the fan's email plus a fixed
// server-side salt, never Math.random().
//
// Species is assigned ONCE, at hatch, and persisted to fan_profiles.species
// (see evaluateCreature in creature.ts, which never calls this again for a
// fan who already has one). That is what makes "adding an inactive species
// never changes anyone's existing assignment" true: this module is not
// consulted again after hatch, and an inactive species is simply excluded
// from the weighting below, so it can only ever affect fans who have not
// hatched yet.

import type { CreatureSpeciesRow } from './types';

// Fixed and never rotated. Rotating it would only affect fans who hatch
// AFTER the change (already-hatched fans keep their stored species — see
// above), so there is no upside to rotating it, and doing so would make a
// manual "why did fan X get species Y" audit unreproducible by hand.
const SPECIES_SALT = 'morphics-creature-species-salt-v1';

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  // Web Crypto, not a Node built-in — this runs in the Workers runtime.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministically assign a species to `email` from the given roster.
 * Only `active` rows are eligible, weighted by `rarity_weight` (higher =
 * more common — same convention as sort_order elsewhere in this codebase,
 * just for probability instead of display order). Returns null if the
 * roster has no active species with positive weight — the caller must not
 * hatch in that case (see evaluateCreature).
 */
export async function assignSpecies(
  email: string,
  roster: CreatureSpeciesRow[],
): Promise<string | null> {
  // Sorted by id so the cumulative-weight walk below is stable regardless
  // of what order rows come back from D1 (no ORDER BY is guaranteed there
  // without an explicit clause) or how a test constructs the array.
  const active = roster
    .filter(s => !!s.active && s.rarity_weight > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const totalWeight = active.reduce((sum, s) => sum + s.rarity_weight, 0);
  if (!active.length || totalWeight <= 0) return null;

  const hex = await sha256Hex(`${SPECIES_SALT}:${email.toLowerCase().trim()}`);
  // The first 32 bits of a SHA-256 digest is plenty of entropy for a
  // weighted pick across a small roster — using the full 256 bits would not
  // make the distribution any more uniform for this purpose.
  const n = parseInt(hex.slice(0, 8), 16);
  const point = n % totalWeight;

  let cursor = 0;
  for (const s of active) {
    cursor += s.rarity_weight;
    if (point < cursor) return s.id;
  }
  // Unreachable given totalWeight > 0 and the loop covering [0, totalWeight),
  // but returning the last bucket rather than undefined keeps this total.
  return active[active.length - 1].id;
}
