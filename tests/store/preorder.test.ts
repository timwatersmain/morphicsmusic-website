import { describe, it, expect, vi } from 'vitest';

// The allow-list ships empty (nothing is on pre-order today), so the module is
// given a fixture one. Mocking the JSON rather than editing the real file keeps
// these tests from turning green or red depending on what is currently on sale.
vi.mock('../../src/data/preorders.json', () => ({
  default: { slugs: ['future-ep'], digital_slugs: ['future-plugin'] },
}));

const {
  isPreorderable, isSellable, daysUntilUnlock,
  isDigitalPreorderable, digitalDeliverable, digitalSellable,
} = await import('../../functions/_lib/preorder.mjs');
const { isReleased } = await import('../../functions/_lib/release-gate.mjs');
const realPreorders = (await import('../../src/data/preorders.json?raw')).default;

// Midnight ET on 2026-09-01 is 04:00 UTC (EDT, UTC-4).
const GO_LIVE = Date.UTC(2026, 8, 1, 4, 0, 0);
const BEFORE = GO_LIVE - 5 * 86_400_000;
const AFTER = GO_LIVE + 1000;

describe('isPreorderable', () => {
  it('is true only for a listed slug that has not been released', () => {
    expect(isPreorderable('future-ep', '2026-09-01', BEFORE)).toBe(true);
  });

  it('is false for an unlisted slug, however far off its date is', () => {
    // The date alone must never open sales — scheduling a release is not the
    // same decision as announcing a pre-order.
    expect(isPreorderable('some-other-ep', '2026-09-01', BEFORE)).toBe(false);
  });

  it('is false once the release is out, so the allow-list cannot pin a slug in pre-order forever', () => {
    expect(isPreorderable('future-ep', '2026-09-01', AFTER)).toBe(false);
  });

  it('is false with no date at all — an unscheduled release is not a pre-order', () => {
    expect(isPreorderable('future-ep', '', BEFORE)).toBe(false);
    expect(isPreorderable('future-ep', undefined, BEFORE)).toBe(false);
  });
});

describe('the sell gate and the deliver gate are independent', () => {
  // This is the whole safety property of the feature. A pre-order is sellable
  // and NOT deliverable at the same instant; if these two ever agree before
  // the release date, buyers can download unreleased masters.
  it('a live pre-order is sellable while release-gate still refuses delivery', () => {
    expect(isSellable('future-ep', '2026-09-01', BEFORE)).toBe(true);
    expect(isReleased('2026-09-01', BEFORE)).toBe(false);
  });

  it('an ordinary released item is both', () => {
    expect(isSellable('anything', '2026-09-01', AFTER)).toBe(true);
    expect(isReleased('2026-09-01', AFTER)).toBe(true);
  });

  it('an unreleased, unlisted item is neither', () => {
    expect(isSellable('some-other-ep', '2026-09-01', BEFORE)).toBe(false);
    expect(isReleased('2026-09-01', BEFORE)).toBe(false);
  });
});

describe('daysUntilUnlock', () => {
  it('rounds up, so a part-day still reads as a day rather than as zero', () => {
    expect(daysUntilUnlock('2026-09-01', GO_LIVE - 90_000_000)).toBe(2); // 25h
    expect(daysUntilUnlock('2026-09-01', GO_LIVE - 3_600_000)).toBe(1);  // 1h
  });

  it('is null once unlocked, and null for an unusable date', () => {
    expect(daysUntilUnlock('2026-09-01', AFTER)).toBeNull();
    expect(daysUntilUnlock('', BEFORE)).toBeNull();
    expect(daysUntilUnlock('not-a-date', BEFORE)).toBeNull();
  });
});

describe('the shipped allow-list', () => {
  it('parses and exposes a slugs array', () => {
    const parsed = JSON.parse(realPreorders);
    expect(Array.isArray(parsed.slugs)).toBe(true);
    expect(parsed.slugs.every((s: unknown) => typeof s === 'string')).toBe(true);
  });
});

describe('the library card for a pre-order', () => {
  it('offers no download link, and says when it unlocks instead of "coming soon"', async () => {
    const { musicSection } = await import('../../src/scripts/library-view');
    const html = musicSection([
      {
        slug: 'future-ep',
        title: 'Future EP',
        type: 'ep',
        artwork: '/x.png',
        track_count: 4,
        release_date: '2026-09-01',
        preorder: true,
        unlocks_in_days: 5,
        files: [],
      },
    ]);
    // The one thing that must never appear: a button that would 403.
    expect(html).not.toContain('/api/download');
    expect(html).toContain('Pre-order');
    expect(html).toContain('in 5 days');
    expect(html).toContain('Unlocks 2026-09-01');
    expect(html).not.toContain('coming soon');
  });

  it('a released purchase is unaffected and still lists its files', async () => {
    const { musicSection } = await import('../../src/scripts/library-view');
    const html = musicSection([
      {
        slug: 'out-now',
        title: 'Out Now',
        type: 'ep',
        artwork: '/x.png',
        track_count: 1,
        files: [{ key: 'masters/out-now/a.flac', filename: 'a.flac', ext: 'flac', size: 1024 }],
      },
    ]);
    expect(html).toContain('/api/download');
    expect(html).not.toContain('Pre-order');
  });
});

describe('digital pre-orders', () => {
  const plugin = { slug: 'future-plugin', available: false, release_date: '2026-09-01' };
  const font = { slug: 'morphian', available: true };
  const withdrawn = { slug: 'gone', available: false };

  it('a listed, dated, unavailable product is sellable as a pre-order', () => {
    expect(isDigitalPreorderable(plugin.slug, plugin.release_date, BEFORE)).toBe(true);
    expect(digitalSellable(plugin, BEFORE)).toBe(true);
  });

  it('and is NOT deliverable at that same instant — the property the gate exists for', () => {
    expect(digitalDeliverable(plugin, BEFORE)).toBe(false);
  });

  it('flips to deliverable, and stops being a pre-order, once the date passes', () => {
    expect(digitalDeliverable(plugin, AFTER)).toBe(true);
    expect(isDigitalPreorderable(plugin.slug, plugin.release_date, AFTER)).toBe(false);
  });

  it('a product with NO release_date is delivered on purchase, exactly as before', () => {
    // The regression that would hurt most: every existing font and pack has
    // no date, and a missing date must mean "ship it", not "hold it".
    expect(digitalDeliverable(font, BEFORE)).toBe(true);
    expect(digitalSellable(font, BEFORE)).toBe(true);
  });

  it('an unavailable product that is not listed stays unsellable', () => {
    expect(digitalSellable(withdrawn, BEFORE)).toBe(false);
    expect(isDigitalPreorderable(withdrawn.slug, undefined, BEFORE)).toBe(false);
  });

  it('a listed product with no date is refused, same as music', () => {
    expect(isDigitalPreorderable('future-plugin', '', BEFORE)).toBe(false);
  });
});

describe('the library card for a digital pre-order', () => {
  it('offers no download link and names the date', async () => {
    const { digitalSection } = await import('../../src/scripts/library-view');
    const html = digitalSection([
      {
        slug: 'future-plugin',
        title: 'Future Plugin',
        kind: 'plugin',
        artwork: '/x.png',
        licence: 'Commercial licence',
        preorder: true,
        release_date: '2026-09-01',
        files: [],
      },
    ]);
    expect(html).not.toContain('/api/download');
    expect(html).toContain('Pre-order');
    expect(html).toContain('2026-09-01');
  });
});

describe('free products and the claim path', () => {
  // Stripe cannot take a zero-amount payment, so a free product has NO route
  // through checkout — the guard has to be explicit or it fails as an opaque
  // Stripe API error at the worst possible moment.
  const freePreorder = { slug: 'future-plugin', available: false, price_cents: 0, release_date: '2026-09-01' };
  const paid = { slug: 'morphian', available: true, price_cents: 1000 };

  it('a free pre-order is still sellable — free changes the door, not the gate', () => {
    expect(digitalSellable(freePreorder, BEFORE)).toBe(true);
    expect(isDigitalPreorderable(freePreorder.slug, freePreorder.release_date, BEFORE)).toBe(true);
  });

  it('and is still NOT deliverable before its date — free does not mean early', () => {
    // The failure that would matter most: giving it away AND handing over the
    // files immediately, because "free" got read as "no longer a pre-order".
    expect(digitalDeliverable(freePreorder, BEFORE)).toBe(false);
    expect(digitalDeliverable(freePreorder, AFTER)).toBe(true);
  });

  it('a free product that is not listed and not available still cannot be claimed', () => {
    expect(digitalSellable({ slug: 'nope', available: false, price_cents: 0 }, BEFORE)).toBe(false);
  });

  it('price is a catalogue fact, so a paid product is never free', () => {
    expect(paid.price_cents).toBeGreaterThan(0);
  });
});

describe('the shipped catalogue', () => {
  it('every digital product with a release_date is on the pre-order list, and vice versa', async () => {
    // A dated product that is NOT listed is invisible (unbuyable, no way in);
    // a listed product with NO date is refused at the gate. Either mismatch
    // is a silent no-op rather than a loud failure, so it is pinned here.
    const digital = (await import('../../src/data/digital.json')).default as any[];
    const lists = JSON.parse((await import('../../src/data/preorders.json?raw')).default);
    const dated = digital.filter(d => d.release_date).map(d => d.slug).sort();
    expect(dated).toEqual([...(lists.digital_slugs || [])].sort());
  });

  it('a free product must be claimable, i.e. it must carry price_cents 0 exactly', async () => {
    const digital = (await import('../../src/data/digital.json')).default as any[];
    for (const d of digital) {
      expect(typeof d.price_cents).toBe('number');
      expect(d.price_cents).toBeGreaterThanOrEqual(0);
    }
  });
});
