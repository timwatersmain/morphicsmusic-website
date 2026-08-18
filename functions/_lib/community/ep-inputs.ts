// Assembling the three signals ep.ts's computeEp needs, in ONE place.
//
// Two endpoints now decide a fan's rank: GET /api/community/me (visiting
// your profile advances your creature) and POST /api/discord/award (Discord
// activity advances the same creature). If those two assembled EpInputs
// even slightly differently — a different tenure rounding, a forgotten
// engagement source — a fan would see one stage on the site and a different
// role in Discord, which is the exact split merging the ladders removed.
// So neither builds EpInputs itself; both call epInputsFor.

import type { EpInputs } from './ep';
import type { FanProfileRow } from './types';

/** The KV customer record's purchase shape — see me.ts's CustomerRecord. */
export interface PurchaseBearingRecord {
  purchases?: Array<{ music_release_slugs?: string[]; digital_slugs?: string[] }>;
}

/**
 * Distinct owned release/digital slugs. A Set, not a count, because me.ts
 * also feeds the slugs themselves to the unlock engine — returning a count
 * here would make that caller rebuild the set and re-introduce exactly the
 * duplication this module exists to prevent.
 */
export function ownedSlugsFromRecord(record: PurchaseBearingRecord): Set<string> {
  const owned = new Set<string>();
  for (const p of record.purchases || []) {
    for (const s of p.music_release_slugs || []) owned.add(s);
    for (const d of p.digital_slugs || []) owned.add(d);
  }
  return owned;
}

/**
 * Site engagement plus Discord engagement, as one number.
 *
 * Both are "actions the fan took", weighted 1 EP each by
 * EP_WEIGHTS.PER_ENGAGEMENT_ACTION, so they belong in the same input rather
 * than as a fourth weighted signal. Keeping them as separate STORED columns
 * (fan_profiles.engagement_ep and discord_links.discord_ep) is still worth
 * it: it stays possible to see where a fan's EP came from, and the two are
 * capped independently at their own sources.
 */
export function engagementActionsFor(
  engagementEp: number | null | undefined,
  discordEp: number | null | undefined,
): number {
  return Math.max(0, engagementEp || 0) + Math.max(0, discordEp || 0);
}

/**
 * The complete EpInputs for a fan. `nowSec` is passed in rather than read
 * from the clock here so callers that already stamped a time use the same
 * instant for tenure as for everything else they write in that request.
 */
export function epInputsFor(
  profile: Pick<FanProfileRow, 'fan_since' | 'engagement_ep'>,
  ownedCount: number,
  nowSec: number,
  discordEp: number,
  /**
   * Live xp_events total (migration 0014). Trailing and defaulted so a
   * caller that predates the ledger still compiles — but every real caller
   * must pass it. Any recompute path that forgets to re-introduces the bug
   * the ledger exists to fix: computeEp overwrites fan_profiles.ep, so a
   * path that scores a fan without their ledger silently deletes every
   * grant they have. That is precisely why this lives here rather than at
   * the call sites.
   */
  ledgerXp: number = 0,
): EpInputs {
  return {
    purchaseCount: ownedCount,
    ledgerXp,
    // Clamped at 0: a fan_since in the future (clock skew on the machine
    // that wrote it) would otherwise make tenure negative, and computeEp
    // would silently floor it anyway — doing it here keeps the value the
    // caller sees and the value scored identical.
    tenureDays: Math.max(0, (nowSec - profile.fan_since) / 86400),
    engagementActions: engagementActionsFor(profile.engagement_ep, discordEp),
  };
}
