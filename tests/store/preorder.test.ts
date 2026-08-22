import { describe, it, expect, vi } from 'vitest';

// The allow-list ships empty (nothing is on pre-order today), so the module is
// given a fixture one. Mocking the JSON rather than editing the real file keeps
// these tests from turning green or red depending on what is currently on sale.
vi.mock('../../src/data/preorders.json', () => ({
  default: { slugs: ['future-ep'] },
}));

const { isPreorderable, isSellable, daysUntilUnlock } = await import('../../functions/_lib/preorder.mjs');
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
