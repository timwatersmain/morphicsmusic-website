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

import { computeEp, resolveStage, type CreatureStage, type EpInputs } from './ep';
import type { FanProfileRow } from './types';

export interface CreatureUpdate {
  ep: number;
  stage: CreatureStage;
  /** True only on the call that just crossed out of 'egg' — for UI toasts, etc. */
  justHatched: boolean;
}

type StageableProfile = Pick<FanProfileRow, 'stage'>;

function toStage(update: { ep: number; stage: CreatureStage }, wasEgg: boolean): CreatureUpdate {
  return { ep: update.ep, stage: update.stage, justHatched: wasEgg && update.stage !== 'egg' };
}

/**
 * The stage decision for a fan already sitting at `ep` EP. Split out from
 * evaluateCreature so admin.ts's grant-ep/force-hatch endpoints can drive
 * this from an EP value they set directly, without duplicating resolveStage.
 */
function progressStage(profile: StageableProfile, ep: number): CreatureUpdate {
  const currentStage: CreatureStage | null = (profile.stage as CreatureStage | null) || null;
  const stage = resolveStage(ep, currentStage);
  return toStage({ ep, stage }, (currentStage || 'egg') === 'egg');
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
