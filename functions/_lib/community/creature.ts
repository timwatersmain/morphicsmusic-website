// Orchestrates a fan's creature STAGE progress: compute EP, decide the
// stage. Deliberately separate from repo.ts's persistence and from ep.ts's
// pure math — this is the one place that combines them, so it is the one
// place a test needs to read to see the whole stage decision.
//
// Sprite/colourway ASSIGNMENT is a separate concern (see sprites.ts) and
// happens exactly once, at profile creation — never here. This module used
// to also own species assignment at the moment a fan first left 'egg' (the
// "hatch"); that model is retired (see migration 0007's header comment) now
// that every fan's sprites are settled from the start. What's left here is
// just: how much EP does the fan have, and what stage does that put them at.
//
// Idempotent by construction: calling this repeatedly with the same profile
// and inputs (mod EP, which only grows) always returns a stage >= the one
// stored. That is what lets me.ts call this on every profile read — visiting
// your profile IS what advances you, with no separate "claim" step.

import { computeEp, resolveStage, cycleEp, canAscend, type CreatureStage, type EpInputs } from './ep';
import type { FanProfileRow } from './types';

export interface CreatureUpdate {
  /** TOTAL EP. Never reset by ascension — see ep.ts's prestige note. */
  ep: number;
  stage: CreatureStage;
  /** True only on the call that just crossed out of 'egg' — for UI toasts, etc. */
  justHatched: boolean;
  /** Progress within the CURRENT line, i.e. ep - cycle_base_ep. */
  cycleEp: number;
  prestige: number;
  /** Whether the fan may begin a new line right now. */
  canAscend: boolean;
}

type StageableProfile = Pick<FanProfileRow, 'stage'> & {
  prestige?: number;
  cycle_base_ep?: number;
};

function toStage(
  update: { ep: number; stage: CreatureStage; cycleEp: number; prestige: number; canAscend: boolean },
  wasEgg: boolean,
): CreatureUpdate {
  return {
    ep: update.ep,
    stage: update.stage,
    justHatched: wasEgg && update.stage !== 'egg',
    cycleEp: update.cycleEp,
    prestige: update.prestige,
    canAscend: update.canAscend,
  };
}

/**
 * The stage decision for a fan already sitting at `ep` EP. Split out from
 * evaluateCreature so admin.ts's grant-ep/force-hatch endpoints can drive
 * this from an EP value they set directly, without duplicating resolveStage.
 */
function progressStage(profile: StageableProfile, ep: number): CreatureUpdate {
  const currentStage: CreatureStage | null = (profile.stage as CreatureStage | null) || null;
  const prestige = Math.max(0, Math.floor(Number(profile.prestige) || 0));
  const base = Math.max(0, Math.floor(Number(profile.cycle_base_ep) || 0));
  // Stage is resolved from CYCLE ep, not total. A fan on their second line
  // with 700 total EP and a base of 600 is 100 into that line — an egg — not
  // an adult. Passing the total here is the one mistake that would silently
  // hand every ascended fan a fully-grown creature on their next page load.
  const inCycle = cycleEp(ep, base);
  const stage = resolveStage(inCycle, currentStage, prestige);
  return toStage({
    ep,
    stage,
    cycleEp: inCycle,
    prestige,
    canAscend: canAscend(stage, ep, base, prestige),
  }, (currentStage || 'egg') === 'egg');
}

export async function evaluateCreature(
  profile: StageableProfile,
  inputs: EpInputs,
): Promise<CreatureUpdate> {
  return progressStage(profile, computeEp(inputs));
}

/**
 * Admin path: grant `amount` EP directly (on top of whatever the fan already
 * has from computeEp) and re-run the same stage decision. Never lets EP go
 * negative. Used by POST /api/admin/grant-ep.
 */
export function grantEp(
  profile: StageableProfile & { ep: number },
  amount: number,
): CreatureUpdate {
  const ep = Math.max(0, (profile.ep || 0) + amount);
  return progressStage(profile, ep);
}

/**
 * Admin path: force a fan out of 'egg' regardless of EP. A no-op — not an
 * error — for a fan already past 'egg', since stage never regresses. Used by
 * POST /api/admin/force-hatch.
 */
export function forceHatch(profile: StageableProfile & { ep: number }): CreatureUpdate {
  const currentStage: CreatureStage | null = (profile.stage as CreatureStage | null) || null;
  const ep = profile.ep || 0;
  const wasEgg = (currentStage || 'egg') === 'egg';
  const stage = resolveStage(ep, wasEgg ? 'grub' : currentStage);
  return toStage({ ep, stage }, wasEgg);
}
