// What a fan's prestige level is actually worth, in money.
//
// Ascending used to buy only a rarer creature. That is a fine reward for
// someone who is already invested and no reason at all for someone who is
// not, so each completed line now also takes a percentage off the store.
//
// Deliberately small and capped. A discount large enough to distort the
// catalogue's pricing would make the ladder feel like a paywall rather than a
// thank-you, and the cap means the economy cannot be broken by a fan who
// ascends ten times.

/** Percent off per completed line, and the ceiling. */
const PER_PRESTIGE_PCT = 5;
const MAX_PCT = 15;

/**
 * Discount for a given prestige level. 0 for everyone on their first line —
 * which is most people, and must stay the default for anyone the server
 * cannot identify.
 */
export function prestigeDiscountPct(prestige: number | null | undefined): number {
  const p = Math.max(0, Math.floor(Number(prestige) || 0));
  return Math.min(MAX_PCT, p * PER_PRESTIGE_PCT);
}

/**
 * Apply a percentage to a price in CENTS.
 *
 * Rounds UP, so the discount can never round a paid item to something the
 * payment processor will not take: Stripe rejects a charge under 50 cents,
 * and a $0.40 line item is a failed checkout rather than a cheap one. `floor`
 * on a 15% discount off a 50c item would produce exactly that.
 */
export function applyDiscount(cents: number, pct: number): number {
  const base = Math.max(0, Math.floor(Number(cents) || 0));
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (!p || !base) return base;
  return Math.ceil(base * (1 - p / 100));
}
