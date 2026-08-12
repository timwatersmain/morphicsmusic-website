import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHARMAP, HALF, PHRASE } from '../../src/scripts/spelling/charmap.js';
import { flatten } from '../../src/scripts/spelling/glyph-parse.js';

const dir = fileURLToPath(new URL('../../public/glyphs/svg/', import.meta.url));

describe('CHARMAP', () => {
  it('maps letters to themselves, digits to num-, symbols to sym-', () => {
    expect(CHARMAP['A']).toBe('A');
    expect(CHARMAP['Z']).toBe('Z');
    expect(CHARMAP['0']).toBe('num-0');
    expect(CHARMAP['7']).toBe('num-7');
    expect(CHARMAP['.']).toBe('sym-period');
    expect(CHARMAP['&']).toBe('sym-ampersand');
  });

  it('has no entry for space, so spaces are handled by the sequencer', () => {
    expect(CHARMAP[' ']).toBeUndefined();
  });

  it('exposes the load-bearing half-stroke and the landing phrase', () => {
    expect(HALF).toBe(6.5);
    expect(PHRASE).toBe('THE ONLY CONSTANT IS CHANGE');
  });
});

describe('flatten', () => {
  it('returns drawable parts for every tagline glyph', () => {
    for (const ch of new Set('THEONLYCONSTANTISCHANGE')) {
      const parts = flatten(readFileSync(dir + ch + '.svg', 'utf8'));
      expect(parts.length, ch + ' produced no parts').toBeGreaterThan(0);
      for (const p of parts) expect(['p', 'c']).toContain(p.t);
    }
  });

  it('bakes wrapper transforms into absolute coordinates inside the artboard', () => {
    const parts = flatten(readFileSync(dir + 'I.svg', 'utf8'));
    const nums = parts.flatMap(p =>
      p.t === 'c' ? [p.cx, p.cy] : (p.d.match(/-?[\d.]+/g) || []).map(Number)
    );
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(-200);
      expect(n).toBeLessThan(320);
    }
  });

  it('returns an empty array when the root group is absent', () => {
    expect(flatten('<svg></svg>')).toEqual([]);
  });
});
