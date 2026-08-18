// Pure EP (Evolution Points) computation. No D1, no KV, no fetch — callers
// gather the inputs (owned-release count from the KV customer record,
// fan_profiles.fan_since for tenure, and later a real engagement tracker
// that does not exist yet) and pass them in here.
//
// Weights are named constants in ONE place, not scattered magic numbers,
// because they will be tuned as real usage data comes in.

// Stage keys match the vendored sprite export exactly (see
// src/scripts/sprites/vendor/README.txt) — egg/grub/pupa/adult — so there is
// no translation layer between what's stored and what the art is authored
// against. Migration 0007 renamed these from the pre-launch placeholder
// names (larva/chrysalis/emergent); see that migration's header comment.
// Display wording is a SEPARATE concern — see STAGE_LABELS below — so
// copy can change without ever touching a stored value.
export type CreatureStage = 'egg' | 'grub' | 'pupa' | 'adult';

// Ordered low to high — every place that needs "is X past Y" walks this.
const STAGE_ORDER: CreatureStage[] = ['egg', 'grub', 'pupa', 'adult'];

/** Fan-facing wording for each stored stage key. Never used as a lookup key itself.
 *  Egg -> Larva -> Chrysalis -> Emergent: the ladder reads as one metamorphosis
 *  rather than four unrelated words, and "Emergent" names an arrival instead of
 *  an age. The stored keys stay egg/grub/pupa/adult on purpose — they match the
 *  vendored sprite export and the stage CHECK constraint on fan_profiles, so
 *  renaming them would mean a table rebuild and a re-export of the art for a
 *  change that is purely wording. This is exactly the split the type comment
 *  above describes. */
export const STAGE_LABELS: Record<CreatureStage, string> = {
  egg: 'Egg',
  grub: 'Larva',
  pupa: 'Chrysalis',
  adult: 'Emergent',
};

export const EP_WEIGHTS = {
  // Purchases are the strongest signal a fan is real and invested.
  PER_PURCHASE: 45,
  // Tenure cannot be rushed or bought — a slow, steady trickle instead.
  PER_TENURE_DAY: 0.2,
  // Visits/actions. The site tracks none of this yet — see EpInputs below
  // — this weight exists so a future engagement tracker needs only to feed
  // a non-zero number here, with no migration and no change to this module.
  PER_ENGAGEMENT_ACTION: 1,
} as const;

// EP required to REACH each stage (egg has no threshold — everyone starts
// there). Kept gentle on purpose: a fan who buys one release and sticks
// around for a few weeks should hatch, not grind — see computeEp's doc
// comment for the arithmetic that keeps this true.
export const STAGE_THRESHOLDS: Record<Exclude<CreatureStage, 'egg'>, number> = {
  grub: 50,
  pupa: 200,
  adult: 600,
};

export interface EpInputs {
  /** Count of distinct owned releases/digital slugs — see me.ts's `owned`. */
  purchaseCount: number;
  /** Days since fan_since. Negative or non-finite is treated as 0. */
  tenureDays: number;
  /**
   * Visits/actions. Always 0 today — the site has no engagement tracker —
   * but the input exists so wiring a real counter in later needs no schema
   * change and no change to this function's signature.
   */
  engagementActions: number;
}

/**
 * Pure EP total from the three signals. Never negative.
 *
 * Worked example: one purchase (45) plus a month of tenure (30 * 0.2 = 6)
 * is 51 EP — just past the 50-EP grub threshold, so a fan who buys a
 * release and sticks around for about a month hatches. Two purchases
 * (90 EP) hatch immediately, with no tenure needed at all. A ladder nobody
 * climbs is worse than no ladder, so these weights are deliberately
 * generous at the bottom.
 */
export function computeEp(inputs: EpInputs): number {
  const purchases = Math.max(0, Number(inputs.purchaseCount) || 0);
  const tenureDays = Math.max(0, Number(inputs.tenureDays) || 0);
  const engagement = Math.max(0, Number(inputs.engagementActions) || 0);
  const raw =
    purchases * EP_WEIGHTS.PER_PURCHASE +
    tenureDays * EP_WEIGHTS.PER_TENURE_DAY +
    engagement * EP_WEIGHTS.PER_ENGAGEMENT_ACTION;
  return Math.floor(raw);
}

/** Which stage a given EP total qualifies for, taken in isolation (no history). */
export function stageForEp(ep: number): CreatureStage {
  if (ep >= STAGE_THRESHOLDS.adult) return 'adult';
  if (ep >= STAGE_THRESHOLDS.pupa) return 'pupa';
  if (ep >= STAGE_THRESHOLDS.grub) return 'grub';
  return 'egg';
}

/** EP needed to reach the stage AFTER `stage`, or null once already at the top. */
export function nextStageThreshold(stage: CreatureStage): number | null {
  const idx = STAGE_ORDER.indexOf(stage);
  const next = STAGE_ORDER[idx + 1] as Exclude<CreatureStage, 'egg'> | undefined;
  return next ? STAGE_THRESHOLDS[next] : null;
}

/**
 * The stage a fan should be at right now: never lower than `currentStage`.
 * EP can only move a fan forward — a weight tuned down later, or EP that
 * genuinely drops, must never demote someone. Demoting a fan for something
 * they didn't do would feel like a punishment, so this always takes the
 * higher of "what current EP implies" and "what they already had".
 * `currentStage` of null (a legacy pre-migration row) is read as 'egg'.
 */
export function resolveStage(ep: number, currentStage: CreatureStage | null): CreatureStage {
  const computed = stageForEp(ep);
  const current = currentStage || 'egg';
  return STAGE_ORDER.indexOf(computed) > STAGE_ORDER.indexOf(current) ? computed : current;
}

/**
 * EP the fan already had on entering `stage`, and the width of that stage's
 * band — the two numbers stageXp needs. 'egg' starts at 0 with a band as
 * wide as the gap to 'grub'. The top stage ('adult') has no upper threshold
 * (nextStageThreshold returns null), so it reuses the WIDTH of the band
 * below it rather than dividing by Infinity — an arbitrary but stable choice
 * that keeps growth visually continuous across the pupa->adult boundary
 * instead of jumping straight to "fully grown".
 */
function stageBand(stage: CreatureStage): { start: number; width: number } {
  const idx = STAGE_ORDER.indexOf(stage);
  const start = idx === 0 ? 0 : STAGE_THRESHOLDS[STAGE_ORDER[idx] as Exclude<CreatureStage, 'egg'>];
  const next = STAGE_ORDER[idx + 1] as Exclude<CreatureStage, 'egg'> | undefined;
  if (next) return { start, width: STAGE_THRESHOLDS[next] - start };
  // Top stage: reuse the previous band's width so the curve stays continuous.
  const prevStart = idx <= 1 ? 0 : STAGE_THRESHOLDS[STAGE_ORDER[idx - 1] as Exclude<CreatureStage, 'egg'>];
  return { start, width: Math.max(1, start - prevStart) };
}

/**
 * Percentage (0..100) through `stage`'s own EP band — what recipes.js's
 * frame(sprite, xp, frameIndex) wants as `xp`, per the vendored README: eggs
 * and pupae crack progressively across this range, grubs and adults grow
 * across it. Deliberately re-based per stage rather than using raw EP
 * directly, so "a fan near hatching" always means "near 100" regardless of
 * which stage they're in. Clamped to [0, 100] — resolveStage guarantees `ep`
 * is high enough for `stage` to have been reached, but this stays defensive
 * against a stale/out-of-sync (ep, stage) pair.
 */
export function stageXp(ep: number, stage: CreatureStage): number {
  const { start, width } = stageBand(stage);
  const pct = ((ep - start) / width) * 100;
  return Math.max(0, Math.min(100, pct));
}
