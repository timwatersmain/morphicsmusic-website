// Orchestrates a fan's creature progress: compute EP, decide the stage,
// hatch (assign a species) the first time EP crosses out of 'egg'. Deliberately
// separate from repo.ts's persistence and from ep.ts/species.ts's pure math —
// this is the one place that combines them, so it is the one place a test
// needs to read to see the whole hatch decision.
//
// Idempotent by construction: calling this repeatedly with the same profile
// and inputs (mod EP, which only grows) always returns a stage >= the one
// stored, and never reassigns a species once profile.species is set. That is
// what lets me.ts call this on every profile read — visiting your profile IS
// what advances you, with no separate "claim" step.

import { computeEp, resolveStage, type CreatureStage, type EpInputs } from './ep';
import { assignSpecies } from './species';
import type { CreatureSpeciesRow, FanProfileRow } from './types';

export interface CreatureUpdate {
  ep: number;
  stage: CreatureStage;
  species: string | null;
  hatchedAt: number | null;
  /** True only on the call that just performed the hatch — for UI toasts, etc. */
  justHatched: boolean;
}

type HatchableProfile = Pick<FanProfileRow, 'email' | 'stage' | 'species' | 'hatched_at'>;

/**
 * The stage/species/hatch decision for a fan already sitting at `ep` EP.
 * Split out from evaluateCreature so admin.ts's grant-ep/force-hatch
 * endpoints can drive this from an EP value they set directly, without
 * duplicating the hatch logic or going through computeEp's inputs.
 */
async function progressCreature(
  profile: HatchableProfile,
  ep: number,
  speciesRoster: CreatureSpeciesRow[],
  now: number,
): Promise<CreatureUpdate> {
  const currentStage: CreatureStage | null = (profile.stage as CreatureStage | null) || null;

  // Already hatched: species is permanent. Stage may still climb further
  // (larva -> chrysalis -> emergent) but resolveStage guarantees it never
  // drops below what is already stored, and species is never touched again.
  if (profile.species) {
    return {
      ep,
      stage: resolveStage(ep, currentStage),
      species: profile.species,
      hatchedAt: profile.hatched_at,
      justHatched: false,
    };
  }

  const computedStage = resolveStage(ep, currentStage);
  if (computedStage === 'egg') {
    return { ep, stage: 'egg', species: null, hatchedAt: null, justHatched: false };
  }

  // Crossing out of 'egg' for the first time — this is the hatch moment.
  const species = await assignSpecies(profile.email, speciesRoster);
  if (!species) {
    // No active species in the roster (e.g. not seeded yet). Refuse to
    // strand the fan in a non-egg stage with no creature to render —
    // however much EP they have, stay an egg until a roster exists.
    return { ep, stage: 'egg', species: null, hatchedAt: null, justHatched: false };
  }
  return { ep, stage: computedStage, species, hatchedAt: now, justHatched: true };
}

export async function evaluateCreature(
  profile: HatchableProfile,
  inputs: EpInputs,
  speciesRoster: CreatureSpeciesRow[],
  now: number,
): Promise<CreatureUpdate> {
  return progressCreature(profile, computeEp(inputs), speciesRoster, now);
}

/**
 * Admin path: grant `amount` EP directly (on top of whatever the fan
 * already has from computeEp) and re-run the same stage/hatch decision.
 * Never lets EP go negative. Used by POST /api/admin/grant-ep.
 */
export async function grantEp(
  profile: HatchableProfile & { ep: number },
  amount: number,
  speciesRoster: CreatureSpeciesRow[],
  now: number,
): Promise<CreatureUpdate> {
  const ep = Math.max(0, (profile.ep || 0) + amount);
  return progressCreature(profile, ep, speciesRoster, now);
}

/**
 * Admin path: force a hatch regardless of EP. Still refuses to hatch a fan
 * with no active species roster (same rule as the natural path), and still
 * never reassigns a species for a fan who already has one. Used by
 * POST /api/admin/force-hatch. If the fan's own EP does not yet justify
 * 'larva', this still puts them there — force-hatch is meant to unstick
 * someone the admin has decided should be a creature already, not to
 * simulate more EP for them (use grantEp for that).
 */
export async function forceHatch(
  profile: HatchableProfile & { ep: number },
  speciesRoster: CreatureSpeciesRow[],
  now: number,
): Promise<CreatureUpdate> {
  if (profile.species) {
    // Nothing to do — already hatched, and hatch is permanent.
    return {
      ep: profile.ep || 0,
      stage: resolveStage(profile.ep || 0, (profile.stage as CreatureStage | null) || null),
      species: profile.species,
      hatchedAt: profile.hatched_at,
      justHatched: false,
    };
  }
  const currentStage: CreatureStage | null = (profile.stage as CreatureStage | null) || null;
  const ep = profile.ep || 0;
  // At least 'larva' — resolveStage still won't let a naturally-higher
  // stage (e.g. an admin re-running this after EP already earned chrysalis)
  // regress.
  const stage = resolveStage(ep, currentStage === 'egg' || !currentStage ? 'larva' : currentStage);
  const species = await assignSpecies(profile.email, speciesRoster);
  if (!species) {
    return { ep, stage: 'egg', species: null, hatchedAt: null, justHatched: false };
  }
  return { ep, stage, species, hatchedAt: now, justHatched: true };
}

/**
 * Art path for a fan's creature at their current stage, or null when there
 * is nothing to show yet — still an egg (falls back to the glyph avatar) or
 * no species row could be resolved. Pure and synchronous; callers pass in
 * the already-fetched species row (see repo.ts's getSpeciesCatalogue).
 */
export function creatureArtPath(species: CreatureSpeciesRow | null, stage: CreatureStage): string | null {
  if (!species || stage === 'egg') return null;
  return `/images/creatures/${species.art_prefix}-${stage}.webp`;
}
