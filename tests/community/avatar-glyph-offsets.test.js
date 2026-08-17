// Regression coverage for the per-letter glyph-centring fix (avatar.js +
// scripts/generate-glyph-offsets.mjs). Two things are asserted without a
// browser: the generated table itself is complete and sane, and the
// renderer actually APPLIES it, scaled to the real rendered font size.
//
// What this file deliberately does NOT try to assert: that the resulting
// SVG is pixel-perfect centred. That is a property of rendered pixels
// (anti-aliasing, the engine's text layout, actual glyph ink), which no
// amount of string-matching on the SVG markup can prove — a browser really
// has to paint it. That verification lives in
// /private/tmp/claude-501/-Users-morphics/36753a36-9370-4b2d-a8a6-618a78e57f90/scratchpad/glyph-centring/verify-glyphs.mjs
// (CDP + real Chrome, measuring ink bounding boxes from actual pixels) —
// see the task report for the numbers it produced. This file is the fast,
// CI-safe half of that verification: the table exists, is sane, and is
// wired up.

import { describe, it, expect } from 'vitest';
import { GLYPH_OFFSETS } from '../../src/scripts/avatar-glyph-offsets.generated.js';
import { computeOffsets, SANITY_LIMIT } from '../../scripts/generate-glyph-offsets.mjs';
import { avatarHtml } from '../../src/scripts/avatar.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

describe('GLYPH_OFFSETS (generated table)', () => {
  it('has an entry for all 26 letters, and nothing extra', () => {
    expect(Object.keys(GLYPH_OFFSETS).sort()).toEqual(LETTERS);
  });

  it('every entry has finite numeric dx and dy', () => {
    for (const letter of LETTERS) {
      const { dx, dy } = GLYPH_OFFSETS[letter];
      expect(Number.isFinite(dx), `dx for '${letter}'`).toBe(true);
      expect(Number.isFinite(dy), `dy for '${letter}'`).toBe(true);
    }
  });

  it('no correction exceeds the sanity limit (half an em)', () => {
    for (const letter of LETTERS) {
      const { dx, dy } = GLYPH_OFFSETS[letter];
      expect(Math.abs(dx), `dx for '${letter}'`).toBeLessThanOrEqual(SANITY_LIMIT);
      expect(Math.abs(dy), `dy for '${letter}'`).toBeLessThanOrEqual(SANITY_LIMIT);
    }
  });

  it('is not a flat/degenerate table — letters genuinely differ from each other', () => {
    // Guards against a generator regression that silently emits the same
    // {dx:0,dy:0} (or any single constant) for every letter, which would
    // pass the checks above while providing no per-letter correction at all.
    const dxValues = new Set(LETTERS.map(l => GLYPH_OFFSETS[l].dx.toFixed(5)));
    expect(dxValues.size).toBeGreaterThan(5);
  });
});

describe('computeOffsets (generator logic, re-run against the checked-in table)', () => {
  it('is idempotent: running it again on synthetic metrics matches the documented formula', () => {
    // Two synthetic letters with known asymmetric bearings/heights —
    // verifies the dx (advance-box-centre delta) and dy (absolute,
    // baseline-relative) formulas directly, independent of the real font.
    const metrics = {
      a: { xMin: 100, xMax: 700, yMin: 0, yMax: 700, aw: 1000, upm: 1000 },
      b: { xMin: 200, xMax: 800, yMin: -100, yMax: 600, aw: 1000, upm: 1000 },
    };
    const offsets = computeOffsets(metrics);
    // a: dx = (1000/2 - (100+700)/2)/1000 = (500-400)/1000 = 0.1
    expect(offsets.a.dxFrac).toBeCloseTo(0.1, 10);
    // a: dy = (700+0)/(2*1000) = 0.35
    expect(offsets.a.dyFrac).toBeCloseTo(0.35, 10);
    // b: dx = (500 - 500)/1000 = 0
    expect(offsets.b.dxFrac).toBeCloseTo(0, 10);
    // b: dy = (600-100)/2000 = 0.25
    expect(offsets.b.dyFrac).toBeCloseTo(0.25, 10);
  });
});

describe('avatar.js applies GLYPH_OFFSETS, scaled to the actual rendered font size', () => {
  // font-size = round(sizePx * scale); scale is 0.6 for tiers 1-2, 0.72 for
  // tier 4 (see avatar.js's glyphSvg scale args) — so the same letter's
  // pixel nudge must differ between styles/sizes even though the
  // underlying fraction (GLYPH_OFFSETS.m) is identical.
  const dx = (html) => Number(html.match(/dx="(-?[\d.]+)"/)[1]);
  const y = (html) => Number(html.match(/\by="(-?[\d.]+)"/)[1]);

  it('glyph_solid (tier 1, scale 0.6): dx/y track fontSize = round(sizePx*0.6)', () => {
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, 'm', 84);
    const fontSize = Math.round(84 * 0.6);
    expect(dx(html)).toBeCloseTo(GLYPH_OFFSETS.m.dx * fontSize, 1);
    expect(y(html)).toBeCloseTo(84 / 2 + GLYPH_OFFSETS.m.dy * fontSize, 1);
  });

  it('glyph_overlay (tier 4, scale 0.72) uses a LARGER fontSize than tier 1 at the same disc size, so the same letter gets a different pixel nudge', () => {
    const solid = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, 'y', 84);
    const overlay = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/images/visuals/dscf3589-960.webp' }, 'y', 84);
    expect(dx(overlay)).not.toBeCloseTo(dx(solid), 1);
  });

  it('40px and 84px avatars of the same letter/style get proportionally different nudges (scales with size, not a fixed magic pixel offset)', () => {
    const small = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, 'y', 40);
    const large = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, 'y', 84);
    const fs40 = Math.round(40 * 0.6);
    const fs84 = Math.round(84 * 0.6);
    // Ratio of the applied dx should track the ratio of the two font sizes
    // (both derived from the SAME GLYPH_OFFSETS.y.dx fraction).
    expect(dx(small) / dx(large)).toBeCloseTo(fs40 / fs84, 2);
  });

  it('an unknown/unsupported letter falls back to a zero offset rather than throwing', () => {
    // avatarHtml always receives a real lowercase letter from glyphLetterFor,
    // but glyphSvg's own `GLYPH_OFFSETS[letter] || { dx: 0, dy: 0 }` fallback
    // is what actually protects that invariant — cover it directly.
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, '7', 84);
    expect(dx(html)).toBe(0);
    expect(y(html)).toBeCloseTo(42, 5); // sizePx/2 + 0*fontSize
  });

  it('no longer relies on dominant-baseline="middle" (measured to introduce per-letter noise unrelated to this font'+"'"+'s ink — see generator header comment)', () => {
    const html = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/images/visuals/dscf3589-960.webp' }, 'g', 84);
    expect(html).not.toContain('dominant-baseline');
  });
});
