import { describe, it, expect } from 'vitest';
import { prestigeDiscountPct, applyDiscount } from '../../functions/_lib/community/perks';

describe('prestigeDiscountPct', () => {
  it('is zero on the first line — the default for almost everyone', () => {
    expect(prestigeDiscountPct(0)).toBe(0);
    // And for anyone the server could not identify at all: an anonymous
    // checkout must never be handed a discount by accident.
    expect(prestigeDiscountPct(null)).toBe(0);
    expect(prestigeDiscountPct(undefined)).toBe(0);
    expect(prestigeDiscountPct(NaN as any)).toBe(0);
  });

  it('grows 5% per completed line and stops at 15%', () => {
    expect(prestigeDiscountPct(1)).toBe(5);
    expect(prestigeDiscountPct(3)).toBe(15);
    // The cap is what stops the economy breaking for a fan who ascends ten
    // times — without it, prestige 20 would be free.
    expect(prestigeDiscountPct(20)).toBe(15);
  });

  it('ignores a negative or fractional level rather than trusting it', () => {
    expect(prestigeDiscountPct(-5)).toBe(0);
    expect(prestigeDiscountPct(2.9)).toBe(10);
  });
});

describe('applyDiscount', () => {
  it('takes the percentage off', () => {
    expect(applyDiscount(1000, 10)).toBe(900);
    expect(applyDiscount(700, 5)).toBe(665);
  });

  it('rounds UP, so a discount never lands a paid item under Stripe minimum', () => {
    // Stripe rejects a charge below 50 cents. Rounding down here turns a
    // discount into a FAILED CHECKOUT rather than a cheap one.
    expect(applyDiscount(50, 15)).toBe(43);
    expect(applyDiscount(51, 15)).toBeGreaterThanOrEqual(43);
    expect(applyDiscount(100, 15)).toBe(85);
  });

  it('leaves free and zero-percent alone', () => {
    expect(applyDiscount(0, 15)).toBe(0);
    expect(applyDiscount(1500, 0)).toBe(1500);
  });

  it('never returns a negative price', () => {
    expect(applyDiscount(100, 100)).toBe(0);
    expect(applyDiscount(-100, 10)).toBe(0);
  });
});
