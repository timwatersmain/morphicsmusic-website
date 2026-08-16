import { describe, it, expect } from 'vitest';
import { buildReleaseAvatars } from '../../scripts/sync-avatar-catalogue.mjs';

const catalog = {
  releases: [
    { slug: 'perception', title: 'PERCEPTION', artwork: '/images/albums/perception.jpg' },
    { slug: 'swamp-logic', title: 'SWAMP LOGIC', artwork: '/images/albums/swamp-logic.jpg' },
  ],
};

describe('buildReleaseAvatars', () => {
  it('makes one avatar per release', () => {
    expect(buildReleaseAvatars(catalog)).toHaveLength(2);
  });

  it('uses a stable id so re-running never re-issues an unlock', () => {
    expect(buildReleaseAvatars(catalog)[0].id).toBe('release:perception');
  });

  it('prefers the 400px webp variant over the source jpg', () => {
    expect(buildReleaseAvatars(catalog)[0].art_path).toBe('/images/albums/perception-400.webp');
  });

  it('encodes an ownership rule naming the release', () => {
    expect(JSON.parse(buildReleaseAvatars(catalog)[0].unlock_rule))
      .toEqual({ type: 'own_release', slug: 'perception' });
  });

  it('writes a hint that tells a locked fan how to earn it', () => {
    expect(buildReleaseAvatars(catalog)[0].hint).toBe('Own PERCEPTION');
  });

  it('skips a release with no artwork rather than emitting a broken avatar', () => {
    const out = buildReleaseAvatars({ releases: [{ slug: 'x', title: 'X', artwork: null }] });
    expect(out).toEqual([]);
  });

  it('is deterministic — same input, same output', () => {
    expect(buildReleaseAvatars(catalog)).toEqual(buildReleaseAvatars(catalog));
  });
});
