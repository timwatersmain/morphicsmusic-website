// The unlock engine. Deliberately pure — no D1, no KV, no fetch — so it is
// fully testable and so the caller controls persistence.
//
// Idempotency lives in the caller: it inserts grants with ON CONFLICT DO
// NOTHING. That is what lets this run on every sign-in, and what makes the
// first run backfill every existing customer's collection rather than
// starting them at zero.

import type { AvatarCatalogueRow, UnlockContext, UnlockGrant, UnlockRule } from './types';

function parseRule(json: string): UnlockRule | null {
  try {
    const r = JSON.parse(json);
    return r && typeof r.type === 'string' ? (r as UnlockRule) : null;
  } catch {
    // A malformed rule must never take down a profile page. It simply never
    // grants, and the avatar stays locked.
    return null;
  }
}

function isAvailable(a: AvatarCatalogueRow, now: number): boolean {
  if (a.available_from !== null && now < a.available_from) return false;
  if (a.available_until !== null && now > a.available_until) return false;
  return true;
}

function qualifies(rule: UnlockRule, ctx: UnlockContext): string | null | false {
  switch (rule.type) {
    case 'own_release':
      return ctx.ownedSlugs.includes(rule.slug) ? rule.slug : false;
    case 'tenure_days':
      return (ctx.now - ctx.fanSince) / 86400 >= rule.days ? null : false;
    case 'free_song_streak':
      return ctx.streakWeeks >= rule.weeks ? String(rule.weeks) : false;
    case 'show_attended':
      return ctx.showsAttended.includes(rule.showId) ? rule.showId : false;
    case 'gate_completed':
      return ctx.gatesCompleted.includes(rule.gateSlug) ? rule.gateSlug : false;
    case 'has_password':
      return ctx.hasPassword ? null : false;
    case 'manual':
      // Tiers 3-4 are granted only via the admin endpoint, which writes
      // directly to fan_avatar_unlocks and never goes through this
      // evaluation path — so this must always refuse.
      return false;
    case 'tier1_default':
      // Tier 1 availability comes from the `tier` column at equip time, not
      // from a ledger row — this must always refuse so grantUnlocks never
      // writes one.
      return false;
    default:
      // Unknown rule type — forward-compatible with catalogue rows written by
      // a newer deploy. Never throws, never grants.
      return false;
  }
}

/** Every avatar the fan qualifies for right now. Order follows the catalogue. */
export function evaluateUnlocks(
  ctx: UnlockContext,
  catalogue: AvatarCatalogueRow[],
): UnlockGrant[] {
  const grants: UnlockGrant[] = [];
  for (const a of catalogue) {
    if (!isAvailable(a, ctx.now)) continue;
    const rule = parseRule(a.unlock_rule);
    if (!rule) continue;
    const result = qualifies(rule, ctx);
    if (result === false) continue;
    grants.push({ avatarId: a.id, source: rule.type, sourceRef: result });
  }
  return grants;
}
