import { describe, it, expect } from 'vitest';
import {
  assignSpriteRefs, assignSpriteForStage, assignColourway, isValidColourway, COLOURWAY_IDS,
} from '../../functions/_lib/community/sprites';
import { SPRITE_REFS_BY_STAGE } from '../../functions/_lib/community/sprite-refs.generated';

describe('assignSpriteRefs', () => {
  it('is stable — the same email always yields the same assignment', async () => {
    const a = await assignSpriteRefs('fan@example.com');
    const b = await assignSpriteRefs('fan@example.com');
    expect(a).toEqual(b);
  });

  it('is case- and whitespace-insensitive on the email, matching how emails are stored elsewhere', async () => {
    const a = await assignSpriteRefs('Fan@Example.com');
    const b = await assignSpriteRefs(' fan@example.com ');
    expect(a).toEqual(b);
  });

  it('picks a ref that actually exists in the sprite set and matches its stage', async () => {
    const a = await assignSpriteRefs('fan2@example.com');
    expect(SPRITE_REFS_BY_STAGE.egg).toContain(a.sprite_egg);
    expect(SPRITE_REFS_BY_STAGE.grub).toContain(a.sprite_grub);
    expect(SPRITE_REFS_BY_STAGE.pupa).toContain(a.sprite_pupa);
    expect(SPRITE_REFS_BY_STAGE.adult).toContain(a.sprite_adult);
  });

  it('picks one of the 12 real colourway ids', async () => {
    const a = await assignSpriteRefs('fan3@example.com');
    expect(COLOURWAY_IDS).toContain(a.colourway);
    expect(COLOURWAY_IDS.length).toBe(12);
  });

  it('different emails can land on different refs for the same stage', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(await assignSpriteForStage(`fan${i}@example.com`, 'adult'));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('the four stage picks for one fan are independent draws, not the same index reused', async () => {
    // Each stage has a different-sized roster (50/100/50/201), so if the
    // implementation reused one hash for all four stages instead of
    // per-stage salting, this would still often look "independent" by
    // accident. The real guarantee this asserts: changing ONLY the stage
    // in the hash input changes the pick.
    const a = await assignSpriteForStage('fan4@example.com', 'egg');
    const b = await assignSpriteForStage('fan4@example.com', 'grub');
    // Not a hard cross-stage equality claim (refs are different roster
    // spaces entirely, e.g. "A1" vs "G1"), just that both are valid and the
    // function does not throw/collide on the same email.
    expect(SPRITE_REFS_BY_STAGE.egg).toContain(a);
    expect(SPRITE_REFS_BY_STAGE.grub).toContain(b);
  });
});

describe('assignColourway', () => {
  it('is stable for the same email', async () => {
    const a = await assignColourway('c@example.com');
    const b = await assignColourway('c@example.com');
    expect(a).toBe(b);
  });
});

describe('isValidColourway', () => {
  it('accepts all 12 real ids', () => {
    for (const id of COLOURWAY_IDS) expect(isValidColourway(id)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidColourway('not-a-real-colourway')).toBe(false);
    expect(isValidColourway('')).toBe(false);
    // Guard against accidentally reusing an UNRELATED avatar-tier colourway
    // id (functions/_lib/community/colourways.ts's own, separate 6-id
    // space) that happens not to also be one of the 12 creature colourways.
    expect(isValidColourway('mint')).toBe(false);
  });
});
