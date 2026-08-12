import { describe, it, expect } from 'vitest';
import { planPhrase, viewScaleFor } from '../../src/scripts/spelling/layout.js';
import { PHRASE } from '../../src/scripts/spelling/charmap.js';

describe('planPhrase', () => {
  it('puts one word on each line and never breaks a word', () => {
    const plan = planPhrase(PHRASE, 7200);
    expect(plan.lines.map(l => l.join(''))).toEqual(
      ['THE', 'ONLY', 'CONSTANT', 'IS', 'CHANGE']
    );
  });

  it('emits one slot per glyph, in reading order', () => {
    const plan = planPhrase(PHRASE, 7200);
    expect(plan.slots).toHaveLength(23);
    expect(plan.slots.map(s => s.ch).join('')).toBe('THEONLYCONSTANTISCHANGE');
  });

  it('centres each line horizontally and the block vertically', () => {
    const plan = planPhrase('AB CDEF', 7200);
    const [l0, l1] = [plan.slots.slice(0, 2), plan.slots.slice(2)];
    const mid = s => (s[0].cx + s[s.length - 1].cx) / 2;
    expect(mid(l0)).toBeCloseTo(mid(l1), 6);
    const ys = [...new Set(plan.slots.map(s => s.cy))];
    expect(ys).toHaveLength(2);
    expect((ys[0] + ys[1]) / 2).toBeCloseTo(60, 6);
  });

  it('shrinks the scale as the phrase grows, and never exceeds 0.72', () => {
    const short = planPhrase('AB', 7200).scale;
    const long = planPhrase(PHRASE, 7200).scale;
    expect(short).toBeLessThanOrEqual(0.72);
    expect(long).toBeLessThan(short);
  });

  it('clamps the per-glyph point budget to 360..760', () => {
    expect(planPhrase(PHRASE, 100).perGlyph).toBe(360);
    expect(planPhrase(PHRASE, 1e6).perGlyph).toBe(760);
    expect(planPhrase(PHRASE, 12000).perGlyph).toBe(Math.floor(12000 / 23));
  });

  it('uppercases input and drops unmapped characters', () => {
    const plan = planPhrase('a§b', 7200);
    expect(plan.slots.map(s => s.ch).join('')).toBe('AB');
  });

  it('returns null when nothing is mappable', () => {
    expect(planPhrase('   ', 7200)).toBeNull();
    expect(planPhrase('§§', 7200)).toBeNull();
  });
});

describe('viewScaleFor', () => {
  it('opens the view so the laid-out block fills the canvas', () => {
    const wide = viewScaleFor(40, 430, 430, 14);
    const narrow = viewScaleFor(120, 430, 430, 14);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('clamps to 0.6..2.6 so no phrase length can blow out the framing', () => {
    expect(viewScaleFor(1, 430, 430, 14)).toBeLessThanOrEqual(2.6);
    expect(viewScaleFor(100000, 430, 430, 14)).toBeGreaterThanOrEqual(0.6);
  });

  it('scales with the canvas, so a smaller canvas still fits the phrase', () => {
    expect(viewScaleFor(60, 300, 300, 14)).toBeGreaterThan(0);
    expect(viewScaleFor(60, 300, 300, 14)).toBeLessThanOrEqual(2.6);
  });
});
