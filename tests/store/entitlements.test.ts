import { describe, it, expect } from 'vitest';
import { ownedSlugs, ownedDigital, licenceTerms } from '../../functions/_lib/entitlements';
import digitalData from '../../src/data/digital.json';

const font = {
  slug: 'morphian',
  name: 'Morphian',
  kind: 'font',
  thumbnail: '/images/digital/morphian-card.png',
  details: ['Morphian and Morphian Mono', 'Commercial licence, up to 5 users'],
  file: { r2_key: 'digital/morphian/Morphian.zip', filename: 'Morphian.zip' },
};

describe('ownedSlugs', () => {
  it('dedupes across orders — buying the same thing twice is still one entitlement', () => {
    const rec = { purchases: [{ digital_slugs: ['morphian'] }, { digital_slugs: ['morphian', 'other'] }] };
    expect([...ownedSlugs(rec, 'digital_slugs')].sort()).toEqual(['morphian', 'other']);
  });

  it('a customer with no record and one with no purchases both own nothing, without throwing', () => {
    expect(ownedSlugs(null, 'digital_slugs').size).toBe(0);
    expect(ownedSlugs({}, 'music_release_slugs').size).toBe(0);
    expect(ownedSlugs({ purchases: [{}] }, 'digital_slugs').size).toBe(0);
  });
});

describe('licenceTerms', () => {
  it('reads the licence line out of the product, not out of a second hard-coded copy', () => {
    expect(licenceTerms(font)).toBe('Commercial licence, up to 5 users');
  });

  it('a product with no licence line has no limit to state', () => {
    expect(licenceTerms({ slug: 'x', name: 'X', details: ['Two weights'] })).toBeNull();
    expect(licenceTerms({ slug: 'x', name: 'X' })).toBeNull();
  });

  it('the shipped catalogue keeps its licence terms where this code can find them', () => {
    // A silent rename in digital.json would drop the ONE limit the store is
    // meant to show, so the real data is asserted, not just a fixture.
    for (const p of digitalData as any[]) {
      expect(licenceTerms(p), `${p.slug} has no findable licence line`).toBeTruthy();
    }
  });
});

describe('ownedDigital', () => {
  it('returns only what was bought, with its file and licence attached', () => {
    const rec = { purchases: [{ music_release_slugs: ['some-ep'], digital_slugs: ['morphian'] }] };
    const owned = ownedDigital(rec, [font, { slug: 'unbought', name: 'Nope', file: { r2_key: 'k', filename: 'f.zip' } }]);
    expect(owned).toHaveLength(1);
    expect(owned[0].slug).toBe('morphian');
    expect(owned[0].licence).toBe('Commercial licence, up to 5 users');
    expect(owned[0].files).toEqual([{ key: 'digital/morphian/Morphian.zip', filename: 'Morphian.zip', ext: 'zip' }]);
  });

  it('music-only customers get an empty digital list, not every product in the store', () => {
    const rec = { purchases: [{ music_release_slugs: ['some-ep'] }] };
    expect(ownedDigital(rec, [font])).toEqual([]);
  });

  it('a product with no uploaded file yet still lists, with no download row to click', () => {
    const rec = { purchases: [{ digital_slugs: ['pending'] }] };
    const owned = ownedDigital(rec, [{ slug: 'pending', name: 'Pending', details: ['Commercial licence'] }]);
    expect(owned[0].files).toEqual([]);
  });
});
