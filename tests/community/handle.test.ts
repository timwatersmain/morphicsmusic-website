import { describe, it, expect } from 'vitest';
import {
  slugifyHandle, isValidDisplayName, isBlockedName, nextAvailableHandle,
} from '../../functions/_lib/community/handle';

describe('slugifyHandle', () => {
  it.each([
    ['Ana Vex', 'ana-vex'],
    ['  Spaced  Out  ', 'spaced-out'],
    ['MORPHICS', 'morphics'],
    ['Ünïcodé Näme', 'unicode-name'],
    ['emoji 🎧 fan', 'emoji-fan'],
    ['a---b', 'a-b'],
    ['-leading-and-trailing-', 'leading-and-trailing'],
  ])('slugifies %s to %s', (input, expected) => {
    expect(slugifyHandle(input)).toBe(expected);
  });

  it('falls back when nothing survives slugification', () => {
    expect(slugifyHandle('🎧🎧🎧')).toBe('fan');
  });

  it('caps length at 32 characters', () => {
    expect(slugifyHandle('x'.repeat(80)).length).toBe(32);
  });
});

describe('isValidDisplayName', () => {
  it.each(['Ana', 'Ana Vex', 'DJ 3000'])('accepts %s', n =>
    expect(isValidDisplayName(n)).toBe(true));
  it.each(['', ' ', 'a', 'x'.repeat(41)])('rejects %s', n =>
    expect(isValidDisplayName(n)).toBe(false));
  it('rejects control characters', () => {
    expect(isValidDisplayName('bad\u0000name')).toBe(false);
  });
});

describe('isBlockedName', () => {
  it.each(['admin', 'Admin', 'ADMIN', 'official', 'moderator', 'support'])(
    'blocks impersonation: %s', n => expect(isBlockedName(n)).toBe(true));
  it('blocks reserved route words so handles cannot shadow pages', () => {
    expect(isBlockedName('me')).toBe(true);
    expect(isBlockedName('u')).toBe(true);
  });
  it("allows the owner's own name — it was only ever reserved against fans", () => {
    expect(isBlockedName('morphics')).toBe(false);
    expect(isBlockedName('morphicsmusic')).toBe(false);
  });

  it('allows an ordinary name', () => {
    expect(isBlockedName('Ana Vex')).toBe(false);
  });
});

describe('nextAvailableHandle', () => {
  it('returns the base when free', async () => {
    expect(await nextAvailableHandle('ana', async () => false)).toBe('ana');
  });
  it('suffixes on collision', async () => {
    const taken = new Set(['ana', 'ana-2']);
    expect(await nextAvailableHandle('ana', async h => taken.has(h))).toBe('ana-3');
  });
  it('gives up after 50 attempts and appends a random suffix', async () => {
    const h = await nextAvailableHandle('ana', async () => true);
    expect(h).toMatch(/^ana-[a-z0-9]{6}$/);
  });

  it('caps the random-suffix fallback at 32 characters even for a max-length root', async () => {
    // slugifyHandle already caps a root at 32 chars, so a maximally long
    // display name still yields a 32-char root here. Appending "-" + a
    // 6-char suffix without a final slice would produce a 39-char handle,
    // which profile.ts's ^[a-z0-9-]{1,32}$ check then rejects — permanently
    // 400ing that fan's profile.
    const longRoot = 'x'.repeat(40); // slugifyHandle trims this to 32 x's
    const h = await nextAvailableHandle(longRoot, async () => true);
    expect(h.length).toBeLessThanOrEqual(32);
    expect(h).toMatch(/^[a-z0-9-]+$/);
  });
});
